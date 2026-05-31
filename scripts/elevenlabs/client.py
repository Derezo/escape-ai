"""
ElevenLabs text-to-speech client using stdlib urllib.

Handles auth (ELEVENLABS_API_KEY from os.environ), the TTS POST (which returns MP3
bytes directly — no submit/poll like Suno), retry/backoff on rate limits, and a
zero-dependency MP3 duration measurer (frame-header parse — no ffmpeg).
"""

import os
import time
import json
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, Tuple


class VoiceAuthError(Exception):
    """Raised when ELEVENLABS_API_KEY is missing or invalid."""
    pass


class VoiceApiError(Exception):
    """Raised on API errors or network issues (after retries)."""
    pass


BASE_URL = "https://api.elevenlabs.io"
OUTPUT_FORMAT = "mp3_44100_128"
TIMEOUT_SEC = 120
MAX_RETRIES = 4
RETRY_SLEEP_SEC = 2  # exponential backoff base, doubled each retry, capped

# Cinematic delivery defaults (documentary gravitas). eleven_v3 ignores
# use_speaker_boost; we omit it for v3 (added only for older models).
DEFAULT_VOICE_SETTINGS = {
    "stability": 0.6,
    "similarity_boost": 0.78,
    "style": 0.12,
    "speed": 0.92,
}


def _api_key() -> str:
    """
    Read ELEVENLABS_API_KEY from os.environ.

    Raises:
        VoiceAuthError if missing/empty.
    """
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise VoiceAuthError(
            "set the ELEVENLABS_API_KEY system env var; it is NOT read from a repo .env"
        )
    return key


def build_payload(text: str, model_id: str) -> Dict[str, Any]:
    """
    Build the TTS request body. eleven_v3 omits use_speaker_boost (unsupported);
    older models include it.
    """
    settings = dict(DEFAULT_VOICE_SETTINGS)
    if model_id != "eleven_v3":
        settings["use_speaker_boost"] = True
    return {
        "text": text,
        "model_id": model_id,
        "voice_settings": settings,
    }


def synthesize(voice_id: str, payload: Dict[str, Any]) -> Tuple[bytes, str]:
    """
    POST to /v1/text-to-speech/<voice_id> and return (mp3_bytes, request_id).

    Retries on 429/5xx with exponential backoff. Surfaces clear messages for 401
    (auth) and 422 (validation).

    Raises:
        VoiceAuthError on missing key or HTTP 401.
        VoiceApiError on validation/other HTTP/network errors after retries.
    """
    key = _api_key()
    url = f"{BASE_URL}/v1/text-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}"
    data_bytes = json.dumps(payload).encode("utf-8")

    delay = RETRY_SLEEP_SEC
    last_err: Optional[str] = None

    for attempt in range(MAX_RETRIES + 1):
        req = urllib.request.Request(
            url,
            data=data_bytes,
            method="POST",
            headers={
                "xi-api-key": key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                body = resp.read()
                request_id = resp.headers.get("request-id", "") or ""
                if not body:
                    last_err = "empty response body"
                    raise urllib.error.URLError("empty body")
                return body, request_id
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code == 401:
                raise VoiceAuthError(
                    "HTTP 401: ElevenLabs rejected ELEVENLABS_API_KEY (check it's valid "
                    "and has text_to_speech permission)"
                )
            if e.code == 422:
                raise VoiceApiError(f"HTTP 422 (validation): {_detail(err_body)}")
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                last_err = f"HTTP {e.code}"
                time.sleep(delay)
                delay = min(delay * 2, 32)
                continue
            raise VoiceApiError(f"HTTP {e.code}: {_detail(err_body)}")
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                last_err = f"network: {e}"
                time.sleep(delay)
                delay = min(delay * 2, 32)
                continue
            raise VoiceApiError(f"Network error after retries: {e}")

    raise VoiceApiError(f"Failed after {MAX_RETRIES + 1} attempts ({last_err})")


def _detail(body: str) -> str:
    """Pull a human message out of an ElevenLabs JSON error body if present."""
    try:
        d = json.loads(body)
        detail = d.get("detail", d)
        if isinstance(detail, dict):
            return detail.get("message", json.dumps(detail))
        return str(detail)
    except Exception:
        return body[:300]


# ---------------------------------------------------------------------------
# MP3 duration measurement — zero dependencies (no ffmpeg/mutagen).
# ---------------------------------------------------------------------------
#
# We sum each MPEG audio frame's duration by walking frame headers. This handles the
# CBR/VBR 44.1kHz MP3s ElevenLabs returns. An ID3v2 tag (if any) is skipped first.

# [version_index][bitrate_index] → kbps. version_index: 3=MPEG1, 2=MPEG2, 0=MPEG2.5.
_BITRATES = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],   # MPEG1 L3
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],        # MPEG2 L3
    0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],        # MPEG2.5 L3
}
# [version_index][sample_rate_index] → Hz.
_SAMPLE_RATES = {
    3: [44100, 48000, 32000, 0],
    2: [22050, 24000, 16000, 0],
    0: [11025, 12000, 8000, 0],
}
_SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}  # MPEG1 L3 vs MPEG2/2.5 L3


def measure_mp3_duration_ms(data: bytes) -> int:
    """
    Return the duration of an MP3 byte string in milliseconds, by summing frame
    durations. Best-effort: returns 0 if no valid frames are found (caller can fall
    back). Pure stdlib — no external tools.
    """
    i = 0
    n = len(data)

    # Skip an ID3v2 tag if present ("ID3" + version(2) + flags(1) + size(4, syncsafe)).
    if n >= 10 and data[0:3] == b"ID3":
        size = (
            (data[6] & 0x7F) << 21
            | (data[7] & 0x7F) << 14
            | (data[8] & 0x7F) << 7
            | (data[9] & 0x7F)
        )
        i = 10 + size

    total_seconds = 0.0
    frames = 0
    while i + 4 <= n:
        # Frame sync: 11 bits set (0xFFE).
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        b1 = data[i + 1]
        b2 = data[i + 2]
        version_index = (b1 >> 3) & 0x03  # 3=MPEG1, 2=MPEG2, 0=MPEG2.5 (1=reserved)
        layer = (b1 >> 1) & 0x03          # 1 == Layer III
        bitrate_index = (b2 >> 4) & 0x0F
        sr_index = (b2 >> 2) & 0x03
        padding = (b2 >> 1) & 0x01

        if (
            version_index == 1
            or layer != 1
            or bitrate_index in (0, 15)
            or sr_index == 3
            or version_index not in _BITRATES
        ):
            i += 1
            continue

        bitrate = _BITRATES[version_index][bitrate_index] * 1000
        sample_rate = _SAMPLE_RATES[version_index][sr_index]
        if bitrate <= 0 or sample_rate <= 0:
            i += 1
            continue

        spf = _SAMPLES_PER_FRAME[version_index]
        frame_len = int((spf // 8) * bitrate / sample_rate) + padding
        if frame_len <= 0:
            i += 1
            continue

        total_seconds += spf / sample_rate
        frames += 1
        i += frame_len

    if frames == 0:
        return 0
    return int(round(total_seconds * 1000))
