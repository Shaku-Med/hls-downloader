#!/usr/bin/env python3
"""
HLS Grabber - Native Messaging Host
Receives m3u8 URLs from the Chrome extension and runs ffmpeg.
Supports multiple JSON messages per connection (use connectNative in the extension).
"""

import sys
import json
import struct
import subprocess
import threading
import os
import re
import time
import hashlib
import tempfile
import shutil
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit, urlunsplit
from typing import Optional, Set, Any, Dict, List, Tuple

DEFAULT_DOWNLOAD_DIR = os.path.abspath(
    os.path.normpath(os.path.expanduser(os.path.join("~", "Downloads", "TOB")))
)
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

_RE_TIME = re.compile(r"time=(\d+):(\d+):(\d+\.?\d*)")
_RE_SPEED = re.compile(r"speed=\s*([\d.]+|N/A)\s*x")
_RE_SIZE = re.compile(r"size=\s*(\S+)")
_SEND_LOCK = threading.Lock()
# Current ffmpeg process; cancel is delivered on stdin while a job is running
_PROC_LOCK = threading.Lock()
_active_ffmpeg: Optional[subprocess.Popen] = None
_CANCEL_EVENT = threading.Event()
_CURRENT_JOB_ID = ""
# Per-job: output path, last known media time (sec) from ffmpeg progress, last message
_JOB_LIVE: Dict[str, Dict[str, Any]] = {}
# When we kill ffmpeg to resume with fresh auth, skip the normal done/error for that run
_SILENCE_FFMPEG_DONE: Set[str] = set()
_REFRESH_LOCK = threading.Lock()
# While the second-pass ffmpeg (after auth refresh) runs, this is the jobId so another refresh can kill it.
_HLS_CONT_ACTIVE_JID: Optional[str] = None
# Each auth-refresh / bump; newer refresh supersedes older _handle() runs
_HLS_REFRESH_SEQ: Dict[str, int] = {}


def _bump_hls_refresh_seq(jid: str) -> int:
    _HLS_REFRESH_SEQ[jid] = _HLS_REFRESH_SEQ.get(jid, 0) + 1
    return _HLS_REFRESH_SEQ[jid]


def _hls_refresh_stale(jid: str, seq: int) -> bool:
    if not seq:
        return True
    return _HLS_REFRESH_SEQ.get(jid) != seq


def get_referer(url):
    from urllib.parse import urlparse
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}/"


def _origin_from_url(page_url):
    from urllib.parse import urlparse
    p = urlparse(page_url)
    if p.scheme and p.netloc:
        return f"{p.scheme}://{p.netloc}"
    return ""


def _cap_headers(caps):
    """Normalize captured header dict to lowercase keys, string values."""
    out = {}
    for k, v in (caps or {}).items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        s = v.strip()
        if s:
            out[k.lower()] = s
    return out


def _http_header_line(name_lower, value):
    """Emit a single header line (HTTP header names are case-insensitive; mimic Chrome)."""
    special = {
        "sec-ch-ua": "Sec-CH-UA",
        "sec-ch-ua-mobile": "Sec-CH-UA-Mobile",
        "sec-ch-ua-platform": "Sec-CH-UA-Platform",
    }
    if name_lower in special:
        disp = special[name_lower]
    else:
        disp = "-".join(
            (p[:1].upper() + p[1:].lower()) if p else "" for p in name_lower.split("-")
        )
    return f"{disp}: {value}\r\n"


def build_ffmpeg_header_block(message, stream_url):
    """
    Match the browser request as closely as possible. Many CDNs return 403 if
    Referer/Origin/User-Agent/Cookie do not match what the player sent.
    Prefer headers captured from webRequest (with extraHeaders) over guesses.
    """
    cap = _cap_headers(message.get("capturedHeaders"))

    referer = cap.get("referer") or (message.get("referer") or "").strip() or get_referer(stream_url)
    ua = (message.get("userAgent") or "").strip() or USER_AGENT
    origin = cap.get("origin") or (message.get("origin") or "").strip() or _origin_from_url(referer)
    cookie = cap.get("cookie") or (message.get("cookie") or "").strip()
    authorization = cap.get("authorization")

    parts = [
        f"Referer: {referer}\r\n",
        f"User-Agent: {ua}\r\n",
    ]
    if origin:
        parts.append(f"Origin: {origin}\r\n")
    if cookie:
        parts.append(f"Cookie: {cookie}\r\n")
    if authorization:
        parts.append(f"Authorization: {authorization}\r\n")

    for key in (
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-fetch-dest",
        "sec-fetch-user",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
    ):
        val = cap.get(key)
        if val:
            parts.append(_http_header_line(key, val))

    parts.append("Accept: */*\r\n")
    return "".join(parts)


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("=I", raw_length)[0]
    if length > 64 * 1024 * 1024:
        return None
    message = sys.stdin.buffer.read(length).decode("utf-8")
    return json.loads(message)


def send_message(data):
    encoded = json.dumps(data).encode("utf-8")
    with _SEND_LOCK:
        sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def with_job_id(data, job_id):
    if job_id:
        d = {**data, "jobId": job_id}
    else:
        d = data
    return d


