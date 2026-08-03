"""Bookarr — IRC search + DCC download (irchighway #ebooks protocol).

Basierend auf den auf diesem Server verifizierten LazyLibrarian-Patterns:
- SSL on 6697 (plaintext is banned by irchighway), ssl_verify=False
- Search: "@search <title>" in the channel, bots reply with "!botname <title> ::INFO:: <size>"
- Download: post "!botname <exact title> ::INFO:: <size>" in the channel
  (NICHT per Privatnachricht — Bots antworten dann nur mit FSN/SearchList)
- DCC SEND: CTCP empfangen, zum Peer verbinden, Datei schreiben, Ack senden
- Etiquette: only ONE bot action at a time (global lock), minimum gaps
"""
import logging
import os
import re
import shlex
import socket
import ssl
import struct
import threading
import time

import db

log = logging.getLogger("bookarr.irc")

_irc_lock = threading.Lock()
_last_search = 0.0
_last_dl = 0.0
IRC_MIN_SEARCH = 30
IRC_MIN_DL = 60


def _settings():
    server = db.get_setting("irc_server", "irc.irchighway.net:6697")
    host, _, port = server.rpartition(":")
    host = host or server
    port = int(port) if port.isdigit() else 6697
    return {
        "host": host,
        "port": port,
        "ssl": db.get_setting("irc_ssl", "1") == "1",
        "channel": db.get_setting("irc_channel", "#ebooks"),
        "botnick": db.get_setting("irc_botnick", "BookarrBot"),
        "searchtimeout": 180,
        "dltimeout": int(db.get_setting("irc_dl_timeout", "480")),
        "per_user_timeout": 90,
        "max_bots": int(db.get_setting("max_irc_bots", "4")),
    }


def irc_configured():
    s = _settings()
    return bool(s["host"] and s["channel"])


class IrcSession(threading.Thread):
    """Eine IRC-Verbindung mit Event-Callbacks."""

    def __init__(self, cfg, callbacks, nick_suffix=""):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.cb = callbacks
        self.nick = cfg["botnick"] + nick_suffix
        self.running = True
        self.connected = threading.Event()
        self._sock = None

    def run(self):
        try:
            raw = socket.create_connection((self.cfg["host"], self.cfg["port"]), timeout=30)
            if self.cfg["ssl"]:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                raw = ctx.wrap_socket(raw, server_hostname=self.cfg["host"])
            self._sock = raw
            raw.sendall(f"NICK {self.nick}\r\n".encode())
            raw.sendall(f"USER {self.nick[:9]} 0 * :Bookarr\r\n".encode())
            buf = b""
            while self.running:
                try:
                    chunk = raw.recv(4096)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\r\n" in buf:
                    line, buf = buf.split(b"\r\n", 1)
                    self._process_line(line.decode("utf-8", "replace"))
        except Exception as e:
            import traceback as _tb
            self.cb.get("on_error", lambda m: None)(f"{e}\n{_tb.format_exc()}")
        finally:
            self.connected.set()
            try:
                self._sock.close()
            except Exception:
                pass
            self.cb.get("on_disconnect", lambda: None)()

    def stop(self):
        self.running = False
        try:
            self._sock.close()
        except Exception:
            pass

    def _send(self, data):
        try:
            self._sock.sendall(data.encode())
        except Exception:
            pass

    def _process_line(self, line):
        if line.startswith("PING"):
            self._send("PONG " + line[5:] + "\r\n")
            return
        parts = shlex.split(line, posix=False)
        if not parts:
            return
        prefix = ""
        idx = 0
        if line.startswith(":"):
            prefix = parts[0][1:]
            idx = 1
        if idx >= len(parts):
            return
        cmd = parts[idx].upper()
        args = parts[idx + 1:]
        if cmd == "001":
            self.cb.get("on_welcome", lambda: None)()
        elif cmd == "433":
            self.cb.get("on_nick_collision", lambda: None)()
        elif cmd == "PRIVMSG":
            target = args[0] if args else ""
            text = line.split(" :", 1)[1] if " :" in line else ""
            nick = prefix.split("!")[0]
            if "\x01" in text:
                # CTCP-Payload (z.B. DCC SEND)
                payload = text.split("\x01", 1)[1].rsplit("\x01", 1)[0]
                self.cb.get("on_ctcp", lambda n, p: None)(nick, payload)
                return
            if target == self.cfg["channel"]:
                self.cb.get("on_channel", lambda n, t: None)(nick, text)
            if target == self.nick:
                self.cb.get("on_privmsg", lambda n, t: None)(nick, text)


