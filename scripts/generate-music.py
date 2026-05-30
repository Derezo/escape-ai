#!/usr/bin/env python3
"""
Generate Suno music assets.

Usage:
  python3 generate-music.py --list
  python3 generate-music.py --generate-all [--dry-run] [--only must]
  python3 generate-music.py --key=title_theme [--dry-run]
  python3 generate-music.py --credits
"""

import sys
from pathlib import Path

# Bootstrap sys.path so 'sunoapi' imports work from repo root
scripts_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(scripts_dir))

from sunoapi.core import run

if __name__ == "__main__":
    sys.exit(run("music", sys.argv[1:]))
