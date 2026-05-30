"""
Manifest (asset inventory) loading and validation.

The manifest is the single source of truth for all audio assets.
Consumed by both Python generator and Node codegen.
"""

import json
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass


@dataclass
class Asset:
    """A single audio asset from the manifest."""
    key: str
    kind: str  # 'music' or 'sfx'
    priority: str  # 'must' or 'nice'
    trigger: str
    output: str
    descriptor: str
    title: Optional[str] = None
    # Music-specific
    model: Optional[str] = None
    instrumental: Optional[bool] = None
    loop: Optional[bool] = None
    durationHint: Optional[int] = None
    styleWeight: Optional[float] = None
    weirdnessConstraint: Optional[float] = None
    # SFX-specific
    soundLoop: Optional[bool] = None
    soundTempo: Optional[int] = None
    soundKey: Optional[str] = None
    placeholder: Optional[str] = None
    # Common
    defaultVolume: Optional[float] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Asset":
        """Create an Asset from a manifest entry dict."""
        return cls(
            key=d.get("key"),
            kind=d.get("kind"),
            priority=d.get("priority"),
            trigger=d.get("trigger"),
            output=d.get("output"),
            descriptor=d.get("descriptor"),
            title=d.get("title"),
            model=d.get("model"),
            instrumental=d.get("instrumental"),
            loop=d.get("loop"),
            durationHint=d.get("durationHint"),
            styleWeight=d.get("styleWeight"),
            weirdnessConstraint=d.get("weirdnessConstraint"),
            soundLoop=d.get("soundLoop"),
            soundTempo=d.get("soundTempo"),
            soundKey=d.get("soundKey"),
            placeholder=d.get("placeholder"),
            defaultVolume=d.get("defaultVolume"),
        )


def load_assets(kind: Optional[str] = None) -> List[Asset]:
    """
    Load all assets from manifest.json.

    Args:
        kind: if set, filter by 'music' or 'sfx'; if None, return all.

    Returns:
        List of Asset objects.

    Raises:
        ValueError if manifest is malformed.
    """
    from sunoapi.paths import manifest_path

    with open(manifest_path()) as f:
        manifest = json.load(f)

    assets = []

    for entry in manifest.get("music", []):
        asset = Asset.from_dict(entry)
        asset.kind = "music"
        if kind is None or asset.kind == kind:
            assets.append(asset)

    for entry in manifest.get("sfx", []):
        asset = Asset.from_dict(entry)
        asset.kind = "sfx"
        if kind is None or asset.kind == kind:
            assets.append(asset)

    _validate_assets(assets)
    return assets


def find(key: str) -> Optional[Asset]:
    """
    Find an asset by key.

    Args:
        key: asset key

    Returns:
        Asset or None if not found.
    """
    for asset in load_assets():
        if asset.key == key:
            return asset
    return None


def status(asset: Asset) -> str:
    """
    Check if an asset has been generated.

    Args:
        asset: Asset object

    Returns:
        'generated' if the target file exists, 'missing' otherwise.
    """
    from sunoapi.paths import target_path

    target = target_path(asset.output)
    return "generated" if target.exists() else "missing"


def _validate_assets(assets: List[Asset]) -> None:
    """
    Validate the asset list for integrity.

    Raises:
        ValueError if validation fails.
    """
    from sunoapi.paths import target_path

    # Check for unique keys
    keys = [a.key for a in assets]
    if len(keys) != len(set(keys)):
        raise ValueError(f"Duplicate asset keys in manifest: {keys}")

    # Check for output path validity
    for asset in assets:
        output = asset.output
        if not output.startswith("assets/"):
            raise ValueError(
                f"Asset {asset.key} output must start with 'assets/'; got {output}"
            )
        if asset.kind == "music" and not output.startswith("assets/music/"):
            raise ValueError(
                f"Music asset {asset.key} output must be under assets/music/; got {output}"
            )
        if asset.kind == "sfx" and not output.startswith("assets/sfx/"):
            raise ValueError(
                f"SFX asset {asset.key} output must be under assets/sfx/; got {output}"
            )

    # Check that all SFX have a placeholder
    for asset in assets:
        if asset.kind == "sfx" and not asset.placeholder:
            raise ValueError(
                f"SFX asset {asset.key} missing required 'placeholder' field"
            )
