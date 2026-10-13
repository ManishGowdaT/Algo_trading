"""
applog.py — centralized logging for Spread Terminal.

Writes to BOTH the console (stdout) and a rotating file `spread-terminal.log`
in the project directory, so errors are visible even when the terminal output
is swallowed (a common uvicorn-on-Windows situation). Importing this module
configures logging exactly once; both main.py and screener.py use it.

Tune verbosity with the env var SPREAD_LOG_LEVEL (DEBUG, INFO, WARNING, ...).
"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_CONFIGURED = False
_ROOT_NAME = "spread_terminal"
LOG_PATH = Path(__file__).parent / "spread-terminal.log"


def setup_logging() -> logging.Logger:
    """Idempotently attach console + rotating-file handlers to our root logger."""
    global _CONFIGURED
    root = logging.getLogger(_ROOT_NAME)
    if _CONFIGURED:
        return root

    level_name = os.environ.get("SPREAD_LOG_LEVEL", "DEBUG").upper()
    level = getattr(logging, level_name, logging.INFO)
    root.setLevel(level)
    root.propagate = False  # don't double-emit through uvicorn's root logger

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    root.addHandler(console)

    try:
        file_h = RotatingFileHandler(
            LOG_PATH, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
        file_h.setFormatter(fmt)
        root.addHandler(file_h)
    except Exception as exc:  # file system edge cases must not kill the app
        root.warning("could not open log file %s: %s", LOG_PATH, exc)

    _CONFIGURED = True
    root.info("logging initialized (level=%s) -> %s", level_name, LOG_PATH)
    return root


def get_logger(name: str) -> logging.Logger:
    """Return a child logger, ensuring handlers are configured first."""
    setup_logging()
    return logging.getLogger(f"{_ROOT_NAME}.{name}")


# Configure on import so any module that imports us is immediately covered.
setup_logging()
