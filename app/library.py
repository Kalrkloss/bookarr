"""Bookarr — library logic: authors, books, series, wanted, downloads."""
import logging
import os
import re
import shutil
import threading
import time
import traceback

import db
import indexers
import irc as irc_mod
import metadata

log = logging.getLogger("bookarr.library")


# ---------------- authors ----------------

def add_author(ol_key, languages=None):
    """Add an author from Open Library (with works + series). Returns author_id."""
    detail = metadata.author_detail(ol_key)
    if not detail:
        raise RuntimeError(f"Open Library: author {ol_key} not found")
    works = metadata.author_works(ol_key)
    if not works:
        raise RuntimeError(f"Open Library: no works found for {detail['name']}")

    now = db.now()
    langs = db.json_dump(languages or ["de", "en"])
    author_id = db.ex(
        "INSERT INTO authors(name, sort_name, ol_key, wikipedia_url, website, birth_date, "
        "death_date, bio, languages, added, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (detail["name"], _sort_name(detail["name"]), ol_key, detail["wikipedia_url"],
         detail["website"], detail["birth_date"], detail["death_date"], detail["bio"],
         langs, now, now))

    # enrich works in parallel (editions → exact date, ISBN, cover, series)
    def enrich(w):
        try:
            eds = metadata.work_editions(w["ol_work_key"], limit=25)
            if eds:
                # date: NEWEST edition with a year (also surfaces upcoming books)
                dated = [e for e in eds if e["year"]]
                best_date = max(dated, key=lambda e: e["year"]) if dated else eds[0]
                # language: oldest dated edition (first publication ≈ original language),
                # fallback: most frequent language among all editions
                lang = metadata.best_language_from_editions(eds)
                return {**w, "edition": best_date, "language_guess": lang}
        except Exception:
            pass
        return {**w, "edition": None, "language_guess": None}

    from concurrent.futures import ThreadPoolExecutor
    enriched = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for w in pool.map(enrich, works[:250]):
            enriched.append(w)

    added_books = 0
    for w in enriched:
        ed = w.get("edition") or {}
        lang = db.lang_code(w.get("language_guess")
                            or metadata.detect_language_from_title(w["title"])
                            or (w["languages"][0] if w["languages"] else ""))
        year = ed.get("year") or w["first_publish_year"]
        date = ed.get("publish_date") or (f"{year}-01-01" if year else "")
        series_id = None
        for s in w.get("series", []):
            series_id = _get_or_create_series(author_id, s.get("name", ""), s.get("position", ""),
                                              w["ol_work_key"], s.get("ol_key", ""))
        try:
            db.ex(
                "INSERT OR IGNORE INTO books(title, norm_title, author_id, series_id, series_number, "
                "language, publish_date, isbn, ol_work_key, ol_edition_key, description, cover_url, "
                "status, wanted, source, added, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (w["title"], db.norm_title(w["title"]), author_id, series_id, s.get("position", "") if w.get("series") else "",
                 lang, date, ed.get("isbn", ""), w["ol_work_key"], ed.get("ol_edition_key", ""),
                 w.get("description", "")[:2000], ed.get("cover") or w.get("cover", ""),
                 "wanted" if _should_want(author_id, lang) else "missing", 1 if _should_want(author_id, lang) else 0,
                 "ol", now, now))
            added_books += 1
        except Exception:
            pass
    db.log_event("success", "author", f"Author '{detail["name"]}' created ({added_books} books)")
    return author_id


def _should_want(author_id, lang):
    a = db.q1("SELECT monitor, languages FROM authors WHERE id=?", (author_id,))
    if not a or not a["monitor"]:
        return False
    if lang and lang not in db.parse_langs(a["languages"]):
        return False
    return True


def _sort_name(name):
    m = re.match(r"^(.*?)\s+(?:Jr\.?|Sr\.?|I{1,3})?$", name)
    parts = name.rsplit(" ", 1)
    if len(parts) == 2 and not name.endswith("."):
        return f"{parts[1]}, {parts[0]}"
    return name