_WIN_RESERVED = (
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)


def _sanitize_filename_stem(name):
    s = (name or "stream").strip()
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s)
    s = re.sub(r"\s+", "_", s)
    s = s.strip(" ._") or "stream"
    root = s.split(".")[0].lower()
    if root in _WIN_RESERVED:
        s = "_" + s
    return s


def _shorten_stem_for_windows(stem, download_dir, ext=".mp4"):
    """
    Full path must stay under ~260 chars (MAX_PATH) or CreateFile/ffmpeg fail with EINVAL.
    """
    d = os.path.abspath(os.path.normpath(download_dir))
    max_full = 248
    room = max_full - len(d) - len(ext) - 1  # path sep before basename
    room = max(room, 24)
    if len(stem) <= room:
        return stem
    digest = hashlib.sha1(stem.encode("utf-8", errors="replace")).hexdigest()[:12]
    keep = max(1, room - len(digest) - 1)
    return f"{stem[:keep]}_{digest}"


def _safe_output_path(download_dir, filename, ext=".mp4"):
    stem = _sanitize_filename_stem(filename)
    stem = _shorten_stem_for_windows(stem, download_dir, ext)
    return os.path.join(download_dir, f"{stem}{ext}")


def _clear_active_if(p: Optional[subprocess.Popen]) -> None:
    global _active_ffmpeg
    if p is None:
        return
    with _PROC_LOCK:
        if _active_ffmpeg is p:
            _active_ffmpeg = None


def _request_cancel() -> None:
    with _PROC_LOCK:
        p = _active_ffmpeg
    has_proc = p is not None and p.poll() is None
    jid = (_CURRENT_JOB_ID or "").strip()
    if not has_proc and not jid:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "canceled": True,
                    "error": "No active download to cancel",
                    "idle": True,
                },
                _CURRENT_JOB_ID,
            )
        )
        return
    _CANCEL_EVENT.set()
    if not has_proc:
        return
    try:
        p.terminate()
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def _resolve_output_dir(message):
    raw = (message.get("outputDirectory") or message.get("output_dir") or "").strip()
    if not raw:
        return DEFAULT_DOWNLOAD_DIR
    return os.path.abspath(os.path.normpath(os.path.expanduser(raw)))


def _time_hms_to_sec(s: str) -> float:
    m = re.match(r"^(\d+):(\d+):(\d+\.?\d*)$", (s or "").strip())
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _parse_ffmpeg_progress(line):
    out = {}
    m = _RE_TIME.search(line)
    if m:
        out["time"] = f"{m.group(1)}:{m.group(2)}:{m.group(3)}"
        out["tsec"] = _time_hms_to_sec(out["time"])
    m = _RE_SPEED.search(line)
    if m:
        out["speed"] = m.group(1) + "x"
    m = _RE_SIZE.search(line)
    if m:
        out["size"] = m.group(1).strip()
    return out


def _is_hls_input(url: str, message) -> bool:
    u = (url or "").lower()
    if ".m3u8" in u or u.endswith(".m3u") or re.search(r"\.m3u8[?#]", u):
        return True
    sk = (message.get("streamKind") or message.get("stream_kind") or "").strip().lower()
    return sk in ("hls", "apple_hls", "hls_by_header", "m3u8", "m3u")


def _use_hls_aac_bsf(url: str, message) -> bool:
    """HLS fMP4 to .mp4 often needs this; DASH/MP4 direct usually does not."""
    u = (url or "").lower()
    if ".m3u8" in u:
        return True
    sk = (message.get("streamKind") or message.get("stream_kind") or "").strip().lower()
    if sk in ("hls", "apple_hls", "m3u8", "hls_by_header"):
        return True
    if sk in ("direct", "dash", "mpd", "mp4", "webm", "yt", "social", "by_header", "other"):
        return False
    return False


# --- Obfuscated HLS (image-wrapped .ts segments) ---

_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_PNG_IEND = b"IEND\xae\x42\x60\x82"
_JPEG_SIG = b"\xff\xd8\xff"
_GIF_SIG = b"GIF8"
_WEBP_RIFF = b"RIFF"
_WEBP_MAGIC = b"WEBP"


def _headers_dict_from_block(header_block: str) -> Dict[str, str]:
    d: Dict[str, str] = {}
    for line in (header_block or "").split("\r\n"):
        if not line.strip():
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        d[k.strip()] = v.strip()
    return d


def _m3u8_base_url(playlist_url: str) -> str:
    """Directory base for resolving relative segment URIs (RFC 3986 / HLS)."""
    u = urlsplit(playlist_url)
    path = u.path or "/"
    if "/" in path.rstrip("/"):
        dirpath = path.rsplit("/", 1)[0] + "/"
    else:
        dirpath = "/"
    return urlunsplit((u.scheme, u.netloc, dirpath, "", ""))


