#!/usr/bin/env python3
"""
Generate ElevenLabs voice narration for the cinematic intro.

The narration `text` (single source for both the spoken clip and the on-screen
subtitle) lives in the `voice` array of asset-pipeline/manifest.json. This generates
one MP3 per entry, places it at assets/voice/<key>.mp3, and bakes the measured clip
duration back into the manifest (the client reads it to pace each subtitle).

Generation spends ElevenLabs credits and is USER-RUN (nothing in the build/CI calls
the API). `--list` and `--dry-run` make ZERO network calls and work with the key unset.

Usage:
  python3 generate-voice.py --list
  python3 generate-voice.py --dry-run --key=intro_vo_1
  python3 generate-voice.py --key=intro_vo_1 [--force] [--voice ID] [--model M]
  python3 generate-voice.py --generate-all [--only nice]

After generating, run `cd scripts && npm run audio` so the baked durations + URLs
reach client/src/audio.generated.ts, then rebuild the client.

Environment:
  ELEVENLABS_API_KEY  (required for real generation) — system env var, not a repo .env

Exit codes: 0 ok · 1 usage · 2 auth (key unset) · 3 API · 4 integrity
"""

import sys
from pathlib import Path

# Bootstrap sys.path so 'elevenlabs' (the local package) imports from scripts/.
scripts_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(scripts_dir))

from elevenlabs.core import run

if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