def _get_or_create_series(author_id, name, position, ol_work_key, ol_series_key=""):
    if not name:
        return None
    # resolve name for key-only series
    if name.startswith("/series/") and ol_series_key:
        det = metadata.series_detail(name)
        if det and det["name"]:
            name = det["name"]
    r = db.q1("SELECT id FROM series WHERE author_id=? AND name=?", (author_id, name))
    if r:
        if ol_series_key:
            db.ex("UPDATE series SET ol_key=? WHERE id=?", (ol_series_key, r["id"]))
        return r["id"]
    now = db.now()
    return db.ex("INSERT INTO series(name, author_id, ol_key, added, updated) VALUES(?,?,?,?,?)",
                 (name, author_id, ol_series_key or "", now, now))


def sync_author(author_id):
    """Re-sync an author: detect new works/series, set wanted flags."""
    a = db.q1("SELECT * FROM authors WHERE id=?", (author_id,))
    if not a:
        return 0
    works = metadata.author_works(a["ol_key"])
    new_books = 0
    now = db.now()
    for w in works:
        title = w["title"]
        if not title:
            continue
        norm = db.norm_title(title)
        existing = db.q1("SELECT id FROM books WHERE author_id=? AND norm_title=?", (author_id, norm))
        if existing:
            # Sprache/Datum nachziehen falls fehlt
            if w["first_publish_year"] and not db.q1("SELECT publish_date FROM books WHERE id=?", (existing["id"],))["publish_date"]:
                db.ex("UPDATE books SET publish_date=?, updated=? WHERE id=?",
                      (f"{w['first_publish_year']}-01-01", now, existing["id"]))
            continue
        series_id = None
        for s in w.get("series", []):
            series_id = _get_or_create_series(author_id, s.get("name", ""), s.get("position", ""),
                                              w["ol_work_key"], s.get("ol_key", ""))
        lang = db.lang_code(w["languages"][0] if w["languages"] else "")
        year = w["first_publish_year"]
        date = f"{year}-01-01" if year else ""
        # fetch exact date + language for new works (oldest-dated-edition heuristic)
        try:
            eds = metadata.work_editions(w["ol_work_key"], limit=15)
            if eds:
                dated = [e for e in eds if e["year"]]
                if dated:
                    best = max(dated, key=lambda e: e["year"])
                    date = best.get("publish_date") or date
                    year = best.get("year") or year
                lang = db.lang_code(metadata.best_language_from_editions(eds)
                                    or metadata.detect_language_from_title(title)) or lang
        except Exception:
            pass
        want = _should_want(author_id, lang)
        try:
            db.ex(
                "INSERT OR IGNORE INTO books(title, norm_title, author_id, series_id, series_number, "
                "language, publish_date, isbn, ol_work_key, description, cover_url, status, wanted, "
                "source, added, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (title, norm, author_id, series_id, s.get("position", "") if w.get("series") else "",
                 lang, date,
                 "", w["ol_work_key"], w.get("description", "")[:2000], w.get("cover", ""),
                 "wanted" if want else "missing", 1 if want else 0, "ol", now, now))
            new_books += 1
            if want:
                _set_wanted(db.q1("SELECT id FROM books WHERE author_id=? AND norm_title=?", (author_id, norm))["id"])
        except Exception:
            pass
    db.ex("UPDATE authors SET last_checked=?, updated=? WHERE id=?", (now, now, author_id))
    if new_books:
        db.log_event("info", "author", f"Sync '{a["name"]}': {new_books} new books")
    return new_books


def sync_series(series_id):
    """Re-sync a series: mark new volumes as wanted."""
    s = db.q1("SELECT * FROM series WHERE id=?", (series_id,))
    if not s:
        return 0
    # search via Open Library series search
    try:
        results = metadata.search_books(f"series:{s['name']}", limit=30)
    except Exception:
        results = []
    new_books = 0
    now = db.now()
    for r in results:
        if s["name"].lower() not in (r.get("title") or "").lower() and s["name"].lower() not in (r.get("series") or "").lower():
            pass
        norm = db.norm_title(r["title"])
        existing = db.q1("SELECT id FROM books WHERE series_id=? AND norm_title=?", (series_id, norm))
        if existing:
            continue
        try:
            db.ex(
                "INSERT OR IGNORE INTO books(title, norm_title, author_id, series_id, language, "
                "publish_date, isbn, ol_work_key, cover_url, status, wanted, source, added, updated) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (r["title"], norm, s["author_id"], series_id, "", f"{r['year']}-01-01" if r["year"] else "",
                 r.get("isbn", ""), r["ol_work_key"], r.get("cover", ""), "wanted", 1, "ol", now, now))
            new_books += 1
            bid = db.q1("SELECT id FROM books WHERE series_id=? AND norm_title=?", (series_id, norm))["id"]
            _set_wanted(bid)
        except Exception:
            pass
    db.ex("UPDATE series SET last_checked=?, updated=? WHERE id=?", (now, now, series_id))
    if new_books:
        db.log_event("info", "series", f"Series sync '{s["name"]}': {new_books} new volumes")
    return new_books


