"""
Core generation and swap engines for the Suno pipeline.

Handles: generate (skip/dry-run/force/place), generate-all, swap, with proper exit codes.
"""

import sys
import json
import argparse
import shutil
from pathlib import Path
from typing import Optional, List

from sunoapi.manifest import Asset, load_assets, find, status
from sunoapi.compose import load_theme, compose_music, compose_sfx
from sunoapi.paths import raw_dir, raw_sample_path, raw_meta_path, target_path
from sunoapi.client import (
    SunoAuthError,
    SunoApiError,
    SunoTerminalError,
    SunoShapeError,
    get_credits,
    submit_music,
    submit_sounds,
    poll,
    download,
)


def _generate_one(asset: Asset, opts: argparse.Namespace, kind: str) -> None:
    """
    Generate a single asset or reuse raw samples.

    Args:
        asset: Asset to generate.
        opts: Parsed command-line options.
        kind: 'music' or 'sfx'.
    """
    target = target_path(asset.output)
    raw = raw_dir(asset.key)

    # Skip if target exists and not --force
    if target.exists() and not opts.force:
        print(f"[skip] {asset.key} exists; --force to overwrite")
        return

    # Load theme for composition
    theme = load_theme()

    # Compose request body
    if kind == "music":
        body = compose_music(theme, asset)
    else:  # sfx
        body = compose_sfx(theme, asset)

        # Apply CLI overrides for SFX
        if opts.loop is not None:
            body["soundLoop"] = opts.loop
        if opts.tempo is not None:
            body["soundTempo"] = opts.tempo
        if opts.sound_key is not None:
            body["soundKey"] = opts.sound_key

    # Dry-run: print and return (ZERO network calls)
    if opts.dry_run:
        print(f"\n[dry-run] {kind.upper()} {asset.key}")
        print(f"METHOD: POST /api/v1/generate{'/' + ('sounds' if kind == 'sfx' else '')}")
        print(f"BODY:\n{json.dumps(body, indent=2)}")
        print(f"Raw staging: {raw}/")
        print(f"Target: {target}")
        print("DRY RUN — no request sent, 0 credits spent\n")
        return

    # Raw-reuse: if both samples already exist and not --force, copy sample #<--sample> to target
    sample1 = raw_sample_path(asset.key, 1)
    sample2 = raw_sample_path(asset.key, 2)
    if sample1.exists() and sample2.exists() and not opts.force:
        print(
            f"[reuse] {asset.key} raw samples exist; copying sample #{opts.sample} to target (no credits spent)"
        )
        shutil.copyfile(raw_sample_path(asset.key, opts.sample), target)
        return

    # Real generation: submit -> poll -> download -> place
    print(f"[generate] {asset.key}...")
    try:
        if kind == "music":
            task_id = submit_music(body)
        else:
            task_id = submit_sounds(body)

        print(f"  Task ID: {task_id}")

        # Poll with theme's configured interval/timeout
        poll_interval = theme.get("pollIntervalSec", 12)
        poll_timeout = theme.get("pollTimeoutSec", 480)
        result = poll(task_id, kind, interval=poll_interval, timeout=poll_timeout)

        # Download samples
        raw.mkdir(parents=True, exist_ok=True)
        for idx, url in enumerate(result.sample_urls, 1):
            dest = raw_sample_path(asset.key, idx)
            print(f"  Downloading sample {idx}...")
            download(url, dest)

        # Write provenance JSON
        meta = {
            "request_body": body,
            "response_raw": result.raw,
            "sample_urls": result.sample_urls,
            "kind": kind,
            "task_id": task_id,
        }
        with open(raw_meta_path(asset.key), "w") as f:
            json.dump(meta, f, indent=2)

        # Copy sample #<--sample> to target
        shutil.copyfile(raw_sample_path(asset.key, opts.sample), target)
        print(f"  Wrote {target}")

    except SunoTerminalError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        sys.exit(3)
    except SunoApiError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        sys.exit(3)


