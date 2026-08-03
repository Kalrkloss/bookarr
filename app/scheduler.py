"""Bookarr — Hintergrund-Scheduler: Wanted-Suche, Monitoring, Queue-Sync."""
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
    # nach einem Crash hängengebliebene Status zurücksetzen
    db.ex("UPDATE wanted SET status='wanted' WHERE status IN ('searching','found')")
    threading.Thread(target=_wanted_loop, name="wanted-loop", daemon=True).start()
    threading.Thread(target=_monitor_loop, name="monitor-loop", daemon=True).start()
    threading.Thread(target=_queue_loop, name="queue-loop", daemon=True).start()
    _state["running"] = True
    log.info("Scheduler gestartet")


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


# ---------------- Wanted-Suche ----------------

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
    db.log_event("info", "wanted", f"Suche nach '{book['title']}' …")
    results = library.search_downloads(book)
    if not results:
        db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (book["id"],))
        db.log_event("info", "wanted", f"'{book['title']}': keine Treffer")
        return
    # besten Treffer wählen: IRC nur, wenn keine NZB da (NZB zuverlässiger)
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
    """Manuell ausgelöste Wanted-Suche (läuft im Hintergrund, ignoriert Intervalle)."""
    threading.Thread(target=lambda: _process_wanted_due(force=True), daemon=True).start()
    return True


# ---------------- Autor-/Serien-Monitoring ----------------

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
                db.log_event("error", "monitor", f"Sync '{a['name']}' fehlgeschlagen: {e}")
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
                db.log_event("error", "monitor", f"Sync Serie '{s['name']}' fehlgeschlagen: {e}")
            finally:
                _state.pop("current_sync", None)
        _state["loop"] = "idle"
        _state["last_sync"] = db.now()
    finally:
        _sync_lock.release()


def sync_all_now():
    threading.Thread(target=_process_monitors, daemon=True).start()
    return True


# ---------------- Queue-Sync (Fortschritt aus SABnzbd) ----------------

def _queue_loop():
    while not _stop.is_set():
        try:
            _sync_queue()
        except Exception:
            log.error("queue loop: %s", traceback.format_exc())
        _stop.wait(30)


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