def _http_get_bytes(
    url: str,
    header_block: str,
    *,
    max_bytes: Optional[int] = None,
    timeout: float = 60.0,
) -> bytes:
    headers = _headers_dict_from_block(header_block)
    req = urllib.request.Request(url, headers=headers, method="GET")
    out = bytearray()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        chunk = 64 * 1024
        while True:
            if max_bytes is not None and len(out) >= max_bytes:
                break
            to_read = chunk
            if max_bytes is not None:
                to_read = min(chunk, max_bytes - len(out))
                if to_read <= 0:
                    break
            b = resp.read(to_read)
            if not b:
                break
            out.extend(b)
    return bytes(out)


def _http_get_text(url: str, header_block: str, timeout: float = 60.0) -> str:
    return _http_get_bytes(url, header_block, max_bytes=None, timeout=timeout).decode(
        "utf-8", errors="replace"
    )


def _is_master_playlist(text: str) -> bool:
    return "#EXT-X-STREAM-INF" in text


def _select_highest_bandwidth_variant_uri(text: str, base_url: str) -> Optional[str]:
    lines = [ln.strip() for ln in text.splitlines()]
    best_bw = -1
    best_uri: Optional[str] = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF"):
            m = re.search(r"BANDWIDTH=(\d+)", line, re.I)
            bw = int(m.group(1)) if m else 0
            uri = None
            j = i + 1
            while j < len(lines):
                ln = lines[j]
                if not ln:
                    j += 1
                    continue
                if ln.startswith("#"):
                    j += 1
                    continue
                uri = ln
                break
            if uri:
                if bw > best_bw:
                    best_bw = bw
                    best_uri = uri
            i = j + 1 if uri else i + 1
            continue
        i += 1
    if best_uri:
        return urljoin(base_url, best_uri)
    # No BANDWIDTH match: first stream URI after any STREAM-INF
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            for j in range(i + 1, len(lines)):
                ln = lines[j]
                if not ln or ln.startswith("#"):
                    continue
                return urljoin(base_url, ln)
            break
    return None


def _resolve_variant_playlist_url(start_url: str, header_block: str) -> Tuple[str, str]:
    """
    Fetch playlist chain; if master, follow highest-bandwidth variant.
    Returns (variant_playlist_url, variant_playlist_text).
    """
    base0 = _m3u8_base_url(start_url)
    text = _http_get_text(start_url, header_block, timeout=45.0)
    cur_url = start_url
    guard = 0
    while _is_master_playlist(text) and guard < 8:
        guard += 1
        var = _select_highest_bandwidth_variant_uri(text, _m3u8_base_url(cur_url))
        if not var:
            break
        cur_url = var
        text = _http_get_text(cur_url, header_block, timeout=45.0)
    return cur_url, text


def _parse_hls_media_segment_uris(playlist_text: str, playlist_url: str) -> List[str]:
    base = _m3u8_base_url(playlist_url)
    out: List[str] = []
    for line in playlist_text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(urljoin(base, s))
    return out


def _looks_like_ts_at(data: bytes, idx: int) -> bool:
    n = len(data)
    if idx < 0 or idx + 376 >= n:
        return False
    return (
        data[idx] == 0x47
        and data[idx + 188] == 0x47
        and data[idx + 376] == 0x47
    )


def _find_mpegts_payload_start(data: bytes, start: int = 0) -> int:
    n = len(data)
    begin = max(0, start)
    last_triple = n - 565
    for i in range(begin, last_triple + 1):
        if _looks_like_ts_at(data, i):
            return i
    for i in range(begin, max(begin, n - 189)):
        if i + 188 < n and data[i] == 0x47 and data[i + 188] == 0x47:
            return i
    return 0


def _strip_png_prefix(data: bytes) -> Optional[bytes]:
    if not data.startswith(_PNG_SIG):
        return None
    idx = data.find(_PNG_IEND)
    if idx < 0:
        return None
    off = idx + len(_PNG_IEND)
    if off <= len(data):
        return data[off:]
    return None


def _strip_jpeg_prefix(data: bytes) -> Optional[bytes]:
    if len(data) < 3 or not data.startswith(_JPEG_SIG):
        return None
    j = data.rfind(b"\xff\xd9")
    if j < 0:
        return None
    off = j + 2
    if off <= len(data):
        return data[off:]
    return None


def _strip_gif_prefix(data: bytes) -> Optional[bytes]:
    if len(data) < 6 or not data.startswith(_GIF_SIG):
        return None
    off = _find_mpegts_payload_start(data, start=6)
    if off > 0:
        return data[off:]
    return None


def _strip_webp_prefix(data: bytes) -> Optional[bytes]:
    if len(data) < 12:
        return None
    if data[0:4] != _WEBP_RIFF or data[8:12] != _WEBP_MAGIC:
        return None
    chunk_size = struct.unpack("<I", data[4:8])[0]
    off = 8 + int(chunk_size)
    if off > len(data):
        return None
    return data[off:]


def _obfuscation_kind_from_magic(data: bytes) -> Optional[str]:
    if len(data) >= 8 and data.startswith(_PNG_SIG):
        return "png"
    if len(data) >= 3 and data.startswith(_JPEG_SIG):
        return "jpeg"
    if len(data) >= 6 and data.startswith(_GIF_SIG):
        return "gif"
    if len(data) >= 12 and data[0:4] == _WEBP_RIFF and data[8:12] == _WEBP_MAGIC:
        return "webp"
    return None


