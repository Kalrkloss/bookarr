"""Bookarr — Indexer-Suche (Prowlarr/Newznab) und SABnzbd-Download."""
import json
import re
import urllib.parse

import requests

import db

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Bookarr/1.0"})


def _prowlarr_config():
    return {
        "url": db.get_setting("prowlarr_url", "").rstrip("/"),
        "key": db.get_setting("prowlarr_key", ""),
        "cats": db.get_setting("prowlarr_categories", "7000,7020"),
    }


def prowlarr_available():
    cfg = _prowlarr_config()
    return bool(cfg["url"] and cfg["key"])


def search_newznab(query, timeout=30):
    """Suche über Prowlarr (Newznab-kompatibel). Gibt Treffer mit NZB-Links zurück."""
    cfg = _prowlarr_config()
    results = []
    if not prowlarr_available():
        return results
    # Bücher-Kategorien: 7000 (eBooks) + Unterkategorien, 7030 (Audiobooks)
    try:
        params = {"query": query, "type": "search", "limit": 100}
        for c in (cfg["cats"] or "7000,7020").split(","):
            c = c.strip()
            if c.isdigit():
                params.setdefault("categories", [])
                params["categories"].append(c)
        r = SESSION.get(f"{cfg['url']}/api/v1/search", params=params,
                        headers={"X-Api-Key": cfg["key"]}, timeout=timeout)
        if r.status_code != 200:
            db.log_event("error", "prowlarr", f"Suche fehlgeschlagen: HTTP {r.status_code}")
            return results
        data = r.json()
    except Exception as e:
        db.log_event("error", "prowlarr", f"Suche fehlgeschlagen: {e}")
        return results

    for item in data:
        title = item.get("title") or ""
        size = item.get("size") or 0
        guid = item.get("guid") or item.get("downloadUrl") or ""
        if not title or not guid:
            continue
        results.append({
            "source": "newznab",
            "indexer": item.get("indexer", ""),
            "title": title,
            "size": size,
            "pub_date": item.get("publishDate", ""),
            "url": item.get("downloadUrl") or guid,
            "guid": guid,
            "category": item.get("category", []),
            "info": item.get("infoUrl", ""),
        })
    return results


def search_all_indexers(query, timeout=40):
    """Prowlarr + zusätzlich konfigurierte direkte Newznab-Indexer."""
    results = search_newznab(query, timeout=timeout)
    for idx in db.q("SELECT * FROM indexers WHERE enabled=1 ORDER BY priority DESC"):
        try:
            r = SESSION.get(idx["url"].rstrip("/") + "/api", params={
                "t": "search", "q": query, "apikey": idx["api_key"],
                "cat": idx["categories"] or "7000,7020",
                "extended": 1,
            }, timeout=timeout)
            if r.status_code != 200:
                continue
            try:
                items = r.json().get("channel", {}).get("item", [])
            except Exception:
                continue
            if isinstance(items, dict):
                items = [items]
            for it in items:
                guid = it.get("guid", "") or it.get("link", "")
                if not guid:
                    continue
                results.append({
                    "source": "newznab",
                    "indexer": idx["name"],
                    "title": it.get("title", ""),
                    "size": int(it.get("size", 0) or 0),
                    "pub_date": it.get("pubDate", ""),
                    "url": it.get("link", ""),
                    "guid": guid,
                    "category": [it.get("category", "")],
                    "info": it.get("comments", ""),
                })
        except Exception:
            continue
    return _dedup(results)


def _dedup(results):
    seen = set()
    out = []
    for r in results:
        key = re.sub(r"[^a-z0-9]", "", r["title"].lower())[:80]
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _sab_config():
    return {
        "url": db.get_setting("sabnzbd_url", "http://127.0.0.1:8081").rstrip("/"),
        "key": db.get_setting("sabnzbd_key", ""),
        "category": db.get_setting("sabnzbd_category", "ebook"),
    }


def sabnzbd_available():
    c = _sab_config()
    return bool(c["url"] and c["key"])


def sabnzbd_test():
    c = _sab_config()
    try:
        r = SESSION.get(f"{c['url']}/api", params={"mode": "version", "apikey": c["key"], "output": "json"}, timeout=10)
        return r.status_code == 200 and "version" in r.text
    except Exception:
        return False


def sabnzbd_add_nzb(url, title, category=None):
    """NZB an SABnzbd übergeben. Gibt (ok, nzo_id) zurück."""
    c = _sab_config()
    try:
        r = SESSION.get(f"{c['url']}/api", params={
            "mode": "addurl", "name": url, "apikey": c["key"],
            "cat": category or c["category"], "output": "json",
        }, timeout=30)
        data = r.json()
        if data.get("status") is False:
            return False, data.get("error", "unbekannter Fehler")
        nzo_ids = data.get("nzo_ids", [])
        return True, (nzo_ids[0] if nzo_ids else "")
    except Exception as e:
        return False, str(e)


def sabnzbd_queue():
    """Aktive Downloads aus SABnzbd (für die Übersichtsseite)."""
    c = _sab_config()
    if not sabnzbd_available():
        return []
    try:
        r = SESSION.get(f"{c['url']}/api", params={
            "mode": "queue", "apikey": c["key"], "output": "json",
            "start": 0, "limit": 100,
        }, timeout=10)
        slots = r.json().get("queue", {}).get("slots", [])
        out = []
        for s in slots:
            out.append({
                "nzo_id": s.get("nzo_id"),
                "title": s.get("filename", ""),
                "size": s.get("size", ""),
                "progress": s.get("percentage", 0),
                "status": s.get("status", ""),
                "speed": s.get("speed", ""),
                "eta": s.get("timeleft", ""),
                "category": s.get("cat", ""),
            })
        return out
    except Exception:
        return []


def sabnzbd_history(limit=20):
    c = _sab_config()
    if not sabnzbd_available():
        return []
    try:
        r = SESSION.get(f"{c['url']}/api", params={
            "mode": "history", "apikey": c["key"], "output": "json",
            "start": 0, "limit": limit,
        }, timeout=10)
        return r.json().get("history", {}).get("slots", [])
    except Exception:
        return []


def sanitize_filename(name):
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip()
