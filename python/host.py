#!/usr/bin/env python3
"""
Stuff Grabber - Native Messaging Host
Receives stream URLs from the Chrome extension. Resolves social/platform URLs with yt-dlp;
otherwise runs ffmpeg (HLS, DASH, direct) when possible.
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
import glob
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse, urlsplit, urlunsplit
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
    d = {**data, "jobId": job_id} if job_id else dict(data)
    if job_id and d.get("type") == "progress" and "ffmpegPreset" not in d:
        st = _JOB_LIVE.get(job_id) or {}
        preset = (st.get("ffmpegPreset") or "").strip()
        if preset:
            d["ffmpegPreset"] = preset
    return d


def _job_live_from_message(output, url, message) -> Dict[str, Any]:
    live: Dict[str, Any] = {"output": output, "tsec": 0.0, "url": url}
    raw_preset = (message.get("ffmpegPreset") or "").strip().lower()
    if raw_preset:
        live["ffmpegPreset"] = raw_preset
    return live


def _send_done_canceled(job_id: str, error: str = "Canceled") -> None:
    payload: Dict[str, Any] = {
        "type": "done",
        "success": False,
        "canceled": True,
        "error": error,
    }
    st = _JOB_LIVE.get(job_id) or {}
    out = (st.get("output") or "").strip()
    if out and os.path.isfile(out):
        payload["output"] = out
    send_message(with_job_id(payload, job_id))


_WIN_RESERVED = (
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)


def _sanitize_filename_stem(name):
    # Keep the user's name as-is (including spaces). Only replace characters that
    # are invalid on Windows/macOS filesystems or unsafe for paths.
    s = (name or "stream").strip()
    # Strip bidi/format marks (Apple Music titles often include U+200E LRM, etc.)
    s = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", s)
    # Windows invalid chars + ASCII control chars. Replace with a space to preserve readability.
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s)
    # Windows forbids trailing spaces and trailing dots. Leading dots are allowed but can be confusing.
    s = s.strip()
    s = s.lstrip(".")
    s = s.rstrip(" .")
    # Collapse nothing: preserve internal whitespace. If we blanked out the name, fall back.
    s = s or "stream"
    root = s.split(".")[0].lower()
    if root in _WIN_RESERVED:
        # Avoid reserved device names on Windows (CON, PRN, ...). Only adjust when required.
        s = f"{s} file"
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
    # Avoid forcing underscores; keep it human-readable while staying under MAX_PATH.
    return f"{stem[:keep]} {digest}"


def _safe_output_path(download_dir, filename, ext=".mp4"):
    stem = _sanitize_filename_stem(filename)
    stem = _shorten_stem_for_windows(stem, download_dir, ext)
    return os.path.join(download_dir, f"{stem}{ext}")


def _numbered_output_path(download_dir, filename, ext=".mp4") -> str:
    """Next free path: stem (1).ext, stem (2).ext, … when base already exists."""
    base = _safe_output_path(download_dir, filename, ext)
    if not os.path.isfile(base):
        return base
    stem_full = os.path.splitext(base)[0]
    ext_part = os.path.splitext(base)[1] or ext
    for n in range(1, 10000):
        candidate = f"{stem_full} ({n}){ext_part}"
        if not os.path.isfile(candidate):
            return candidate
    return base


def _resolve_output_path(message, out_dir: str, filename: str, ext: str = ".mp4") -> str:
    if message and message.get("numberedOutput"):
        return _numbered_output_path(out_dir, filename, ext)
    return _safe_output_path(out_dir, filename, ext)


def _yt_dlp_output_target(message: dict, out_dir: str, filename: str) -> str:
    """Single file path, or yt-dlp template for playlist downloads."""
    if message.get("ytDlpAudioOnly"):
        stem = _sanitize_filename_stem(filename)
        stem = _shorten_stem_for_windows(stem, out_dir, ".mp3")
        single = os.path.join(out_dir, f"{stem}.%(ext)s")
    else:
        single = _safe_output_path(out_dir, filename, ".mp4")
    if not message.get("ytDlpDownloadPlaylist"):
        return single
    stem = os.path.splitext(os.path.basename(single))[0]
    return os.path.join(out_dir, f"{stem} %(playlist_index)03d-%(title)s.%(ext)s")


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
    # CDN playlists disguised as .txt / .php / .asp / … (still contain #EXTM3U)
    if re.search(r"\.(?:txt|php|asp|aspx|ashx|jsp)(?:[?#]|$)", u) and (
        "index-" in u
        or "playlist" in u
        or "/hls/" in u
        or "/pts" in u
        or "/v4/" in u
        or "m3u" in u
        or "hls" in u
    ):
        return True
    sk = (message.get("streamKind") or message.get("stream_kind") or "").strip().lower()
    return sk in ("hls", "apple_hls", "hls_by_header", "m3u8", "m3u")


def _is_dash_input(url: str, message) -> bool:
    u = (url or "").lower()
    if ".mpd" in u or re.search(r"\.mpd(?:$|[?#])", u):
        return True
    sk = (message.get("streamKind") or message.get("stream_kind") or "").strip().lower()
    return sk in ("dash", "mpd")


def _use_hls_aac_bsf(
    url: str,
    message,
    *,
    playlist_text: Optional[str] = None,
    is_fmp4: Optional[bool] = None,
) -> bool:
    """
    MPEG-TS HLS + AAC → MP4 needs aac_adtstoasc (strips ADTS).
    fMP4/CMAF AAC is already ASC — applying the filter can corrupt audio (unplayable /
    seeks to end). MP3-in-HLS must not use it either.
    """
    if is_fmp4 is None and playlist_text is not None:
        is_fmp4 = _hls_playlist_is_fmp4(playlist_text)
    if is_fmp4:
        return False
    u = (url or "").lower()
    # e.g. …/playlist/id.128.mp3/playlist.m3u8  segments are MP3, not ADTS AAC
    if re.search(r"\.mp3/playlist\.m3u8", u):
        return False
    if ".m3u8" in u or u.endswith(".m3u") or re.search(r"\.m3u8[?#]", u):
        return True
    if re.search(r"\.(?:txt|php|asp|aspx|ashx|jsp)(?:[?#]|$)", u) and (
        "index-" in u
        or "playlist" in u
        or "/hls/" in u
        or "/pts" in u
        or "/v4/" in u
        or "m3u" in u
        or "hls" in u
    ):
        return True
    sk = (message.get("streamKind") or message.get("stream_kind") or "").strip().lower()
    if sk in ("hls", "apple_hls", "m3u8", "hls_by_header"):
        return True
    if sk in ("direct", "dash", "mpd", "mp4", "webm", "yt", "social", "by_header", "other"):
        return False
    return False


def _ffprobe_first_video_codec(path: str) -> str:
    if not path or not os.path.isfile(path):
        return ""
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if r.returncode != 0:
            return ""
        return ((r.stdout or "").strip().splitlines() or [""])[0].strip().lower()
    except (subprocess.SubprocessError, OSError, IndexError):
        return ""


def _ffmpeg_mp4_to_ts_bsf_args(path: str) -> List[str]:
    """Annex-B bitstream filter so MP4 parts concat cleanly through MPEG-TS."""
    codec = _ffprobe_first_video_codec(path)
    if codec in ("h264", "avc"):
        return ["-bsf:v", "h264_mp4toannexb"]
    if codec in ("hevc", "h265"):
        return ["-bsf:v", "hevc_mp4toannexb"]
    return []


def _ffmpeg_hls_network_fflags() -> List[str]:
    """Demux from network HLS: generate missing PTS only; discard corrupt packets.
    Omit +igndts — rewriting DTS clashes with coded frame order in -c:v copy and
    yields smeared/decoded freezes while audio stays fine."""
    return ["-fflags", "+genpts+discardcorrupt"]


def _ffmpeg_local_file_remux_fflags() -> List[str]:
    """Local combined fMP4/TS blobs already carry fragment timestamps — do not synthesize PTS."""
    return ["-fflags", "+discardcorrupt"]


def _ffmpeg_concat_demux_fflags() -> List[str]:
    """TS concat demuxer: keep timestamps from parts; concat step uses -reset_timestamps."""
    return ["-fflags", "+discardcorrupt"]


def _ffmpeg_copy_mux_fixup_args(for_mp4: bool = False) -> List[str]:
    out: List[str] = [
        "-avoid_negative_ts",
        "auto",
        "-max_muxing_queue_size",
        "9999",
    ]
    if for_mp4:
        out.extend(["-movflags", "+faststart"])
    else:
        out.extend(["-muxpreload", "0", "-muxdelay", "0"])
    return out


def _ffmpeg_force_stream_copy_hls_mp4() -> bool:
    """If set, use -c copy for HLS/DASH→MP4 (faster but often smears/freezes on bad PTS)."""
    v = (os.environ.get("HLS_GRABBER_FFMPEG_STREAM_COPY") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


_FFMPEG_X264_ALLOWED_PRESETS = frozenset(
    {
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
        "placebo",
    }
)
_FFMPEG_X264_PRESET_ORDER: Tuple[str, ...] = (
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
    "placebo",
)
# Auto x264 preset tiers from duration/size (fastest → slowest along _FFMPEG_X264_PRESET_ORDER).
_FFMPEG_AUTO_PRESET_DURATION_FAST_SEC = 3600.0
_FFMPEG_AUTO_PRESET_SIZE_FAST_BYTES = 1_073_741_824  # 1 GiB


def _ffmpeg_env_x264_crf_maxrate_mbps() -> Tuple[int, Optional[float]]:
    """
    Tune H.264 encode size vs quality vs CPU. Defaults favor smaller outputs than ultrafast+low-CRF
    (which can inflate a ~1GB CDN encode to multi-GB AVC).

    HLS_GRABBER_FFMPEG_CRF — integer roughly 18 (larger files) … 28 (smaller); default 24
    HLS_GRABBER_FFMPEG_PRESET — optional fixed x264 preset; when unset, auto veryfast/fast
    HLS_GRABBER_FFMPEG_VIDEO_MAX_MBPS — peak video bitrate cap, e.g. 8 (= 8 Mbit/s). Optional.
    """
    raw_crf = (os.environ.get("HLS_GRABBER_FFMPEG_CRF") or "").strip()
    try:
        crf = int(raw_crf) if raw_crf else 24
    except ValueError:
        crf = 24
    crf = max(15, min(32, crf))

    max_mbps: Optional[float] = None
    raw_mr = (os.environ.get("HLS_GRABBER_FFMPEG_VIDEO_MAX_MBPS") or "").strip()
    if raw_mr:
        try:
            max_mbps = float(raw_mr.replace(",", "."))
            if max_mbps <= 0 or max_mbps > 200:
                max_mbps = None
        except ValueError:
            max_mbps = None

    return crf, max_mbps


def _ffmpeg_env_preset_override() -> Optional[str]:
    raw = (os.environ.get("HLS_GRABBER_FFMPEG_PRESET") or "").strip().lower()
    if not raw:
        return None
    if raw in _FFMPEG_X264_ALLOWED_PRESETS:
        return raw
    return "fast"


def _ffmpeg_auto_x264_preset(
    duration_sec: float = 0.0, size_bytes: Optional[int] = None
) -> str:
    """Pick one of all x264 presets from duration/size (no env or user override)."""
    dur = max(0.0, float(duration_sec or 0.0))
    sz = int(size_bytes) if size_bytes is not None and size_bytes > 0 else 0
    if dur >= 7200 or sz >= 4 * _FFMPEG_AUTO_PRESET_SIZE_FAST_BYTES:
        return "medium"
    if dur >= _FFMPEG_AUTO_PRESET_DURATION_FAST_SEC or sz >= _FFMPEG_AUTO_PRESET_SIZE_FAST_BYTES:
        return "fast"
    if dur >= 1800 or sz >= 512 * 1024 * 1024:
        return "faster"
    if dur >= 600 or sz >= 200 * 1024 * 1024:
        return "veryfast"
    if dur >= 180 or sz >= 50 * 1024 * 1024:
        return "superfast"
    return "ultrafast"


def _ffmpeg_resolve_x264_preset(
    message,
    duration_sec: float = 0.0,
    size_bytes: Optional[int] = None,
) -> str:
    """Env override, then message.ffmpegPreset, then auto duration/size."""
    env = _ffmpeg_env_preset_override()
    if env:
        return env
    if message:
        raw = (message.get("ffmpegPreset") or "").strip().lower()
        if raw in _FFMPEG_X264_ALLOWED_PRESETS:
            return raw
    return _ffmpeg_auto_x264_preset(duration_sec, size_bytes)


def _ffmpeg_auto_preset_reason(duration_sec: float, size_bytes: Optional[int]) -> str:
    dur = max(0.0, float(duration_sec or 0.0))
    sz = int(size_bytes) if size_bytes is not None and size_bytes > 0 else 0
    parts: List[str] = []
    if dur >= 7200:
        parts.append("duration ≥ 2 hours")
    elif dur >= _FFMPEG_AUTO_PRESET_DURATION_FAST_SEC:
        parts.append("duration ≥ 1 hour")
    elif dur >= 1800:
        parts.append("duration ≥ 30 min")
    elif dur >= 600:
        parts.append("duration ≥ 10 min")
    elif dur >= 180:
        parts.append("duration ≥ 3 min")
    elif dur > 0.5:
        parts.append("short clip")
    if sz >= 4 * _FFMPEG_AUTO_PRESET_SIZE_FAST_BYTES:
        parts.append("size ≥ 4 GB")
    elif sz >= _FFMPEG_AUTO_PRESET_SIZE_FAST_BYTES:
        parts.append("size ≥ 1 GB")
    elif sz >= 512 * 1024 * 1024:
        parts.append("size ≥ 512 MB")
    elif sz >= 200 * 1024 * 1024:
        parts.append("size ≥ 200 MB")
    elif sz >= 50 * 1024 * 1024:
        parts.append("size ≥ 50 MB")
    if not parts:
        return "very small / unknown source"
    return ", ".join(parts)


def _ffmpeg_download_needs_x264_reencode(url: str, message) -> bool:
    """True when this job will re-encode HLS/DASH to MP4 (not yt-dlp or stream-copy)."""
    page_for_social = (message.get("pageUrl") or message.get("referer") or "").strip()
    if _social_platform_for_yt_dlp(url, page_for_social, message):
        return False
    if _ffmpeg_force_stream_copy_hls_mp4():
        return False
    if _ffmpeg_preferred_container_ext(url, message) != ".mp4":
        return False
    return _is_hls_input(url, message) or _is_dash_input(url, message)


def _ffmpeg_pick_x264_preset(
    duration_sec: float = 0.0, size_bytes: Optional[int] = None
) -> str:
    """Pick x264 preset from duration/size unless HLS_GRABBER_FFMPEG_PRESET is set."""
    override = _ffmpeg_env_preset_override()
    if override:
        return override
    return _ffmpeg_auto_x264_preset(duration_sec, size_bytes)


def _message_media_hints(message) -> Tuple[float, Optional[int]]:
    """Optional duration/size hints from the extension message."""
    dur = 0.0
    size: Optional[int] = None
    if not message:
        return dur, size
    for key in ("duration", "durationSec", "duration_sec", "mediaDuration"):
        v = message.get(key)
        if v is not None:
            try:
                dur = max(dur, float(v))
            except (TypeError, ValueError):
                pass
    for key in ("fileSize", "file_size", "contentLength", "size"):
        v = message.get(key)
        if v is not None:
            try:
                n = int(v)
                if n > 0:
                    size = max(size or 0, n)
            except (TypeError, ValueError):
                pass
    return dur, size


def _ffmpeg_x264_vencode_core_argv(*, preset: Optional[str] = None) -> List[str]:
    crf, max_mb = _ffmpeg_env_x264_crf_maxrate_mbps()
    effective_preset = preset or _ffmpeg_pick_x264_preset()
    argv: List[str] = [
        "-c:v",
        "libx264",
        "-preset",
        effective_preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
    ]
    if max_mb is not None:
        argv.extend(
            ["-maxrate", f"{max_mb}M", "-bufsize", f"{max_mb * 2:.4g}M"]
        )
    return argv


def _ffmpeg_audio_only_encode_args() -> List[str]:
    """
    Audio-only HLS → MP4/M4A: re-encode AAC so timestamps/extradata are clean.
    Stream-copy of FairPlay/SAMPLE-AES produces a full-length file that seeks to the end.
    """
    return [
        "-vn",
        "-map",
        "0:a:0?",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        "-ac",
        "2",
    ]


def _ffmpeg_stable_mp4_map_and_encode_args(
    *,
    preset: Optional[str] = None,
    aac_bsf: bool = False,
    audio_only: bool = False,
) -> List[str]:
    """
    Map first video + audio when present. Video map is optional so audio-only HLS
    does not fail with "Stream map '0:v:0' matches no streams".
    Re-encode video for stable PTS; copy audio (unless audio_only → re-encode audio).
    """
    if audio_only:
        return _ffmpeg_audio_only_encode_args()
    out: List[str] = [
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        *_ffmpeg_x264_vencode_core_argv(preset=preset),
        "-c:a",
        "copy",
    ]
    if aac_bsf:
        out.extend(["-bsf:a", "aac_adtstoasc"])
    return out


def _ffmpeg_transcode_stable_mp4_from_url(
    url,
    message,
    *,
    preset: Optional[str] = None,
    playlist_text: Optional[str] = None,
    audio_only: bool = False,
    is_fmp4: Optional[bool] = None,
) -> List[str]:
    """Decode+re-encode video; audio copy. Fixes corrupt reference chains from -c copy HLS mux."""
    return _ffmpeg_stable_mp4_map_and_encode_args(
        preset=preset,
        aac_bsf=_use_hls_aac_bsf(
            url, message, playlist_text=playlist_text, is_fmp4=is_fmp4
        ),
        audio_only=audio_only,
    )


def _ffmpeg_transcode_stable_mp4_from_combined_file(
    container: str, *, preset: Optional[str] = None, audio_only: bool = False
) -> List[str]:
    return _ffmpeg_stable_mp4_map_and_encode_args(
        preset=preset,
        aac_bsf=(container == "ts"),
        audio_only=audio_only,
    )


def _ffmpeg_transcode_stable_mp4_concat_merge(
    *, preset: Optional[str] = None
) -> List[str]:
    return _ffmpeg_stable_mp4_map_and_encode_args(preset=preset, aac_bsf=True)


def _ffmpeg_preferred_container_ext(url: str, message) -> str:
    """Prefer .mp3 when HLS variant is explicitly MP3 (SoundCloud progressive); else .mp4."""
    if not _is_hls_input(url, message):
        return ".mp4"
    u = (url or "").lower()
    if re.search(r"\.mp3/playlist\.m3u8", u):
        return ".mp3"
    return ".mp4"


# --- Social / streaming platforms → yt-dlp ---------------------------------

# Cached argv prefix to invoke yt-dlp (e.g. ["yt-dlp"] or [sys.executable, "-m", "yt_dlp"]).
_YTDLP_CMD_PREFIX: Optional[List[str]] = None
_YTDLP_PREFIX_PROBED: bool = False


def _ensure_user_site_packages_on_path() -> None:
    """pip --user (especially Microsoft Store Python) installs here; add if missing."""
    try:
        import site as _site

        u = _site.getusersitepackages()
        if isinstance(u, str) and u and os.path.isdir(u) and u not in sys.path:
            sys.path.insert(0, u)
    except Exception:
        pass


def _yt_dlp_importable_in_process() -> bool:
    """Whether yt_dlp is visible to this process (same interpreter as host.py)."""
    _ensure_user_site_packages_on_path()
    try:
        import importlib.util

        return importlib.util.find_spec("yt_dlp") is not None
    except Exception:
        return False


_TIKTOK_CDN_STREAM_HOSTS = ("tiktokcdn.com", "musical.ly", "tiktokv.com")
# Signed HLS from SoundCloud CDNs. The tab is often soundcloud.com (yt-dlp social rule), but
# yt-dlp must not swallow a raw *.m3u8 URL  use ffmpeg. Includes *.sndcdn.com (cf-hls-media, etc.)
# and *.soundcloud.com media hosts (ec-media, …); not the main site URL bar host.
_SOUNDCLOUD_CDN_STREAM_HOSTS = ("soundcloud.cloud", "sndcdn.com", "soundcloud.com")

# Netflix (and nflx CDNs): manifests/segments are Widevine-encrypted — ffmpeg/yt-dlp cannot decrypt.
_NETFLIX_DRM_HOSTS = ("netflix.com", "nflxvideo.net", "nflxso.net", "nflxext.com")

# Apple Music / iTunes FairPlay (and related CDN hosts). Segments look like AAC but won't decode.
_APPLE_MUSIC_DRM_HOSTS = (
    "music.apple.com",
    "itunes.apple.com",
    "audio-ssl.itunes.apple.com",
    "audio.itunes.apple.com",
    "aod.itunes.apple.com",
    "aod-ssl.itunes.apple.com",
    "streamingaudio.itunes.apple.com",
)


def _is_netflix_drm_context(stream_url: str, page_url: str = "") -> bool:
    for u in (stream_url, page_url):
        h = _netloc_host(u)
        if h and _host_matches_any(h, _NETFLIX_DRM_HOSTS):
            return True
    return False


def _netflix_drm_error_message() -> str:
    return (
        "Netflix playback is Widevine DRM encrypted. Stuff Grabber can only save unencrypted "
        "HLS/DASH/direct streams (ffmpeg/yt-dlp). Netflix manifests and segments cannot be "
        "decrypted by this tool. Use Netflix's official offline downloads, or grab trailers from "
        "open sources like YouTube where streams are not DRM-wrapped."
    )


def _is_apple_music_drm_context(stream_url: str, page_url: str = "") -> bool:
    for u in (stream_url, page_url):
        h = _netloc_host(u)
        if h and _host_matches_any(h, _APPLE_MUSIC_DRM_HOSTS):
            return True
        low = (u or "").lower()
        if "music.apple.com" in low or "itunes.apple.com" in low:
            return True
    return False


def _apple_music_drm_error_message() -> str:
    return (
        "Apple Music streams use FairPlay DRM. The file may download but the audio is encrypted "
        "and will not play (players jump to the end). Stuff Grabber cannot decrypt FairPlay. "
        "Use Apple Music's official offline downloads, or grab non-DRM audio (previews on open "
        "sources, SoundCloud, etc.)."
    )


def _apple_music_youtube_query(message: dict, page_url: str = "", stream_url: str = "") -> Optional[str]:
    """Build a ytsearch query from Apple Music page title / filename when the page itself is DRM."""
    for key in ("pageTitle", "title", "filename"):
        raw = (message.get(key) or "").strip() if message else ""
        if not raw:
            continue
        q = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", raw)
        q = re.sub(r"\s*[-–—]\s*Apple Music\s*$", "", q, flags=re.I)
        q = re.sub(r"\s+Album by\s+", " ", q, flags=re.I)
        q = re.sub(r"\s+", " ", q).strip(" -–—")
        if len(q) >= 3 and q.lower() not in ("stream", "video", "audio", "download", "track"):
            return q
    for u in (page_url, stream_url):
        low = (u or "").lower()
        if "music.apple.com" not in low:
            continue
        try:
            parts = [x for x in (urlparse(u).path or "").split("/") if x]
            # /us/album/the-difference/… or /us/song/…
            for i, p in enumerate(parts):
                if p in ("album", "song", "playlist") and i + 1 < len(parts):
                    slug = parts[i + 1].replace("-", " ").strip()
                    if len(slug) >= 3:
                        return slug
        except Exception:
            pass
    return None


def _hls_playlist_drm_error(playlist_text: str) -> Optional[str]:
    """Return a user-facing error if the media playlist uses unsupported DRM."""
    if not playlist_text:
        return None
    up = playlist_text.upper()
    if "COM.APPLE.STREAMINGKEYDELIVERY" in up or "SKD://" in up:
        return _apple_music_drm_error_message()
    if "SAMPLE-AES" in up:
        return (
            "This HLS stream uses SAMPLE-AES DRM encryption. Segments can be saved but the "
            "audio/video will not play. Stuff Grabber only supports clear or AES-128 HLS."
        )
    if "WIDEVINE" in up or "URN:UUID:EDEF8BA9" in up:
        return (
            "This HLS stream uses Widevine DRM. Stuff Grabber cannot decrypt it. "
            "Use the service's official offline feature, or a non-DRM source."
        )
    return None


def _combine_dual_try_errors(
    ytdlp_err: str,
    ffmpeg_err: str,
    *,
    drm_hint: Optional[str] = None,
) -> str:
    """Final error after yt-dlp and ffmpeg both failed."""
    parts: List[str] = []
    if (ytdlp_err or "").strip():
        parts.append("yt-dlp: " + ytdlp_err.strip()[-500:])
    if (ffmpeg_err or "").strip():
        parts.append("ffmpeg: " + ffmpeg_err.strip()[-500:])
    body = " | ".join(parts) if parts else "Download failed"
    if drm_hint:
        return drm_hint.rstrip() + " Tried yt-dlp then ffmpeg — both failed. " + body
    return "Tried yt-dlp then ffmpeg — both failed. " + body


def _hls_playlist_is_fmp4(playlist_text: str) -> bool:
    """True when media playlist uses fMP4/CMAF (EXT-X-MAP), not MPEG-TS segments."""
    if not playlist_text:
        return False
    for line in playlist_text.splitlines():
        if line.strip().upper().startswith("#EXT-X-MAP:"):
            return True
    return False


def _hls_playlist_likely_has_video(playlist_text: str) -> bool:
    """Best-effort: False for audio-only variants (no RESOLUTION / video codec in CODECS)."""
    if not playlist_text:
        return True
    saw_stream_inf = False
    any_video_hint = False
    for raw in playlist_text.splitlines():
        line = raw.strip()
        up = line.upper()
        if up.startswith("#EXT-X-STREAM-INF:") or up.startswith("#EXT-X-MEDIA:"):
            saw_stream_inf = True
            if re.search(r"RESOLUTION\s*=", line, re.I):
                any_video_hint = True
            m = re.search(r'CODECS\s*=\s*"([^"]+)"', line, re.I)
            if m:
                codecs = m.group(1).lower()
                if any(
                    c in codecs
                    for c in ("avc1", "avc3", "hvc1", "hev1", "vp09", "av01", "dvh1", "dvhe")
                ):
                    any_video_hint = True
            if up.startswith("#EXT-X-MEDIA:") and re.search(
                r"TYPE\s*=\s*VIDEO", line, re.I
            ):
                any_video_hint = True
        if up.startswith("#EXT-X-STREAM-INF:") and re.search(
            r"RESOLUTION\s*=", line, re.I
        ):
            any_video_hint = True
    # Media playlists often omit CODECS; assume video unless master clearly audio-only.
    if saw_stream_inf and not any_video_hint:
        # Master/audio rendition list with only audio codecs (mp4a) and no video hints.
        if re.search(r'CODECS\s*=\s*"[^"]*mp4a', playlist_text, re.I) and not re.search(
            r"RESOLUTION\s*=", playlist_text, re.I
        ):
            return False
    return True


_SOCIAL_PLATFORM_RULES: List[Tuple[str, Tuple[str, ...]]] = [
    ("YouTube", ("googlevideo.com", "youtube.com", "youtu.be", "ytimg.com")),
    (
        "Facebook / Meta",
        (
            "facebook.com",
            "fb.watch",
            "fbcdn.net",
            "fbvideo.com",
            "instagram.com",
            "cdninstagram.com",
            "threads.net",
        ),
    ),
    ("TikTok", ("tiktok.com", "tiktokcdn.com", "musical.ly", "tiktokv.com")),
    ("Twitter / X", ("twitter.com", "x.com", "twimg.com", "video.twimg.com")),
    ("Reddit", ("reddit.com", "redd.it", "redditstatic.com", "redditmedia.com")),
    ("Twitch", ("twitch.tv", "twitchcdn.net", "jtvnw.net")),
    ("Vimeo", ("vimeo.com", "vimeocdn.com", "player.vimeo.com")),
    ("Dailymotion", ("dailymotion.com", "dm-event.net", "dmcdn.net")),
    ("Snapchat", ("snapchat.com", "snap.com", "sc-cdn.net")),
    ("Pinterest", ("pinterest.com", "pinimg.com")),
    ("LinkedIn", ("linkedin.com", "licdn.com")),
    ("Bilibili", ("bilibili.com", "bilivideo.com", "bilibiliapi.net")),
    ("SoundCloud", ("soundcloud.com",)),
    ("Spotify", ("spotify.com", "open.spotify.com", "scdn.co")),
    (
        "Apple Music",
        (
            "music.apple.com",
            "itunes.apple.com",
            "audio-ssl.itunes.apple.com",
            "audio.itunes.apple.com",
            "aod.itunes.apple.com",
            "aod-ssl.itunes.apple.com",
        ),
    ),
    ("Bandcamp", ("bandcamp.com",)),
    ("Crunchyroll", ("crunchyroll.com", "vrv.co")),
    ("Rumble", ("rumble.com",)),
    ("Kick", ("kick.com",)),
]


def _netloc_host(url: str) -> str:
    try:
        u = (url or "").strip()
        if not u:
            return ""
        p = urlparse(u if "://" in u else "https://" + u)
        h = (p.netloc or "").split("@")[-1].split(":")[0].lower()
        if h.startswith("www."):
            h = h[4:]
        return h
    except Exception:
        return ""


def _url_is_youtube_page(url: str) -> bool:
    h = _netloc_host(url).lower()
    if not h:
        return False
    if h in ("youtube.com", "youtu.be", "youtube-nocookie.com"):
        return True
    return h.endswith(".youtube.com")


def _yt_dlp_target_is_youtube_like(target_url: str) -> bool:
    t = (target_url or "").strip().lower()
    return t.startswith("ytsearch") or _url_is_youtube_page(target_url)


def _yt_dlp_youtube_cli_extras(message: dict, target_url: str) -> List[str]:
    """
    YouTube needs n/sig challenge solving (EJS). Plain `pip install yt-dlp` omits solver assets;
    use --remote-components ejs:github plus a JS runtime (Deno or Node on PATH).
    See https://github.com/yt-dlp/yt-dlp/wiki/EJS

    Omit token-heavy clients by default: ios/android/mweb often need a GVS PO token
    (--extractor-args youtube:po_token=...), which we do not pass.

    Do not pass `--js-runtimes deno,node` (one arg): yt-dlp treats that as an invalid name. Use
    repeated `--js-runtimes deno` and `--js-runtimes node`.

    Prefer web clients first on music/VEVO URLs: android/ios https often require PO tokens; web
    may still expose a combined progressive format (e.g. 360p) without them.
    """
    if not _yt_dlp_target_is_youtube_like(target_url):
        return []
    override = (message.get("ytDlpYoutubeExtractorArgs") or "").strip()
    if override:
        ex = ["--extractor-args", override]
    else:
        ex = [
            "--extractor-args",
            "youtube:player_client=web,web_embedded",
        ]
    if message.get("ytDlpSkipEjsBootstrap"):
        return ex
    ex.extend(["--remote-components", "ejs:github"])
    runtimes: List[str] = []
    if shutil.which("deno"):
        runtimes.append("deno")
    if shutil.which("node"):
        runtimes.append("node")
    # Keep explicit runtime list when available to avoid deprecated no-runtime extraction paths.
    for rt in runtimes:
        ex.extend(["--js-runtimes", rt])
    return ex


def _host_endswith_domain(host: str, domain: str) -> bool:
    host = (host or "").lower().rstrip(".")
    domain = (domain or "").lower().lstrip(".")
    if not host or not domain:
        return False
    return host == domain or host.endswith("." + domain)


def _host_matches_any(host: str, domains: Tuple[str, ...]) -> bool:
    return any(_host_endswith_domain(host, d) for d in domains)


def _page_is_tiktok(page_url: str) -> bool:
    h = _netloc_host(page_url)
    return _host_matches_any(h, ("tiktok.com", "musical.ly", "tiktokv.com"))


def _social_platform_for_yt_dlp(stream_url: str, page_url: str, message: Any) -> Optional[str]:
    """
    Host matched a known social / streaming CDN → use yt-dlp.
    Exceptions (use ffmpeg instead):
    - HLS from SoundCloud's media CDN (signed m3u8 URLs).
    - HLS from TikTok-like CDNs when the tab is not a TikTok page (obfuscated HLS, etc.).
    Apple Music song/album pages (and their CDNs) always go to yt-dlp with the page URL —
    never FairPlay m3u8 via ffmpeg.
    """
    sh = _netloc_host(stream_url)
    ph = _netloc_host(page_url)
    if _is_apple_music_drm_context(stream_url, page_url):
        return "Apple Music"
    if _is_hls_input(stream_url, message):
        if _host_matches_any(sh, _SOUNDCLOUD_CDN_STREAM_HOSTS):
            return None
    if _is_hls_input(stream_url, message) and not _page_is_tiktok(page_url):
        if _host_matches_any(sh, _TIKTOK_CDN_STREAM_HOSTS):
            return None
    for label, domains in _SOCIAL_PLATFORM_RULES:
        if _host_matches_any(sh, domains) or _host_matches_any(ph, domains):
            return label
    return None


def _wants_yt_dlp_audio_extract(message: dict, target_url: str = "") -> bool:
    if message and message.get("ytDlpAudioOnly"):
        return True
    page_url = (message.get("pageUrl") or message.get("referer") or "").strip() if message else ""
    if _is_spotify_url(target_url) or _is_spotify_url(page_url):
        return True
    if _is_apple_music_drm_context(target_url, page_url):
        return True
    return False


def _is_spotify_url(url: str) -> bool:
    h = _netloc_host(url)
    return _host_matches_any(h, ("spotify.com", "open.spotify.com", "scdn.co"))


def _spotify_filename_hint(stream_url: str, page_url: str, fallback_stem: str) -> str:
    """
    Build a readable track-ish name from Spotify URL path when user kept a generic name.
    Keeps existing sanitization behavior via _safe_output_path callers.
    """
    candidate = (page_url or stream_url or "").strip()
    if not candidate:
        return fallback_stem
    try:
        p = urlparse(candidate if "://" in candidate else "https://" + candidate)
        parts = [x for x in (p.path or "").split("/") if x]
    except Exception:
        return fallback_stem
    if not parts:
        return fallback_stem
    kind = parts[0].lower()
    if kind not in ("track", "playlist", "album", "episode", "show"):
        return fallback_stem
    ident = parts[1] if len(parts) > 1 else ""
    ident = re.sub(r"[^A-Za-z0-9_-]+", "", ident)[:16]
    if not ident:
        ident = "item"
    return f"spotify {kind} {ident}"


def _looks_like_spotify_drm_or_unsupported(err_tail: str) -> bool:
    t = (err_tail or "").lower()
    needles = (
        "drm",
        "widevine",
        "license",
        "encrypted",
        "unsupported url",
        "unsupported site",
        "spotify requires",
        "cannot download",
        "login required",
        "not available",
    )
    return any(n in t for n in needles)


def _spotify_oembed_query(spotify_url: str) -> Optional[str]:
    u = (spotify_url or "").strip()
    if not u:
        return None
    api = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(u, safe="")
    try:
        req = urllib.request.Request(api, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            raw = resp.read()
        obj = json.loads(raw.decode("utf-8", errors="replace"))
        title = str(obj.get("title") or "").strip()
        if not title:
            return None
        title = re.sub(r"\s*\|\s*Spotify\s*$", "", title, flags=re.I).strip()
        if not title:
            return None
        return f"{title} official audio"
    except Exception:
        return None


def _yt_dlp_version_probe_candidates() -> List[List[str]]:
    """Ways to run `yt_dlp --version`; host may use a different Python than your terminal."""
    out: List[List[str]] = [["yt-dlp"]]
    exe_seen: Set[str] = set()

    def add_py_m(pyexe: Optional[str]) -> None:
        if not pyexe:
            return
        try:
            key = os.path.normcase(os.path.realpath(pyexe))
        except OSError:
            key = os.path.normcase(pyexe)
        if key in exe_seen:
            return
        exe_seen.add(key)
        out.append([pyexe, "-m", "yt_dlp"])

    add_py_m(sys.executable)
    add_py_m(shutil.which("python"))
    add_py_m(shutil.which("python3"))
    if os.name == "nt":
        out.extend((["py", "-3", "-m", "yt_dlp"], ["py", "-m", "yt_dlp"]))
    return out


def _yt_dlp_invocation_prefix() -> Optional[List[str]]:
    """
    How to start yt-dlp on this machine. pip often installs the module but not yt-dlp.exe on PATH
    (e.g. Microsoft Store Python) then `python -m yt_dlp` works.

    Chrome-spawned Store Python often fails subprocess `[sys.executable, "-m", "yt_dlp", "--version"]`
    even when yt-dlp is installed; prefer in-process importability first.
    """
    global _YTDLP_CMD_PREFIX, _YTDLP_PREFIX_PROBED
    if _YTDLP_PREFIX_PROBED:
        return _YTDLP_CMD_PREFIX
    _YTDLP_PREFIX_PROBED = True
    if _yt_dlp_importable_in_process():
        _YTDLP_CMD_PREFIX = [sys.executable, "-m", "yt_dlp"]
        return _YTDLP_CMD_PREFIX
    # Do not use CREATE_NO_WINDOW here: Store Python shims under WindowsApps often fail with it
    # when the host is spawned from Chrome, even though `python -m yt_dlp` works in a terminal.
    run_kw: Dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": 40,
    }
    for prefix in _yt_dlp_version_probe_candidates():
        try:
            r = subprocess.run(prefix + ["--version"], **run_kw)
            if r.returncode == 0:
                _YTDLP_CMD_PREFIX = prefix
                return prefix
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            continue
        except Exception:
            continue
    _YTDLP_CMD_PREFIX = None
    return None


def _yt_dlp_available() -> bool:
    return _yt_dlp_invocation_prefix() is not None


_RE_YTDLP_PROGRESS = re.compile(
    r"\[download\]\s+(?P<pct>[\d.]+)%\s+of\s+~?\s*(?P<size>\S+)(?:\s+at\s+(?P<rate>\S+))?(?:\s+ETA\s+(?P<eta>\S+))?",
    re.I,
)


def _parse_yt_dlp_progress(line: str) -> Dict[str, Any]:
    m = _RE_YTDLP_PROGRESS.search(line)
    if not m:
        return {}
    parts = [f"{m.group('pct').strip()}%"]
    if m.group("rate"):
        parts.append(m.group("rate").strip())
    if m.group("eta"):
        parts.append(f"ETA {m.group('eta').strip()}")
    return {"detail": " · ".join(parts)}


def _yt_dlp_header_args(message: dict) -> List[str]:
    """Extra yt-dlp CLI args: --add-header for Referer, UA, Authorization."""
    referer = (message.get("pageUrl") or message.get("referer") or "").strip()
    ua = (message.get("userAgent") or "").strip() or USER_AGENT
    cap = _cap_headers(message.get("capturedHeaders"))
    if not referer and cap.get("referer"):
        referer = cap["referer"].strip()
    args: List[str] = []
    if referer:
        args.extend(["--add-header", f"Referer:{referer}"])
    args.extend(["--add-header", f"User-Agent:{ua}"])
    auth = cap.get("authorization") or (message.get("authorization") or "").strip()
    if auth:
        args.extend(["--add-header", f"Authorization:{auth}"])
    return args


_YTDLP_COOKIE_BROWSERS = frozenset(
    {"chrome", "chromium", "edge", "brave", "opera", "vivaldi", "firefox", "safari", "whale"}
)


def _yt_dlp_cookies_from_browser_args(message: dict, target_url: str) -> List[str]:
    """
    On your own machine the simplest auth that actually works is letting yt-dlp read cookies
    straight from the browser you are already logged into. Instagram, Facebook and the like send
    an empty media response otherwise. YouTube is left out by default since account cookies can
    trip its bot checks; set the browser to a value like "none" to turn this off.
    """
    if _yt_dlp_target_is_youtube_like(target_url):
        return []
    raw = (
        message.get("ytDlpCookiesFromBrowser")
        or os.environ.get("HLS_GRABBER_COOKIES_FROM_BROWSER")
        or "chrome"
    ).strip().lower()
    if raw in ("", "none", "off", "0", "false", "disabled"):
        return []
    browser = raw if raw in _YTDLP_COOKIE_BROWSERS else "chrome"
    return ["--cookies-from-browser", browser]


def _write_netscape_cookie_file(cookie_jar: Any) -> Optional[str]:
    """
    Write the extension-supplied cookies as a Netscape cookies.txt for yt-dlp --cookies. These
    come from the browser in plaintext, so this avoids yt-dlp having to decrypt Chrome's own
    cookie store (the "Failed to decrypt with DPAPI" App-Bound Encryption error). Returns the temp
    file path, or None when there is nothing usable. Caller is responsible for deleting it.
    """
    if not isinstance(cookie_jar, list) or not cookie_jar:
        return None
    lines = ["# Netscape HTTP Cookie File", ""]
    count = 0
    for c in cookie_jar:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "")
        domain = str(c.get("domain") or "").strip()
        if not name or not domain:
            continue
        value = "" if c.get("value") is None else str(c.get("value"))
        if not c.get("hostOnly") and not domain.startswith("."):
            domain = "." + domain
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = str(c.get("path") or "/") or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        exp = c.get("expirationDate")
        try:
            expiry = str(int(float(exp))) if exp else "0"
        except (TypeError, ValueError):
            expiry = "0"
        domain_field = ("#HttpOnly_" + domain) if c.get("httpOnly") else domain
        lines.append("\t".join([domain_field, include_sub, path, secure, expiry, name, value]))
        count += 1
    if not count:
        return None
    try:
        fd, path = tempfile.mkstemp(prefix="sg_cookies_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")
        return path
    except OSError:
        return None


def _remove_temp_file_quietly(path: Optional[str]) -> None:
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


def _yt_dlp_cookies_args(message: dict, target_url: str) -> List[str]:
    """
    Prefer the cookie jar the extension handed us (already written to a temp file), then fall back
    to reading the browser store directly. YouTube stays cookie-free by default either way.
    """
    if _yt_dlp_target_is_youtube_like(target_url):
        return []
    jar_file = message.get("_ytDlpCookieFile")
    if jar_file and os.path.isfile(jar_file):
        return ["--cookies", jar_file]
    return _yt_dlp_cookies_from_browser_args(message, target_url)


def _yt_dlp_format_string(message: dict, target_url: str) -> str:
    """
    Prefer best video + best audio (merged with ffmpeg). Use bestvideo* (asterisk) first so yt-dlp
    can pick a combined progressive stream (e.g. single 360p mp4) when split DASH/https formats
    are missing or blocked (PO tokens).
    """
    custom = (message.get("ytDlpFormat") or "").strip()
    if custom:
        return custom
    if _wants_yt_dlp_audio_extract(message, target_url):
        return "bestaudio/best"
    try:
        cap_h = int(message.get("ytDlpMaxHeight") if message.get("ytDlpMaxHeight") is not None else 4320)
    except (TypeError, ValueError):
        cap_h = 4320
    if cap_h <= 0:
        return "bestvideo*+bestaudio/best"
    return f"bestvideo*[height<={cap_h}]+bestaudio/best[height<={cap_h}]/best"


def _yt_dlp_build_cmd(prefix: List[str], message: dict, output_path: str, target_url: str) -> List[str]:
    cmd: List[str] = list(prefix) + [
        "-f",
        _yt_dlp_format_string(message, target_url),
        "--merge-output-format",
        "mp4",
    ]
    if _wants_yt_dlp_audio_extract(message, target_url):
        cmd.extend(["--extract-audio", "--audio-format", "mp3", "--audio-quality", "0"])
    if not message.get("ytDlpDownloadPlaylist"):
        cmd.append("--no-playlist")
    cmd.extend(
        [
            "--no-mtime",
            "-o",
            output_path,
        ]
    )
    thumbs = message.get("ytDlpWriteThumbnail") or message.get("includeThumbnail")
    if thumbs:
        cmd.extend(["--write-thumbnail", "--convert-thumbnails", "jpg"])
    cmd.extend(_yt_dlp_youtube_cli_extras(message, target_url))
    cmd.extend(_yt_dlp_cookies_args(message, target_url))
    cmd.extend(_yt_dlp_header_args(message))
    cmd.append(target_url)
    return cmd


def _yt_dlp_primary_input_url(page_url: str, stream_url: str) -> str:
    """yt-dlp extractors need the watch page URL when available, not only the CDN."""
    p = (page_url or "").strip()
    if p.startswith("http://") or p.startswith("https://"):
        return p
    return (stream_url or "").strip()


def _handle_ytdlp_formats(message: dict) -> None:
    """Synchronous JSON probe for UI quality picker (Chrome sends dedicated native port)."""
    req_id = (message.get("requestId") or "").strip()
    page_url = (message.get("pageUrl") or message.get("referer") or "").strip()
    stream_url = (message.get("url") or "").strip()
    target = _yt_dlp_primary_input_url(page_url, stream_url)
    if not target:
        send_message(
            {
                "type": "ytdlp_formats_result",
                "requestId": req_id,
                "success": False,
                "error": "No page URL for yt-dlp",
                "formats": [],
            }
        )
        return
    prefix = _yt_dlp_invocation_prefix()
    if not prefix:
        send_message(
            {
                "type": "ytdlp_formats_result",
                "requestId": req_id,
                "success": False,
                "error": "yt-dlp not available",
                "formats": [],
            }
        )
        return
    cookie_file = _write_netscape_cookie_file(message.get("cookieJar"))
    if cookie_file:
        message["_ytDlpCookieFile"] = cookie_file
    cmd: List[str] = list(prefix) + [
        "--dump-single-json",
        "--no-download",
        "--skip-download",
    ]
    cmd.extend(_yt_dlp_youtube_cli_extras(message, target))
    cmd.extend(_yt_dlp_cookies_args(message, target))
    cmd.extend(_yt_dlp_header_args(message))
    cmd.append(target)
    run_kw: Dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": 120,
        "encoding": "utf-8",
        "errors": "replace",
    }
    try:
        r = subprocess.run(cmd, **run_kw)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        send_message(
            {
                "type": "ytdlp_formats_result",
                "requestId": req_id,
                "success": False,
                "error": str(e),
                "formats": [],
            }
        )
        return
    finally:
        _remove_temp_file_quietly(cookie_file)
    if r.returncode != 0 or not (r.stdout or "").strip():
        tail = ((r.stderr or "") + (r.stdout or ""))[-800:]
        send_message(
            {
                "type": "ytdlp_formats_result",
                "requestId": req_id,
                "success": False,
                "error": tail or f"yt-dlp exit {r.returncode}",
                "formats": [],
            }
        )
        return
    try:
        info = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        send_message(
            {
                "type": "ytdlp_formats_result",
                "requestId": req_id,
                "success": False,
                "error": f"Bad JSON from yt-dlp: {e}",
                "formats": [],
            }
        )
        return

    formats_raw = info.get("formats") or []
    rows: List[Dict[str, Any]] = []
    for fmt in formats_raw:
        fid = fmt.get("format_id")
        if fid is None:
            continue
        vcodec = fmt.get("vcodec") or "none"
        acodec = fmt.get("acodec") or "none"
        if vcodec == "none" and acodec == "none":
            continue
        height = fmt.get("height")
        ext = fmt.get("ext") or ""
        fps = fmt.get("fps")
        fs = fmt.get("filesize") or fmt.get("filesize_approx")
        has_video = vcodec not in ("none", None)
        has_audio = acodec not in ("none", None)
        parts = [str(fid)]
        if has_video and height:
            parts.append(f"{height}p")
        if has_video and ext:
            parts.append(ext)
        if has_video and fps:
            parts.append(f"{fps}fps")
        if has_audio and not has_video:
            parts.append("audio only")
        elif has_audio:
            parts.append("+audio")
        if fs and str(fs).isdigit():
            parts.append(f"~{int(fs) // 1_000_000}MB" if int(fs) > 1_000_000 else f"~{int(fs) // 1024}KB")
        label = " ".join(parts)
        rows.append(
            {
                "format_id": str(fid),
                "label": label,
                "ext": ext,
                "height": height,
                "vcodec": vcodec,
                "acodec": acodec,
                "has_video": has_video,
                "has_audio": has_audio,
            }
        )

    def sort_key(row: Dict[str, Any]) -> Tuple[int, int, str]:
        hv = 2 if row.get("has_video") else 0
        ha = 1 if row.get("has_audio") else 0
        h = int(row.get("height") or 0)
        return (hv + ha, h, row.get("label") or "")

    rows.sort(key=sort_key, reverse=True)
    rows = rows[:28]

    send_message(
        {
            "type": "ytdlp_formats_result",
            "requestId": req_id,
            "success": True,
            "title": (info.get("title") or "")[:200],
            "formats": rows,
        }
    )


def run_yt_dlp_with_updates(
    stream_url: str,
    message: dict,
    output_path: str,
    job_id: str,
    platform_label: str,
    *,
    emit_done_on_failure: bool = True,
) -> Tuple[bool, str]:
    """
    Download with yt-dlp using page URL first, then stream URL on failure.
    Returns (True, "") when the job finished successfully or was canceled (done already sent).
    Returns (False, error) on failure; sends done only when emit_done_on_failure is True.
    """
    page_url = (message.get("pageUrl") or message.get("referer") or "").strip()
    run_message = dict(message or {})
    cookie_file = _write_netscape_cookie_file(run_message.get("cookieJar"))
    if cookie_file:
        run_message["_ytDlpCookieFile"] = cookie_file

    def run_one(target: str) -> Tuple[int, List[str]]:
        global _active_ffmpeg
        stderr_lines: List[str] = []
        prefix = _yt_dlp_invocation_prefix()
        if not prefix:
            return 127, ["yt-dlp not found (tried PATH, python -m yt_dlp, py -m yt_dlp)"]
        cmd = _yt_dlp_build_cmd(prefix, run_message, output_path, target)
        popen_kw: Dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
        }
        # Same as version probe: avoid CREATE_NO_WINDOW with WindowsApps Python (Chrome-spawned host).
        try:
            proc = subprocess.Popen(cmd, **popen_kw)
        except FileNotFoundError:
            return 127, ["yt-dlp invocation failed (executable missing)"]
        except Exception as e:
            return 1, [str(e)]

        with _PROC_LOCK:
            _active_ffmpeg = proc

        last_send = 0.0
        throttle_s = 0.35

        def read_stderr() -> None:
            nonlocal last_send
            try:
                for raw in iter(proc.stderr.readline, b""):
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace")
                    stderr_lines.append(line)
                    if len(stderr_lines) > 250:
                        stderr_lines.pop(0)
                    if "[download]" not in line:
                        continue
                    pr = _parse_yt_dlp_progress(line)
                    det = pr.get("detail") or line.strip()[:140]
                    now = time.monotonic()
                    if now - last_send < throttle_s:
                        continue
                    last_send = now
                    send_message(
                        with_job_id(
                            {
                                "type": "progress",
                                "phase": "downloading",
                                "detail": det,
                                "output": output_path,
                            },
                            job_id,
                        )
                    )
            finally:
                try:
                    proc.stderr.close()
                except Exception:
                    pass

        t_sd = threading.Thread(target=read_stderr, daemon=True)
        t_sd.start()
        code = proc.wait()
        t_sd.join(timeout=2.0)
        _clear_active_if(proc)
        return code, stderr_lines

    primary = _yt_dlp_primary_input_url(page_url, stream_url)
    plat = (platform_label or "").strip().lower()
    spotify_flow = plat == "spotify"
    apple_flow = plat in ("apple music", "apple") or _is_apple_music_drm_context(
        stream_url, page_url
    )
    audio_flow = spotify_flow or apple_flow or bool(run_message.get("ytDlpAudioOnly"))
    if audio_flow:
        run_message["ytDlpAudioOnly"] = True
    start_detail = f"yt-dlp - {platform_label}"
    if spotify_flow:
        start_detail = "Attempting Spotify extraction…"
    elif apple_flow:
        start_detail = "Attempting Apple Music via yt-dlp…"
    send_message(
        with_job_id(
            {
                "type": "progress",
                "phase": "starting",
                "detail": start_detail,
                "output": output_path,
            },
            job_id,
        )
    )
    code, err_lines = run_one(primary)
    if (
        code != 0
        and stream_url
        and primary != stream_url
    ):
        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "downloading",
                    "detail": "yt-dlp: retrying with stream URL…",
                    "output": output_path,
                },
                job_id,
            )
        )
        code, err_lines = run_one(stream_url)

    tail = "".join(err_lines[-35:]).strip()
    if code != 0 and spotify_flow and _looks_like_spotify_drm_or_unsupported(tail):
        q = _spotify_oembed_query(primary) or _spotify_oembed_query(stream_url)
        if q:
            send_message(
                with_job_id(
                    {
                        "type": "progress",
                        "phase": "downloading",
                        "detail": "Spotify blocked; searching YouTube fallback…",
                        "output": output_path,
                    },
                    job_id,
                )
            )
            yt_target = "ytsearch1:" + q
            code, err_lines = run_one(yt_target)

    if code != 0 and apple_flow:
        q = _apple_music_youtube_query(run_message, page_url, stream_url)
        if q:
            send_message(
                with_job_id(
                    {
                        "type": "progress",
                        "phase": "downloading",
                        "detail": "Apple Music blocked; searching YouTube fallback…",
                        "output": output_path,
                    },
                    job_id,
                )
            )
            code, err_lines = run_one("ytsearch1:" + q)

    _remove_temp_file_quietly(cookie_file)

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
        return True, ""

    tail = "".join(err_lines[-35:]).strip()
    if code == 0:
        if audio_flow:
            ok_v, verr = _verify_yt_dlp_audio_output(output_path)
        else:
            ok_v, verr = _verify_yt_dlp_output(output_path)
        if not ok_v:
            err = verr or "Download validation failed"
            if tail:
                err = err + " | " + tail[-600:]
            if emit_done_on_failure:
                send_message(
                    with_job_id({"type": "done", "success": False, "error": err}, job_id)
                )
            return False, err
        out_report = output_path
        detail_done = "Finished"
        if message.get("ytDlpDownloadPlaylist"):
            out_report = os.path.normpath(os.path.dirname(output_path))
            detail_done = "Playlist finished (multiple files in folder)"
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": True,
                    "output": out_report,
                    "detail": detail_done,
                },
                job_id,
            )
        )
        return True, ""

    err = f"yt-dlp exited with code {code}"
    if tail:
        err = err + ": " + tail[-600:]
    if spotify_flow and _looks_like_spotify_drm_or_unsupported(tail):
        err = (
            "Spotify source protected (DRM/unsupported). "
            "Direct full-audio extraction is blocked for many Spotify URLs. "
            f"Details: {tail[-420:]}" if tail else
            "Spotify source protected (DRM/unsupported). Direct full-audio extraction is blocked."
        )
    if apple_flow and _looks_like_spotify_drm_or_unsupported(tail):
        err = (
            "Apple Music page extraction failed (often FairPlay DRM). "
            f"Details: {tail[-420:]}" if tail else
            "Apple Music page extraction failed (often FairPlay DRM)."
        )
    if emit_done_on_failure:
        send_message(with_job_id({"type": "done", "success": False, "error": err}, job_id))
    return False, err


# --- Obfuscated HLS (image-wrapped .ts segments) ---

_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_PNG_IEND = b"IEND\xae\x42\x60\x82"
_JPEG_SIG = b"\xff\xd8\xff"
_GIF_SIG = b"GIF8"
_WEBP_RIFF = b"RIFF"
_WEBP_MAGIC = b"WEBP"
_MP4_BOX_TYPES = (b"ftyp", b"styp", b"moof")


def _strip_leading_garbage(data: bytes) -> bytes:
    """Skip BOM, whitespace, and # comment lines some CDNs prepend to binary segments."""
    if not data:
        return data
    i = 0
    if data.startswith(b"\xef\xbb\xbf"):
        i = 3
    while i < len(data) and data[i] in (9, 10, 13, 32):
        i += 1
    max_scan = min(len(data), 16384)
    while i < max_scan and data[i : i + 1] == b"#":
        nl = data.find(b"\n", i)
        if nl < 0:
            i = max_scan
            break
        i = nl + 1
        while i < len(data) and data[i] in (9, 10, 13, 32):
            i += 1
    return data[i:]