def _extract_ts_payload(data: bytes, hint: Optional[str]) -> bytes:
    """Remove image wrapper if present; otherwise return data or TS slice from generic scan."""
    if not data:
        return data
    if data[0] == 0x47 and _looks_like_ts_at(data, 0):
        return data

    order = []
    if hint in ("png", "jpeg", "gif", "webp", "generic"):
        order.append(hint)
    for k in ("png", "jpeg", "gif", "webp"):
        if k not in order:
            order.append(k)
    if "generic" not in order:
        order.append("generic")

    for kind in order:
        if kind == "png":
            s = _strip_png_prefix(data)
            if s is not None and s:
                return s
        elif kind == "jpeg":
            s = _strip_jpeg_prefix(data)
            if s is not None and s:
                return s
        elif kind == "gif":
            s = _strip_gif_prefix(data)
            if s is not None and s:
                return s
        elif kind == "webp":
            s = _strip_webp_prefix(data)
            if s is not None and s:
                return s
        elif kind == "generic":
            off = _find_mpegts_payload_start(data, 0)
            if off > 0:
                return data[off:]
    off2 = _find_mpegts_payload_start(data, 0)
    if off2 > 0:
        return data[off2:]
    return data


def _detect_obfuscated_segments(
    url: str, header_block: str
) -> Tuple[Optional[str], int]:
    """
    Download variant playlist and sample first segment.
    Returns (obfuscation_kind, sample_video_offset). kind None => use normal ffmpeg.
    sample_video_offset is informational (0 if plain TS / unknown).
    """
    try:
        var_url, var_text = _resolve_variant_playlist_url(url, header_block)
    except (urllib.error.URLError, OSError, ValueError, UnicodeError):
        return None, 0

    seg_urls = _parse_hls_media_segment_uris(var_text, var_url)
    if not seg_urls:
        return None, 0

    sample_url = seg_urls[0]
    try:
        head = _http_get_bytes(sample_url, header_block, max_bytes=4 * 1024 * 1024, timeout=90.0)
    except (urllib.error.URLError, OSError, ValueError):
        return None, 0

    if not head:
        return None, 0

    if head[0] == 0x47 and _looks_like_ts_at(head, 0):
        return None, 0

    kind = _obfuscation_kind_from_magic(head)
    if kind is None:
        off = _find_mpegts_payload_start(head, 0)
        if off > 0:
            return "generic", off
        return None, 0

    payload = _extract_ts_payload(head, kind)
    if not payload or (payload[0] != 0x47):
        try:
            full = _http_get_bytes(sample_url, header_block, max_bytes=None, timeout=120.0)
        except (urllib.error.URLError, OSError, ValueError):
            return None, 0
        payload = _extract_ts_payload(full, kind)

    if not payload or payload[0] != 0x47:
        off = _find_mpegts_payload_start(head, 0)
        if off > 0 and kind:
            return kind if kind != "generic" else "generic", off
        return None, 0

    if kind == "png" and head.startswith(_PNG_SIG):
        idx = head.find(_PNG_IEND)
        off = (idx + len(_PNG_IEND)) if idx >= 0 else 0
        return "png", off
    if kind == "jpeg" and head.startswith(_JPEG_SIG):
        j = head.rfind(b"\xff\xd9")
        off = (j + 2) if j >= 0 else 0
        return "jpeg", off
    if kind == "webp" and len(head) >= 12:
        cs = struct.unpack("<I", head[4:8])[0]
        return "webp", 8 + int(cs)
    if kind == "gif":
        off = _find_mpegts_payload_start(head, 6)
        return "gif", off

    return kind, 0


def _download_segment_bytes(url: str, header_block: str) -> bytes:
    last_err: Optional[BaseException] = None
    for attempt in range(3):
        try:
            return _http_get_bytes(url, header_block, max_bytes=None, timeout=120.0)
        except (urllib.error.URLError, OSError, ValueError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1.0)
    if last_err:
        raise last_err
    return b""


