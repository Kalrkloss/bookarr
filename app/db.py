"""Bookarr — database (SQLite, WAL)."""
import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("BOOKARR_DB", "/opt/bookarr/data/bookarr.db")

_lock = threading.Lock()
_conn = None


def connect():
    global _conn
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _init_schema()
    _ensure_columns()
    _seed_defaults()


def _ensure_columns():
    """Idempotent ALTERs for schema evolution on existing databases."""
    cols = {r["name"] for r in _conn.execute("PRAGMA table_info(authors)")}
    if "image_url" not in cols:
        _conn.execute("ALTER TABLE authors ADD COLUMN image_url TEXT DEFAULT ''")
        _conn.commit()


def _init_schema():
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS authors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sort_name TEXT,
            ol_key TEXT,
            wikipedia_url TEXT,
            website TEXT,
            birth_date TEXT,
            death_date TEXT,
            bio TEXT,
            image_url TEXT DEFAULT '',
            languages TEXT DEFAULT '["de","en"]',
            monitor INTEGER DEFAULT 0,
            interval_hours INTEGER DEFAULT 168,
            last_checked TEXT,
            added TEXT,
            updated TEXT
        );
        CREATE TABLE IF NOT EXISTS series (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            author_id INTEGER,
            ol_key TEXT,
            monitor INTEGER DEFAULT 0,
            interval_hours INTEGER DEFAULT 168,
            last_checked TEXT,
            added TEXT,
            updated TEXT,
            FOREIGN KEY(author_id) REFERENCES authors(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            norm_title TEXT NOT NULL,
            author_id INTEGER,
            series_id INTEGER,
            series_number TEXT,
            language TEXT DEFAULT '',
            publish_date TEXT,
            isbn TEXT,
            ol_work_key TEXT,
            ol_edition_key TEXT,
            description TEXT,
            cover_url TEXT,
            status TEXT DEFAULT 'wanted',
            format TEXT,
            file_path TEXT,
            wanted INTEGER DEFAULT 0,
            source TEXT DEFAULT 'ol',
            added TEXT,
            updated TEXT,
            FOREIGN KEY(author_id) REFERENCES authors(id) ON DELETE CASCADE,
            FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE SET NULL,
            UNIQUE(author_id, norm_title)
        );
        CREATE TABLE IF NOT EXISTS wanted (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL UNIQUE,
            status TEXT DEFAULT 'wanted',
            interval_hours INTEGER DEFAULT 24,
            last_search TEXT,
            added TEXT,
            FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER,
            title TEXT,
            source TEXT,
            nzb_url TEXT,
            irc_user TEXT,
            filename TEXT,
            status TEXT DEFAULT 'queued',
            progress REAL DEFAULT 0,
            size REAL DEFAULT 0,
            message TEXT,
            added TEXT,
            updated TEXT,
            completed TEXT,
            FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            level TEXT DEFAULT 'info',
            source TEXT,
            message TEXT,
            time TEXT
        );
        CREATE TABLE IF NOT EXISTS indexers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            url TEXT,
            api_key TEXT,
            categories TEXT DEFAULT '7000,7020',
            enabled INTEGER DEFAULT 1,
            priority INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS searchcache (
            book_id INTEGER PRIMARY KEY,
            results TEXT,
            created TEXT
        );
        """
    )
    _conn.commit()


def _seed_defaults():
    defaults = {
        "sabnzbd_url": "http://127.0.0.1:8081",
        "sabnzbd_key": "",
        "sabnzbd_category": "ebook",
        "sabnzbd_sorted_dir": "",
        "prowlarr_url": "http://127.0.0.1:9696",
        "prowlarr_key": "",
        "prowlarr_categories": "7000,7020",
        "irc_server": "irc.irchighway.net:6697",
        "irc_ssl": "1",
        "irc_channel": "#ebooks",
        "irc_botnick": "BookarrBot",
        "irc_search_pattern": "!search {title}",
        "google_books_key": "",
        "download_dir": "/opt/bookarr/downloads",
        "library_dir": "/opt/bookarr/books",
        "convert_enabled": "1",
        "convert_format": "epub",
        "wanted_interval": "24",
        "monitor_interval": "168",
        "wanted_search_enabled": "1",
        "max_irc_bots": "4",
        "irc_dl_timeout": "480",
    }
    for k, v in defaults.items():
        _conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (k, v))
    _conn.commit()


# ---------- generic helpers ----------

def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def q(sql, params=()):
    with _lock:
        cur = _conn.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def q1(sql, params=()):
    with _lock:
        cur = _conn.execute(sql, params)
        r = cur.fetchone()
        return dict(r) if r else None


def ex(sql, params=()):
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        return cur.lastrowid


def get_setting(key, default=None):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    return r["value"] if r else default


def set_setting(key, value):
    ex("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, str(value)))


def get_settings():
    return {r["key"]: r["value"] for r in q("SELECT key, value FROM settings")}


def put_settings(d):
    for k, v in d.items():
        set_setting(k, v)


def log_event(level, source, message):
    ex("INSERT INTO events(level, source, message, time) VALUES(?,?,?,?)",
       (level, source, message, now()))
    if level in ("warn", "error"):
        # keep only the last 500 events
        ex("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)")


def parse_langs(s):
    try:
        v = json.loads(s) if s else []
        return [x for x in v if x] or ["de", "en"]
    except Exception:
        return ["de", "en"]


def norm_title(t):
    import re
    t = (t or "").lower()
    t = re.sub(r"[^\w\s]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ISO 639-2 (Open Library) → ISO 639-1
_LANG_MAP = {
    "ger": "de", "eng": "en", "fre": "fr", "spa": "es", "ita": "it", "dut": "nl",
    "por": "pt", "rus": "ru", "pol": "pl", "heb": "he", "chi": "zh", "jpn": "ja",
    "kor": "ko", "swe": "sv", "dan": "da", "nor": "no", "fin": "fi", "tur": "tr",
    "ara": "ar", "ukr": "uk", "hun": "hu", "ces": "cs", "cat": "ca", "srp": "sr",
    "bel": "be", "bul": "bg", "gre": "el", "rum": "ro", "slo": "sk", "slv": "sl",
    "hrv": "hr", "lit": "lt", "lav": "lv", "est": "et", "tha": "th", "vie": "vi",
    "hin": "hi", "ben": "bn", "tam": "ta", "tel": "te", "mar": "mr", "urd": "ur",
    "fas": "fa", "ind": "id", "may": "ms", "gle": "ga", "wel": "cy", "ice": "is",
    "alb": "sq", "mkd": "mk", "geo": "ka", "arm": "hy", "aze": "az", "kaz": "kk",
    "uzb": "uz", "mon": "mn", "lat": "la", "und": "", "mul": "", "zxx": "",
}


def lang_code(code):
    """Normalize Open Library language codes (ISO 639-2) to two-letter codes."""
    c = (code or "").strip().lower()
    if not c:
        return ""
    if len(c) == 2:
        return c
    return _LANG_MAP.get(c, c)


def json_dump(o):
    return json.dumps(o, ensure_ascii=False)
