"""
Path resolution for the Suno pipeline.

ONE place for all path math: repo root, theme, manifest, raw staging, target outputs.
"""

from pathlib import Path
import sys


def repo_root() -> Path:
    """
    Resolve the tins2026 repo root by walking up from scripts/sunoapi/.

    Returns the directory that contains scripts/, assets/, client/, server/, etc.
    """
    current = Path(__file__).resolve().parent  # scripts/sunoapi
    while current != current.parent:
        if (current / "scripts" / "sunoapi").exists() and (current / "assets").exists():
            return current
        current = current.parent
    raise RuntimeError(
        "Could not find repo root from " + str(Path(__file__).resolve().parent)
    )


def theme_path() -> Path:
    """Return absolute path to asset-pipeline/theme.json."""
    return repo_root() / "asset-pipeline" / "theme.json"


def manifest_path() -> Path:
    """Return absolute path to asset-pipeline/manifest.json."""
    return repo_root() / "asset-pipeline" / "manifest.json"


def raw_dir(key: str) -> Path:
    """
    Return absolute path to asset-pipeline/output/<key>/.

    This is where raw samples and provenance are staged (gitignored).
    """
    return repo_root() / "asset-pipeline" / "output" / key


def raw_sample_path(key: str, n: int) -> Path:
    """
    Return absolute path to asset-pipeline/output/<key>/<key>.<n>.mp3.

    Args:
        key: asset key (e.g. 'robot_alert', 'title_theme')
        n: sample number (1 or 2)
    """
    return raw_dir(key) / f"{key}.{n}.mp3"


def raw_meta_path(key: str) -> Path:
    """
    Return absolute path to asset-pipeline/output/<key>/<key>.json.

    This stores request body, response raw, sample URLs, and generation metadata.
    """
    return raw_dir(key) / f"{key}.json"


def target_path(output: str) -> Path:
    """
    Resolve a manifest entry's output field to an absolute path.

    Args:
        output: repo-relative output path from manifest (e.g. 'assets/music/title_theme.mp3')

    Returns:
        Absolute path to the target file.
    """
    return repo_root() / output