def _ts_sync_count(data: bytes, idx: int) -> int:
    """Count consecutive 188-byte MPEG-TS packets starting at idx (sync 0x47)."""
    if idx < 0 or idx >= len(data) or (idx < len(data) and data[idx] != 0x47):
        return 0
    c = 0
    j = idx
    while j + 188 <= len(data) and data[j] == 0x47:
        c += 1
        j += 188
    return c


def _looks_like_ts_at(data: bytes, idx: int) -> bool:
    return _ts_sync_count(data, idx) >= 3


def _is_mpegts_packet_sync_at(data: bytes, offset: int = 0) -> bool:
    """True if raw MPEG-TS packets start at offset (0x47 every 188 bytes)."""
    if offset < 0:
        return False
    if len(data) < offset + 189:
        return False
    return data[offset] == 0x47 and data[offset + 188] == 0x47


def _find_best_mpegts_start(data: bytes, start: int = 0) -> int:
    """Strongest sync-aligned run of TS packets; avoids accidental 0x47 in MP4/binary noise."""
    n = len(data)
    begin = max(0, start)
    best_c = 0
    best_i = 0
    limit = max(0, n - 188)
    for i in range(begin, limit + 1):
        if data[i] != 0x47:
            continue
        c = _ts_sync_count(data, i)
        if c > best_c:
            best_c = c
            best_i = i
    if best_c >= 4:
        return best_i
    return 0