def _download_obfuscated_hls(
    url: str,
    message: dict,
    output_path: str,
    header_block: str,
    job_id: str,
    obfuscation_kind: Optional[str] = None,
) -> None:
    """
    Manual segment download + strip + concat + ffmpeg remux.
    """
    global _active_ffmpeg
    kind_hint = obfuscation_kind
    if not kind_hint:
        kind_hint, _ = _detect_obfuscated_segments(url, header_block)
    if not kind_hint:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": "Obfuscated HLS: download path invoked but segments do not appear wrapped.",
                },
                job_id,
            )
        )
        return
    temp_root = os.path.join(
        tempfile.gettempdir(),
        "hgr_hls_" + hashlib.sha1((job_id or url).encode("utf-8", errors="replace")).hexdigest()[:16],
    )
    proc: Optional[subprocess.Popen] = None
    try:
        os.makedirs(temp_root, exist_ok=True)
        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "fetch",
                    "detail": "Resolving obfuscated HLS playlist…",
                    "output": output_path,
                },
                job_id,
            )
        )
        var_url, var_text = _resolve_variant_playlist_url(url, header_block)
        seg_urls = _parse_hls_media_segment_uris(var_text, var_url)
        if not seg_urls:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": "Obfuscated HLS: no segment URLs in playlist."},
                    job_id,
                )
            )
            return

        total = len(seg_urls)
        combined_ts = os.path.join(temp_root, "combined.ts")
        seg_paths: List[str] = []

        for i, seg_url in enumerate(seg_urls, start=1):
            if _CANCEL_EVENT.is_set():
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "canceled": True,
                            "error": "Canceled",
                        },
                        job_id,
                    )
                )
                return
            send_message(
                with_job_id(
                    {
                        "type": "progress",
                        "phase": "fetch",
                        "detail": f"[{i}/{total}] Downloading…",
                        "output": output_path,
                    },
                    job_id,
                )
            )
            try:
                raw = _download_segment_bytes(seg_url, header_block)
            except (urllib.error.URLError, OSError, ValueError) as e:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": f"Segment download failed ({i}/{total}): {e}",
                        },
                        job_id,
                    )
                )
                return

            per_hint = _obfuscation_kind_from_magic(raw)
            hint = per_hint or kind_hint
            cleaned = _extract_ts_payload(raw, hint)
            if not cleaned:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": f"Obfuscated HLS: empty payload after strip at segment {i}/{total}.",
                        },
                        job_id,
                    )
                )
                return
            seg_path = os.path.join(temp_root, f"seg_{i:05d}.ts")
            with open(seg_path, "wb") as sf:
                sf.write(cleaned)
            seg_paths.append(seg_path)
            time.sleep(0.05)

        if _CANCEL_EVENT.is_set():
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "canceled": True, "error": "Canceled"},
                    job_id,
                )
            )
            return

        with open(combined_ts, "wb") as combined:
            for sp in seg_paths:
                with open(sp, "rb") as inf:
                    shutil.copyfileobj(inf, combined)

        if not os.path.isfile(combined_ts) or os.path.getsize(combined_ts) < 64:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "Obfuscated HLS: combined transport stream is empty or too small.",
                    },
                    job_id,
                )
            )
            return

        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "encoding",
                    "detail": "Remuxing to MP4 (ffmpeg)…",
                    "output": output_path,
                },
                job_id,
            )
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-loglevel",
            "info",
            "-stats",
            "-i",
            combined_ts,
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            output_path,
        ]
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": "ffmpeg not found in PATH"},
                    job_id,
                )
            )
            return
        except Exception as e:
            send_message(with_job_id({"type": "done", "success": False, "error": str(e)}, job_id))
            return

        with _PROC_LOCK:
            _active_ffmpeg = proc

        stderr_lines: List[str] = []
        last_send = 0.0
        throttle_s = 0.35

        def read_stderr_ff():
            nonlocal last_send
            try:
                for raw in iter(proc.stderr.readline, b""):
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace")
                    stderr_lines.append(line)
                    if len(stderr_lines) > 200:
                        stderr_lines.pop(0)
                    if "time=" not in line:
                        continue
                    parsed = _parse_ffmpeg_progress(line)
                    now = time.monotonic()
                    if now - last_send < throttle_s:
                        continue
                    last_send = now
                    parts = []
                    if parsed.get("time"):
                        parts.append(f"time {parsed['time']}")
                    if parsed.get("size"):
                        parts.append(f"size {parsed['size']}")
                    if parsed.get("speed"):
                        parts.append(parsed["speed"])
                    send_message(
                        with_job_id(
                            {
                                "type": "progress",
                                "phase": "encoding",
                                "detail": ", ".join(parts) if parts else line.strip()[:120],
                                "output": output_path,
                                **parsed,
                            },
                            job_id,
                        )
                    )
            finally:
                try:
                    proc.stderr.close()
                except OSError:
                    pass

        t_ff = threading.Thread(target=read_stderr_ff, daemon=True)
        t_ff.start()
        code = proc.wait()
        t_ff.join(timeout=2.0)
        _clear_active_if(proc)

        if _CANCEL_EVENT.is_set():
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "canceled": True, "error": "Canceled"},
                    job_id,
                )
            )
            return
        tail = "".join(stderr_lines[-30:]).strip()
        if code == 0:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": True,
                        "output": output_path,
                        "detail": "Finished",
                    },
                    job_id,
                )
            )
        else:
            err = f"ffmpeg exited with code {code}"
            if tail:
                err = err + ": " + tail[-500:]
            send_message(with_job_id({"type": "done", "success": False, "error": err}, job_id))
    finally:
        _clear_active_if(proc)
        try:
            if os.path.isdir(temp_root):
                shutil.rmtree(temp_root, ignore_errors=True)
        except OSError:
            pass


