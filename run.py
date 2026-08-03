#!/usr/bin/env python3
"""Bookarr — entry point."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("BOOKARR_PORT", "8788"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
