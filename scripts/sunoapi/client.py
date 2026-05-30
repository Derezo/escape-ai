"""
Suno API client using stdlib urllib.

Handles auth (SUNOAPI_KEY from os.environ), POST/GET, retries, downloads.
"""

import os
import json
import time
import urllib.request
import urllib.error
from typing import Optional, Any, Dict
from pathlib import Path


class SunoAuthError(Exception):
    """Raised when SUNOAPI_KEY is missing or invalid."""
    pass


class SunoApiError(Exception):
    """Raised on API errors or network issues (after retries)."""
    pass


class SunoTerminalError(Exception):
    """Raised when the generation task hits a terminal failure status."""
    pass


class SunoShapeError(Exception):
    """Raised when the API response shape is unexpected (e.g., missing audioUrl)."""
    pass


BASE_URL = "https://api.sunoapi.org"
TIMEOUT_SEC = 30
MAX_RETRIES = 1
RETRY_SLEEP_SEC = 6


def _api_key() -> str:
    """
    Read SUNOAPI_KEY from os.environ.

    Raises:
        SunoAuthError if the key is missing or empty.
    """
    key = os.environ.get("SUNOAPI_KEY", "").strip()
    if not key:
        raise SunoAuthError(
            "set the SUNOAPI_KEY system env var; it is NOT read from a repo .env"
        )
    return key


def _post(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """
    POST a JSON body to the Suno API.

    Args:
        path: API endpoint (e.g. '/api/v1/generate')
        body: request body dict

    Returns:
        Parsed response.data (the nested 'data' field from the envelope).

    Raises:
        SunoAuthError if SUNOAPI_KEY is missing.
        SunoApiError on HTTP or envelope errors.
    """
    key = _api_key()
    url = BASE_URL + path
    data_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )

    for attempt in range(MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                if resp.status != 200:
                    raise SunoApiError(f"HTTP {resp.status}")
                response_data = json.loads(resp.read().decode("utf-8"))
                break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                time.sleep(RETRY_SLEEP_SEC)
                continue
            raise SunoApiError(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}")
        except urllib.error.URLError as e:
            raise SunoApiError(f"Network error: {e}")
        except json.JSONDecodeError as e:
            raise SunoApiError(f"Invalid JSON in response: {e}")

    if response_data.get("code") != 200:
        msg = response_data.get("msg", "Unknown error")
        raise SunoApiError(f"API error {response_data.get('code')}: {msg}")

    return response_data.get("data", {})


def _get(path: str, params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """
    GET from the Suno API.

    Args:
        path: API endpoint
        params: query parameters (e.g. {'taskId': '...'})

    Returns:
        Parsed response.data.

    Raises:
        SunoAuthError if SUNOAPI_KEY is missing.
        SunoApiError on HTTP or envelope errors.
    """
    key = _api_key()
    url = BASE_URL + path

    if params:
        from urllib.parse import urlencode
        url += "?" + urlencode(params)

    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {key}"},
    )

    for attempt in range(MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                if resp.status != 200:
                    raise SunoApiError(f"HTTP {resp.status}")
                response_data = json.loads(resp.read().decode("utf-8"))
                break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                time.sleep(RETRY_SLEEP_SEC)
                continue
            raise SunoApiError(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}")
        except urllib.error.URLError as e:
            raise SunoApiError(f"Network error: {e}")
        except json.JSONDecodeError as e:
            raise SunoApiError(f"Invalid JSON in response: {e}")

    if response_data.get("code") != 200:
        msg = response_data.get("msg", "Unknown error")
        raise SunoApiError(f"API error {response_data.get('code')}: {msg}")

    return response_data.get("data", {})


def get_credits() -> int:
    """
    Fetch the user's remaining Suno credits.

    Returns:
        Credit count (int).

    Raises:
        SunoAuthError if SUNOAPI_KEY is missing.
        SunoApiError on network/API errors.
    """
    data = _get("/api/v1/generate/credit")
    return int(data.get("credits", data) if isinstance(data, dict) else data)


def submit_music(body: Dict[str, Any]) -> str:
    """
    Submit a music generation request.

    Args:
        body: Suno API music request body

    Returns:
        Task ID (taskId from response.data).

    Raises:
        SunoAuthError if SUNOAPI_KEY is missing.
        SunoApiError on network/API errors.
    """
    data = _post("/api/v1/generate", body)
    return data.get("taskId", "")


def submit_sounds(body: Dict[str, Any]) -> str:
    """
    Submit an SFX generation request.

    Args:
        body: Suno API SFX request body

    Returns:
        Task ID (taskId from response.data).

    Raises:
        SunoAuthError if SUNOAPI_KEY is missing.
        SunoApiError on network/API errors.
    """
    data = _post("/api/v1/generate/sounds", body)
    return data.get("taskId", "")


class PollResult:
    """Result of polling a generation task."""

    def __init__(self, task_id: str, status: str, sample_urls: list, raw: dict):
        self.task_id = task_id
        self.status = status
        self.sample_urls = sample_urls
        self.raw = raw


def poll(
    task_id: str,
    kind: str,
    interval: float = 12.0,
    timeout: float = 480.0,
) -> PollResult:
    """
    Poll a generation task until completion or timeout.

    Args:
        task_id: Task ID from submit.
        kind: 'music' or 'sfx' (for error messages only; both use same endpoint).
        interval: seconds between polls.
        timeout: max seconds to wait.

    Returns:
        PollResult with status, sample_urls, and raw response.

    Raises:
        SunoTerminalError if the task hits a terminal failure.
        SunoApiError if timeout is exceeded.
        SunoAuthError if SUNOAPI_KEY is missing.
    """
    from sunoapi.extract import TERMINAL_FAIL, extract_samples

    start_time = time.time()

    while True:
        elapsed = time.time() - start_time
        if elapsed > timeout:
            raise SunoApiError(f"Poll timeout ({timeout}s) for {kind} task {task_id}")

        try:
            data = _get("/api/v1/generate/record-info", {"taskId": task_id})
        except SunoApiError:
            # If we get an API error during polling, sleep and retry
            time.sleep(interval)
            continue

        status = data.get("status", "")

        if status in TERMINAL_FAIL:
            error_msg = data.get("errorMessage", "Unknown error")
            raise SunoTerminalError(
                f"Task {task_id} hit terminal failure: {status} — {error_msg}"
            )

        if status == "SUCCESS":
            sample_urls = extract_samples(kind, data.get("response"))
            return PollResult(task_id, status, sample_urls, data)

        # Still pending; wait and retry
        time.sleep(interval)


def download(url: str, dest: Path) -> None:
    """
    Download a file from URL to dest (atomic: .tmp + rename).

    Args:
        url: URL to download from.
        dest: destination path (Path object).

    Raises:
        SunoApiError on download failure.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")

    try:
        urllib.request.urlretrieve(url, str(tmp))
        tmp.replace(dest)
    except Exception as e:
        if tmp.exists():
            tmp.unlink()
        raise SunoApiError(f"Download failed for {url}: {e}")
