# asset-pipeline/

Audio generation for **Escape AI**: Suno ([sunoapi.org](https://docs.sunoapi.org/)) for music + SFX,
and ElevenLabs for the cinematic-intro **voice** narration. This directory holds the committed
contract files and the gitignored raw-output staging.
Full docs: [`docs/AUDIO_PIPELINE.md`](../docs/AUDIO_PIPELINE.md).

| File | Committed? | Purpose |
|------|:---------:|---------|
| `theme.json` | ✅ | Global eerie/creepy audio identity. Edit to re-theme **all** Suno audio. |
| `manifest.json` | ✅ | **Single source of truth** — one entry per audio asset (music + sfx + voice). |
| `output/` | ❌ (gitignored) | Raw samples + provenance: Suno `<key>/<key>.{1,2}.mp3` + `<key>.json`; voice `<key>/<key>.mp3` + `<key>.json`. |

The manifest drives three things: the Python generators (`scripts/sunoapi/` for music+sfx,
`scripts/elevenlabs/` for voice), the Node codegen (`scripts/audio/gen-bindings.js` →
`client/src/audio.generated.ts`), and the drift gate (`scripts/audio/verify-audio.js`). **Never
hand-edit `audio.generated.ts`** — edit the manifest and run `npm run audio` (from `scripts/`).

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

## Voice narration (ElevenLabs) — the cinematic intro

The `voice` array in `manifest.json` is the single source for the intro narration: each entry's
`text` is BOTH the spoken clip AND the on-screen subtitle (`client/src/intro.ts` keeps `SUBTITLES`
identical to it). `ELEVENLABS_API_KEY` must be set in your **system** environment.

```bash
# Free, no credits, no key needed:
python3 scripts/generate-voice.py --list
python3 scripts/generate-voice.py --dry-run --key=intro_vo_1

# Spend credits (you run this): one clip, or all of them
python3 scripts/generate-voice.py --key=intro_vo_1
python3 scripts/generate-voice.py --generate-all

# Then regenerate the client bindings so the baked durations + URLs reach the client:
cd scripts && npm run audio        # and rebuild the client
```

Each generation places `assets/voice/<key>.mp3`, stages the raw clip + provenance under
`output/<key>/`, **measures the clip's duration and bakes `durationMs` back into the manifest**.
The intro then holds each subtitle for `durationMs + 1.5s` and plays the clip on the transition.
Until a clip is generated the intro falls back to fixed timing and plays it silently — so a clean
clone works unchanged. Default voice id `6sFKzaJr574YWVu4UuJF`, model `eleven_v3` (override with
`--voice` / `--model`).

See `docs/AUDIO_PIPELINE.md` for the theme system, prompt best-practices, cost notes, and how to
add a new asset.