# ---------------- Wanted ----------------

def _set_wanted(book_id, interval_hours=None):
    now = db.now()
    iv = interval_hours or int(db.get_setting("wanted_interval", "24"))
    db.ex("INSERT INTO wanted(book_id, status, interval_hours, added) VALUES(?,?,?,?) "
          "ON CONFLICT(book_id) DO UPDATE SET status='wanted'",
          (book_id, "wanted", iv, now))
    db.ex("UPDATE books SET wanted=1, status='wanted', updated=? WHERE id=?", (now, book_id))


def set_book_wanted(book_id, wanted, interval_hours=None):
    if wanted:
        _set_wanted(book_id, interval_hours)
    else:
        db.ex("DELETE FROM wanted WHERE book_id=?", (book_id,))
        # Status konsistent zur Datei-Lage: have nur bei echter Datei, sonst missing
        b = db.q1("SELECT file_path FROM books WHERE id=?", (book_id,))
        new_status = "have" if (b and b["file_path"]) else "missing"
        db.ex("UPDATE books SET wanted=0, status=?, updated=? WHERE id=?",
              (new_status, db.now(), book_id))


def wanted_books():
    return db.q("""SELECT b.*, a.name AS author_name, w.interval_hours, w.last_search, w.status AS w_status
                   FROM wanted w JOIN books b ON b.id=w.book_id
                   LEFT JOIN authors a ON a.id=b.author_id
                   WHERE w.status IN ('wanted','searching','found','failed')
                   ORDER BY b.publish_date""")


def mark_wanted_failed(book_id, msg=""):
    db.ex("UPDATE wanted SET status='failed', last_search=? WHERE book_id=?",
          (db.now(), book_id))
    db.ex("UPDATE books SET status='missing', updated=? WHERE id=?", (db.now(), book_id))
    db.log_event("warn", "wanted", f"Search failed: {msg}")


# ---------------- search & download ----------------

def search_downloads(book):
    """Search NZB and IRC sources for a book."""
    title = book["title"]
    author = db.q1("SELECT name FROM authors WHERE id=?", (book["author_id"],)) if book["author_id"] else None
    query = f"{title} {author['name'] if author else ''}".strip()
    results = []
    try:
        results += indexers.search_all_indexers(query)
    except Exception as e:
        db.log_event("error", "newznab", f"NZB search failed: {e}")
    try:
        results += irc_mod.search_irc(title)
    except Exception as e:
        db.log_event("error", "irc", f"IRC search failed: {e}")
    return results


def start_download(book, result):
    """Start a download for a book. result: a search hit."""
    now = db.now()
    if result["source"] == "irc":
        sources = [{"bot": result["bot"], "title": result["title"], "size": result.get("size", "")}]
        dl_id = db.ex("INSERT INTO downloads(book_id, title, source, irc_user, filename, status, "
                      "message, added, updated) VALUES(?,?,?,?,?,?,?,?,?)",
                      (book["id"], book["title"], "irc", result["bot"], result["title"],
                       "downloading", "IRC download started", now, now))
        threading.Thread(target=_irc_download_worker, args=(dl_id, book["id"], sources), daemon=True).start()
        return dl_id

    # Newznab → SABnzbd
    ok, nzo_id = indexers.sabnzbd_add_nzb(result["url"], result["title"])
    if not ok:
        db.ex("INSERT INTO downloads(book_id, title, source, status, message, added, updated) "
              "VALUES(?,?,?,?,?,?,?)",
              (book["id"], book["title"], "newznab", "failed", f"SABnzbd: {nzo_id}", now, now))
        db.log_event("error", "download", f"SABnzbd lehnt NZB ab: {nzo_id}")
        return None
    dl_id = db.ex("INSERT INTO downloads(book_id, title, source, nzb_url, status, message, added, updated) "
                  "VALUES(?,?,?,?,?,?,?,?)",
                  (book["id"], book["title"], "newznab", str(nzo_id or ""), "snatched",
                   f"SABnzbd: {result['title']}", now, now))
    # Status setzen
    db.ex("UPDATE books SET status='snatched', updated=? WHERE id=?", (now, book["id"]))
    db.ex("UPDATE wanted SET status='snatched' WHERE book_id=?", (book["id"],))
    db.log_event("success", "download", f"NZB for '{book["title"]}' handed to SABnzbd")
    threading.Thread(target=_nzb_completion_worker, args=(dl_id, book["id"], err if not ok else ""), daemon=True).start()
    return dl_id


