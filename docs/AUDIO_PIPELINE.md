# Audio Pipeline — Suno music + SFX for *Escape AI*

How the game's music and sound effects are defined, generated (via
[sunoapi.org](https://docs.sunoapi.org/)), and wired into the client. This is the
**best-practices reference**; the one-screen quick-start is in
[`asset-pipeline/README.md`](../asset-pipeline/README.md).

---

## 1. Overview & data flow

```
asset-pipeline/theme.json     ── global aesthetic (eerie/creepy palette)
asset-pipeline/manifest.json  ── SINGLE SOURCE OF TRUTH (every audio asset)
        │
        ├──▶ scripts/sunoapi/  (Python, stdlib)  ── generate-music.py / generate-sfx.py
        │        submit → poll → download 2 samples → place #1
        │        raw → asset-pipeline/output/<key>/   (gitignored)
        │        placed → assets/{music,sfx}/<key>.mp3 (committed)
        │
        └──▶ scripts/audio/  (Node)  ── gen-bindings.js → client/src/audio.generated.ts
                 verify-audio.js  (drift gate)
                                    │
                                    ▼
                 client/src/audio.ts  (SFX)  +  client/src/music.ts  (music)
                                    │
                                    ▼
                 client/src/main.ts  ── plays SFX on events, music per game state
```

Two languages, one seam: **Python** generates the audio; **Node** turns the manifest
into TypeScript bindings and gates drift. They share nothing but `manifest.json`.

---

## 2. Cost-consciousness (read this first)

Generation spends credits. The pipeline is built so you never spend by accident:

- **The user runs all generation.** Nothing in the build or CI calls the API.
- **`--dry-run` and `--list` make zero network calls** — they work even with
  `SUNOAPI_KEY` unset. `--dry-run` prints the exact request body that *would* be sent.
- **Already-generated assets are skipped** unless you pass `--force` (the target
  `.mp3` existing on disk is the skip signal).
- **Raw-reuse:** if both samples were already downloaded to `asset-pipeline/output/<key>/`,
  re-running places sample #1 again with **no** network call.
- **`--credits`** prints your remaining balance.
- **Batch by priority:** `--generate-all --only must` does only the must-have set.
- Rate limit is 20 requests / 10 s (the sequential poll-and-wait keeps you well under it).
  A downloadable MP3 is ready ~2–3 min after submit for music, ~20–30 s for SFX. Suno
  retains the files ~15 days.

Recommended first run (cheapest meaningful test): a single SFX —
`python3 scripts/generate-sfx.py --key=robot_alert`.

---

## 3. The theme system

`asset-pipeline/theme.json` is the **global audio identity**. Edit it to re-theme the
whole game at once. Structure:

- `shared` — mood + setting descriptors + a global `negativeTags` string that apply to
  everything (the *Caves of Steel* dystopia: eerie, creepy, cold robotic facility).
- `music` — the "light and spooky" sub-palette: `model`, `instrumental`, `customMode`,
  genre/instrument/mood/energy descriptor lists, `tempoRange`, `styleWeight`,
  `weirdnessConstraint`, `negativeTags`.
- `sfx` — the "punchy and engaging" sub-palette: `model` (`V5`, required by the
  endpoint), descriptor lists, `soundKey`, `negativeTags`.
- Top-level: `callBackUrl` (a placeholder — see §6), `pollIntervalSec`, `pollTimeoutSec`.

**The final prompt for an asset = `shared` palette + the per-kind palette + that
asset's `descriptor`** (from the manifest). So `theme.json` sets the house style and
each manifest entry adds only what's unique to it.

---

## 4. Suno prompt best practices

Distilled from the Suno docs and applied by `scripts/sunoapi/compose.py`:

**Music** (`POST /api/v1/generate`, `customMode: true`):
- Describe **style + genre**, **mood + atmosphere**, **instruments**, **tempo + energy**
  — that's exactly the order `compose.py` joins the palette in.
- We use `instrumental: true` (game underscore, no vocals). **When instrumental, send no
  `prompt` field** — only `style` + `title`. (A `prompt` is lyrics; we don't want any.)
- `style` carries the whole description (capped at 1000 chars for V4.5+/V5). `title` is
  short. `negativeTags` excludes what we never want (vocals, upbeat, major key…).
- `styleWeight` (how hard to follow the style) and `weirdnessConstraint` (how much
  creative deviation) are tunable per-theme and per-asset.

**SFX** (`POST /api/v1/generate/sounds`, `model: "V5"` required):
- Keep the prompt **short, punchy, single-event** (capped 500 chars). Lead with the
  asset's `descriptor`, then a few palette flavor words.
- `soundLoop: true` for ambient/looping effects; `soundTempo` (1–300 BPM) for rhythmic
  ones; `soundKey` to pitch it. These come from the manifest entry.
- **The `/generate/sounds` endpoint has no `negativeTags` parameter** — put any
  exclusions directly in the descriptor.

---

## 5. The eerie / creepy aesthetic

The vocabulary that defines *Escape AI*'s sound (edit in `theme.json` to shift it):

- **Setting:** Asimov *Caves of Steel*, dystopian underground steel city, cold robotic
  facility, sterile machine corridors.
- **Music — light and spooky:** dark ambient, horror synth, minimal cinematic
  underscore; low drones, detuned pads, distant metallic clangs, sparse music-box bells,
  reverberant piano; haunting, fragile, ghostly, quietly menacing; sparse, restrained,
  slow-building; 50–80 BPM.
- **SFX — punchy and engaging:** sci-fi foley, mechanical, servo motors, metal impacts,
  synth stabs, electronic alarms; sharp attack, tight, impactful, cold, robotic.
- **Always exclude:** upbeat, cheerful, major key, vocals, distorted/harsh noise.

---

## 6. How polling works (and why callBackUrl is a placeholder)

Both kinds submit a job and get a `taskId`, then we **poll**
`GET /api/v1/generate/record-info?taskId=…` until `status: "SUCCESS"`. The result —
**identical shape for music and SFX** — is `data.response.sunoData`, an array of **two
samples**, each with a downloadable `audioUrl` (MP3).

Because we poll, **no callback server is needed**. The Suno playground itself sends the
literal string `"playground"` as `callBackUrl` and polls; we send the `theme.json`
placeholder and do the same. Don't stand up a webhook receiver.

Terminal failure statuses (`CREATE_TASK_FAILED`, `GENERATE_AUDIO_FAILED`,
`SENSITIVE_WORD_ERROR`, `CALLBACK_EXCEPTION`) abort the poll with a clear error.

---

## 7. Adding a new audio asset

1. **Add an entry to `asset-pipeline/manifest.json`** (in `music` or `sfx`):
   - `key` (unique), `kind`, `priority` (`must`|`nice`), `trigger`, `output`
     (`assets/music/<key>.mp3` or `assets/sfx/<key>.mp3`), `descriptor` (the unique
     prompt fragment). Music adds `title` (+ optional `model`/`loop`/`durationHint`/…);
     SFX adds `placeholder` (an existing synth WAV key to fall back to) + optional
     `soundLoop`/`soundTempo`/`soundKey`.
2. **Regenerate + verify the client bindings:** `cd scripts && npm run audio`
   (codegen `client/src/audio.generated.ts`, then the drift gate). Commit the
   regenerated file.
3. **Wire it into gameplay** (`client/src/main.ts`): play an SFX with `playSfx('<key>')`
   at its event edge, or add a music track to `selectMusic()`. Until the `.mp3` is
   generated, an SFX plays its `placeholder` WAV and music stays silent — both safe.
4. **Generate it** (when you're ready to spend): `python3 scripts/generate-sfx.py
   --key=<key>` (or `generate-music.py`). Verify it sounds right; if the second sample
   is better, swap it (§9).

The drift gate (`npm run audio:verify`) fails the build if `manifest.json` and
`audio.generated.ts` disagree, so the client can never reference a key the manifest
doesn't define (or vice versa).

---

## 8. CLI reference

`SUNOAPI_KEY` must be in your **system** environment (never a repo file).

```bash
# generate-music.py and generate-sfx.py share these flags:
--key=<name>        generate one asset by key
--generate-all      generate every asset of this kind (kind-scoped)
--only must|nice    with --generate-all, restrict by priority
--list              print every asset's generated|missing status (no network)
--credits           print remaining Suno credits
--dry-run           print the exact request that WOULD be sent; spend nothing
--force             regenerate even if the target .mp3 already exists
--sample 1|2        which of the two samples to auto-place (default 1)
--model <M>         override the model for this run

# generate-sfx.py additionally:
--loop / --no-loop  override soundLoop
--tempo <N>         override soundTempo (1–300)
--sound-key <K>     override soundKey

# exit codes: 0 ok · 1 usage · 2 auth (SUNOAPI_KEY unset) · 3 API · 4 integrity
```

---

## 9. Swapping to the second sample

Every generation downloads **both** samples to `asset-pipeline/output/<key>/`
(`<key>.1.mp3`, `<key>.2.mp3`) and a `<key>.json` provenance file (request body + full
raw API response). Sample #1 is auto-placed. To promote sample #2:

```bash
python3 scripts/change-music-track.py --key=title_theme           # uses <key>.2.mp3
python3 scripts/change-sfx-track.py   --key=robot_alert --sample=2
# or an explicit file:
python3 scripts/change-music-track.py --key=title_theme \
    --input=./asset-pipeline/output/title_theme/title_theme.2.mp3
```

It backs up the current target to `<target>.bak` (gitignored) then copies the new file
over it. No codegen rerun is needed — only the file's bytes change, not its path.

---

## 10. The drift gate

`scripts/audio/verify-audio.js` (run by `npm run audio:verify`) mirrors
`verify-tileset.js`. It fails the build on any inconsistency:

1. Every manifest key appears in the generated maps, and vice versa (no orphans).
2. Each generated URL equals `./` + the entry's `output` with the leading `assets/`
   stripped.
3. **Regenerate-and-diff:** the on-disk `audio.generated.ts` matches a fresh `render()`
   of the manifest (catches a stale committed file — re-run `npm run audio:codegen`).
4. Asset existence, with tolerance: a missing SFX `.mp3` is a **WARN** while its
   placeholder WAV exists; missing music is a **WARN** (incremental generation). A
   manifest SFX with neither an `.mp3` nor an existing placeholder is a **FAIL**.
5. Every `SFX_FALLBACK` target points at a committed WAV.

---

## 11. Raw output & provenance

`asset-pipeline/output/` is gitignored (regenerable, large, and deliberately **outside**
Vite's `publicDir` so raw samples never ship in the bundle/APK). Per asset:

```
asset-pipeline/output/<key>/
├── <key>.1.mp3   # sample #1 (auto-placed at the manifest target)
├── <key>.2.mp3   # sample #2 (swap candidate)
└── <key>.json    # request body + FULL raw record-info response + sample URLs
```

The `<key>.json` is the ground-truth record of what was sent and received — useful if a
generation looks wrong or if the API response shape ever changes.

---

## 12. Dependencies & environment

- **Python:** standard library only (`urllib`, `json`, `argparse`, `os`, `shutil`,
  `pathlib`, `time`) — no `pip install`. Requires Python 3.8+. See
  `scripts/requirements.txt`.
- **Node:** the codegen + verifier are zero-dependency (like the sprite/tile tools).
- **`SUNOAPI_KEY`:** read from `os.environ` only. It is a **system** environment
  variable, never committed and never read from a repo `.env`. The scripts error
  clearly (exit code 2) if it's missing for an operation that needs it.
- **Client:** `client/src/music.ts` decodes MP3 via the Web Audio API (`decodeAudioData`
  handles MP3 directly), shares the one `AudioContext` from `audio.ts`, and is
  renderer-agnostic. `base: './'` keeps the asset URLs Capacitor-safe.

---

## 13. Voice narration — ElevenLabs (the cinematic intro)

A third audio kind: spoken narration for the first-run "ESCAPE AI" intro. It rides the
SAME manifest single-source-of-truth + drift gate as music/sfx, but is generated via
**ElevenLabs** (not Suno) by a parallel stdlib-only package, `scripts/elevenlabs/`.

**Manifest (`voice` array).** Each entry's `text` is the narration AND the on-screen
subtitle (`client/src/intro.ts` keeps `SUBTITLES` byte-identical to it). Fields: `key`,
`text`, `output` (`assets/voice/<key>.mp3`), `voiceId` (default `6sFKzaJr574YWVu4UuJF`),
`model` (default `eleven_v3`), `defaultVolume`, and `durationMs` (null until baked).

**Generation (you run it — spends ElevenLabs credits).** `ELEVENLABS_API_KEY` must be a
**system** env var (never a repo file). Mirrors the Suno CLI:

```bash
python3 scripts/generate-voice.py --list                      # free, no key
python3 scripts/generate-voice.py --dry-run --key=intro_vo_1  # free, prints the request
python3 scripts/generate-voice.py --key=intro_vo_1            # spends credits
python3 scripts/generate-voice.py --generate-all              # all four clips
# exit codes: 0 ok · 1 usage · 2 auth (key unset) · 3 API · 4 integrity
```

Unlike Suno's submit→poll→download, the ElevenLabs TTS endpoint
(`POST /v1/text-to-speech/<voice_id>`) returns the MP3 bytes directly. Each run: stages
the raw clip + provenance JSON under `asset-pipeline/output/<key>/`, places
`assets/voice/<key>.mp3`, **measures the clip duration** (a zero-dependency MP3
frame-header parser — no ffmpeg) and **bakes `durationMs` back into the manifest** with a
surgical one-line edit. Then run `cd scripts && npm run audio` so the baked durations +
URLs reach `client/src/audio.generated.ts` (`VOICE_FILES` + `VOICE_META`), and rebuild.

**Client.** `intro.ts` reads `VOICE_META`: each subtitle holds for `durationMs + 1.5s`,
and plays its clip on the transition via `playVoice()` in `audio.ts` (a one-shot voice
buffer cache parallel to SFX; `stopVoice()` cuts it on skip/teardown). **Fallback:** a
clip whose duration isn't baked yet uses the original fixed cadence and plays silently —
so a clean clone (no voice generated) runs the intro exactly as before; voice + clip-paced
timing activate only once you generate. The drift gate treats a missing voice `.mp3` as a
WARN (like music).
