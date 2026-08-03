"""Bookarr — metadata sources: Open Library, Wikipedia, Google Books."""
import re
import time

import requests

UA = {"User-Agent": "Bookarr/1.0 (ebook manager; contact: local)"}
SESSION = requests.Session()
SESSION.headers.update(UA)

OL = "https://openlibrary.org"


def _get(url, params=None, timeout=15):
    try:
        r = SESSION.get(url, params=params, timeout=timeout)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        raise RuntimeError(f"Fehler bei {url}: {e}")
    return None


def _year(date_str):
    m = re.search(r"\d{4}", str(date_str or ""))
    return m.group(0) if m else None


# ---------------- Open Library ----------------

def search_authors(query, limit=10):
    data = _get(f"{OL}/search/authors.json", {"q": query, "limit": limit})
    out = []
    for d in (data or {}).get("docs", []):
        key = d.get("key", "")
        if key and not key.startswith("/"):
            key = "/authors/" + key
        out.append({
            "ol_key": key,
            "name": d.get("name", ""),
            "birth_date": d.get("birth_date", ""),
            "death_date": d.get("death_date", ""),
            "alternate_names": d.get("alternate_names", [])[:3],
        })
    return out


def author_detail(ol_key):
    d = _get(f"{OL}{ol_key}.json")
    if not d:
        return None
    links = d.get("links") or []
    wikipedia = ""
    website = ""
    for l in links:
        u = (l.get("url") or "")
        if "wikipedia" in u.lower() and not wikipedia:
            wikipedia = u
        elif not website and u.startswith("http"):
            website = u
    return {
        "name": d.get("name", ""),
        "birth_date": d.get("birth_date", ""),
        "death_date": d.get("death_date", ""),
        "bio": _bio_text(d.get("bio")),
        "wikipedia_url": wikipedia,
        "website": website,
        "ol_key": ol_key,
    }


def _bio_text(bio):
    if isinstance(bio, dict):
        return bio.get("value", "")
    return bio or ""


def author_works(ol_key, limit=300):
    """All works of an author incl. language, series, first publication year."""
    data = _get(f"{OL}{ol_key}/works.json", {"limit": limit, "offset": 0})
    works = []
    if not data:
        return works
    for w in data.get("entries", []):
        langs = []
        for l in w.get("languages", []):
            k = (l.get("key") or "").rsplit("/", 1)[-1]
            if k:
                langs.append(k)
        series = []
        for s in w.get("series", []):
            # Format 1: {"name": ..., "position": ...} | Format 2: {"series": {"key": ...}, "position": ...}
            if isinstance(s, dict):
                s_key = ""
                s_name = s.get("name", "")
                if not s_name and isinstance(s.get("series"), dict):
                    s_key = s["series"].get("key", "")
                    s_name = s.get("position", "") or ""
                    s_name = s_key  # resolve name later via /series/{key}.json
                    series.append({"ol_key": s_key, "name": s_name, "position": s.get("position", "")})
                    continue
                series.append({"ol_key": s_key, "name": s_name, "position": s.get("position", "")})
        works.append({
            "ol_work_key": w.get("key", ""),
            "title": w.get("title", ""),
            "subtitle": w.get("subtitle", ""),
            "first_publish_year": _year(w.get("first_publish_date") or w.get("created", {}).get("value")),
            "languages": langs,
            "series": series,
            "cover": _cover(w),
            "description": _bio_text(w.get("description")),
        })
    return works


def _cover(entry):
    if entry.get("covers"):
        cid = entry["covers"][0]
        return f"https://covers.openlibrary.org/b/id/{cid}-M.jpg"
    return ""


def work_editions(ol_work_key, limit=50):
    """Editions of a work with publish date, ISBN, language, cover."""
    data = _get(f"{OL}{ol_work_key}/editions.json", {"limit": limit})
    out = []
    for e in (data or {}).get("entries", []):
        isbns = [i for i in e.get("isbn_13", []) or [] if len(i) == 13]
        if not isbns:
            isbns = [i for i in e.get("isbn_10", []) or []]
        langs = [l.get("key", "").rsplit("/", 1)[-1] for l in e.get("languages", [])]
        out.append({
            "ol_edition_key": e.get("key", ""),
            "publish_date": e.get("publish_date", ""),
            "year": _year(e.get("publish_date")),
            "language": langs[0] if langs else "",
            "isbn": isbns[0] if isbns else "",
            "cover": _cover(e),
            "format": e.get("physical_format", ""),
        })
    return out


def search_books(query, limit=20):
    data = _get(f"{OL}/search.json", {"q": query, "limit": limit, "fields": "key,title,author_name,first_publish_year,language,isbn,cover_i"})
    out = []
    for d in (data or {}).get("docs", []):
        out.append({
            "ol_work_key": d.get("key", ""),
            "title": d.get("title", ""),
            "authors": d.get("author_name", [])[:3],
            "year": d.get("first_publish_year", ""),
            "languages": (d.get("language") or [])[:4],
            "isbn": (d.get("isbn") or [None])[0],
            "cover": f"https://covers.openlibrary.org/b/id/{d['cover_i']}-M.jpg" if d.get("cover_i") else "",
        })
    return out