def _find_first_mp4_box(data: bytes) -> int:
    """Offset of first plausible MP4/MPEG-4 box (32-bit size + ftyp|styp|moof)."""
    n = min(len(data), 524288)
    for i in range(0, max(0, n - 8)):
        typ = data[i + 4 : i + 8]
        if typ not in _MP4_BOX_TYPES:
            continue
        try:
            sz = struct.unpack(">I", data[i : i + 4])[0]
        except struct.error:
            continue
        if 8 <= sz <= min(len(data) - i, 100_000_000):
            return i
    return -1


def _parse_hls_byterange_attr(val: str) -> Optional[Tuple[int, Optional[int]]]:
    """HLS BYTERANGE value: length[@offset]. Returns (length, offset or None if implicit)."""
    m = re.match(r"^\s*(\d+)(?:@(\d+))?\s*$", (val or "").strip())
    if not m:
        return None
    n = int(m.group(1))
    o = int(m.group(2)) if m.group(2) else None
    return (n, o)


def _parse_ext_x_map(
    playlist_text: str, playlist_url: str
) -> Tuple[Optional[str], Optional[Tuple[int, int]]]:
    """
    Parse #EXT-X-MAP. Returns (absolute init URL, optional (start, length) byte range).
    """
    base = _m3u8_base_url(playlist_url)
    for line in playlist_text.splitlines():
        s = line.strip()
        if not s.startswith("#EXT-X-MAP:"):
            continue
        rest = s[len("#EXT-X-MAP:") :]
        m = re.search(r'URI\s*=\s*"([^"]+)"', rest, re.I)
        if not m:
            m = re.search(r"URI\s*=\s*([^,\s]+)", rest, re.I)
        if not m:
            continue
        u = m.group(1).strip().strip('"')
        if not u:
            continue
        abs_u = urljoin(base, u)
        br_out: Optional[Tuple[int, int]] = None
        bm = re.search(r'BYTERANGE\s*=\s*"([^"]+)"', rest, re.I)
        if not bm:
            bm = re.search(r"BYTERANGE\s*=\s*([^,\s]+)", rest, re.I)
        if bm:
            parsed = _parse_hls_byterange_attr(bm.group(1).strip())
            if parsed:
                n, o_opt = parsed
                start = int(o_opt) if o_opt is not None else 0
                br_out = (start, n)
        return (abs_u, br_out)
    return (None, None)


