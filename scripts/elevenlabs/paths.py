"""
Path resolution for the ElevenLabs voice pipeline.

ONE place for path math: repo root, manifest, raw staging, target outputs. Mirrors
scripts/sunoapi/paths.py (and deliberately reuses the SAME asset-pipeline/output/
staging dir and asset-pipeline/manifest.json single source of truth).
"""

from pathlib import Path


def repo_root() -> Path:
    """
    Resolve the tins2026 repo root by walking up from scripts/elevenlabs/.

    Returns the directory that contains scripts/, assets/, client/, server/, etc.
    """
    current = Path(__file__).resolve().parent  # scripts/elevenlabs
    while current != current.parent:
        if (current / "scripts" / "elevenlabs").exists() and (current / "assets").exists():
            return current
        current = current.parent
    raise RuntimeError(
        "Could not find repo root from " + str(Path(__file__).resolve().parent)
    )


def manifest_path() -> Path:
    """Return absolute path to asset-pipeline/manifest.json (shared single source of truth)."""
    return repo_root() / "asset-pipeline" / "manifest.json"


def raw_dir(key: str) -> Path:
    """
    Return absolute path to asset-pipeline/output/<key>/ (gitignored raw staging).

    Shared with the Suno pipeline's staging dir; voice keys (intro_vo_*) don't collide
    with music/sfx keys.
    """
    return repo_root() / "asset-pipeline" / "output" / key


def raw_clip_path(key: str) -> Path:
    """Return absolute path to asset-pipeline/output/<key>/<key>.mp3 (raw clip)."""
    return raw_dir(key) / f"{key}.mp3"


def raw_meta_path(key: str) -> Path:
    """
    Return absolute path to asset-pipeline/output/<key>/<key>.json.

    Stores the request body, response metadata (status, request-id, byte size), and the
    measured duration — the ground-truth provenance for a generated clip.
    """
    return raw_dir(key) / f"{key}.json"


def target_path(output: str) -> Path:
    """
    Resolve a manifest entry's output field to an absolute path.

    Args:
        output: repo-relative output path (e.g. 'assets/voice/intro_vo_1.mp3')
    """
    return repo_root() / output
