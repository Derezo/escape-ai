"""
Compose Suno API request bodies from theme and manifest entries.

Music: instrumental mode, style-based (no prompt), title.
SFX: prompt-based, descriptor-led.
"""

import json
from typing import Dict, Any, Optional
from sunoapi.manifest import Asset


def load_theme() -> Dict[str, Any]:
    """Load theme.json and return the parsed dict."""
    from sunoapi.paths import theme_path

    with open(theme_path()) as f:
        return json.load(f)


def _join_negative_tags(*parts: str) -> str:
    """
    Join comma-separated negative-tag strings, dropping case-insensitive
    duplicates while preserving first-seen order. The shared and per-kind
    palettes deliberately overlap (e.g. both list 'vocals'), so a naive join
    repeats terms; this keeps the tag list tight.
    """
    seen = set()
    out = []
    for part in parts:
        for tag in (t.strip() for t in part.split(",")):
            if tag and tag.lower() not in seen:
                seen.add(tag.lower())
                out.append(tag)
    return ", ".join(out)


def compose_music(theme: Dict[str, Any], asset: Asset) -> Dict[str, Any]:
    """
    Compose a music generation request body.

    Args:
        theme: parsed theme.json
        asset: Asset with music-specific fields

    Returns:
        Suno API request body for music generation.
    """
    # Collect style components from theme palettes
    style_parts = []

    # shared setting descriptors
    style_parts.extend(theme.get("shared", {}).get("settingDescriptors", []))

    # music genre/instrument/mood/energy descriptors
    style_parts.extend(theme.get("music", {}).get("genreDescriptors", []))
    style_parts.extend(theme.get("music", {}).get("instruments", []))
    style_parts.extend(theme.get("music", {}).get("moodDescriptors", []))
    style_parts.extend(theme.get("music", {}).get("energyDescriptors", []))

    # tempo phrase from tempoRange
    tempo_range = theme.get("music", {}).get("tempoRange", {})
    if tempo_range:
        min_tempo = tempo_range.get("min", 50)
        max_tempo = tempo_range.get("max", 80)
        style_parts.append(f"tempo {min_tempo}–{max_tempo} BPM")

    # asset descriptor
    if asset.descriptor:
        style_parts.append(asset.descriptor)

    # duration hint if set
    if asset.durationHint:
        style_parts.append(f"~{asset.durationHint} second seamless loop")

    # Join and cap to 1000 chars
    style = ", ".join(style_parts)
    if len(style) > 1000:
        style = style[:1000].rsplit(",", 1)[0]  # trim trailing partial word
        style = style.rstrip(", ")

    # Collect negative tags (dedup the deliberate shared/music overlap)
    negative_tags = _join_negative_tags(
        theme.get("shared", {}).get("negativeTags", ""),
        theme.get("music", {}).get("negativeTags", ""),
    )

    # Resolve model, instrumental, styleWeight, weirdnessConstraint
    model = asset.model or theme.get("music", {}).get("model", "V4_5PLUS")
    instrumental = asset.instrumental if asset.instrumental is not None else theme.get("music", {}).get("instrumental", True)
    style_weight = asset.styleWeight if asset.styleWeight is not None else theme.get("music", {}).get("styleWeight", 0.65)
    weirdness = asset.weirdnessConstraint if asset.weirdnessConstraint is not None else theme.get("music", {}).get("weirdnessConstraint", 0.35)

    body = {
        "customMode": True,
        "instrumental": instrumental,
        "model": model,
        "style": style,
        "title": asset.title or "",
        "negativeTags": negative_tags,
        "styleWeight": style_weight,
        "weirdnessConstraint": weirdness,
        "callBackUrl": theme.get("callBackUrl", "playground"),
    }

    # NO 'prompt' key when instrumental
    if not instrumental:
        body["prompt"] = asset.descriptor

    return body


def compose_sfx(theme: Dict[str, Any], asset: Asset) -> Dict[str, Any]:
    """
    Compose an SFX generation request body.

    Args:
        theme: parsed theme.json
        asset: Asset with SFX-specific fields

    Returns:
        Suno API request body for SFX generation.
    """
    # Build prompt: descriptor-led, then mood/genre/instruments, cap at 500 chars
    prompt_parts = []

    if asset.descriptor:
        prompt_parts.append(asset.descriptor)

    # Add a couple of SFX mood and genre descriptors for flavor
    sfx_theme = theme.get("sfx", {})
    mood_descriptors = sfx_theme.get("moodDescriptors", [])
    genre_descriptors = sfx_theme.get("genreDescriptors", [])
    instruments = sfx_theme.get("instruments", [])

    if mood_descriptors:
        prompt_parts.append(mood_descriptors[0])
    if genre_descriptors:
        prompt_parts.append(genre_descriptors[0])
    if instruments:
        prompt_parts.append(instruments[0] if len(instruments) > 0 else "")
        if len(instruments) > 1:
            prompt_parts.append(instruments[1])

    # Add a shared setting flavor
    shared_settings = theme.get("shared", {}).get("settingDescriptors", [])
    if shared_settings:
        prompt_parts.append(shared_settings[0])

    prompt = ", ".join([p for p in prompt_parts if p])
    if len(prompt) > 500:
        prompt = prompt[:500].rsplit(",", 1)[0]
        prompt = prompt.rstrip(", ")

    # NOTE: the /generate/sounds endpoint has no `negativeTags` parameter (see the
    # HAR-verified body shape in docs/AUDIO_PIPELINE.md), so the sfx.negativeTags
    # palette is advisory-only for authors — it is not sent. Exclusions for SFX
    # belong inside the descriptor/prompt itself.

    body = {
        "prompt": prompt,
        "model": "V5",  # Required for SFX
        "soundLoop": asset.soundLoop if asset.soundLoop is not None else False,
        "soundKey": asset.soundKey or sfx_theme.get("soundKey", "Any"),
        "callBackUrl": theme.get("callBackUrl", "playground"),
        "grabLyrics": False,
    }

    # Add soundTempo if set in the asset
    if asset.soundTempo is not None:
        body["soundTempo"] = asset.soundTempo

    return body
