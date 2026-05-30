# asset-pipeline/

Suno ([sunoapi.org](https://docs.sunoapi.org/)) music + SFX generation for **Escape AI**.
This directory holds the two committed contract files and the gitignored raw-output staging.
Full docs: [`docs/AUDIO_PIPELINE.md`](../docs/AUDIO_PIPELINE.md).

| File | Committed? | Purpose |
|------|:---------:|---------|
| `theme.json` | ✅ | Global eerie/creepy audio identity. Edit to re-theme **all** audio. |
| `manifest.json` | ✅ | **Single source of truth** — one entry per audio asset (music + sfx). |
| `output/` | ❌ (gitignored) | Raw Suno samples + provenance: `<key>/<key>.{1,2}.mp3` + `<key>.json`. |

The manifest drives three things: the Python generator (`scripts/sunoapi/`), the Node codegen
(`scripts/audio/gen-bindings.js` → `client/src/audio.generated.ts`), and the drift gate
(`scripts/audio/verify-audio.js`). **Never hand-edit `audio.generated.ts`** — edit the manifest
and run `npm run audio` (from `scripts/`).

## Generate (you run these — they spend credits)

`SUNOAPI_KEY` must be set in your **system** environment (not a repo file).

```bash
# Free, no credits: inspect what would happen
python3 scripts/generate-music.py --list
python3 scripts/generate-sfx.py   --list
python3 scripts/generate-music.py --generate-all --dry-run
python3 scripts/generate-sfx.py   --credits

# Spend credits: one asset, or the must-have batch, or everything
python3 scripts/generate-sfx.py   --key=robot_alert
python3 scripts/generate-music.py --key=title_theme
python3 scripts/generate-sfx.py   --generate-all --only must
python3 scripts/generate-music.py --generate-all

# Each run downloads BOTH samples to output/<key>/ and auto-places sample #1.
# Already-generated assets are skipped unless you pass --force.

# Prefer the second sample for an asset:
python3 scripts/change-music-track.py --key=title_theme            # uses output/title_theme/title_theme.2.mp3
python3 scripts/change-music-track.py --key=title_theme --input=./asset-pipeline/output/title_theme/title_theme.2.mp3
```

See `docs/AUDIO_PIPELINE.md` for the theme system, prompt best-practices, cost notes, and how to
add a new asset.