def series_detail(series_key):
    d = _get(f"{OL}{series_key}.json")
    if not d:
        return None
    works = []
    for w in d.get("works", []):
        works.append({
            "ol_work_key": w.get("key", ""),
            "title": w.get("title", ""),
            "position": w.get("position", ""),
        })
    return {"name": d.get("name", ""), "ol_key": series_key, "works": works}


# ---------------- Wikipedia ----------------

SECTION_ALIASES = {
    "de": ["werke", "bibliografie", "bibliographie", "werkeverzeichnis", "bücher", "publikationen"],
    "en": ["bibliography", "works", "publications", "novels", "books"],
    "fr": ["bibliographie", "œuvres", "oeuvres"],
    "es": ["bibliografía", "obras"],
    "it": ["bibliografia", "opere"],
}


def wikipedia_author_works(name, lang="de", timeout=15):
    """Find the works section on the author's Wikipedia page and extract titles."""
    api = f"https://{lang}.wikipedia.org/w/api.php"
    try:
        r = SESSION.get(api, params={
            "action": "parse", "page": name, "prop": "sections", "format": "json",
            "redirects": 1,
        }, timeout=timeout)
        if r.status_code != 200:
            return []
        sections = (r.json().get("parse") or {}).get("sections", [])
    except Exception:
        return []
    aliases = SECTION_ALIASES.get(lang, SECTION_ALIASES["de"])
    target = None
    for s in sections:
        if s.get("line", "").strip().lower() in aliases:
            target = s.get("index")
            break
    if not target:
        return []
    try:
        r2 = SESSION.get(api, params={
            "action": "parse", "page": name, "section": target, "prop": "wikitext",
            "format": "json", "redirects": 1,
        }, timeout=timeout)
        wikitext = (r2.json().get("parse") or {}).get("wikitext", {}).get("*", "")
    except Exception:
        return []
    return _parse_works_wikitext(wikitext, lang)


def _parse_works_wikitext(wt, lang):
    """Heuristic: lines with [[Title]] (year) from works sections."""
    works = []
    seen = set()
    # year order (de: (2000), en: (2000); also "2000–2003")
    year_pat = r"\((\d{4})(?:\s*(?:–|-|/)\s*\d{4})?\)"
    for line in wt.splitlines():
        line = line.strip()
        if not line.startswith(("*", "#")):
            continue
        m = re.search(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", line)
        if not m:
            continue
        title = m.group(1).strip()
        title = re.sub(r"\s*\([^)]*\)\s*$", "", title)  # (novel) etc. at the end
        if not title or title.lower() in ("bild", "datei", "file"):
            continue
        year = None
        ym = re.search(year_pat, line)
        if ym:
            year = ym.group(1)
        else:
            ym2 = re.search(r"\b(19\d{2}|20\d{2})\b", line)
            if ym2:
                year = ym2.group(0)
        key = title.lower().strip()
        if key in seen or len(key) < 3:
            continue
        seen.add(key)
        works.append({"title": title, "year": year, "source": "wikipedia"})
    return works


# ---------------- Google Books (optional, braucht API-Key) ----------------

def google_books_author_works(author_name, api_key, limit=40, lang=""):
    if not api_key:
        return []
    try:
        q = f'inauthor:"{author_name}"'
        if lang:
            q += f"&langRestrict={lang}"
        r = SESSION.get("https://www.googleapis.com/books/v1/volumes",
                        params={"q": q, "maxResults": min(limit, 40), "key": api_key}, timeout=15)
        if r.status_code != 200:
            return []
        out = []
        for v in (r.json().get("items") or []):
            vi = v.get("volumeInfo", {})
            out.append({
                "title": vi.get("title", ""),
                "subtitle": vi.get("subtitle", ""),
                "year": _year(vi.get("publishedDate")),
                "publish_date": vi.get("publishedDate", ""),
                "language": vi.get("language", ""),
                "isbn": _gb_isbn(vi),
                "cover": (vi.get("imageLinks") or {}).get("thumbnail", ""),
                "series": vi.get("seriesInfo", {}).get("bookDisplayName", ""),
                "series_position": vi.get("seriesInfo", {}).get("shortSeriesBookTitle", ""),
            })
        return out
    except Exception:
        return []


def _gb_isbn(vi):
    for ident in vi.get("industryIdentifiers", []):
        if ident.get("type") == "ISBN_13":
            return ident.get("identifier")
    for ident in vi.get("industryIdentifiers", []):
        if ident.get("type") == "ISBN_10":
            return ident.get("identifier")
    return ""