def _nzb_completion_worker(dl_id, book_id, _unused=""):
    """Pollt SABnzbd-History bis der NZB-Download fertig ist, dann Post-Processing."""
    dl = db.q1("SELECT * FROM downloads WHERE id=?", (dl_id,))
    if not dl:
        return
    nzo_id = dl["nzb_url"] or ""
    completed = False
    failed = False
    fail_msg = ""
    folder = ""
    try:
        for _ in range(240):  # max ~2h
            time.sleep(15)
            hist = indexers.sabnzbd_history(limit=50)
            for h in hist:
                if nzo_id and h.get("nzo_id") != nzo_id:
                    continue
                status = h.get("status", "")
                if status in ("Completed", "Failed"):
                    completed = True
                    failed = status == "Failed"
                    fail_msg = h.get("fail_message", "") or ""
                    folder = h.get("path") or h.get("download_dir") or ""
                    break
            if completed:
                break
            dl = db.q1("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not dl:
                return
    except Exception as e:
        db.log_event("error", "download", f"NZB watch aborted: {e}")
    if not completed:
        return
    if failed:
        _post_process(dl_id, book_id, "", True, fail_msg)
        return
    # Kandidatenordner: History-Pfad, complete_dir, sortierter Fertigordner
    folders = [folder] if folder else []
    complete_dir = _sab_complete_dir()
    if complete_dir:
        folders.append(complete_dir)
    sorted_dir = db.get_setting("sabnzbd_sorted_dir", "")
    if sorted_dir:
        folders.append(sorted_dir)
    for f in folders:
        if f and os.path.isdir(f):
            found = _post_process(dl_id, book_id, f, False, "")
            if found:
                return
    # letzter Versuch: kompletten sortierten Ordner durchsuchen
    if sorted_dir and os.path.isdir(sorted_dir):
        _post_process(dl_id, book_id, sorted_dir, False, "")


def _irc_download_worker(dl_id, book_id, sources):
    dl = db.q1("SELECT * FROM downloads WHERE id=?", (dl_id,))
    if not dl:
        return
    dest = os.path.join(db.get_setting("download_dir", "/opt/bookarr/downloads"), f"dl{dl_id}")
    ok, path, err = irc_mod.download_irc(sources, dest)
    if not ok:
        db.ex("UPDATE downloads SET status='failed', message=?, updated=?, completed=? WHERE id=?",
              (err or "IRC error", db.now(), db.now(), dl_id))
        db.ex("UPDATE books SET status='missing' WHERE id=?", (book_id,))
        db.log_event("error", "download", f"IRC download failed: {err}")
        return
    _post_process(dl_id, book_id, os.path.dirname(path), False, "", path)


def _sab_complete_dir():
    """Liest das complete_dir aus der SABnzbd-INI."""
    try:
        for ini in ("/home/sabnzbd/.sabnzbd/sabnzbd.ini", "/opt/sabnzbd/sabnzbd.ini"):
            if os.path.exists(ini):
                for line in open(ini, encoding="utf-8", errors="replace"):
                    if line.startswith("complete_dir"):
                        return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def _post_process(dl_id, book_id, folder, failed, fail_msg="", single_file=None):
    """Datei importieren, optional konvertieren, Buch als 'have' markieren.
    Returns True if a book was imported."""
    book = db.q1("SELECT * FROM books WHERE id=?", (book_id,))
    if not book:
        return False
    if failed:
        db.ex("UPDATE downloads SET status='failed', message=?, updated=?, completed=? WHERE id=?",
              (fail_msg or "Download failed", db.now(), db.now(), dl_id))
        db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (book_id,))
        db.log_event("warn", "download", f"Download failed: {fail_msg}")
        return False
    # Buchdatei finden
    path = single_file
    if not path and folder and os.path.isdir(folder):
        path = _find_book_file(folder, book)
    if not path:
        return False
    lib_dir = db.get_setting("library_dir", "/opt/bookarr/books")
    author_name = db.q1("SELECT name FROM authors WHERE id=?", (book["author_id"],)) if book["author_id"] else None
    author_name = (author_name or {}).get("name", "Unbekannt")
    dest_dir = os.path.join(lib_dir, _safe(author_name))
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, _safe(book["title"]) + os.path.splitext(path)[1])
    shutil.move(path, dest_path)

    final_path = dest_path
    # Konvertierung
    if db.get_setting("convert_enabled", "1") == "1":
        final_path = convert_book(dest_path, book_id)
    db.ex("UPDATE books SET status='have', wanted=0, file_path=?, format=?, updated=? WHERE id=?",
          (final_path, os.path.splitext(final_path)[1].lstrip("."), db.now(), book_id))
    db.ex("DELETE FROM wanted WHERE book_id=?", (book_id,))
    db.ex("UPDATE downloads SET status='completed', message='Importiert', progress=100, updated=?, completed=? WHERE id=?",
          (db.now(), db.now(), dl_id))
    db.log_event("success", "import", f"'{book["title"]}' imported to {final_path}")
    return True