def _build_ffmpeg_cmd_list(
    url, message, output_path, header_block, *, resume_from_sec: float = 0.0
):
    pre = [
        "ffmpeg",
        "-y",
        "-nostdin",
        "-loglevel",
        "info",
        "-stats",
    ]
    # HLS: default live_start_index is -3 (near live edge) which can make ffmpeg only
    # follow a short sliding window. Force start from the first listed segment, reload
    # playlists longer, and retry flaky segments (without TCP reconnect flags — they
    # destabilize some CDNs).
    if _is_hls_input(url, message):
        if resume_from_sec and resume_from_sec > 0.05:
            pre.extend(["-ss", f"{float(resume_from_sec):.3f}"])
        pre.extend(
            [
                "-protocol_whitelist",
                "file,http,https,tcp,tls,crypto,ffurl",
                "-analyzeduration",
                "200M",
                "-probesize",
                "200M",
                "-fflags",
                "+genpts",
                "-f",
                "hls",
                "-live_start_index",
                "0",
                "-max_reload",
                "2000",
                "-m3u8_hold_counters",
                "2000",
                "-seg_max_retry",
                "10",
            ]
        )
    pre.extend(
        [
            "-headers",
            header_block,
            "-i",
            url,
        ]
    )
    cmd = pre + [
        "-c",
        "copy",
    ]
    if _use_hls_aac_bsf(url, message):
        cmd.extend(["-bsf:a", "aac_adtstoasc"])
    cmd.append(output_path)
    return cmd


def _ffprobe_duration_seconds(path: str) -> float:
    if not path or not os.path.isfile(path):
        return 0.0
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if r.returncode != 0 or not (r.stdout or "").strip():
            return 0.0
        return max(0.0, float((r.stdout or "").strip().splitlines()[0]))
    except (ValueError, subprocess.SubprocessError, OSError, IndexError):
        return 0.0


def _ffmpeg_concat_two_mp4_to_one(part_a: str, part_b: str, out_final: str) -> bool:
    d = os.path.dirname(os.path.abspath(out_final)) or "."
    fd, t1 = tempfile.mkstemp(suffix=".ts", dir=d, prefix="hgr_")
    os.close(fd)
    fd, t2 = tempfile.mkstemp(suffix=".ts", dir=d, prefix="hgr_")
    os.close(fd)
    list_path = out_final + ".concat.txt"
    try:
        r1 = subprocess.run(
            ["ffmpeg", "-y", "-nostdin", "-i", part_a, "-c", "copy", "-f", "mpegts", t1],
            capture_output=True,
            timeout=3600,
        )
        r2 = subprocess.run(
            ["ffmpeg", "-y", "-nostdin", "-i", part_b, "-c", "copy", "-f", "mpegts", t2],
            capture_output=True,
            timeout=3600,
        )
        if r1.returncode != 0 or r2.returncode != 0:
            return False
        p1 = os.path.normpath(t1).replace("\\", "/").replace("'", "'\\''")
        p2 = os.path.normpath(t2).replace("\\", "/").replace("'", "'\\''")
        with open(list_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"file '{p1}'\nfile '{p2}'\n")
        tmp = out_final + ".merging.mp4"
        r3 = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-nostdin",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                list_path,
                "-c",
                "copy",
                tmp,
            ],
            capture_output=True,
            timeout=3600 * 3,
        )
        if r3.returncode != 0:
            return False
        if os.path.isfile(out_final):
            os.remove(out_final)
        os.replace(tmp, out_final)
        return True
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        for p in (t1, t2, list_path):
            try:
                if p and os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass
        if os.path.isfile(out_final + ".merging.mp4"):
            try:
                os.remove(out_final + ".merging.mp4")
            except OSError:
                pass


