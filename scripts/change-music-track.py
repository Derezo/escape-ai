#!/usr/bin/env python3
"""
Swap a music track: replace the target with a raw sample or explicit input.

Usage:
  python3 change-music-track.py --key=title_theme
  python3 change-music-track.py --key=title_theme --sample 2 [--no-backup] [--dry-run]
  python3 change-music-track.py --key=title_theme --input=/path/to/file.mp3
"""

import sys
from pathlib import Path

# Bootstrap sys.path so 'sunoapi' imports work from repo root
scripts_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(scripts_dir))

from sunoapi.core import swap

if __name__ == "__main__":
    sys.exit(swap("music", sys.argv[1:]))
