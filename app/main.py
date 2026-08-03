"""Bookarr — FastAPI-Anwendung (API + statisches Frontend)."""
import logging
import os
import threading
import traceback
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import indexers
import irc as irc_mod
import library
import metadata
import scheduler

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
BASE_DIR = Path(__file__).resolve().parent.parent

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bookarr")


@asynccontextmanager
async def lifespan(_app):
    db.connect()
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="Bookarr", version="1.0.0", lifespan=lifespan)


# ---------------- static frontend ----------------

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------- status / overview ----------------

@app.get("/api/status")
def api_status():
    counts = {
        "authors": db.q1("SELECT COUNT(*) c FROM authors")["c"],
        "books": db.q1("SELECT COUNT(*) c FROM books")["c"],
        "have": db.q1("SELECT COUNT(*) c FROM books WHERE status='have'")["c"],
        "missing": db.q1("SELECT COUNT(*) c FROM books WHERE status='missing'")["c"],
        "wanted": db.q1("SELECT COUNT(*) c FROM wanted WHERE status='wanted'")["c"],
        "series": db.q1("SELECT COUNT(*) c FROM series")["c"],
        "active_downloads": db.q1("SELECT COUNT(*) c FROM downloads WHERE status IN ('queued','snatched','downloading')")["c"],
    }
    return {
        "version": "1.0.0",
        "counts": counts,
        "scheduler": scheduler.state(),
        "connectivity": {
            "prowlarr": indexers.prowlarr_available() and _probe_prowlarr(),
            "sabnzbd": indexers.sabnzbd_available() and indexers.sabnzbd_test(),
            "irc": irc_mod.irc_configured(),
            "convert": _convert_available(),
        },
    }


