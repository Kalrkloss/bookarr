"""Bookarr — background scheduler: wanted search, monitoring, queue sync."""
import logging
import threading
import time
import traceback
from datetime import datetime, timedelta

import db
import indexers
import library

log = logging.getLogger("bookarr.scheduler")

_search_lock = threading.Lock()
_sync_lock = threading.Lock()
_stop = threading.Event()
_state = {"running": False, "loop": "idle", "last_wanted": None, "last_sync": None}


def start():
    _stop.clear()
    # reset statuses stuck after a crash
    db.ex("UPDATE wanted SET status='wanted' WHERE status IN ('searching','found')")
    # IRC downloads cannot be resumed: any still-running one is dead after a restart
    _cleanup_stale_irc()
    threading.Thread(target=_wanted_loop, name="wanted-loop", daemon=True).start()
    threading.Thread(target=_monitor_loop, name="monitor-loop", daemon=True).start()
    threading.Thread(target=_queue_loop, name="queue-loop", daemon=True).start()
    threading.Thread(target=_stale_loop, name="stale-loop", daemon=True).start()
    _resume_nzb_downloads()
    _state["running"] = True
    log.info("Scheduler gestartet")


def _cleanup_stale_irc():
    for d in db.q("SELECT * FROM downloads WHERE source='irc' AND status='downloading'"):
        db.ex("UPDATE downloads SET status='failed', message='Timeout: worker aborted (restart)', "
              "updated=?, completed=? WHERE id=?", (db.now(), db.now(), d["id"]))
        if d["book_id"]:
            db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (d["book_id"],))
            db.ex("UPDATE books SET status='wanted', updated=? WHERE id=? AND status='snatched'",
                  (db.now(), d["book_id"]))
        db.log_event("warn", "download",
                     f"IRC download #{d['id']} ('{d['title'][:40]}') aborted by restart, marked failed")
        log.warning("IRC download #%s aborted by restart, marked failed", d["id"])


def _resume_nzb_downloads():
    """Keep watching in-flight NZB downloads after a restart."""
    for d in db.q("SELECT * FROM downloads WHERE status='snatched'"):
        if d["book_id"] and d["nzb_url"]:
            threading.Thread(target=library._nzb_completion_worker,
                             args=(d["id"], d["book_id"]), daemon=True).start()
            log.info("NZB watch resumed: download #%s", d["id"])


def stop():
    _stop.set()
    _state["running"] = False


def state():
    return dict(_state)


def _ts(ts_str):
    try:
        return datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


# ---------------- wanted search ----------------

def _wanted_loop():
    while not _stop.is_set():
        try:
            _process_wanted_due()
        except Exception:
            log.error("wanted loop: %s", traceback.format_exc())
        _stop.wait(60)


def _process_wanted_due(force=False):
    if db.get_setting("wanted_search_enabled", "1") != "1" and not force:
        return
    if not _search_lock.acquire(blocking=False):
        return
    try:
        _state["loop"] = "wanted-search"
        for w in library.wanted_books():
            if _stop.is_set():
                break
            last = _ts(w["last_search"])
            iv = w["interval_hours"] or int(db.get_setting("wanted_interval", "24"))
            if not force and last and datetime.now() - last < timedelta(hours=iv):
                continue
            db.ex("UPDATE wanted SET last_search=?, status='searching' WHERE book_id=?",
                  (db.now(), w["id"]))
            _state["current_book"] = w["title"]
            try:
                _search_and_download(w)
            finally:
                _state.pop("current_book", None)
        _state["loop"] = "idle"
        _state["last_wanted"] = db.now()
    finally:
        _search_lock.release()


def _search_and_download(book):
    db.log_event("info", "wanted", f"Searching for '{book["title"]}' …")
    results = library.search_downloads(book)
    if not results:
        db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (book["id"],))
        db.log_event("info", "wanted", f"'{book["title"]}': no results")
        return
    # pick the best hit: IRC only when no NZB is available (NZB is more reliable)
    nzb = [r for r in results if r["source"] == "newznab"]
    irc = [r for r in results if r["source"] == "irc"]
    if nzb:
        best = max(nzb, key=lambda r: r.get("size") or 0)
    elif irc:
        best = irc[0]
    else:
        return
    db.ex("UPDATE wanted SET status='found' WHERE book_id=?", (book["id"],))
    library.start_download(book, best)