def run(kind: str, argv: List[str]) -> int:
    """
    Main generation engine.

    Args:
        kind: 'music' or 'sfx'.
        argv: command-line arguments (not including program name).

    Returns:
        Exit code (0 ok, 1 usage, 2 auth, 3 API, 4 integrity).
    """
    parser = argparse.ArgumentParser(
        prog=f"generate-{kind}",
        description=f"Generate {kind} assets via Suno API.",
    )

    # Mutually exclusive group: --key | --generate-all | --list | --credits
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--key", help=f"Single {kind} key to generate")
    group.add_argument(
        "--generate-all", action="store_true", help=f"Generate all {kind} assets"
    )
    group.add_argument(
        "--list", action="store_true", help=f"List all {kind} assets and their status"
    )
    group.add_argument("--credits", action="store_true", help="Show remaining Suno credits")

    # Optional flags
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print request bodies without spending credits",
    )
    parser.add_argument(
        "--force", action="store_true", help="Regenerate even if target exists"
    )
    parser.add_argument(
        "--sample",
        type=int,
        choices=[1, 2],
        default=1,
        help="Which sample to auto-place (default 1)",
    )
    parser.add_argument(
        "--model",
        help="Override the theme model (music only)",
    )
    parser.add_argument(
        "--only",
        choices=["must", "nice"],
        help="Filter by priority (for --generate-all)",
    )

    # SFX-specific flags
    if kind == "sfx":
        parser.add_argument(
            "--loop",
            action="store_true",
            dest="loop",
            help="Override soundLoop to True",
        )
        parser.add_argument(
            "--no-loop",
            action="store_false",
            dest="loop",
            help="Override soundLoop to False",
        )
        parser.set_defaults(loop=None)
        parser.add_argument(
            "--tempo",
            type=int,
            help="Override soundTempo",
        )
        parser.add_argument(
            "--sound-key",
            help="Override soundKey",
        )

    try:
        opts = parser.parse_args(argv)
    except SystemExit:
        return 1

    try:
        # --list: print asset status (no auth needed)
        if opts.list:
            assets = load_assets(kind=kind)
            for asset in assets:
                gen_status = status(asset)
                target = target_path(asset.output)
                print(
                    f"  {asset.key:<30} {asset.priority:<6} {gen_status:<12} {target}"
                )
            return 0

        # --credits: fetch and print
        if opts.credits:
            try:
                credits = get_credits()
                print(f"Remaining credits: {credits}")
                return 0
            except SunoAuthError as e:
                print(f"Auth error: {e}", file=sys.stderr)
                return 2

        # --generate-all: iterate and generate
        if opts.generate_all:
            assets = load_assets(kind=kind)
            if opts.only:
                assets = [a for a in assets if a.priority == opts.only]
            for asset in assets:
                _generate_one(asset, opts, kind)
            return 0

        # --key: single asset
        if opts.key:
            asset = find(opts.key)
            if not asset:
                print(f"Asset not found: {opts.key}", file=sys.stderr)
                return 4
            if asset.kind != kind:
                print(
                    f"Asset {opts.key} is {asset.kind}, not {kind}",
                    file=sys.stderr,
                )
                return 4
            _generate_one(asset, opts, kind)
            return 0

    except SunoAuthError as e:
        print(f"Auth error: {e}", file=sys.stderr)
        return 2
    except SunoApiError as e:
        print(f"API error: {e}", file=sys.stderr)
        return 3
    except ValueError as e:
        print(f"Manifest error: {e}", file=sys.stderr)
        return 4
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 3

    return 0


def swap(kind: str, argv: List[str]) -> int:
    """
    Swap a generated track: replace target with raw sample or explicit input.

    Args:
        kind: 'music' or 'sfx'.
        argv: command-line arguments.

    Returns:
        Exit code (0 ok, 1 usage, 2 auth, 3 API, 4 integrity).
    """
    parser = argparse.ArgumentParser(
        prog=f"change-{kind}-track",
        description=f"Swap a {kind} track at the target path.",
    )
    parser.add_argument("--key", required=True, help=f"Asset key to swap")
    parser.add_argument("--input", help="Source file path (default: output/<key>/<key>.<sample>.mp3)")
    parser.add_argument(
        "--sample",
        type=int,
        choices=[1, 2],
        default=2,
        help="Which sample to use from raw (default 2)",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Don't create a .bak backup",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen",
    )

    try:
        opts = parser.parse_args(argv)
    except SystemExit:
        return 1

    try:
        # Validate key exists and is the right kind
        asset = find(opts.key)
        if not asset:
            print(f"Asset not found: {opts.key}", file=sys.stderr)
            return 4
        if asset.kind != kind:
            print(
                f"Asset {opts.key} is {asset.kind}, not {kind}",
                file=sys.stderr,
            )
            return 4

        # Resolve source file
        if opts.input:
            source = Path(opts.input)
        else:
            source = raw_sample_path(opts.key, opts.sample)

        target = target_path(asset.output)

        # Dry-run (before validating source exists)
        if opts.dry_run:
            print(f"[dry-run] swap {asset.key}")
            print(f"  Source: {source}")
            print(f"  Target: {target}")
            if target.exists() and not opts.no_backup:
                print(f"  Backup: {target}.bak")
            return 0

        # Real swap: validate source exists
        if not source.exists():
            print(
                f"Source file not found: {source}; generate first or use --input",
                file=sys.stderr,
            )
            return 4

        # Real swap
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not opts.no_backup:
            backup = target.with_suffix(target.suffix + ".bak")
            shutil.copyfile(target, backup)
            print(f"  Backed up to {backup}")

        shutil.copyfile(source, target)
        print(f"[swap] {opts.key} ← {source}")

        return 0

    except ValueError as e:
        print(f"Manifest error: {e}", file=sys.stderr)
        return 4
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 3

    return 0