def _handle_hls_auth_refresh(new_message: dict) -> None:
    """Stop current encode, re-fetch with fresh auth from time offset, merge with partial file."""
    global _HLS_CONT_ACTIVE_JID, _active_ffmpeg
    job_id = (new_message.get("jobId") or "").strip()
    if not job_id or job_id not in _JOB_LIVE:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": "Refresh: no active job or job unknown.",
                },
                job_id,
            )
        )
        return
    my_seq = 0
    with _REFRESH_LOCK:
        # _CURRENT is cleared after the main encode is killed, but a "continue" encode may be running
        if _CURRENT_JOB_ID and _CURRENT_JOB_ID != job_id:
            return
        if _HLS_CONT_ACTIVE_JID and _HLS_CONT_ACTIVE_JID != job_id:
            return
        st = _JOB_LIVE.get(job_id) or {}
        out_path = st.get("output")
        old_url = st.get("url") or new_message.get("url")
        tprog = float(st.get("tsec") or 0.0)
        ffd = _ffprobe_duration_seconds(out_path) if out_path and os.path.isfile(out_path) else 0.0
        tsec = max(tprog, ffd)
        if not out_path or not os.path.isfile(out_path) or tsec < 0.15:
            return
        offset = tsec - 0.15
        if offset < 0.1:
            return
        with _PROC_LOCK:
            p = _active_ffmpeg
        if p is None or p.poll() is not None:
            return
        my_seq = _bump_hls_refresh_seq(job_id)
        _SILENCE_FFMPEG_DONE.add(job_id)
        try:
            p.terminate()
        except OSError:
            try:
                p.kill()
            except OSError:
                pass
        for _ in range(20):
            if p.poll() is not None:
                break
            time.sleep(0.1)
    # Wait for the worker thread to finish and skip its done
    time.sleep(0.5)
    if my_seq and _hls_refresh_stale(job_id, my_seq):
        _SILENCE_FFMPEG_DONE.discard(job_id)
        return

    new_url = (new_message.get("url") or old_url or "").strip()
    filename = (new_message.get("filename") or "stream").strip() or "stream"
    if not new_url:
        _SILENCE_FFMPEG_DONE.discard(job_id)
        send_message(
            with_job_id(
                {"type": "done", "success": False, "error": "Refresh: no URL after auth timeout."},
                job_id,
            )
        )
        return

    cont_path = out_path + ".cont.mp4"
    if os.path.isfile(cont_path):
        try:
            os.remove(cont_path)
        except OSError:
            pass

    send_message(
        with_job_id(
            {
                "type": "progress",
                "phase": "encoding",
                "detail": f"Refreshing session from {int(offset//60)}m {int(offset%60)}s…",
                "output": out_path,
            },
            job_id,
        )
    )

    header_block = build_ffmpeg_header_block(new_message, new_url)
    cmd = _build_ffmpeg_cmd_list(
        new_url, new_message, cont_path, header_block, resume_from_sec=offset
    )
    cproc: Optional[subprocess.Popen] = None
    code = 1
    stderr_lines: list = []
    try:
        cproc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with _PROC_LOCK:
            _active_ffmpeg = cproc
        _HLS_CONT_ACTIVE_JID = job_id

        def _drain_cont_err():
            try:
                for raw in iter(cproc.stderr.readline, b""):
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace")
                    if len(stderr_lines) > 120:
                        stderr_lines.pop(0)
                    stderr_lines.append(line)
            finally:
                try:
                    cproc.stderr.close()
                except OSError:
                    pass

        threading.Thread(target=_drain_cont_err, daemon=True).start()
        code = cproc.wait() or 0
    except (OSError, Exception) as e:
        with _PROC_LOCK:
            if cproc is not None and _active_ffmpeg is cproc:
                _active_ffmpeg = None
        if _HLS_CONT_ACTIVE_JID == job_id:
            _HLS_CONT_ACTIVE_JID = None
        _SILENCE_FFMPEG_DONE.discard(job_id)
        _JOB_LIVE.pop(job_id, None)
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": f"Refresh encode failed: {e}",
                },
                job_id,
            )
        )
        return
    else:
        with _PROC_LOCK:
            if cproc is not None and _active_ffmpeg is cproc:
                _active_ffmpeg = None
        if _HLS_CONT_ACTIVE_JID == job_id:
            _HLS_CONT_ACTIVE_JID = None
    if my_seq and _hls_refresh_stale(job_id, my_seq):
        _SILENCE_FFMPEG_DONE.discard(job_id)
        return
    if code != 0:
        if my_seq and _hls_refresh_stale(job_id, my_seq):
            _SILENCE_FFMPEG_DONE.discard(job_id)
            return
        _SILENCE_FFMPEG_DONE.discard(job_id)
        _JOB_LIVE.pop(job_id, None)
        tail = ("".join(stderr_lines) or "").strip()[-500:]
        if not tail and not os.path.isfile(cont_path):
            tail = "no output or encode failed"
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": f"Session refresh failed: {tail}",
                },
                job_id,
            )
        )
        return
    if not os.path.isfile(cont_path) or os.path.getsize(cont_path) < 64:
        _SILENCE_FFMPEG_DONE.discard(job_id)
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": "Session refresh: no new data; try starting the video again and re-download.",
                },
                job_id,
            )
        )
        return

    if my_seq and _hls_refresh_stale(job_id, my_seq):
        _SILENCE_FFMPEG_DONE.discard(job_id)
        return
    send_message(
        with_job_id(
            {
                "type": "progress",
                "phase": "encoding",
                "detail": "Merging…",
                "output": out_path,
            },
            job_id,
        )
    )
    if not _ffmpeg_concat_two_mp4_to_one(out_path, cont_path, out_path):
        _SILENCE_FFMPEG_DONE.discard(job_id)
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": "Could not merge re-downloaded part with the first part.",
                },
                job_id,
            )
        )
        return
    try:
        if os.path.isfile(cont_path):
            os.remove(cont_path)
    except OSError:
        pass
    if job_id in _JOB_LIVE:
        _JOB_LIVE[job_id]["tsec"] = max(
            float(_JOB_LIVE[job_id].get("tsec") or 0),
            _ffprobe_duration_seconds(out_path) or 0.0,
        )
    _SILENCE_FFMPEG_DONE.discard(job_id)
    send_message(
        with_job_id(
            {
                "type": "done",
                "success": True,
                "output": out_path,
                "detail": "Finished",
            },
            job_id,
        )
    )
    if job_id in _JOB_LIVE:
        del _JOB_LIVE[job_id]


