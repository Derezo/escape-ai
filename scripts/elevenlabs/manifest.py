"""
Voice manifest loading, validation, and durationMs write-back.

The `voice` array in asset-pipeline/manifest.json is the single source of truth for the
intro narration: each entry's `text` is BOTH the spoken clip and the on-screen subtitle.
This module loads those entries and writes the measured clip duration back into the
manifest (the one field generate-voice.py mutates).
"""

import json
import re
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass

from elevenlabs.paths import manifest_path, target_path

# Default voice id (overridable per-entry via `voiceId`, or per-run via --voice).
DEFAULT_VOICE_ID = "6sFKzaJr574YWVu4UuJF"
# Default ElevenLabs model (overridable per-entry via `model`, or per-run via --model).
DEFAULT_MODEL = "eleven_v3"


@dataclass
class VoiceAsset:
    """A single `voice` manifest entry."""
    key: str
    text: str
    output: str
    priority: str = "nice"
    voiceId: Optional[str] = None
    model: Optional[str] = None
    defaultVolume: Optional[float] = None
    durationMs: Optional[int] = None
    trigger: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VoiceAsset":
        return cls(
            key=d.get("key"),
            text=d.get("text"),
            output=d.get("output"),
            priority=d.get("priority", "nice"),
            voiceId=d.get("voiceId"),
            model=d.get("model"),
            defaultVolume=d.get("defaultVolume"),
            durationMs=d.get("durationMs"),
            trigger=d.get("trigger"),
        )

    def resolved_voice_id(self) -> str:
        return self.voiceId or DEFAULT_VOICE_ID

    def resolved_model(self) -> str:
        return self.model or DEFAULT_MODEL


def _read_manifest() -> Dict[str, Any]:
    with open(manifest_path()) as f:
        return json.load(f)


def load_voice_assets() -> List[VoiceAsset]:
    """
    Load every `voice` entry from the manifest, validated.

    Raises:
        ValueError if the manifest is malformed.
    """
    manifest = _read_manifest()
    assets = [VoiceAsset.from_dict(e) for e in manifest.get("voice", [])]
    _validate(assets)
    return assets


def find(key: str) -> Optional[VoiceAsset]:
    """Find a voice asset by key, or None."""
    for a in load_voice_assets():
        if a.key == key:
            return a
    return None


def status(asset: VoiceAsset) -> str:
    """'generated' if the target mp3 exists, else 'missing'."""
    return "generated" if target_path(asset.output).exists() else "missing"


def _validate(assets: List[VoiceAsset]) -> None:
    keys = [a.key for a in assets]
    if len(keys) != len(set(keys)):
        raise ValueError(f"Duplicate voice keys in manifest: {keys}")
    for a in assets:
        if not a.key:
            raise ValueError("A voice entry is missing 'key'")
        if not a.text:
            raise ValueError(f"Voice entry {a.key} is missing 'text'")
        if not a.output or not a.output.startswith("assets/voice/"):
            raise ValueError(
                f"Voice entry {a.key} output must be under assets/voice/; got {a.output!r}"
            )
        if not a.output.endswith(".mp3"):
            raise ValueError(f"Voice entry {a.key} output must end .mp3; got {a.output!r}")


def write_duration_ms(key: str, duration_ms: int) -> None:
    """
    Write `durationMs` for one voice key back into the manifest with a SURGICAL in-place
    text edit — only the one `"durationMs": <old>` line inside that key's block changes.

    Why not json.dump the whole file: the manifest has intentional blank lines between
    sections/entries that a full re-serialize would strip, producing a noisy diff. We
    locate the target key's object span and rewrite just its durationMs literal, leaving
    every other byte (and all formatting) untouched. The codegen reads durationMs into
    the client's VOICE_META, so re-run `npm run audio` after this.
    """
    p: Path = manifest_path()
    text = p.read_text()

    # Verify the key exists (and is a voice key) before touching anything.
    asset = find(key)
    if asset is None:
        raise ValueError(f"Voice key not found in manifest: {key}")

    # Find the entry object whose "key": "<key>" appears, then rewrite the FIRST
    # "durationMs": <literal> that follows it within the same object (before the next
    # entry's "key"). The voice block uses unique keys, so anchoring on the key string
    # is unambiguous.
    key_anchor = re.search(r'"key"\s*:\s*"' + re.escape(key) + r'"', text)
    if key_anchor is None:
        raise ValueError(f"Could not locate \"key\": \"{key}\" in manifest text")

    # Search for the durationMs field from the key anchor onward. Bound the search to
    # the next "key": occurrence so we never bleed into a neighbouring entry.
    rest = text[key_anchor.end():]
    next_key = re.search(r'"key"\s*:', rest)
    bound = next_key.start() if next_key else len(rest)
    window = rest[:bound]

    dur_re = re.compile(r'("durationMs"\s*:\s*)(null|-?\d+)')
    m = dur_re.search(window)
    if m is None:
        raise ValueError(
            f"Voice entry {key} has no \"durationMs\" field to update — add it (null) first"
        )

    new_window = window[:m.start()] + f'{m.group(1)}{int(duration_ms)}' + window[m.end():]
    new_text = text[:key_anchor.end()] + new_window + rest[bound:]
    p.write_text(new_text)