def search_wanted_now():
    """Manually triggered wanted search (runs in the background, ignores intervals)."""
    threading.Thread(target=lambda: _process_wanted_due(force=True), daemon=True).start()
    return True


# ---------------- author/series monitoring ----------------

def _monitor_loop():
    while not _stop.is_set():
        try:
            _process_monitors()
        except Exception:
            log.error("monitor loop: %s", traceback.format_exc())
        _stop.wait(300)


def _process_monitors():
    if not _sync_lock.acquire(blocking=False):
        return
    try:
        _state["loop"] = "monitor-sync"
        now = datetime.now()
        for a in db.q("SELECT * FROM authors WHERE monitor=1"):
            last = _ts(a["last_checked"])
            iv = a["interval_hours"] or int(db.get_setting("monitor_interval", "168"))
            if last and now - last < timedelta(hours=iv):
                continue
            _state["current_sync"] = a["name"]
            try:
                library.sync_author(a["id"])
            except Exception as e:
                db.log_event("error", "monitor", f"Sync '{a["name"]}' failed: {e}")
            finally:
                _state.pop("current_sync", None)
        for s in db.q("SELECT * FROM series WHERE monitor=1"):
            last = _ts(s["last_checked"])
            iv = s["interval_hours"] or int(db.get_setting("monitor_interval", "168"))
            if last and now - last < timedelta(hours=iv):
                continue
            _state["current_sync"] = s["name"]
            try:
                library.sync_series(s["id"])
            except Exception as e:
                db.log_event("error", "monitor", f"Series sync '{s["name"]}' failed: {e}")
            finally:
                _state.pop("current_sync", None)
        _state["loop"] = "idle"
        _state["last_sync"] = db.now()
    finally:
        _sync_lock.release()


def sync_all_now():
    threading.Thread(target=_process_monitors, daemon=True).start()
    return True


# ---------------- queue sync (progress from SABnzbd) ----------------

def _queue_loop():
    while not _stop.is_set():
        try:
            _sync_queue()
        except Exception:
            log.error("queue loop: %s", traceback.format_exc())
        _stop.wait(30)


def _stale_loop():
    """Watchdog: mark in-flight downloads that were never updated for 2h as failed.
    Covers worker threads killed by a restart or any task that hung despite timeouts."""
    while not _stop.is_set():
        try:
            _check_stale_downloads()
        except Exception:
            log.error("stale loop: %s", traceback.format_exc())
        _stop.wait(300)


def _check_stale_downloads():
    rows = db.q("""SELECT * FROM downloads
                   WHERE status IN ('queued','snatched','downloading')
                     AND updated < datetime('now','localtime','-2 hours')""")
    for d in rows:
        db.ex("UPDATE downloads SET status='failed', progress=0, "
              "message='Timeout: task hung (watchdog)', updated=?, completed=? WHERE id=?",
              (db.now(), db.now(), d["id"]))
        if d["book_id"]:
            db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (d["book_id"],))
            db.ex("UPDATE books SET status='wanted', updated=? WHERE id=? AND status='snatched'",
                  (db.now(), d["book_id"]))
        db.log_event("warn", "download",
                     f"Watchdog: hanging download #{d['id']} ('{d['title'][:40]}') marked as failed")
        log.warning("Watchdog: hanging download #%s marked as failed", d["id"])


def _sync_queue():
    q = indexers.sabnzbd_queue()
    by_title = {}
    for slot in q:
        base = slot["title"].split(".nzb")[0]
        by_title.setdefault(base, slot)
    # Downloads mit Status 'snatched' → Fortschritt nachziehen
    for d in db.q("SELECT * FROM downloads WHERE status='snatched'"):
        if not d["nzb_url"]:
            continue
        # nzo_id ist in der DB nicht gespeichert; per Titel matchen
        for base, slot in by_title.items():
            if base.lower() in d["title"].lower() or d["title"].lower() in base.lower():
                def _num(v, default=0.0):
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        return default
                db.ex("UPDATE downloads SET status='downloading', progress=?, size=?, updated=? WHERE id=?",
                      (_num(slot.get("progress")), _num(slot.get("size")), db.now(), d["id"]))
                break
