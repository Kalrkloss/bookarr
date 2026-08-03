#!/usr/bin/env python3
"""Unit tests for Bookarr timeout hardening (IRC lock, stale watchdogs, search flag).

Run:
    ./venv/bin/python -m unittest tests.test_timeouts -v

Uses an isolated temp DB (BOOKARR_DB must be set before importing app modules).
"""
import os
import sys
import tempfile
import time
import unittest

_TMP = tempfile.mkdtemp(prefix="bookarr-test-")
os.environ["BOOKARR_DB"] = os.path.join(_TMP, "test.db")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import db  # noqa: E402
import scheduler  # noqa: E402


class TimeoutHardenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.connect()

    # ---------- IRC lock ----------
    def test_irc_lock_bounded(self):
        import irc
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "irc.py"),
                  encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_irc_lock.acquire(timeout=120)", src)
        self.assertIn('_irc_lock.acquire(timeout=self.cfg["dltimeout"] + 180)', src)
        self.assertIn("_irc_lock.release()", src)
        # functional skip path: a held lock fails acquire(timeout=0) immediately
        self.assertTrue(irc._irc_lock.acquire(timeout=0))
        self.assertFalse(irc._irc_lock.acquire(timeout=0))
        irc._irc_lock.release()

    # ---------- stale download watchdog ----------
    def test_watchdog_stale_marked_failed(self):
        now = db.now()
        bid = db.ex("INSERT INTO books(title, norm_title, status, wanted, added, updated) "
                    "VALUES(?,?,?,?,?,?)", ("StaleBuch", "stalebuch", "snatched", 1, now, now))
        db.ex("INSERT INTO downloads(book_id, title, source, status, added, updated) "
              "VALUES(?,?,?,?,?,?)", (bid, "StaleBuch", "irc", "downloading",
                                      "2026-08-03 10:00:00", "2026-08-03 10:00:00"))
        db.ex("INSERT INTO wanted(book_id, status, added) VALUES(?,?,?)", (bid, "snatched", now))
        scheduler._check_stale_downloads()
        d = db.q1("SELECT status, message FROM downloads WHERE title='StaleBuch'")
        self.assertEqual(d["status"], "failed")
        self.assertIn("watchdog", d["message"])
        b = db.q1("SELECT status FROM books WHERE id=?", (bid,))
        self.assertEqual(b["status"], "wanted")  # snatched -> wanted reset

    def test_watchdog_fresh_untouched(self):
        now = db.now()
        db.ex("INSERT INTO downloads(book_id, title, source, status, added, updated) "
              "VALUES(?,?,?,?,?,?)", (None, "Frisch", "newznab", "downloading", now, now))
        scheduler._check_stale_downloads()
        d = db.q1("SELECT status FROM downloads WHERE title='Frisch'")
        self.assertEqual(d["status"], "downloading")

    # ---------- startup cleanup for IRC ----------
    def test_cleanup_stale_irc(self):
        now = db.now()
        bid = db.ex("INSERT INTO books(title, norm_title, status, wanted, added, updated) "
                    "VALUES(?,?,?,?,?,?)", ("IrcTot", "irctot", "snatched", 1, now, now))
        db.ex("INSERT INTO downloads(book_id, title, source, status, added, updated) "
              "VALUES(?,?,?,?,?,?)", (bid, "IrcTot", "irc", "downloading", now, now))
        scheduler._cleanup_stale_irc()
        d = db.q1("SELECT status, message FROM downloads WHERE title='IrcTot'")
        self.assertEqual(d["status"], "failed")
        self.assertIn("restart", d["message"])
        self.assertEqual(db.q1("SELECT status FROM books WHERE id=?", (bid,))["status"], "wanted")

    # ---------- search flag expiry ----------
    def test_search_running_stale_expires(self):
        import main
        now = db.now()
        bid = db.ex("INSERT INTO books(title, norm_title, status, wanted, added, updated) "
                    "VALUES(?,?,?,?,?,?)", ("SuchBuch", "suchbuch", "wanted", 1, now, now))
        calls = []

        def fake_search(book):
            calls.append(book["id"])
            return [{"source": "newznab", "title": "X", "url": "http://x", "indexer": "T", "size": 1}]

        main.library.search_downloads = fake_search
        main._search_running[bid] = time.monotonic() - 2000  # older than the 30 min timeout
        r1 = main.api_search_downloads(bid)
        self.assertEqual(r1, {"done": False})
        for _ in range(50):
            if bid not in main._search_running:
                break
            time.sleep(0.1)
        self.assertEqual(calls, [bid], "worker not started despite stale flag")

    def test_search_running_fresh_dedupes(self):
        import main
        now = db.now()
        bid = db.ex("INSERT INTO books(title, norm_title, status, wanted, added, updated) "
                    "VALUES(?,?,?,?,?,?)", ("SuchBuch2", "suchbuch2", "wanted", 1, now, now))
        db.ex("DELETE FROM searchcache WHERE book_id=?", (bid,))
        main._search_running[bid] = time.monotonic()
        r = main.api_search_downloads(bid)
        self.assertEqual(r, {"done": False, "running": True})
        main._search_running.pop(bid, None)


if __name__ == "__main__":
    unittest.main()