def run_ffmpeg_with_updates(url, filename, message):
    global _active_ffmpeg, _CURRENT_JOB_ID
    job_id = (message.get("jobId") or "").strip()
    with _PROC_LOCK:
        if _active_ffmpeg is not None and _active_ffmpeg.poll() is None:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "A download is already in progress.",
                    },
                    job_id,
                )
            )
            return
    _CANCEL_EVENT.clear()
    out_dir = _resolve_output_dir(message)
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": f"Cannot create output folder: {e}",
                },
                job_id,
            )
        )
        return
    _CURRENT_JOB_ID = job_id
    output_path = _safe_output_path(out_dir, filename, ".mp4")
    header_block = build_ffmpeg_header_block(message, url)
    cmd = _build_ffmpeg_cmd_list(url, message, output_path, header_block, resume_from_sec=0.0)

    proc: Optional[subprocess.Popen] = None
    try:
        if _is_hls_input(url, message):
            send_message(
                with_job_id(
                    {
                        "type": "progress",
                        "phase": "starting",
                        "detail": "Checking for image-wrapped segments…",
                        "output": output_path,
                    },
                    job_id,
                )
            )
            ob_kind: Optional[str] = None
            try:
                ob_kind, _ob_off = _detect_obfuscated_segments(url, header_block)
            except Exception:
                ob_kind = None
            if ob_kind:
                _JOB_LIVE[job_id] = {"output": output_path, "tsec": 0.0, "url": url}
                _download_obfuscated_hls(
                    url, message, output_path, header_block, job_id, ob_kind
                )
                return

        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "starting",
                    "detail": "Starting ffmpeg",
                    "output": output_path,
                },
                job_id,
            )
        )

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "ffmpeg not found in PATH",
                    },
                    job_id,
                )
            )
            return
        except Exception as e:
            send_message(with_job_id({"type": "done", "success": False, "error": str(e)}, job_id))
            return

        with _PROC_LOCK:
            _active_ffmpeg = proc
        _JOB_LIVE[job_id] = {"output": output_path, "tsec": 0.0, "url": url}

        stderr_lines = []
        last_send = 0.0
        throttle_s = 0.35

        def read_stderr():
            nonlocal last_send
            try:
                for raw in iter(proc.stderr.readline, b""):
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace")
                    stderr_lines.append(line)
                    if len(stderr_lines) > 200:
                        stderr_lines.pop(0)
                    if "time=" in line and job_id in _JOB_LIVE:
                        parsed0 = _parse_ffmpeg_progress(line)
                        if parsed0.get("tsec") is not None:
                            _JOB_LIVE[job_id]["tsec"] = max(
                                float(_JOB_LIVE[job_id].get("tsec") or 0.0),
                                float(parsed0["tsec"]),
                            )
                    if "time=" not in line:
                        continue
                    parsed = _parse_ffmpeg_progress(line)
                    now = time.monotonic()
                    if now - last_send < throttle_s:
                        continue
                    last_send = now
                    parts = []
                    if parsed.get("time"):
                        parts.append(f"time {parsed['time']}")
                    if parsed.get("size"):
                        parts.append(f"size {parsed['size']}")
                    if parsed.get("speed"):
                        parts.append(parsed["speed"])
                    send_message(
                        with_job_id(
                            {
                                "type": "progress",
                                "phase": "encoding",
                                "detail": ", ".join(parts) if parts else line.strip()[:120],
                                "output": output_path,
                                **parsed,
                            },
                            job_id,
                        )
                    )
            finally:
                try:
                    proc.stderr.close()
                except Exception:
                    pass

        t = threading.Thread(target=read_stderr, daemon=True)
        t.start()
        code = proc.wait()
        t.join(timeout=2.0)

        if job_id in _SILENCE_FFMPEG_DONE:
            return
        tail = "".join(stderr_lines[-30:]).strip()
        if _CANCEL_EVENT.is_set():
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "canceled": True,
                        "error": "Canceled",
                    },
                    job_id,
                )
            )
            return
        if code == 0:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": True,
                        "output": output_path,
                        "detail": "Finished",
                    },
                    job_id,
                )
            )
        else:
            err = f"ffmpeg exited with code {code}"
            if tail:
                err = err + ": " + tail[-500:]
            send_message(with_job_id({"type": "done", "success": False, "error": err}, job_id))
    finally:
        _clear_active_if(proc)
        _CANCEL_EVENT.clear()
        if _CURRENT_JOB_ID == job_id:
            _CURRENT_JOB_ID = ""
        if job_id and job_id not in _SILENCE_FFMPEG_DONE:
            _JOB_LIVE.pop(job_id, None)


def main():
    while True:
        message = read_message()
        if message is None:
            break
        mtype = (message.get("type") or "").lower()
        if mtype == "cancel":
            _request_cancel()
            continue
        if mtype == "refresh":
            threading.Thread(
                target=_handle_hls_auth_refresh, args=(message,),
                daemon=True,
            ).start()
            continue
        url = message.get("url", "")
        filename = message.get("filename", "stream")
        jmain = (message.get("jobId") or "").strip()
        if not url:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": "No URL provided"},
                    jmain,
                )
            )
            continue
        threading.Thread(
            target=run_ffmpeg_with_updates,
            args=(url, filename, message),
            daemon=True,
        ).start()


if __name__ == "__main__":
    main()
