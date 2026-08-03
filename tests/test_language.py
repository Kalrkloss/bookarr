#!/usr/bin/env python3
"""Unit tests for Bookarr language detection heuristics (offline, no network).

Run:
    ./venv/bin/python -m unittest tests.test_language -v
"""
import os
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="bookarr-langtest-")
os.environ["BOOKARR_DB"] = os.path.join(_TMP, "test.db")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import db  # noqa: E402
import library  # noqa: E402
import metadata  # noqa: E402


def ed(year, lang=""):
    return {"year": year, "language": lang}


class LanguageDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.connect()

    def test_oldest_dated_edition_wins(self):
        """The language of the OLDEST dated edition is the original-language guess."""
        eds = [ed("2005", "fre"), ed("1999", ""), ed("1974", "eng"), ed("2010", "por")]
        self.assertEqual(metadata.best_language_from_editions(eds), "eng")

    def test_unsorted_input_still_oldest(self):
        """Input order must not matter (API order is arbitrary)."""
        eds = [ed("2010", "por"), ed("2005", "fre"), ed("1974", "eng")]
        self.assertEqual(metadata.best_language_from_editions(eds), "eng")

    def test_skip_undated_until_language_found(self):
        eds = [ed("", "por"), ed("1980", ""), ed("1975", "eng")]
        self.assertEqual(metadata.best_language_from_editions(eds), "eng")

    def test_fallback_most_frequent(self):
        """No dated edition with a language → most frequent language overall."""
        eds = [ed("", "por"), ed("", "por"), ed("", "eng")]
        self.assertEqual(metadata.best_language_from_editions(eds), "por")

    def test_all_empty(self):
        self.assertEqual(metadata.best_language_from_editions([ed("1974"), ed("1980")]), "")

    def test_empty_list(self):
        self.assertEqual(metadata.best_language_from_editions([]), "")

    def test_diacritics_german(self):
        self.assertEqual(metadata.detect_language_from_title("Basar der bösen Träume"), "de")
        self.assertEqual(metadata.detect_language_from_title("Die Farben der Magie"), "")

    def test_diacritics_portuguese_and_spanish(self):
        self.assertEqual(metadata.detect_language_from_title("Não Pise"), "pt")
        self.assertEqual(metadata.detect_language_from_title("El señor de los sueños"), "es")

    def test_diacritics_ambiguous_returns_empty(self):
        self.assertEqual(metadata.detect_language_from_title("The Dark Tower: Books 1-7"), "")

    def test_lang_code_normalization(self):
        self.assertEqual(db.lang_code("ger"), "de")
        self.assertEqual(db.lang_code("eng"), "en")
        self.assertEqual(db.lang_code("und"), "")
        self.assertEqual(db.lang_code("de"), "de")

    def test_author_dominant_language_fallback(self):
        """Books without language data inherit the author's dominant language."""
        now = db.now()
        aid = db.ex("INSERT INTO authors(name, sort_name, languages, added, updated) "
                    "VALUES(?,?,?,?,?)", ("Test-Autor", "Test-Autor", '["de","en"]', now, now))
        for title, lang in (("A1", "en"), ("A2", "en"), ("A3", "de"), ("A4", "")):
            db.ex("INSERT INTO books(title, norm_title, author_id, language, added, updated) "
                  "VALUES(?,?,?,?,?,?)", (title, title.lower(), aid, lang, now, now))
        self.assertEqual(library.author_dominant_language(aid), "en")
        library._fill_author_language_fallback(aid)
        self.assertEqual(db.q1("SELECT language FROM books WHERE title='A4'")["language"], "en")
        # no crash for authors without any language data
        self.assertEqual(library.author_dominant_language(999999), "")


if __name__ == "__main__":
    unittest.main()