def _parse_hls_media_segments(
    playlist_text: str, playlist_url: str
) -> List[Tuple[str, Optional[Tuple[int, int]]]]:
    """
    Media lines with optional #EXT-X-BYTERANGE on the previous line.
    Each entry: (absolute URL, optional (start_offset, length) within the resource).
    """
    base = _m3u8_base_url(playlist_url)
    out: List[Tuple[str, Optional[Tuple[int, int]]]] = []
    pending: Optional[Tuple[int, Optional[int]]] = None
    implicit_off: Dict[str, int] = {}

    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            ul = line.upper()
            if ul.startswith("#EXT-X-BYTERANGE:"):
                rest = line.split(":", 1)[1]
                parsed = _parse_hls_byterange_attr(rest)
                if parsed:
                    pending = parsed
            continue
        uri_abs = urljoin(base, line)
        if pending is not None:
            n, o_opt = pending
            pending = None
            if o_opt is not None:
                start = int(o_opt)
            else:
                start = implicit_off.get(uri_abs, 0)
            implicit_off[uri_abs] = start + n
            out.append((uri_abs, (start, n)))
        else:
            out.append((uri_abs, None))
    return out


def _hls_playlist_duration_seconds(playlist_text: str) -> float:
    total = 0.0
    for raw_line in (playlist_text or "").splitlines():
        line = raw_line.strip()
        if not line.upper().startswith("#EXTINF:"):
            continue
        rest = line.split(":", 1)[1]
        dur_str = rest.split(",", 1)[0].strip()
        try:
            total += max(0.0, float(dur_str))
        except ValueError:
            continue
    return total


