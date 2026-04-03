from __future__ import annotations

import sys
from pathlib import Path


OVERLAY_DIR = Path(__file__).resolve().parent
if str(OVERLAY_DIR) not in sys.path:
    sys.path.insert(0, str(OVERLAY_DIR))

import quest_agent  # noqa: F401