def _parse_offer(text):
    """Bot offer from an '@search' reply: '!botname <title> ::INFO:: <size>' (size optional)."""
    m = re.search(r"^!(\S+)\s+(.+?)(?:\s*::INFO::\s*([\d.]+[KMGT]?B?))?\s*$", text.strip())
    if not m:
        return None
    return {"bot": m.group(1), "title": m.group(2).strip(), "size": m.group(3) or ""}


def _title_norm(t):
    t = t.lower().replace("_", " ")
    t = re.sub(r"%[0-9A-Fa-f]{2}", "", t)
    t = re.sub(r"[\[\(].*?[\]\)]", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def _title_match(a, b, threshold=85):
    import difflib
    na, nb = _title_norm(a), _title_norm(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() * 100 >= threshold


class IrcSearch:
    """@search im Channel; Bots antworten per DCC mit einer Ergebnis-ZIP.
    Additionally, !botname lines in the channel are collected as a fallback."""

    def __init__(self, term, cfg):
        self.term = term
        self.cfg = cfg
        self.offers = []
        self.done = threading.Event()
        self.error = None
        self._bot_answered = set()
        self._dcc_data = bytearray()
        self._dcc_expected = 0
        self._peer = None

    def on_welcome(self):
        self._s._send(f"JOIN {self.cfg['channel']}\r\n")
        time.sleep(2)
        self._send_search()
        # retry after 60 s (bots reply irregularly)
        self._retry_timer = threading.Timer(60, self._send_search)
        self._retry_timer.start()

    def _send_search(self):
        try:
            self._s._send(f"PRIVMSG {self.cfg['channel']} :@search {self.term}\r\n")
        except Exception:
            pass

    def on_channel(self, nick, text):
        offer = _parse_offer(text)
        if offer and nick not in self._bot_answered:
            self._bot_answered.add(nick)
            self.offers.append(offer)

    def on_ctcp(self, nick, payload):
        parts = shlex.split(payload)
        if len(parts) != 5 or parts[0].upper() != "SEND":
            return
        if self._peer:
            return
        _, filename, peer_ip, peer_port, size = parts
        # nur Ergebnis-ZIPs von Such-Bots annehmen
        if "searchbot" not in filename.lower() and not filename.lower().endswith((".zip", ".lst", ".txt")):
            return
        try:
            peer_port = int(peer_port)
            self._dcc_expected = int(size)
        except ValueError:
            return
        try:
            self._peer = socket.create_connection((_ip_quad(peer_ip), peer_port), timeout=30)
            self._peer.settimeout(60)
            threading.Thread(target=self._dcc_receive, daemon=True).start()
        except Exception as e:
            self.error = f"DCC-Suchdatei: {e}"

    def _dcc_receive(self):
        try:
            while len(self._dcc_data) < self._dcc_expected:
                data = self._peer.recv(65536)
                if not data:
                    break
                self._dcc_data.extend(data)
                try:
                    self._peer.sendall(struct.pack("!I", len(self._dcc_data)))
                except Exception:
                    pass
        except Exception:
            pass
        finally:
            try:
                if self._peer:
                    self._peer.close()
            except Exception:
                pass
            self._parse_dcc_results()

    def _parse_dcc_results(self):
        import io
        import zipfile
        try:
            if self._dcc_data[:2] == b"PK":  # ZIP
                with zipfile.ZipFile(io.BytesIO(bytes(self._dcc_data))) as zf:
                    names = [n for n in zf.namelist() if not n.endswith("/")]
                    if not names:
                        return
                    text = zf.read(names[0]).decode("utf-8", "replace")
            else:
                text = bytes(self._dcc_data).decode("utf-8", "replace")
            for line in text.splitlines():
                offer = _parse_offer(line)
                if offer and offer["bot"] not in self._bot_answered:
                    self._bot_answered.add(offer["bot"])
                    self.offers.append(offer)
        except Exception:
            pass

    def run(self):
        global _last_search
        # never wait forever on the global IRC lock: if another action holds it,
        # give up after a bounded wait instead of hanging the caller
        if not _irc_lock.acquire(timeout=120):
            log.warning("IRC search skipped: another bot action is running")
            return
        try:
            wait = IRC_MIN_SEARCH - (time.time() - _last_search)
            if wait > 0:
                time.sleep(wait)
            self._s = IrcSession(self.cfg, {
                "on_welcome": self.on_welcome,
                "on_channel": self.on_channel,
                "on_ctcp": self.on_ctcp,
                "on_error": lambda m: setattr(self, "error", m),
            })
            self._s.start()
            self._s.connected.wait(timeout=15)
            self.done.wait(timeout=self.cfg["searchtimeout"])
            self._s.stop()
            _last_search = time.time()
        finally:
            _irc_lock.release()
        # keep only relevant offers (filter broadcasts of other searches)
        term = _title_norm(self.term)
        relevant = []
        for o in self.offers:
            nt = _title_norm(o["title"])
            if not nt:
                continue
            if term in nt or nt in term:
                relevant.append(o)
                continue
            # token overlap: at least one word >= 4 chars of the search term in the title
            terms = {w for w in term.split() if len(w) >= 4}
            if terms and any(w in nt for w in terms):
                relevant.append(o)
                continue
            if _title_match(o["title"], self.term):
                relevant.append(o)
        self.offers = relevant[: self.cfg["max_bots"]]


class IrcDownload:
    """Asks the offering bots one after another and receives via DCC."""

    def __init__(self, cfg, sources, dest_dir):
        self.cfg = cfg
        self.sources = sources  # list of {"bot","title","size"}
        self.dest_dir = dest_dir
        self.result = {"ok": False, "path": None, "error": None}
        self._idx = 0
        self._file = None
        self._peer = None
        self._received = 0
        self._expected = 0
        self._done = threading.Event()
        self._attempt_timer = None

    def _next_source(self):
        if self._idx >= len(self.sources):
            return False
        src = self.sources[self._idx]
        line = f"!{src['bot']} {src['title']}"
        if src.get("size"):
            line += f" ::INFO:: {src['size']}"
        log.info("IRC-Download: %s", line)
        self._s._send(f"PRIVMSG {self.cfg['channel']} :{line}\r\n")
        self._attempt_timer = threading.Timer(self.cfg["per_user_timeout"], self._timeout_source)
        self._attempt_timer.start()
        return True

    def _timeout_source(self):
        if self._file or self._idx >= len(self.sources):
            return
        self._idx += 1
        if not self._next_source():
            self._fail("Kein Bot hat geantwortet")

    def on_welcome(self):
        self._s._send(f"JOIN {self.cfg['channel']}\r\n")
        time.sleep(2)
        if not self._next_source():
            self._fail("Keine Quellen")

    def on_ctcp(self, nick, payload):
        parts = shlex.split(payload)
        if len(parts) != 5 or parts[0].upper() != "SEND":
            return
        if self._file:
            return
        if self._attempt_timer:
            self._attempt_timer.cancel()
        _, filename, peer_ip, peer_port, size = parts
        try:
            peer_port = int(peer_port)
            self._expected = int(size)
        except ValueError:
            return
        peer_ip = _ip_quad(peer_ip)
        filename = os.path.basename(filename)
        os.makedirs(self.dest_dir, exist_ok=True)
        path = os.path.join(self.dest_dir, filename)
        self._file = open(path, "wb")
        try:
            self._peer = socket.create_connection((peer_ip, peer_port), timeout=30)
            self._peer.settimeout(60)
        except Exception as e:
            self._file.close()
            os.remove(path)
            self._fail(f"DCC connection failed: {e}")
            return
        self.result["path"] = path
        threading.Thread(target=self._receive, daemon=True).start()

    def _receive(self):
        try:
            while self._received < self._expected:
                data = self._peer.recv(65536)
                if not data:
                    if self._received < self._expected:
                        self._fail(f"Vorzeitig beendet ({self._received}/{self._expected} Bytes)")
                    return
                self._file.write(data)
                self._received += len(data)
                # DCC ack (4 bytes big-endian) — bots wait for it before the next chunk
                try:
                    self._peer.sendall(struct.pack("!I", self._received))
                except Exception:
                    pass
            self._file.close()
            self.result["ok"] = True
            self.result["bytes"] = self._received
            self._finish()
        except socket.timeout:
            self._fail("DCC timeout")
        except Exception as e:
            self._fail(f"DCC error: {e}")
        finally:
            try:
                if self._peer:
                    self._peer.close()
            except Exception:
                pass

    def _fail(self, msg):
        self.result["error"] = msg
        log.warning("IRC download failed: %s", msg)
        try:
            if self._file and not self._file.closed:
                self._file.close()
            if self.result.get("path") and os.path.exists(self.result["path"]):
                os.remove(self.result["path"])
        except Exception:
            pass
        self._finish()

    def _finish(self):
        self._done.set()
        self._s.stop()

    def run(self):
        global _last_dl
        # never wait forever on the global IRC lock (bounded by dltimeout + slack)
        if not _irc_lock.acquire(timeout=self.cfg["dltimeout"] + 180):
            self._fail("IRC download skipped: another bot action is running")
            return
        try:
            wait = IRC_MIN_DL - (time.time() - _last_dl)
            if wait > 0:
                time.sleep(wait)
            self._s = IrcSession(self.cfg, {
                "on_welcome": self.on_welcome,
                "on_ctcp": self.on_ctcp,
                "on_error": lambda m: self._fail(m),
            })
            self._s.start()
            self._s.connected.wait(timeout=15)
            self._done.wait(timeout=self.cfg["dltimeout"])
            self._s.stop()
            _last_dl = time.time()
        finally:
            _irc_lock.release()


def _ip_quad(addr):
    """DCC liefert die IP oft als 32-Bit-Zahl — in eine IP umwandeln."""
    try:
        n = int(addr)
        return socket.inet_ntoa(struct.pack("!I", n))
    except (ValueError, struct.error):
        return addr


# ---------- public API ----------

def search_irc(title):
    """Search IRC for a title. Returns a list of offers."""
    if not irc_configured():
        return []
    cfg = _settings()
    try:
        s = IrcSearch(title, cfg)
        s.run()
    except Exception as e:
        db.log_event("error", "irc", f"IRC search failed: {e}")
        return []
    if s.error:
        db.log_event("error", "irc", f"IRC search failed: {s.error}")
    offers = s.offers[: cfg["max_bots"]]
    return [{"source": "irc", "indexer": "IRC", "title": o["title"], "size": o["size"],
             "bot": o["bot"]} for o in offers]


def download_irc(sources, dest_dir):
    """IRC-Download. sources = Liste mit bot/title/size. Gibt (ok, path, error)."""
    if not irc_configured() or not sources:
        return False, None, "No IRC sources configured"
    cfg = _settings()
    d = IrcDownload(cfg, sources, dest_dir)
    d.run()
    if d.result["ok"]:
        return True, d.result["path"], None
    return False, None, d.result.get("error", "Unknown error")