def _hls_playlist_estimated_size_bytes(
    playlist_text: str, playlist_url: str
) -> Optional[int]:
    """Sum #EXT-X-BYTERANGE lengths when present; None if segments have no size hints."""
    entries = _parse_hls_media_segments(playlist_text, playlist_url)
    if not entries:
        return None
    total = 0
    has_estimate = False
    for _seg_url, byte_range in entries:
        if byte_range is None:
            continue
        total += int(byte_range[1])
        has_estimate = True
    return total if has_estimate and total > 0 else None


def _find_mpegts_payload_start(data: bytes, start: int = 0) -> int:
    return _find_best_mpegts_start(data, start)


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
    byte_range: Optional[Tuple[int, int]] = None,
) -> bytes:
    """GET url. Optional byte_range (start, length) uses Range request; max_bytes caps read when no range."""
    headers = _headers_dict_from_block(header_block)
    req = urllib.request.Request(url, headers=headers, method="GET")
    range_start: Optional[int] = None
    range_len: Optional[int] = None
    if byte_range is not None:
        rs, ln = byte_range
        range_start = rs
        eff_len = ln
        if max_bytes is not None:
            eff_len = min(ln, max_bytes)
        range_len = eff_len
        end = rs + eff_len - 1
        req.add_header("Range", f"bytes={rs}-{end}")

    out = bytearray()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        chunk = 64 * 1024
        code = getattr(resp, "status", None) or resp.getcode()
        while True:
            if max_bytes is not None and byte_range is None and len(out) >= max_bytes:
                break
            if range_len is not None and len(out) >= range_len:
                break
            to_read = chunk
            if max_bytes is not None and byte_range is None:
                to_read = min(chunk, max_bytes - len(out))
            elif range_len is not None:
                to_read = min(chunk, range_len - len(out))
            if to_read <= 0:
                break
            b = resp.read(to_read)
            if not b:
                break
            out.extend(b)

    data = bytes(out)
    if byte_range is not None and range_start is not None and range_len is not None:
        if code == 200 and len(data) >= range_start + range_len:
            data = data[range_start : range_start + range_len]
        elif len(data) > range_len:
            data = data[:range_len]
    return data


def _http_get_text(url: str, header_block: str, timeout: float = 60.0) -> str:
    return _http_get_bytes(url, header_block, max_bytes=None, timeout=timeout).decode(
        "utf-8", errors="replace"
    )


def _looks_like_vtt_url(url: str) -> bool:
    u = (url or "").strip().lower()
    if not u:
        return False
    path = (urlsplit(u).path or "").lower()
    if path.endswith(".vtt"):
        return True
    if re.search(r"[?&](format|ext|type|mime)=([^&#]*vtt|text%2Fvtt)(&|$)", u):
        return True
    return False