def _probe_prowlarr():
    from urllib.parse import urljoin
    try:
        import requests
        cfg = indexers._prowlarr_config()
        r = requests.get(f"{cfg['url']}/api/v1/system/status",
                         headers={"X-Api-Key": cfg["key"]}, timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _convert_available():
    try:
        import convert
        return convert.available()
    except Exception:
        return False


@app.get("/api/overview")
def api_overview():
    wanted = db.q("""SELECT b.id, b.title, b.publish_date, b.language, b.cover_url,
                            a.name AS author_name, w.interval_hours, w.last_search
                     FROM wanted w JOIN books b ON b.id=w.book_id
                     LEFT JOIN authors a ON a.id=b.author_id
                     WHERE w.status='wanted' ORDER BY b.publish_date LIMIT 50""")
    active = db.q("""SELECT * FROM downloads WHERE status IN ('queued','snatched','downloading')
                     ORDER BY id DESC LIMIT 20""")
    for d in active:
        book = db.q1("SELECT title FROM books WHERE id=?", (d["book_id"],)) if d["book_id"] else None
        d["book_title"] = book["title"] if book else d["title"]
    events = db.q("SELECT * FROM events ORDER BY id DESC LIMIT 25")
    sab = indexers.sabnzbd_queue()
    return {"wanted": wanted, "active": active, "events": events, "sab_queue": sab}


# ---------------- authors ----------------

class AuthorAdd(BaseModel):
    ol_key: str
    languages: list = ["de", "en"]


@app.post("/api/authors")
def api_add_author(body: AuthorAdd):
    try:
        aid = library.add_author(body.ol_key, body.languages)
        return {"ok": True, "id": aid}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/authors")
def api_authors(q: str = "", limit: int = 200):
    if q:
        rows = db.q("""SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.author_id=a.id) book_count,
                       (SELECT COUNT(*) FROM wanted w JOIN books b ON b.id=w.book_id WHERE b.author_id=a.id) wanted_count
                       FROM authors a WHERE a.name LIKE ? ORDER BY a.sort_name LIMIT ?""",
                    (f"%{q}%", limit))
    else:
        rows = db.q("""SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.author_id=a.id) book_count,
                       (SELECT COUNT(*) FROM wanted w JOIN books b ON b.id=w.book_id WHERE b.author_id=a.id) wanted_count
                       FROM authors a ORDER BY a.sort_name LIMIT ?""", (limit,))
    for r in rows:
        r["languages"] = db.parse_langs(r["languages"])
    return rows


@app.get("/api/authors/{aid}")
def api_author_detail(aid: int, lang: str = ""):
    a = db.q1("SELECT * FROM authors WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404, "Author not found")
    a["languages"] = db.parse_langs(a["languages"])
    book_filter = "author_id=?"
    params = [aid]
    if lang:
        book_filter += " AND language=?"
        params.append(lang)
    books = db.q(f"""SELECT * FROM books WHERE {book_filter}
                     ORDER BY publish_date, title""", params)
    series = db.q("""SELECT s.*, (SELECT COUNT(*) FROM books b WHERE b.series_id=s.id) book_count,
                     (SELECT COUNT(*) FROM wanted w JOIN books b ON b.id=w.book_id WHERE b.series_id=s.id) wanted_count
                     FROM series s WHERE s.author_id=? ORDER BY s.name""", (aid,))
    for s in series:
        if lang:
            s["books"] = db.q("SELECT * FROM books WHERE series_id=? AND language=? ORDER BY series_number, publish_date",
                              (s["id"], lang))
        else:
            s["books"] = db.q("SELECT * FROM books WHERE series_id=? ORDER BY series_number, publish_date", (s["id"],))
    langs = db.q("SELECT DISTINCT language FROM books WHERE author_id=? AND language!='' ORDER BY language", (aid,))
    return {"author": a, "books": books, "series": series, "languages": [r["language"] for r in langs]}


class AuthorPatch(BaseModel):
    monitor: int = None
    interval_hours: int = None
    languages: list = None
    website: str = None


@app.patch("/api/authors/{aid}")
def api_patch_author(aid: int, body: AuthorPatch):
    a = db.q1("SELECT id FROM authors WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404, "Author not found")
    if body.monitor is not None:
        db.ex("UPDATE authors SET monitor=?, updated=? WHERE id=?", (1 if body.monitor else 0, db.now(), aid))
    if body.interval_hours:
        db.ex("UPDATE authors SET interval_hours=?, updated=? WHERE id=?", (body.interval_hours, db.now(), aid))
    if body.languages is not None:
        db.ex("UPDATE authors SET languages=?, updated=? WHERE id=?", (db.json_dump(body.languages), db.now(), aid))
    if body.website is not None:
        db.ex("UPDATE authors SET website=?, updated=? WHERE id=?", (body.website, db.now(), aid))
    return {"ok": True}


@app.post("/api/authors/{aid}/sync")
def api_sync_author(aid: int):
    def _run():
        try:
            library.sync_author(aid)
        except Exception as e:
            db.log_event("error", "author", f"Sync failed: {e}")
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "Sync started"}


@app.post("/api/authors/{aid}/wikipedia-scan")
def api_wikipedia_scan(aid: int):
    a = db.q1("SELECT * FROM authors WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404)
    works = []
    if a["wikipedia_url"]:
        m = re_match_lang(a["wikipedia_url"])
        lang = m or "de"
        works = metadata.wikipedia_author_works(a["name"], lang)
    # also try the standard language versions
    if not works:
        for lang in ("de", "en"):
            works = metadata.wikipedia_author_works(a["name"], lang)
            if works:
                break
    added = 0
    for w in works:
        norm = db.norm_title(w["title"])
        existing = db.q1("SELECT id FROM books WHERE author_id=? AND norm_title=?", (aid, norm))
        if existing:
            continue
        want = library._should_want(aid, "")
        db.ex("INSERT OR IGNORE INTO books(title, norm_title, author_id, language, publish_date, "
              "description, status, wanted, source, added, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              (w["title"], norm, aid, "", f"{w['year']}-01-01" if w["year"] else "",
               f"Quelle: Wikipedia", "wanted" if want else "missing", 1 if want else 0, "wikipedia",
               db.now(), db.now()))
        added += 1
    db.log_event("success", "wikipedia", f"Wikipedia scan '{a["name"]}': {added} new books")
    return {"ok": True, "added": added, "found": len(works)}


def re_match_lang(url):
    import re
    m = re.search(r"//([a-z]{2})\.wikipedia\.org", url or "")
    return m.group(1) if m else None


@app.delete("/api/authors/{aid}")
def api_delete_author(aid: int):
    db.ex("DELETE FROM authors WHERE id=?", (aid,))
    db.log_event("info", "author", f"Author {aid} deleted")
    return {"ok": True}


# ---------------- series ----------------

class SeriesPatch(BaseModel):
    monitor: int = None
    interval_hours: int = None


@app.patch("/api/series/{sid}")
def api_patch_series(sid: int, body: SeriesPatch):
    if body.monitor is not None:
        db.ex("UPDATE series SET monitor=?, updated=? WHERE id=?", (1 if body.monitor else 0, db.now(), sid))
    if body.interval_hours:
        db.ex("UPDATE series SET interval_hours=?, updated=? WHERE id=?", (body.interval_hours, db.now(), sid))
    return {"ok": True}


@app.post("/api/series/{sid}/sync")
def api_sync_series(sid: int):
    threading.Thread(target=lambda: _safe(lambda: library.sync_series(sid),
                                          "series", "Series sync failed"), daemon=True).start()
    return {"ok": True}


@app.delete("/api/series/{sid}")
def api_delete_series(sid: int):
    db.ex("UPDATE books SET series_id=NULL WHERE series_id=?", (sid,))
    db.ex("DELETE FROM series WHERE id=?", (sid,))
    return {"ok": True}


def _safe(fn, src, msg):
    try:
        fn()
    except Exception as e:
        db.log_event("error", src, f"{msg}: {e}")


# ---------------- books ----------------

@app.get("/api/books")
def api_books(q: str = "", status: str = "", author_id: int = 0, language: str = "",
              series_id: int = 0, limit: int = 300, offset: int = 0):
    conds, params = [], []
    if q:
        conds.append("(b.title LIKE ? OR a.name LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if status:
        conds.append("b.status=?")
        params.append(status)
    if author_id:
        conds.append("b.author_id=?")
        params.append(author_id)
    if language:
        conds.append("b.language=?")
        params.append(language)
    if series_id:
        conds.append("b.series_id=?")
        params.append(series_id)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    rows = db.q(f"""SELECT b.*, a.name AS author_name, s.name AS series_name
                    FROM books b LEFT JOIN authors a ON a.id=b.author_id
                    LEFT JOIN series s ON s.id=b.series_id {where}
                    ORDER BY b.publish_date DESC, b.title LIMIT ? OFFSET ?""",
                params + [limit, offset])
    return rows


@app.get("/api/books/{bid}")
def api_book_detail(bid: int):
    b = db.q1("""SELECT b.*, a.name AS author_name, s.name AS series_name
                 FROM books b LEFT JOIN authors a ON a.id=b.author_id
                 LEFT JOIN series s ON s.id=b.series_id WHERE b.id=?""", (bid,))
    if not b:
        raise HTTPException(404, "Book not found")
    return b


# formats the browser can display inline (pdf/txt/html native, epub via epub.js)
_VIEW_MIMES = {
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
}


@app.get("/api/books/{bid}/file")
def api_book_file(bid: int):
    """Serve the book file. Inline for viewable formats (pdf/epub/txt/html),
    attachment otherwise. Supports Range requests (streaming)."""
    b = db.q1("SELECT file_path FROM books WHERE id=?", (bid,))
    if not b or not b["file_path"]:
        raise HTTPException(404, "No file for this book")
    path = b["file_path"]
    if not os.path.exists(path):
        raise HTTPException(404, "File not found on disk")
    ext = os.path.splitext(path)[1].lower()
    mime = _VIEW_MIMES.get(ext, "application/octet-stream")
    inline = ext in _VIEW_MIMES
    return FileResponse(path, media_type=mime, filename=os.path.basename(path),
                        content_disposition_type="inline" if inline else "attachment")


class BookPatch(BaseModel):
    status: str = None
    wanted: int = None
    language: str = None
    interval_hours: int = None


class BookAdd(BaseModel):
    title: str
    author_name: str = ""
    ol_work_key: str = ""
    ol_author_key: str = ""
    isbn: str = ""
    year: str = ""
    language: str = ""
    cover: str = ""
    wanted: int = 1


@app.post("/api/books")
def api_add_book(body: BookAdd):
    """Buch aus einer Suche zur Bibliothek hinzufügen (legt ggf. Autor an)."""
    author_id = None
    if body.author_name:
        r = db.q1("SELECT id FROM authors WHERE name=? OR sort_name=?", (body.author_name, body.author_name))
        if r:
            author_id = r["id"]
        else:
            now = db.now()
            detail = None
            if body.ol_author_key:
                try:
                    detail = metadata.author_detail(body.ol_author_key)
                except Exception:
                    detail = None
            author_id = db.ex(
                "INSERT INTO authors(name, sort_name, ol_key, languages, added, updated) VALUES(?,?,?,?,?,?)",
                (body.author_name, library._sort_name(body.author_name),
                 body.ol_author_key or "", db.json_dump(["de", "en"]), now, now))
            if detail:
                db.ex("UPDATE authors SET wikipedia_url=?, website=?, birth_date=?, death_date=?, bio=? WHERE id=?",
                      (detail.get("wikipedia_url", ""), detail.get("website", ""), detail.get("birth_date", ""),
                       detail.get("death_date", ""), detail.get("bio", ""), author_id))
    norm = db.norm_title(body.title)
    existing = db.q1("SELECT id FROM books WHERE author_id=? AND norm_title=?", (author_id, norm))
    if existing:
        return {"ok": True, "id": existing["id"], "duplicate": True}
    now = db.now()
    language = db.lang_code(body.language)
    if not language and body.ol_work_key:
        # pull the original language from the work's editions
        language = db.lang_code(metadata.best_work_language(body.ol_work_key))
    bid = db.ex(
        "INSERT INTO books(title, norm_title, author_id, language, publish_date, isbn, ol_work_key, "
        "cover_url, status, wanted, source, added, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (body.title, norm, author_id, language,
         f"{body.year}-01-01" if body.year else "", body.isbn, body.ol_work_key,
         body.cover, "wanted" if body.wanted else "missing", 1 if body.wanted else 0,
         "ol", now, now))
    if body.wanted:
        library._set_wanted(bid)
    db.log_event("success", "library", f"Book '{body.title}' added")
    return {"ok": True, "id": bid, "duplicate": False}


@app.patch("/api/books/{bid}")
def api_patch_book(bid: int, body: BookPatch):
    b = db.q1("SELECT id FROM books WHERE id=?", (bid,))
    if not b:
        raise HTTPException(404, "Book not found")
    if body.wanted is not None:
        library.set_book_wanted(bid, bool(body.wanted), body.interval_hours)
    if body.status:
        db.ex("UPDATE books SET status=?, updated=? WHERE id=?", (body.status, db.now(), bid))
        if body.status == "have":
            db.ex("DELETE FROM wanted WHERE book_id=?", (bid,))
    if body.language is not None:
        db.ex("UPDATE books SET language=?, updated=? WHERE id=?", (body.language, db.now(), bid))
    cur = db.q1("SELECT status, wanted FROM books WHERE id=?", (bid,))
    return {"ok": True, "status": cur["status"], "wanted": cur["wanted"]}


@app.post("/api/books/{bid}/convert")
def api_convert_book(bid: int):
    b = db.q1("SELECT * FROM books WHERE id=?", (bid,))
    if not b or not b["file_path"]:
        raise HTTPException(400, "No book available")
    def _run():
        try:
            library.convert_book(b["file_path"], bid)
        except Exception as e:
            db.log_event("error", "convert", str(e))
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "Konvertierung gestartet"}


@app.delete("/api/books/{bid}")
def api_delete_book(bid: int):
    db.ex("DELETE FROM wanted WHERE book_id=?", (bid,))
    db.ex("DELETE FROM books WHERE id=?", (bid,))
    return {"ok": True}


# ---------------- metadata search ----------------

@app.get("/api/search/metadata")
def api_search_metadata(q: str = Query(..., min_length=2), type: str = "all"):
    out = {"authors": [], "books": [], "wikipedia": None}
    try:
        if type in ("all", "author"):
            out["authors"] = metadata.search_authors(q, 8)
            for a in out["authors"]:
                det = metadata.author_detail(a["ol_key"]) or {}
                a.update({k: det.get(k, "") for k in ("wikipedia_url", "website", "bio")})
        if type in ("all", "book"):
            out["books"] = metadata.search_books(q, 15)
        if type in ("all", "author"):
            try:
                out["wikipedia"] = metadata.wikipedia_author_works(q, "de")
            except Exception:
                out["wikipedia"] = []
    except Exception as e:
        raise HTTPException(502, f"Metadata search failed: {e}")
    return out


# is a source search already running for this book? (dedupe against thread explosion)
_search_running = {}  # book_id -> start timestamp (monotonic)
SEARCH_RUNNING_TIMEOUT = 1800  # 30 min: stale worker flag is reset automatically


@app.get("/api/search/downloads")
def api_search_downloads(book_id: int):
    import json as _json
    b = db.q1("SELECT * FROM books WHERE id=?", (book_id,))
    if not b:
        raise HTTPException(404)
    # fresh cache?
    cached = db.q1("SELECT results, created FROM searchcache WHERE book_id=?", (book_id,))
    if cached:
        try:
            import datetime
            created = datetime.datetime.strptime(cached["created"], "%Y-%m-%d %H:%M:%S")
            if (datetime.datetime.now() - created).total_seconds() < 600:
                return {"done": True, "cached": True, "results": _json.loads(cached["results"])}
        except Exception:
            pass
    # already running search for this book → return status only (frontend polls);
    # a stale flag (crashed worker) expires after SEARCH_RUNNING_TIMEOUT
    import time as _time
    ts = _search_running.get(book_id)
    if ts and _time.monotonic() - ts < SEARCH_RUNNING_TIMEOUT:
        return {"done": False, "running": True}

    _search_running[book_id] = _time.monotonic()

    def _worker():
        try:
            results = library.search_downloads(b)
            db.ex("INSERT OR REPLACE INTO searchcache(book_id, results, created) VALUES(?,?,?)",
                  (book_id, _json.dumps(results, ensure_ascii=False), db.now()))
            db.ex("UPDATE wanted SET status='wanted' WHERE book_id=?", (book_id,))
        except Exception as e:
            db.log_event("error", "search", str(e))
            db.ex("INSERT OR REPLACE INTO searchcache(book_id, results, created) VALUES(?,?,?)",
                  (book_id, "[]", db.now()))
        finally:
            _search_running.pop(book_id, None)

    threading.Thread(target=_worker, daemon=True).start()
    db.log_event("info", "search", f"Source search for '{b['title']}' started …")
    return {"done": False}


# ---------------- downloads ----------------

class DownloadStart(BaseModel):
    book_id: int
    source: str
    title: str = ""
    url: str = ""
    bot: str = ""
    size: str = ""


@app.post("/api/downloads")
def api_start_download(body: DownloadStart):
    b = db.q1("SELECT * FROM books WHERE id=?", (body.book_id,))
    if not b:
        raise HTTPException(404)
    result = {"source": body.source, "title": body.title or b["title"],
              "url": body.url, "bot": body.bot, "size": body.size}
    dl_id = library.start_download(b, result)
    if not dl_id:
        raise HTTPException(500, "Download could not be started")
    return {"ok": True, "id": dl_id}


@app.get("/api/downloads")
def api_downloads(limit: int = 100):
    rows = db.q("SELECT * FROM downloads ORDER BY id DESC LIMIT ?", (limit,))
    for d in rows:
        book = db.q1("SELECT title FROM books WHERE id=?", (d["book_id"],)) if d["book_id"] else None
        d["book_title"] = book["title"] if book else d["title"]
    return rows


@app.delete("/api/downloads/{did}")
def api_delete_download(did: int):
    db.ex("DELETE FROM downloads WHERE id=?", (did,))
    return {"ok": True}


# ---------------- wanted ----------------

@app.get("/api/wanted")
def api_wanted():
    return library.wanted_books()


@app.post("/api/wanted/search")
def api_wanted_search_now():
    scheduler.search_wanted_now()
    return {"ok": True, "message": "Wanted-Suche gestartet"}


# ---------------- events ----------------

@app.get("/api/events")
def api_events(limit: int = 100, level: str = ""):
    if level:
        return db.q("SELECT * FROM events WHERE level=? ORDER BY id DESC LIMIT ?", (level, limit))
    return db.q("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))


# ---------------- settings ----------------

@app.get("/api/settings")
def api_get_settings():
    s = db.get_settings()
    s["indexers"] = db.q("SELECT * FROM indexers ORDER BY priority DESC")
    return s


class SettingsPut(BaseModel):
    settings: dict
    indexers: list = None


@app.put("/api/settings")
def api_put_settings(body: SettingsPut):
    db.put_settings({k: v for k, v in body.settings.items() if k != "indexers"})
    if body.indexers is not None:
        db.ex("DELETE FROM indexers")
        for i in body.indexers:
            if i.get("name") and i.get("url"):
                db.ex("INSERT INTO indexers(name, url, api_key, categories, enabled, priority) "
                      "VALUES(?,?,?,?,?,?)",
                      (i["name"], i["url"], i.get("api_key", ""), i.get("categories", "7000,7020"),
                       1 if i.get("enabled") else 0, i.get("priority", 0)))
    db.log_event("info", "settings", "Settings saved")
    return {"ok": True}


@app.post("/api/settings/test")
def api_test_settings(body: dict):
    name = body.get("name", "")
    result = {"name": name, "ok": False, "message": ""}
    if name == "prowlarr":
        url = body.get("url", "").rstrip("/")
        key = body.get("key", "")
        try:
            import requests
            r = requests.get(f"{url}/api/v1/system/status",
                             headers={"X-Api-Key": key}, timeout=8)
            result["ok"] = r.status_code == 200
            result["message"] = "OK" if result["ok"] else f"HTTP {r.status_code}"
        except Exception as e:
            result["message"] = str(e)
    elif name == "sabnzbd":
        url = body.get("url", "").rstrip("/")
        key = body.get("key", "")
        try:
            import requests
            r = requests.get(f"{url}/api", params={"mode": "version", "apikey": key, "output": "json"}, timeout=8)
            result["ok"] = r.status_code == 200 and "version" in r.text
            result["message"] = "OK" if result["ok"] else "Invalid response"
        except Exception as e:
            result["message"] = str(e)
    elif name == "irc":
        host = body.get("server", "")
        result["ok"] = bool(host)
        result["message"] = "Server configured" if result["ok"] else "Kein Server angegeben"
    elif name == "google_books":
        key = body.get("key", "")
        result["ok"] = bool(key)
        result["message"] = "Key stored" if key else "Kein API-Key"
    return result


# ---------------- actions / system ----------------

@app.post("/api/actions/scan-library")
def api_scan_library():
    def _run():
        try:
            library.scan_library()
        except Exception as e:
            db.log_event("error", "library", str(e))
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "Scan started"}


@app.post("/api/actions/sync-all")
def api_sync_all():
    scheduler.sync_all_now()
    return {"ok": True, "message": "Sync started"}


@app.get("/api/system/logs")
def api_logs():
    import subprocess
    try:
        r = subprocess.run(["tail", "-100", "/opt/bookarr/data/bookarr.log"],
                           capture_output=True, text=True, timeout=5)
        return {"logs": r.stdout.splitlines()}
    except Exception as e:
        return {"logs": [f"Log unavailable: {e}"]}


@app.get("/api/health")
def api_health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8788)
