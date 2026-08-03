# 📚 Bookarr

Bookarr ist ein E-Book-Manager in der *arr-Familie (Sonarr/Radarr/Readarr-Stil) mit moderner
Weboberfläche. Es verwaltet Autoren, Bücher und Serien, findet neue Veröffentlichungen aus
offenen Datenbanken und lädt Bücher automatisch aus Usenet (NZB) und IRC herunter.

## Funktionen

- **Metadaten aus offenen Quellen**
  - Open Library: Autoren- und Buchsuche, komplette Werksverzeichnisse, Editionen mit
    Erscheinungsdaten (auch zukünftige), Serien, Cover, ISBN
  - Wikipedia: automatische Auswertung der Werke-/Bibliografie-Sektion einer Autorenseite
  - Google Books (optional, mit API-Key): zusätzliche Serien- und Editionsdaten
- **Autorenseiten** mit allen Büchern, Sprachfilter (z. B. nur DE/EN anzeigen) und
  aufklappbaren Serien mit Bandnummern
- **Monitoring**: Autoren und Serien können überwacht werden — regelmäßige Suche nach
  neuen Büchern in konfigurierbaren Intervallen (Standard: wöchentlich)
- **Wanted-System**: Bücher als *Wanted* markieren; die App sucht sie in konfigurierbaren
  Intervallen (Standard: täglich) auf allen Quellen
- **Download-Quellen**
  - **Prowlarr / Newznab** (Usenet): Suche über alle konfigurierten Indexer, Download
    über SABnzbd (Kategorie z. B. `ebook`)
  - **IRC** (irchighway #ebooks): `@search`-Suche mit DCC-Ergebnisdatei, Download per
    `!botname <Titel> ::INFO:: <Größe>` + DCC-Empfang (SSL, Etikette: 1 Aktion gleichzeitig)
  - Direkte Newznab-Indexer zusätzlich zu Prowlarr
- **Dublettenvermeidung**: normalisierte Titel + Autor (UNIQUE-Constraint), Serien-Bände
  werden nicht doppelt angelegt
- **Konvertierung**: heruntergeladene Bücher werden automatisch mit Calibre
  (`ebook-convert`) in ein Zielformat (EPUB/MOBI/AZW3/PDF/FB2/TXT) umgewandelt
- **Übersicht** (`/`): Wanted-Bücher, laufende Downloads mit Fortschritt, SABnzbd-Queue,
  Ereignisprotokoll
- **Aktivität**: Download-Verlauf und Ereignisprotokoll mit Fehler-/Warnungs-Filter
- **System-Seite**: Verbindungsstatus zu Prowlarr/SABnzbd/IRC/Calibre, Scheduler-Zustand, Logs
- ***arr-Look**: dunkles Theme, Badges, Fortschrittsbalken, Modals, Live-Aktualisierung

## Installation

```bash
# Abhängigkeiten
apt install -y python3-venv calibre        # calibre nur für Konvertierung nötig
cd /opt && git clone https://github.com/Kalrkloss/bookarr.git && cd bookarr
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# systemd
install -m 644 systemd/bookarr.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bookarr

# optional: reverse proxy (lighttpd)
install -m 644 lighttpd/30-bookarr.conf /etc/lighttpd/conf-available/
ln -s /etc/lighttpd/conf-available/30-bookarr.conf /etc/lighttpd/conf-enabled/
service lighttpd force-reload
```

Die Weboberfläche läuft dann auf **http://<server>:8788** (bzw. `/bookarr/` hinter dem Proxy).

## Konfiguration

Unter *Einstellungen* in der Weboberfläche:

| Bereich | Optionen |
|---|---|
| Prowlarr | URL, API-Key, Newznab-Kategorien (Standard `7000,7020`) |
| SABnzbd | URL, API-Key, Kategorie (muss in SABnzbd existieren, z. B. `ebook`) |
| IRC | Server (`irc.irchighway.net:6697`), Channel (`#ebooks`), Bot-Nick (einzigartig!), SSL, max. Bots |
| Google Books | optionaler API-Key |
| Verzeichnisse | Download-Zwischenablage, Bibliothek |
| Konvertierung | ein/aus, Zielformat |
| Scheduler | Wanted-Suche ein/aus, Standard-Intervalle |

Zusätzliche Newznab-Indexer lassen sich direkt verwalten (Name, URL, API-Key, Kategorien, Priorität).

## IRC-Hinweise

- irchighway blockt Plaintext-Verbindungen — SSL auf Port 6697 ist Pflicht
- Der Bot-Nick muss einzigartig sein (nicht parallel im eigenen IRC-Client verwenden,
  sonst Nick-Kollision und hängende Downloads)
- Etikette: nur **eine** Bot-Aktion gleichzeitig (Lock), Mindestabstände 30 s (Suche) /
  60 s (Download) — wird automatisch eingehalten
- Bots antworten langsam (bis 90 s+): Such-Timeout 180 s, Download-Timeout 480 s

## API

REST-API unter `/api/*` (JSON), z. B.:

- `GET /api/status` — Zähler, Scheduler, Verbindungen
- `GET /api/overview` — Wanted, aktive Downloads, Ereignisse
- `POST /api/authors` `{ol_key, languages}` — Autor anlegen
- `GET /api/authors/{id}?lang=de` — Autor mit Büchern/Serien (Sprachfilter)
- `GET /api/search/metadata?q=…` — Autoren + Bücher + Wikipedia-Werke
- `POST /api/wanted/search` — Wanted-Suche jetzt auslösen

## Lizenz

MIT — siehe [LICENSE](LICENSE).
