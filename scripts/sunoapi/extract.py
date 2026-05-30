"""
Extract and validate Suno API response data.

HAR-verified: both music and SFX return data.response.sunoData as an array.
Each item has audioUrl (the downloadable MP3).
"""

from typing import List, Optional, Any, Dict
from dataclasses import dataclass
import json


TERMINAL_FAIL = {"CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR", "CALLBACK_EXCEPTION"}


@dataclass
class PollResult:
    """Result of a successful poll."""
    task_id: str
    status: str
    sample_urls: List[str]
    raw: Dict[str, Any]


def extract_samples(kind: str, response: Optional[Dict[str, Any]]) -> List[str]:
    """
    Extract audioUrl list from a Suno API response.

    HAR-verified: both music and SFX return data.response.sunoData[].audioUrl.

    Args:
        kind: 'music' or 'sfx' (for error context).
        response: the 'response' field from a SUCCESS status response.

    Returns:
        List of audioUrl strings (typically 2, but tolerates 1 for SFX).

    Raises:
        SunoShapeError if the expected array is missing or empty (on SUCCESS).
    """
    from sunoapi.client import SunoShapeError
    from sunoapi.paths import raw_meta_path

    if not response:
        raise SunoShapeError(f"No response data for {kind}; API shape may have changed")

    suno_data = response.get("sunoData", [])
    if not isinstance(suno_data, list):
        raise SunoShapeError(
            f"Expected sunoData to be a list for {kind}, got {type(suno_data).__name__}; "
            f"see raw dump and patch extract.py"
        )

    urls = [it.get("audioUrl") for it in suno_data if it.get("audioUrl")]

    if not urls:
        raise SunoShapeError(
            f"No audioUrl found in sunoData for {kind}; response shape may have changed; "
            f"raw dump saved to provenance JSON — patch extract.py"
        )

    return urls