def _download_vtt_immediate(url: str, message: dict, out_dir: str, filename: str, job_id: str) -> None:
    output_path = _safe_output_path(out_dir, filename, ".vtt")
    send_message(
        with_job_id(
            {
                "type": "progress",
                "phase": "starting",
                "detail": "Fetching VTT subtitle...",
                "output": output_path,
            },
            job_id,
        )
    )
    header_block = build_ffmpeg_header_block(message, url)
    try:
        data = _http_get_bytes(url, header_block, timeout=60.0)
    except Exception as e:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": f"VTT request failed: {e}",
                },
                job_id,
            )
        )
        return

    if not data:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": "VTT request returned an empty response.",
                },
                job_id,
            )
        )
        return

    try:
        with open(output_path, "wb") as f:
            f.write(data)
    except OSError as e:
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": f"Could not save VTT file: {e}",
                },
                job_id,
            )
        )
        return

    send_message(
        with_job_id(
            {
                "type": "done",
                "success": True,
                "output": output_path,
                "detail": "Subtitle saved",
            },
            job_id,
        )
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
    return [u for u, _ in _parse_hls_media_segments(playlist_text, playlist_url)]


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
    """Wrapper kind from magic bytes. Raw MPEG-TS at 0 is not a wrapper  return None."""
    s = _strip_leading_garbage(data)
    if not s:
        return None
    # Before PNG/JPEG/GIF: GIF89a also begins with 0x47; packet-aligned TS uses 188-byte sync.
    if _is_mpegts_packet_sync_at(s, 0):
        return None
    if len(s) >= 8 and s.startswith(_PNG_SIG):
        return "png"
    if len(s) >= 3 and s.startswith(_JPEG_SIG):
        return "jpeg"
    if len(s) >= 6 and s.startswith(_GIF_SIG):
        return "gif"
    if len(s) >= 12 and s[0:4] == _WEBP_RIFF and s[8:12] == _WEBP_MAGIC:
        return "webp"
    return None


def _segment_payload_format(b: bytes) -> str:
    if not b:
        return "unknown"
    if _ts_sync_count(b, 0) >= 4:
        return "ts"
    if _find_first_mp4_box(b) >= 0:
        return "fmp4"
    return "unknown"


def _finalize_segment_payload(b: bytes) -> bytes:
    if not b:
        return b
    if _ts_sync_count(b, 0) >= 4:
        return b
    j = _find_first_mp4_box(b)
    if j >= 0:
        return b[j:]
    off = _find_best_mpegts_start(b, 0)
    if off > 0:
        return b[off:]
    return b


def _extract_ts_payload(data: bytes, hint: Optional[str]) -> bytes:
    """Strip text/BOM/# lines, image wrappers, then locate MPEG-TS or fMP4."""
    if not data:
        return data
    s = _strip_leading_garbage(data)
    if not s:
        return s
    if hint == "fmp4":
        j = _find_first_mp4_box(s)
        if j >= 0:
            return _finalize_segment_payload(s[j:])
    if _ts_sync_count(s, 0) >= 4:
        return s

    order = []
    if hint in ("png", "jpeg", "gif", "webp", "generic", "fmp4"):
        if hint != "fmp4":
            order.append(hint)
    for k in ("png", "jpeg", "gif", "webp"):
        if k not in order:
            order.append(k)
    if "generic" not in order:
        order.append("generic")

    for kind in order:
        if kind == "png":
            t = _strip_png_prefix(s)
            if t is not None and t:
                return _finalize_segment_payload(t)
        elif kind == "jpeg":
            t = _strip_jpeg_prefix(s)
            if t is not None and t:
                return _finalize_segment_payload(t)
        elif kind == "gif":
            t = _strip_gif_prefix(s)
            if t is not None and t:
                return _finalize_segment_payload(t)
        elif kind == "webp":
            t = _strip_webp_prefix(s)
            if t is not None and t:
                return _finalize_segment_payload(t)
        elif kind == "generic":
            off = _find_best_mpegts_start(s, 0)
            if off > 0:
                return _finalize_segment_payload(s[off:])

    j2 = _find_first_mp4_box(s)
    if j2 >= 0:
        return _finalize_segment_payload(s[j2:])
    return _finalize_segment_payload(s)


def _detect_obfuscated_segments(
    url: str,
    header_block: str,
    variant: Optional[Tuple[str, str]] = None,
) -> Tuple[Optional[str], int]:
    """
    Download variant playlist and sample first segment.
    Returns (obfuscation_kind, unused). kind None => use normal ffmpeg with HLS flags
    (raw MPEG-TS segments under fake .jpg/.gif names need -allowed_extensions ALL only).
    """
    try:
        if variant is not None:
            var_url, var_text = variant
        else:
            var_url, var_text = _resolve_variant_playlist_url(url, header_block)
    except (urllib.error.URLError, OSError, ValueError, UnicodeError):
        return None, 0

    seg_entries = _parse_hls_media_segments(var_text, var_url)
    if not seg_entries:
        return None, 0

    sample_url, sample_br = seg_entries[0]
    try:
        head = _http_get_bytes(
            sample_url, header_block, max_bytes=4 * 1024 * 1024, timeout=90.0, byte_range=sample_br
        )
    except (urllib.error.URLError, OSError, ValueError):
        return None, 0

    if not head:
        return None, 0

    s0 = _strip_leading_garbage(head)

    # 1) Raw MPEG-TS at byte 0 (188-byte sync). Disambiguates TS from GIF89a (also 0x47…).
    if _is_mpegts_packet_sync_at(s0, 0):
        return None, 0

    # 2–5) Wrapper / fMP4 via magic; 6) scan first 64KB for TS after leading junk.
    img = _obfuscation_kind_from_magic(head)
    if img:
        hint = img
    elif _find_first_mp4_box(s0) >= 0:
        hint = "fmp4"
    else:
        win = s0[:65536]
        off = _find_best_mpegts_start(win, 0)
        if off > 0 and _looks_like_ts_at(win, off):
            hint = "generic"
        elif _ts_sync_count(s0, 0) >= 4:
            return None, 0
        else:
            hint = "generic"

    def _classify_sample(sample: bytes) -> Optional[str]:
        pl = _extract_ts_payload(sample, hint)
        fmt = _segment_payload_format(pl)
        if fmt == "fmp4":
            return "fmp4"
        if fmt == "ts" and _ts_sync_count(pl, 0) >= 4:
            return hint if hint != "fmp4" else "generic"
        return None

    k = _classify_sample(head)
    if k:
        if img and k == "generic":
            return img, 0
        return k, 0

    try:
        full = _http_get_bytes(sample_url, header_block, max_bytes=None, timeout=120.0, byte_range=sample_br)
    except (urllib.error.URLError, OSError, ValueError):
        return None, 0

    k = _classify_sample(full)
    if not k:
        return None, 0
    if img and k == "generic":
        return img, 0
    return k, 0


def _download_segment_bytes(
    url: str,
    header_block: str,
    byte_range: Optional[Tuple[int, int]] = None,
) -> bytes:
    last_err: Optional[BaseException] = None
    for attempt in range(3):
        try:
            return _http_get_bytes(
                url, header_block, max_bytes=None, timeout=120.0, byte_range=byte_range
            )
        except (urllib.error.URLError, OSError, ValueError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1.0)
    if last_err:
        raise last_err
    return b""


def _ffmpeg_remux_combined_to_output(
    combined_path: str,
    output_path: str,
    job_id: str,
    *,
    container: str,
    message: Optional[dict] = None,
) -> None:
    """ffmpeg mux combined TS/fMP4 to MP4; default re-encodes video for stable PTS/GOP."""
    global _active_ffmpeg
    out_mp4 = output_path.lower().endswith(".mp4")
    has_video = bool(_ffprobe_first_video_codec(combined_path))
    audio_only = not has_video
    # Audio-only: re-encode AAC (stream-copy of DRM/corrupt AAC looks "done" but won't play).
    # Video: re-encode for stable PTS unless stream-copy forced.
    transcoding = out_mp4 and (
        audio_only or (has_video and not _ffmpeg_force_stream_copy_hls_mp4())
    )
    preset = ""
    if transcoding and has_video:
        ld, ls = _local_file_format_hints(combined_path)
        preset = _ffmpeg_resolve_x264_preset(message, ld, ls)
    if audio_only:
        detail = "Re-encoding audio to MP4 (ffmpeg)…"
    elif transcoding and preset:
        detail = f"Re-encoding video to MP4 (x264 preset {preset})…"
    elif transcoding:
        detail = "Re-encoding video to MP4 (ffmpeg)…"
    else:
        detail = "Remuxing to MP4 (ffmpeg)…"
    send_message(
        with_job_id(
            {
                "type": "progress",
                "phase": "encoding",
                "detail": detail,
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
        *_ffmpeg_local_file_remux_fflags(),
        "-i",
        combined_path,
    ]
    if audio_only and out_mp4:
        cmd.extend(_ffmpeg_audio_only_encode_args())
    elif transcoding:
        if not preset:
            ld, ls = _local_file_format_hints(combined_path)
            preset = _ffmpeg_resolve_x264_preset(message, ld, ls)
        cmd.extend(
            _ffmpeg_transcode_stable_mp4_from_combined_file(
                container, preset=preset, audio_only=False
            )
        )
    else:
        cmd.extend(["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy"])
        if container == "ts":
            cmd.extend(["-bsf:a", "aac_adtstoasc"])
    cmd.extend(_ffmpeg_copy_mux_fixup_args(for_mp4=out_mp4))
    cmd.append(output_path)
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
        ok_p, perr = _verify_ffmpeg_output_playable(output_path)
        if not ok_p:
            send_message(
                with_job_id({"type": "done", "success": False, "error": perr}, job_id)
            )
            return
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


def _hls_uses_misleading_extensions(playlist_url: str, playlist_text: str) -> bool:
    """CDN uses wrong extensions (playlist or segments) while bytes are valid media."""
    u = (playlist_url or "").lower()
    if re.search(r"\.(?:txt|php|asp|aspx|ashx|jsp)(?:[?#]|$)", u):
        return True
    low = (playlist_text or "").lower()
    if re.search(r"\.woff2?(?=[?\s\"'#]|$)", low):
        return True
    # Segments named like images but payload may be TS/fMP4 (no wrapper)
    if re.search(r"\.(?:jpe?g|png|gif|webp|bmp|ico)(?=[?\s\"'#]|$)", low):
        return True
    return False


def _clean_hls_payload_kind_raw(data: bytes) -> Optional[str]:
    """
    Valid media at byte 0 (no unwrap): MPEG-TS sync or fMP4 box ftyp/styp/moof.
    """
    if not data or len(data) < 8:
        return None
    if data[0] == 0x47 and _ts_sync_count(data, 0) >= 4:
        return "ts"
    typ = data[4:8]
    if typ in (b"ftyp", b"styp", b"moof"):
        return "fmp4"
    return None


def _classify_clean_fake_ext_hls(
    var_url: str, var_text: str, header_block: str
) -> Optional[str]:
    """
    Probe EXT-X-MAP (if any) and first media segment. Returns 'fmp4', 'ts', or None.
    """
    seg_entries = _parse_hls_media_segments(var_text, var_url)
    if not seg_entries:
        return None
    map_url, map_br = _parse_ext_x_map(var_text, var_url)
    init_kind: Optional[str] = None
    if map_url:
        init_head = _http_get_bytes(
            map_url, header_block, max_bytes=1024 * 1024, timeout=60.0, byte_range=map_br
        )
        if not init_head:
            return None
        init_kind = _clean_hls_payload_kind_raw(init_head)
        if init_kind != "fmp4":
            return None

    seg0_url, seg0_br = seg_entries[0]
    seg_head = _http_get_bytes(
        seg0_url, header_block, max_bytes=4 * 1024 * 1024, timeout=90.0, byte_range=seg0_br
    )
    if not seg_head:
        return None
    seg_kind = _clean_hls_payload_kind_raw(seg_head)
    if not seg_kind:
        return None

    if map_url:
        if seg_kind != "fmp4":
            return None
        return "fmp4"
    if seg_kind == "ts":
        return "ts"
    if seg_kind == "fmp4":
        return "fmp4"
    return None


def _download_clean_hls_no_strip(
    message: dict,
    output_path: str,
    header_block: str,
    job_id: str,
    container: str,
    var_url: str,
    var_text: str,
) -> None:
    """Misleading file extensions but raw fMP4 / MPEG-TS: download, concat, remux (no unwrap)."""
    global _active_ffmpeg
    proc: Optional[subprocess.Popen] = None
    temp_root = os.path.join(
        tempfile.gettempdir(),
        "hgr_hls_" + hashlib.sha1((job_id or var_url).encode("utf-8", errors="replace")).hexdigest()[:16],
    )
    try:
        os.makedirs(temp_root, exist_ok=True)
        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "fetch",
                    "detail": "Downloading HLS (raw fMP4 / TS, no unwrap)…",
                    "output": output_path,
                },
                job_id,
            )
        )
        seg_entries = _parse_hls_media_segments(var_text, var_url)
        if not seg_entries:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": "HLS: no segment URLs in playlist."},
                    job_id,
                )
            )
            return

        map_url, map_br = _parse_ext_x_map(var_text, var_url)
        init_bin = b""
        if container == "fmp4" and map_url:
            try:
                init_bin = _download_segment_bytes(map_url, header_block, byte_range=map_br)
            except (urllib.error.URLError, OSError, ValueError) as e:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": f"HLS init segment download failed: {e}",
                        },
                        job_id,
                    )
                )
                return
            if init_bin and _clean_hls_payload_kind_raw(init_bin) != "fmp4":
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": "HLS: init segment is not raw fMP4 at offset 0.",
                        },
                        job_id,
                    )
                )
                return

        total = len(seg_entries)
        seg_paths: List[str] = []

        for i, (seg_url, seg_br) in enumerate(seg_entries, start=1):
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
                raw = _download_segment_bytes(seg_url, header_block, byte_range=seg_br)
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
            if not raw:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": f"HLS: empty segment {i}/{total}.",
                        },
                        job_id,
                    )
                )
                return
            k = _clean_hls_payload_kind_raw(raw)
            if k != container:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": (
                                f"HLS: segment {i}/{total} is not raw {container} at offset 0 "
                                f"(got {k or 'unknown'})."
                            ),
                        },
                        job_id,
                    )
                )
                return
            seg_path = os.path.join(temp_root, f"seg_{i:05d}.buf")
            with open(seg_path, "wb") as sf:
                sf.write(raw)
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

        combined_path = os.path.join(
            temp_root, "combined.mp4" if container == "fmp4" else "combined.ts"
        )
        with open(combined_path, "wb") as combined:
            if init_bin:
                combined.write(init_bin)
            for sp in seg_paths:
                with open(sp, "rb") as inf:
                    shutil.copyfileobj(inf, combined)

        if not os.path.isfile(combined_path) or os.path.getsize(combined_path) < 64:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "HLS: combined media file is empty or too small.",
                    },
                    job_id,
                )
            )
            return

        _ffmpeg_remux_combined_to_output(
            combined_path, output_path, job_id, container=container, message=message
        )
    finally:
        _clear_active_if(proc)
        try:
            if os.path.isdir(temp_root):
                shutil.rmtree(temp_root, ignore_errors=True)
        except OSError:
            pass


def _download_obfuscated_hls(
    url: str,
    message: dict,
    output_path: str,
    header_block: str,
    job_id: str,
    obfuscation_kind: Optional[str] = None,
    variant: Optional[Tuple[str, str]] = None,
) -> None:
    """
    Manual segment download + strip + concat + ffmpeg remux.
    """
    global _active_ffmpeg
    kind_hint = obfuscation_kind
    if not kind_hint:
        kind_hint, _ = _detect_obfuscated_segments(url, header_block, variant=variant)
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
        if variant is not None:
            var_url, var_text = variant
        else:
            var_url, var_text = _resolve_variant_playlist_url(url, header_block)
        seg_entries = _parse_hls_media_segments(var_text, var_url)
        if not seg_entries:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": "Obfuscated HLS: no segment URLs in playlist."},
                    job_id,
                )
            )
            return

        map_url, map_br = _parse_ext_x_map(var_text, var_url)
        init_bin = b""
        if map_url:
            try:
                init_raw = _download_segment_bytes(map_url, header_block, byte_range=map_br)
                init_bin = _extract_ts_payload(init_raw, kind_hint)
            except (urllib.error.URLError, OSError, ValueError) as e:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": f"Obfuscated HLS: init segment failed ({e}).",
                        },
                        job_id,
                    )
                )
                return

        total = len(seg_entries)
        seg_paths: List[str] = []
        container: Optional[str] = None
        if init_bin:
            ic = _segment_payload_format(init_bin)
            if ic in ("ts", "fmp4"):
                container = ic

        for i, (seg_url, seg_br) in enumerate(seg_entries, start=1):
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
                raw = _download_segment_bytes(seg_url, header_block, byte_range=seg_br)
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

            per_img = _obfuscation_kind_from_magic(raw)
            sr = _strip_leading_garbage(raw)
            if per_img:
                hint = per_img
            elif _find_first_mp4_box(sr) >= 0:
                hint = "fmp4"
            else:
                hint = kind_hint
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
            fmt = _segment_payload_format(cleaned)
            if fmt == "unknown":
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": (
                                f"Obfuscated HLS: segment {i}/{total} is not MPEG-TS or fMP4 after unwrap "
                                "(unsupported wrapper or encryption)."
                            ),
                        },
                        job_id,
                    )
                )
                return
            if container is None:
                container = fmt
            elif fmt != container:
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": "Obfuscated HLS: mixed TS and fMP4 segments in one playlist.",
                        },
                        job_id,
                    )
                )
                return
            seg_path = os.path.join(temp_root, f"seg_{i:05d}.buf")
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

        combined_path = os.path.join(
            temp_root, "combined.mp4" if container == "fmp4" else "combined.ts"
        )

        with open(combined_path, "wb") as combined:
            if init_bin:
                combined.write(init_bin)
            for sp in seg_paths:
                with open(sp, "rb") as inf:
                    shutil.copyfileobj(inf, combined)

        if not os.path.isfile(combined_path) or os.path.getsize(combined_path) < 64:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "Obfuscated HLS: combined media file is empty or too small.",
                    },
                    job_id,
                )
            )
            return

        if not container:
            send_message(
                with_job_id(
                    {
                        "type": "done",
                        "success": False,
                        "error": "Obfuscated HLS: could not determine container (TS vs fMP4).",
                    },
                    job_id,
                )
            )
            return

        _ffmpeg_remux_combined_to_output(
            combined_path, output_path, job_id, container=container, message=message
        )
    finally:
        _clear_active_if(proc)
        try:
            if os.path.isdir(temp_root):
                shutil.rmtree(temp_root, ignore_errors=True)
        except OSError:
            pass