_BOOK_EXTS = {".epub", ".mobi", ".azw", ".azw3", ".pdf", ".djvu", ".txt", ".fb2", ".cbr", ".cbz", ".lit", ".rtf", ".html", ".doc", ".docx"}


def _find_book_file(folder, book):
    for root, _dirs, files in os.walk(folder):
        for f in files:
            if os.path.splitext(f)[1].lower() in _BOOK_EXTS:
                full = os.path.join(root, f)
                if _file_matches(f, book["title"]):
                    return full
    # fallback: largest book file
    best, best_size = None, 0
    for root, _dirs, files in os.walk(folder):
        for f in files:
            if os.path.splitext(f)[1].lower() in _BOOK_EXTS:
                full = os.path.join(root, f)
                if os.path.getsize(full) > best_size:
                    best, best_size = full, os.path.getsize(full)
    return best


def _file_matches(filename, title):
    f = db.norm_title(os.path.splitext(filename)[0])
    t = db.norm_title(title)
    if not t:
        return False
    return t in f or f in t or _ratio(f, t) > 0.6


def _ratio(a, b):
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def _safe(name):
    return re.sub(r"[\\/:*?\"<>|]+", "_", name).strip() or "Unbekannt"


def convert_book(path, book_id=None, target_format=None):
    """Konvertierung mit Calibre ebook-convert."""
    import convert
    fmt = target_format or db.get_setting("convert_format", "epub")
    return convert.convert(path, fmt, book_id)


# Bibliotheks-Scan: bereits vorhandene Dateien in library_dir erkennen
def scan_library():
    lib_dir = db.get_setting("library_dir", "/opt/bookarr/books")
    found = 0
    for root, _dirs, files in os.walk(lib_dir):
        for f in files:
            if os.path.splitext(f)[1].lower() not in _BOOK_EXTS:
                continue
            title = os.path.splitext(f)[0]
            norm = db.norm_title(title)
            b = db.q1("SELECT id FROM books WHERE norm_title=? AND status!='have'", (norm,))
            if b:
                db.ex("UPDATE books SET status='have', wanted=0, file_path=?, format=?, updated=? WHERE id=?",
                      (os.path.join(root, f), os.path.splitext(f)[1].lstrip("."), db.now(), b["id"]))
                db.ex("DELETE FROM wanted WHERE book_id=?", (b["id"],))
                found += 1
    if found:
        db.log_event("success", "library", f"Scan: {found} books found in the library")
    return found
