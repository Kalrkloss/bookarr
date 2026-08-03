# 📚 Bookarr

**Bookarr** is an ebook manager in the spirit of the \*arr family (Sonarr / Radarr / Readarr).
It keeps track of authors, books and series, discovers new releases from open databases,
and downloads books automatically from **Usenet (NZB)** and **IRC** — all behind a modern,
dark-themed web UI.

## Features

- **Metadata from open sources**
  - **Open Library**: author & book search, complete work catalogs, editions with publish
    dates (including *upcoming* releases), series, covers, ISBNs
  - **Wikipedia**: automatic extraction of the works/bibliography section of an author page
  - **Google Books** (optional, with API key): additional series/edition data
- **Author pages** with the full book catalog, a **language filter** (e.g. show only DE/EN)
  and **expandable series** with volume numbers
- **Monitoring**: authors and series can be monitored — Bookarr periodically checks for new
  books at configurable intervals (default: weekly) and marks them as wanted
- **Wanted system**: mark books as *wanted*; they are searched on all sources at configurable
  intervals (default: daily)
- **Download sources**
  - **Prowlarr / Newznab** (Usenet): search across all configured indexers, download via
    SABnzbd (category e.g. `ebook`)
  - **IRC** (irchighway `#ebooks`): `@search` with DCC result files, downloads via
    `!botname <title> ::INFO:: <size>` + DCC receive (SSL, one bot action at a time)
  - Direct Newznab indexers in addition to Prowlarr
- **Duplicate protection**: normalized title + author (UNIQUE constraint); series volumes are
  never added twice
- **Conversion**: downloaded books are automatically converted with Calibre
  (`ebook-convert`) to a target format (EPUB / MOBI / AZW3 / PDF / FB2 / TXT)
- **Overview page**: wanted books, active downloads with progress, SABnzbd queue, event log
- **Activity**: download history and event log with error/warning filter
- **System page**: connection status (Prowlarr / SABnzbd / IRC / Calibre), scheduler state, logs
- **i18n**: all UI strings in resource files (`static/locales/{de,en}.json`); the language
  follows the browser language and can be switched at any time via the dropdown in the top bar
- **Built-in book viewer**: owned books can be **viewed right in the browser**
  (PDF / TXT / HTML natively, EPUB via self-hosted [epub.js](https://github.com/futurepress/epub.js))
  and downloaded (`/api/books/{id}/file`, Range-request capable)
- **No hanging tasks**: every background task is bounded by timeouts — bounded IRC locks,
  a stale-download watchdog (2 h → marked failed), startup cleanup for dead IRC downloads
  and expiring search flags (30 min)

## Stack

- **Backend**: Python 3 + FastAPI + SQLite (WAL), background scheduler (threads)
- **Frontend**: single-page app, vanilla JS, dark \*arr-style theme (no build step)
- **Downloads**: SABnzbd (NZB), custom IRC client with DCC receive (SSL)

## Installation

Requires Python 3.10+ (Debian/Ubuntu):

```bash
# dependencies (calibre only needed for conversion)
apt install -y python3-venv calibre

cd /opt && git clone https://github.com/Kalrkloss/bookarr.git && cd bookarr
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# systemd service
install -m 644 systemd/bookarr.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bookarr

# optional: reverse proxy (lighttpd) → http://<server>/bookarr/
install -m 644 lighttpd/30-bookarr.conf /etc/lighttpd/conf-available/
ln -s /etc/lighttpd/conf-available/30-bookarr.conf /etc/lighttpd/conf-enabled/
service lighttpd force-reload
```

The web UI is then available at **http://<server>:8788** (or `/bookarr/` behind the proxy).

## Configuration

Under *Settings* in the web UI:

| Section | Options |
|---|---|
| Prowlarr | URL, API key, Newznab categories (default `7000,7020`) |
| SABnzbd | URL, API key, category (must exist in SABnzbd, e.g. `ebook`) |
| IRC | Server (`irc.irchighway.net:6697`), channel (`#ebooks`), bot nick (must be unique!), SSL, max. bots |
| Google Books | optional API key |
| Folders | download staging folder, library (finished books) |
| Conversion | on/off, target format |
| Scheduler | wanted search on/off, default intervals |

Additional Newznab indexers can be managed directly (name, URL, API key, categories, priority).

## IRC notes

- irchighway blocks plaintext connections — SSL on port 6697 is mandatory
- The bot nick must be unique (do not use it in your own IRC client, otherwise nick
  collisions cause stuck downloads)
- Etiquette: only **one** bot action at a time (global lock), minimum gaps 30 s (search) /
  60 s (download) are enforced automatically
- Bots react slowly (up to 90 s+): search timeout 180 s, download timeout 480 s

## Tests

```bash
# unit tests for the timeout hardening (isolated temp DB)
./venv/bin/python -m unittest tests.test_timeouts -v

# end-to-end UI test (Playwright, headless Chromium)
python3 -m venv /opt/uitest-venv
/opt/uitest-venv/bin/pip install -r tests/requirements-ui.txt
/opt/uitest-venv/bin/playwright install --with-deps chromium
BOOKARR_URL=http://127.0.0.1:8788 /opt/uitest-venv/bin/python tests/ui_test.py
```

## API

REST API under `/api/*` (JSON), e.g.:

- `GET /api/status` — counters, scheduler, connectivity
- `GET /api/overview` — wanted books, active downloads, events
- `POST /api/authors` `{ol_key, languages}` — add an author
- `GET /api/authors/{id}?lang=de` — author with books/series (language filter)
- `GET /api/search/metadata?q=…` — authors + books + Wikipedia works
- `POST /api/wanted/search` — trigger the wanted search now

## License

MIT — see [LICENSE](LICENSE).
