"""
Core generation engine for the ElevenLabs voice pipeline.

Mirrors scripts/sunoapi/core.py: generate one / generate-all / list, with --dry-run
(zero network), --force, and the same exit-code contract
(0 ok · 1 usage · 2 auth · 3 API · 4 integrity).
"""

import sys
import json
import shutil
import argparse
from typing import List

from elevenlabs.manifest import (
    VoiceAsset,
    load_voice_assets,
    find,
    status,
    write_duration_ms,
    DEFAULT_VOICE_ID,
)
from elevenlabs.paths import raw_dir, raw_clip_path, raw_meta_path, target_path
from elevenlabs.client import (
    VoiceAuthError,
    VoiceApiError,
    build_payload,
    synthesize,
    measure_mp3_duration_ms,
    OUTPUT_FORMAT,
)


def _generate_one(asset: VoiceAsset, opts: argparse.Namespace) -> None:
    """Generate (or reuse) a single voice clip, then bake its duration into the manifest."""
    target = target_path(asset.output)
    voice_id = opts.voice or asset.resolved_voice_id()
    model = opts.model or asset.resolved_model()
    payload = build_payload(asset.text, model)

    # Skip if the target exists and not --force.
    if target.exists() and not opts.force:
        print(f"[skip] {asset.key} exists; --force to overwrite")
        return

    # Dry-run: print the exact request, ZERO network calls.
    if opts.dry_run:
        print(f"\n[dry-run] VOICE {asset.key}")
        print(f"METHOD: POST /v1/text-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}")
        print(f"VOICE:  {voice_id}   MODEL: {model}")
        print(f'TEXT:   "{asset.text}"')
        print(f"BODY:\n{json.dumps(payload, indent=2, ensure_ascii=False)}")
        print(f"Target: {target}")
        print("DRY RUN — no request sent, 0 credits spent\n")
        return

    # Real generation: synthesize → write raw → place → measure → bake duration.
    print(f"[generate] {asset.key} ({len(asset.text)} chars)...")
    raw = raw_dir(asset.key)
    raw.mkdir(parents=True, exist_ok=True)

    mp3, request_id = synthesize(voice_id, payload)

    raw_clip = raw_clip_path(asset.key)
    raw_clip.write_bytes(mp3)

    duration_ms = measure_mp3_duration_ms(mp3)

    meta = {
        "key": asset.key,
        "voiceId": voice_id,
        "model": model,
        "output_format": OUTPUT_FORMAT,
        "request_body": payload,
        "request_id": request_id,
        "bytes": len(mp3),
        "durationMs": duration_ms,
    }
    with open(raw_meta_path(asset.key), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    # Place into the committed target.
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(raw_clip, target)
    print(f"  Wrote {target} ({len(mp3)} bytes, {duration_ms} ms)")

    # Bake the measured duration into the manifest (the client paces subtitles on it).
    if duration_ms > 0:
        write_duration_ms(asset.key, duration_ms)
        print(f"  Baked durationMs={duration_ms} into manifest for {asset.key}")
    else:
        print(
            f"  WARN: could not measure duration for {asset.key} "
            f"(durationMs left as-is); the client will fall back to fixed timing",
            file=sys.stderr,
        )


def run(argv: List[str]) -> int:
    """Main generation engine. Returns an exit code (0 ok · 1 usage · 2 auth · 3 API · 4 integrity)."""
    parser = argparse.ArgumentParser(
        prog="generate-voice",
        description="Generate intro narration clips via the ElevenLabs TTS API.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--key", help="Single voice key to generate (e.g. intro_vo_1)")
    group.add_argument("--generate-all", action="store_true", help="Generate every voice clip")
    group.add_argument("--list", action="store_true", help="List every voice asset and its status")

    parser.add_argument("--dry-run", action="store_true", help="Print the request without spending credits")
    parser.add_argument("--force", action="store_true", help="Regenerate even if the target exists")
    parser.add_argument(
        "--voice",
        help=f"Override the ElevenLabs voice id (default per-entry, else {DEFAULT_VOICE_ID})",
    )
    parser.add_argument("--model", help="Override the ElevenLabs model (default per-entry, else eleven_v3)")
    parser.add_argument(
        "--only",
        choices=["must", "nice"],
        help="Filter by priority (for --generate-all)",
    )

    try:
        opts = parser.parse_args(argv)
    except SystemExit:
        return 1

    try:
        if opts.list:
            for asset in load_voice_assets():
                gen = status(asset)
                dur = f"{asset.durationMs}ms" if asset.durationMs else "—"
                print(
                    f"  {asset.key:<14} {asset.priority:<6} {gen:<10} {dur:<8} "
                    f"{target_path(asset.output)}"
                )
            return 0

        if opts.generate_all:
            assets = load_voice_assets()
            if opts.only:
                assets = [a for a in assets if a.priority == opts.only]
            for asset in assets:
                _generate_one(asset, opts)
            return 0

        if opts.key:
            asset = find(opts.key)
            if not asset:
                print(f"Voice asset not found: {opts.key}", file=sys.stderr)
                return 4
            _generate_one(asset, opts)
            return 0

    except VoiceAuthError as e:
        print(f"Auth error: {e}", file=sys.stderr)
        return 2
    except VoiceApiError as e:
        print(f"API error: {e}", file=sys.stderr)
        return 3
    except ValueError as e:
        print(f"Manifest error: {e}", file=sys.stderr)
        return 4
    except Exception as e:  # pragma: no cover - defensive
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 3

    return 0