def _build_ffmpeg_cmd_list(
    url,
    message,
    output_path,
    header_block,
    *,
    resume_from_sec: float = 0.0,
    playlist_text: Optional[str] = None,
    playlist_url: Optional[str] = None,
):
    pre = [
        "ffmpeg",
        "-y",
        "-nostdin",
        "-loglevel",
        "info",
        "-stats",
    ]
    seek_after_input = False
    seek_sec = 0.0
    is_hls = _is_hls_input(url, message)
    is_fmp4: Optional[bool] = None
    audio_only = False
    effective_playlist = playlist_text
    if is_hls and effective_playlist is None:
        try:
            _pu, effective_playlist = _resolve_variant_playlist_url(url, header_block)
            playlist_url = playlist_url or _pu
        except (urllib.error.URLError, OSError, ValueError, UnicodeError):
            effective_playlist = None
    if effective_playlist:
        is_fmp4 = _hls_playlist_is_fmp4(effective_playlist)
        # Audio-only media playlists: no RESOLUTION and CODECS only mp4a, or EXT-X-MAP
        # without video — also treat missing video codec + fMP4 audio CDNs as audio-only
        # when the page/title looks like music (handled by caller DRM checks too).
        if not _hls_playlist_likely_has_video(effective_playlist):
            audio_only = True
        elif is_fmp4 and not re.search(r"RESOLUTION\s*=", effective_playlist, re.I):
            # Variant media playlist often has no CODECS; fMP4 without RESOLUTION is
            # commonly audio-only (Apple Music, podcasts). Prefer audio encode path.
            if not re.search(
                r'CODECS\s*=\s*"[^"]*(?:avc|hvc|hev|vp09|av01)',
                effective_playlist,
                re.I,
            ):
                audio_only = True
    # HLS: default live_start_index is -3 (near live edge) which can make ffmpeg only
    # follow a short sliding window. Force start from the first listed segment, reload
    # playlists longer, and retry flaky segments (without TCP reconnect flags  they
    # destabilize some CDNs).
    if is_hls:
        if resume_from_sec and resume_from_sec > 0.05:
            seek_after_input = True
            seek_sec = float(resume_from_sec)
        pre.extend(
            [
                "-allowed_extensions",
                "ALL",
                "-extension_picky",
                "0",
                "-protocol_whitelist",
                "file,http,https,tcp,tls,crypto,ffurl",
                "-analyzeduration",
                "200M",
                "-probesize",
                "200M",
                *_ffmpeg_hls_network_fflags(),
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
    cmd = list(pre)
    if seek_after_input:
        cmd.extend(["-ss", f"{seek_sec:.3f}"])
    out_mp4 = output_path.lower().endswith((".mp4", ".m4a", ".aac"))
    preset = ""
    if audio_only and out_mp4:
        cmd.extend(_ffmpeg_audio_only_encode_args())
    elif (
        (is_hls or _is_dash_input(url, message))
        and out_mp4
        and not _ffmpeg_force_stream_copy_hls_mp4()
    ):
        preset = _ffmpeg_probe_transcode_preset(url, message, header_block)
        cmd.extend(
            _ffmpeg_transcode_stable_mp4_from_url(
                url,
                message,
                preset=preset,
                playlist_text=effective_playlist,
                audio_only=False,
                is_fmp4=is_fmp4,
            )
        )
    else:
        cmd.extend(["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy"])
        if _use_hls_aac_bsf(
            url, message, playlist_text=effective_playlist, is_fmp4=is_fmp4
        ):
            cmd.extend(["-bsf:a", "aac_adtstoasc"])
    cmd.extend(_ffmpeg_copy_mux_fixup_args(for_mp4=out_mp4))
    cmd.append(output_path)
    return cmd, preset


def _handle_ffmpeg_encode_preset_probe(message: dict) -> None:
    """Probe duration/size and return recommended x264 preset for UI picker."""
    req_id = (message.get("requestId") or "").strip()
    url = (message.get("url") or "").strip()

    def reply(**fields: Any) -> None:
        send_message({"type": "ffmpeg_encode_preset_result", "requestId": req_id, **fields})

    if not url:
        reply(success=False, error="No URL", applies=False)
        return
    if not _ffmpeg_download_needs_x264_reencode(url, message):
        reply(success=True, applies=False)
        return
    env_locked = _ffmpeg_env_preset_override()
    header_block = build_ffmpeg_header_block(message, url)
    try:
        dur, size = _ffmpeg_probe_transcode_stats(url, message, header_block)
    except (urllib.error.URLError, OSError, ValueError, UnicodeError) as e:
        reply(success=False, error=str(e), applies=True)
        return
    recommended = (
        env_locked
        if env_locked
        else _ffmpeg_resolve_x264_preset(message, dur, size)
    )
    reply(
        success=True,
        applies=True,
        recommendedPreset=recommended,
        allowedPresets=list(_FFMPEG_X264_PRESET_ORDER),
        durationSec=dur,
        sizeBytes=size,
        envLocked=bool(env_locked),
        autoReason=_ffmpeg_auto_preset_reason(dur, size),
    )


def _handle_delete_output_file(message: dict) -> None:
    """Delete a partial/finished output file under the user's save folder (UI restart flow)."""
    req_id = (message.get("requestId") or "").strip()
    path = (message.get("path") or "").strip()
    out_dir = (message.get("outputDirectory") or message.get("outputDir") or "").strip()

    def reply(**fields: Any) -> None:
        send_message({"type": "delete_output_file_result", "requestId": req_id, **fields})

    if not path or not out_dir:
        reply(success=False, error="Missing path or outputDirectory")
        return
    try:
        ap = os.path.abspath(path)
        ad = os.path.abspath(out_dir)
        if not (ap == ad or ap.startswith(ad + os.sep)):
            reply(success=False, error="Path is outside the configured save folder")
            return
        removed: List[str] = []
        for candidate in (path, path + ".part", path + ".cont.mp4"):
            if candidate and os.path.isfile(candidate):
                os.remove(candidate)
                removed.append(os.path.basename(candidate))
        reply(success=True, removed=removed)
    except OSError as e:
        reply(success=False, error=str(e))


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


def _local_file_format_hints(path: str) -> Tuple[float, Optional[int]]:
    dur = _ffprobe_duration_seconds(path)
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    return dur, size


def _ffprobe_url_format_hints(url: str, header_block: str) -> Tuple[float, Optional[int]]:
    if not url or not shutil.which("ffprobe"):
        return 0.0, None
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-headers",
                header_block,
                "-show_entries",
                "format=duration,size",
                "-of",
                "json",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=45,
        )
        if r.returncode != 0:
            return 0.0, None
        data = json.loads(r.stdout or "{}")
        fmt = data.get("format") or {}
        dur = 0.0
        raw_d = fmt.get("duration")
        if raw_d is not None:
            try:
                dur = max(0.0, float(raw_d))
            except (TypeError, ValueError):
                pass
        size: Optional[int] = None
        raw_s = fmt.get("size")
        if raw_s is not None:
            try:
                n = int(raw_s)
                if n > 0:
                    size = n
            except (TypeError, ValueError):
                pass
        return dur, size
    except (
        FileNotFoundError,
        ValueError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
        OSError,
    ):
        return 0.0, None


def _ffmpeg_probe_transcode_stats(
    url,
    message,
    header_block,
    *,
    local_path: Optional[str] = None,
) -> Tuple[float, Optional[int]]:
    """Inspect source duration/size for preset selection."""
    dur, size = _message_media_hints(message)
    if local_path and os.path.isfile(local_path):
        ld, ls = _local_file_format_hints(local_path)
        dur = max(dur, ld)
        if ls:
            size = max(size or 0, ls) or ls
    if _is_hls_input(url, message):
        try:
            var_url, var_text = _resolve_variant_playlist_url(url, header_block)
            dur = max(dur, _hls_playlist_duration_seconds(var_text))
            est = _hls_playlist_estimated_size_bytes(var_text, var_url)
            if est:
                size = max(size or 0, est) or est
        except (urllib.error.URLError, OSError, ValueError, UnicodeError):
            pass
    if dur <= 0.05 or size is None:
        ud, us = _ffprobe_url_format_hints(url, header_block)
        dur = max(dur, ud)
        if us:
            size = max(size or 0, us) or us
    return dur, size


def _ffmpeg_probe_transcode_preset(
    url,
    message,
    header_block,
    *,
    local_path: Optional[str] = None,
) -> str:
    dur, size = _ffmpeg_probe_transcode_stats(
        url, message, header_block, local_path=local_path
    )
    return _ffmpeg_resolve_x264_preset(message, dur, size)


def _ffprobe_video_validation(path: str) -> Tuple[float, bool]:
    """Return (duration_sec, has_video_stream). (0.0, False) if unusable or ffprobe fails."""
    if not path or not os.path.isfile(path):
        return 0.0, False
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if r.returncode != 0:
            return 0.0, False
        data = json.loads(r.stdout or "{}")
        dur = 0.0
        fmt = data.get("format") or {}
        raw_d = fmt.get("duration")
        if raw_d is not None:
            try:
                dur = max(0.0, float(raw_d))
            except (TypeError, ValueError):
                pass
        streams = data.get("streams") or []
        has_video = any(
            (s.get("codec_type") or "").lower() == "video" for s in streams
        )
        return dur, has_video
    except (
        FileNotFoundError,
        ValueError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
        OSError,
    ):
        return 0.0, False


def _verify_ffmpeg_output_playable(path: str) -> Tuple[bool, str]:
    """
    Ensure ffmpeg output actually decodes. DRM/corrupt AAC often muxes with a full
    duration but every packet fails to decode (players jump straight to the end).
    """
    if not path or not os.path.isfile(path):
        return False, "Output file missing after ffmpeg"
    try:
        sz = os.path.getsize(path)
    except OSError as e:
        return False, str(e)
    if sz < 4096:
        return False, f"Output too small ({sz} bytes) — download likely failed"
    if not shutil.which("ffmpeg"):
        return True, ""
    # Decode a short window; count samples. Corrupt/DRM audio yields ~0 samples.
    try:
        r = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                path,
                "-t",
                "3",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as e:
        return False, str(e)
    err = (r.stderr or "") + (r.stdout or "")
    # Count occurrences — ffmpeg often exits 0 while logging hundreds of AAC decode errors
    # on FairPlay/SAMPLE-AES (players then jump straight to the end).
    decode_fail_n = err.count("Error submitting packet to decoder")
    invalid_data_n = err.count("Invalid data found when processing input")
    aac_garbage_n = (
        err.count("Reserved bit set")
        + err.count("Prediction is not allowed in AAC-LC")
        + err.count("Number of bands")
        + err.count("channel element")
    )
    if decode_fail_n >= 15 or invalid_data_n >= 15 or aac_garbage_n >= 40:
        return (
            False,
            "Downloaded media is encrypted or corrupt and will not play "
            "(players jump to the end). This is usually DRM (e.g. Apple Music FairPlay) "
            "which Stuff Grabber cannot decrypt.",
        )
    if r.returncode != 0 and (decode_fail_n + invalid_data_n) >= 2:
        return (
            False,
            "Downloaded media failed decode checks — likely DRM or a corrupt remux. "
            "Try a non-DRM source.",
        )
    dur, has_video = _ffprobe_video_validation(path)
    has_audio = False
    try:
        rp = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        types = (rp.stdout or "").lower()
        has_audio = "audio" in types
    except (subprocess.SubprocessError, OSError):
        pass
    if dur < 0.05 and sz < 64 * 1024:
        return False, "Output has no usable duration — remux produced an empty file"
    if not has_video and not has_audio:
        return False, "Output has no audio or video streams"
    return True, ""


def _yt_dlp_output_is_playlist_template(output_path: str) -> bool:
    return " %(playlist_index)" in os.path.basename(output_path)


def _yt_dlp_playlist_mp4_paths(output_path: str) -> List[str]:
    d = os.path.dirname(os.path.abspath(output_path))
    base = os.path.basename(output_path)
    stem_prefix = base.split(" %(playlist_index)", 1)[0]
    return sorted(glob.glob(os.path.join(d, glob.escape(stem_prefix) + "*.mp4")))


def _verify_yt_dlp_media_file(path: str) -> Tuple[bool, str]:
    """Ensure path is a non-trivial playable video file."""
    if not path:
        return False, "Missing output path"
    if not os.path.isfile(path):
        part = path + ".part"
        if os.path.isfile(part):
            return False, "Download incomplete (.part file still present)"
        return False, f"Output file missing: {path}"
    try:
        sz = os.path.getsize(path)
    except OSError as e:
        return False, str(e)
    if sz < 4096:
        return (
            False,
            f"File too small ({sz} bytes) - likely not a real video",
        )
    if not shutil.which("ffprobe"):
        if sz < 65536:
            return (
                False,
                "ffprobe not found; file is very small - install ffmpeg to verify downloads",
            )
        return True, ""
    dur, has_video = _ffprobe_video_validation(path)
    if dur < 0.12:
        return (
            False,
            "File is not a playable video (ffprobe reports no usable duration) - "
            "may be corrupt, HTML, or an image-only artifact",
        )
    if not has_video:
        return False, "Download has no video stream (audio-only or unsupported container)"
    return True, ""


def _verify_yt_dlp_output(output_path: str) -> Tuple[bool, str]:
    """Validate yt-dlp result: single .mp4 path or playlist template path."""
    if _yt_dlp_output_is_playlist_template(output_path):
        paths = _yt_dlp_playlist_mp4_paths(output_path)
        if not paths:
            return (
                False,
                "Playlist download reported success but no .mp4 files were found in the output folder.",
            )
        errors: List[str] = []
        for p in paths:
            ok, err = _verify_yt_dlp_media_file(p)
            if not ok:
                errors.append(f"{os.path.basename(p)}: {err}")
        if errors:
            tail = "; ".join(errors[:5])
            if len(errors) > 5:
                tail += "…"
            return False, "Playlist validation failed: " + tail
        return True, ""
    return _verify_yt_dlp_media_file(output_path)


def _verify_yt_dlp_audio_output(output_path: str) -> Tuple[bool, str]:
    """Validate yt-dlp audio extraction output (mp3/m4a/opus/aac/flac/wav/webm/ogg)."""
    audio_exts = (".mp3", ".m4a", ".opus", ".aac", ".flac", ".wav", ".webm", ".ogg")
    if _yt_dlp_output_is_playlist_template(output_path):
        folder = os.path.dirname(output_path) or "."
        files: List[str] = []
        for ext in audio_exts:
            files.extend(sorted(glob.glob(os.path.join(folder, "*" + ext))))
        files = [p for p in files if os.path.isfile(p)]
        if not files:
            return False, "Playlist reported success but no extracted audio files were found."
        if max((os.path.getsize(p) for p in files), default=0) < 32 * 1024:
            return False, "Extracted audio files are too small; source may be blocked."
        return True, ""
    if os.path.isfile(output_path):
        if os.path.getsize(output_path) < 32 * 1024:
            return False, "Extracted audio file is too small; source may be blocked."
        return True, ""
    if "%(ext)s" in output_path:
        pat = output_path.replace("%(ext)s", "*")
        matches = [p for p in glob.glob(pat) if os.path.isfile(p)]
        if not matches:
            # yt-dlp can still rename/sanitize unexpectedly on some extractors; scan nearby recent audio files.
            folder = os.path.dirname(output_path) or "."
            stem = os.path.basename(output_path).replace("%(ext)s", "")
            recent: List[str] = []
            now = time.time()
            for ext in audio_exts:
                for p in glob.glob(os.path.join(folder, "*" + ext)):
                    if not os.path.isfile(p):
                        continue
                    try:
                        mt = os.path.getmtime(p)
                    except OSError:
                        continue
                    if abs(now - mt) <= 180 and os.path.basename(p).startswith(stem[:24]):
                        recent.append(p)
            matches = recent
        if not matches:
            return False, "Audio extraction finished but output file was not found."
        if max((os.path.getsize(p) for p in matches), default=0) < 32 * 1024:
            return False, "Extracted audio file is too small; source may be blocked."
        return True, ""
    base, _ext = os.path.splitext(output_path)
    matches = [base + e for e in audio_exts if os.path.isfile(base + e)]
    if not matches:
        return False, "Audio extraction finished but output file was not found."
    if max((os.path.getsize(p) for p in matches), default=0) < 32 * 1024:
        return False, "Extracted audio file is too small; source may be blocked."
    return True, ""


def _ffmpeg_concat_two_mp4_to_one(
    part_a: str, part_b: str, out_final: str, *, message: Optional[dict] = None
) -> bool:
    d = os.path.dirname(os.path.abspath(out_final)) or "."
    fd, t1 = tempfile.mkstemp(suffix=".ts", dir=d, prefix="hgr_")
    os.close(fd)
    fd, t2 = tempfile.mkstemp(suffix=".ts", dir=d, prefix="hgr_")
    os.close(fd)
    list_path = out_final + ".concat.txt"
    try:
        r1 = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-nostdin",
                "-i",
                part_a,
                "-c",
                "copy",
                *_ffmpeg_mp4_to_ts_bsf_args(part_a),
                "-f",
                "mpegts",
                t1,
            ],
            capture_output=True,
            timeout=3600,
        )
        r2 = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-nostdin",
                "-i",
                part_b,
                "-c",
                "copy",
                *_ffmpeg_mp4_to_ts_bsf_args(part_b),
                "-f",
                "mpegts",
                t2,
            ],
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
        use_merge_copy = _ffmpeg_force_stream_copy_hls_mp4()
        if use_merge_copy:
            merge_mid: List[str] = ["-c", "copy", "-bsf:a", "aac_adtstoasc"]
            merge_mid.extend(["-reset_timestamps", "1"])
        else:
            da, sa = _local_file_format_hints(part_a)
            db, sb = _local_file_format_hints(part_b)
            total_dur = da + db
            total_size = (sa or 0) + (sb or 0)
            preset = _ffmpeg_resolve_x264_preset(
                message,
                total_dur,
                total_size if total_size > 0 else None,
            )
            merge_mid = list(_ffmpeg_transcode_stable_mp4_concat_merge(preset=preset))
        r3 = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-nostdin",
                *_ffmpeg_concat_demux_fflags(),
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                list_path,
                *merge_mid,
                *_ffmpeg_copy_mux_fixup_args(for_mp4=True),
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
    st_refresh = _JOB_LIVE.get(job_id) or {}
    stored_preset = (st_refresh.get("ffmpegPreset") or "").strip().lower()
    if stored_preset in _FFMPEG_X264_ALLOWED_PRESETS and not (new_message.get("ffmpegPreset") or "").strip():
        new_message = dict(new_message)
        new_message["ffmpegPreset"] = stored_preset
    cmd, _x264_preset = _build_ffmpeg_cmd_list(
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
    if not _ffmpeg_concat_two_mp4_to_one(out_path, cont_path, out_path, message=new_message):
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
    page_for_social = (message.get("pageUrl") or message.get("referer") or "").strip()
    effective_filename = filename
    if _is_spotify_url(url) or _is_spotify_url(page_for_social):
        low = (filename or "").strip().lower()
        if low in ("video", "stream", "download", "audio", "track"):
            effective_filename = _spotify_filename_hint(url, page_for_social, filename)
    if _looks_like_vtt_url(url):
        _download_vtt_immediate(url, message, out_dir, effective_filename, job_id)
        if _CURRENT_JOB_ID == job_id:
            _CURRENT_JOB_ID = ""
        return

    if _is_netflix_drm_context(url, page_for_social):
        send_message(
            with_job_id(
                {
                    "type": "done",
                    "success": False,
                    "error": _netflix_drm_error_message(),
                },
                job_id,
            )
        )
        if _CURRENT_JOB_ID == job_id:
            _CURRENT_JOB_ID = ""
        return

    out_ext = _ffmpeg_preferred_container_ext(url, message)
    output_path = _resolve_output_path(message, out_dir, effective_filename, out_ext)

    proc: Optional[subprocess.Popen] = None
    try:
        platform_label = _social_platform_for_yt_dlp(url, page_for_social, message)
        if platform_label:
            if not _yt_dlp_available():
                extra = ""
                ex = (sys.executable or "").lower()
                if "windowsapps" in ex:
                    extra = (
                        " Microsoft Store Python often fails here even after pip install; "
                        "install Python from python.org, run python/install.py with that Python, "
                        "or set User env var HLS_GRABBER_PYTHON to a working python.exe "
                        "(see host_wrapper.bat)."
                    )
                send_message(
                    with_job_id(
                        {
                            "type": "done",
                            "success": False,
                            "error": (
                                f"This looks like a {platform_label} video. yt-dlp was not found from this "
                                f"native host (Python: {sys.executable}). "
                                f'Install with: "{sys.executable}" -m pip install -U yt-dlp '
                                f"(same interpreter Chrome uses). "
                                f"Or re-run python/install.py with the Python where yt-dlp works.{extra}"
                            ),
                        },
                        job_id,
                    )
                )
                return
            y_msg = dict(message or {})
            # Apple Music: always hand yt-dlp the music.apple.com page URL (never FairPlay m3u8).
            if platform_label == "Apple Music" or _is_apple_music_drm_context(
                url, page_for_social
            ):
                y_msg["ytDlpAudioOnly"] = True
                page_u = page_for_social
                if page_u and "music.apple.com" in page_u.lower():
                    url = page_u
                elif "music.apple.com" in (url or "").lower():
                    page_u = url
                    y_msg["pageUrl"] = url
                    y_msg["referer"] = url
            ytdlp_out = _yt_dlp_output_target(y_msg, out_dir, effective_filename)
            _JOB_LIVE[job_id] = _job_live_from_message(ytdlp_out, url, y_msg)
            run_yt_dlp_with_updates(url, y_msg, ytdlp_out, job_id, platform_label)
            return

        header_block = build_ffmpeg_header_block(message, url)

        var_pair: Optional[Tuple[str, str]] = None
        var_url_r, var_text_r = "", ""
        if _is_hls_input(url, message):
            send_message(
                with_job_id(
                    {
                        "type": "progress",
                        "phase": "starting",
                        "detail": "Checking HLS format…",
                        "output": output_path,
                    },
                    job_id,
                )
            )
            try:
                var_pair = _resolve_variant_playlist_url(url, header_block)
            except Exception:
                var_pair = None
            var_url_r, var_text_r = (
                var_pair if var_pair is not None else ("", "")
            )
            drm_err = _hls_playlist_drm_error(var_text_r)
            if drm_err:
                # Last resort: if we somehow got FairPlay HLS without an Apple page route,
                # still try yt-dlp against pageUrl when present.
                if page_for_social and _yt_dlp_available():
                    y_msg = dict(message or {})
                    y_msg["ytDlpAudioOnly"] = True
                    ytdlp_out = _yt_dlp_output_target(
                        y_msg, out_dir, effective_filename
                    )
                    _JOB_LIVE[job_id] = _job_live_from_message(
                        ytdlp_out, page_for_social, y_msg
                    )
                    run_yt_dlp_with_updates(
                        page_for_social,
                        y_msg,
                        ytdlp_out,
                        job_id,
                        "Apple Music",
                    )
                    return
                send_message(
                    with_job_id(
                        {"type": "done", "success": False, "error": drm_err},
                        job_id,
                    )
                )
                return

        def _fail_both(ffmpeg_err: str) -> None:
            send_message(
                with_job_id(
                    {"type": "done", "success": False, "error": ffmpeg_err},
                    job_id,
                )
            )

        cmd, x264_preset = _build_ffmpeg_cmd_list(
            url,
            message,
            output_path,
            header_block,
            resume_from_sec=0.0,
            playlist_text=var_text_r or None,
            playlist_url=var_url_r or None,
        )

        if _is_hls_input(url, message):
            if var_text_r and _hls_uses_misleading_extensions(var_url_r or url, var_text_r):
                clean_kind: Optional[str] = None
                try:
                    clean_kind = _classify_clean_fake_ext_hls(
                        var_url_r, var_text_r, header_block
                    )
                except Exception:
                    clean_kind = None
                if clean_kind == "fmp4":
                    _JOB_LIVE[job_id] = _job_live_from_message(output_path, url, message)
                    _download_clean_hls_no_strip(
                        message,
                        output_path,
                        header_block,
                        job_id,
                        clean_kind,
                        var_url_r,
                        var_text_r,
                    )
                    return
                # clean_kind "ts": extension mismatch only  ffmpeg HLS demuxer + ALL suffices.

            ob_kind: Optional[str] = None
            try:
                ob_kind, _ob_n = _detect_obfuscated_segments(
                    url, header_block, variant=var_pair
                )
            except Exception:
                ob_kind = None
            if ob_kind:
                _JOB_LIVE[job_id] = _job_live_from_message(output_path, url, message)
                _download_obfuscated_hls(
                    url,
                    message,
                    output_path,
                    header_block,
                    job_id,
                    ob_kind,
                    variant=var_pair,
                )
                return

        start_detail = "Starting ffmpeg"
        if x264_preset:
            start_detail = f"Starting ffmpeg (x264 preset {x264_preset})"
        send_message(
            with_job_id(
                {
                    "type": "progress",
                    "phase": "starting",
                    "detail": start_detail,
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
            _fail_both("ffmpeg not found in PATH")
            return
        except Exception as e:
            _fail_both(str(e))
            return

        with _PROC_LOCK:
            _active_ffmpeg = proc
        live: Dict[str, Any] = _job_live_from_message(output_path, url, message)
        if x264_preset and "ffmpegPreset" not in live:
            live["ffmpegPreset"] = x264_preset
        _JOB_LIVE[job_id] = live

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
            _send_done_canceled(job_id)
            return
        if code == 0:
            ok_p, perr = _verify_ffmpeg_output_playable(output_path)
            if not ok_p:
                _fail_both(perr)
            else:
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
            _fail_both(err)
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
        if mtype == "ytdlp_formats":
            threading.Thread(
                target=_handle_ytdlp_formats,
                args=(message,),
                daemon=True,
            ).start()
            continue
        if mtype == "ffmpeg_encode_preset":
            threading.Thread(
                target=_handle_ffmpeg_encode_preset_probe,
                args=(message,),
                daemon=True,
            ).start()
            continue
        if mtype == "delete_output_file":
            threading.Thread(
                target=_handle_delete_output_file,
                args=(message,),
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
