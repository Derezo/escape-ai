#!/usr/bin/env python3
"""
Generate Suno SFX assets.

Usage:
  python3 generate-sfx.py --list
  python3 generate-sfx.py --generate-all [--dry-run] [--only must]
  python3 generate-sfx.py --key=robot_alert [--dry-run] [--loop|--no-loop] [--tempo N] [--sound-key K]
  python3 generate-sfx.py --credits
"""

import sys
from pathlib import Path

# Bootstrap sys.path so 'sunoapi' imports work from repo root
scripts_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(scripts_dir))

from sunoapi.core import run

if __name__ == "__main__":
    sys.exit(run("sfx", sys.argv[1:]))
