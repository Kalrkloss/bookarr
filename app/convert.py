"""Bookarr — Konvertierung mit Calibre ebook-convert."""
import logging
import os
import subprocess

import db

log = logging.getLogger("bookarr.convert")

EXTS = {
    "epub": ".epub",
    "mobi": ".mobi",
    "azw3": ".azw3",
    "pdf": ".pdf",
    "fb2": ".fb2",
    "txt": ".txt",
}


def available():
    return os.path.exists("/usr/bin/ebook-convert") or os.path.exists("/usr/local/bin/ebook-convert")


def convert(path, target_format="epub", book_id=None):
    """Convert path to target_format. Returns the path of the result file."""
    target_format = target_format.lower()
    if target_format not in EXTS:
        target_format = "epub"
    if not available():
        db.log_event("error", "convert", "ebook-convert (Calibre) is not installed")
        return path
    ext = os.path.splitext(path)[1].lower()
    if ext == EXTS[target_format]:
        return path
    out = os.path.splitext(path)[0] + EXTS[target_format]
    try:
        proc = subprocess.run(
            ["ebook-convert", path, out],
            capture_output=True, text=True, timeout=1800)
        if proc.returncode == 0 and os.path.exists(out):
            try:
                os.remove(path)
            except OSError:
                pass
            db.log_event("success", "convert",
                         f"Converted to {target_format.upper()}: {os.path.basename(out)}")
            return out
        db.log_event("warn", "convert",
                     f"Conversion failed: {proc.stderr[-300:]}")
        return path
    except subprocess.TimeoutExpired:
        db.log_event("error", "convert", "Conversion timed out")
        return path
    except Exception as e:
        db.log_event("error", "convert", f"Conversion error: {e}")
        return path
