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
from typing import Optional

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
    if p is None or p.poll() is not None:
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


def _parse_ffmpeg_progress(line):
    out = {}
    m = _RE_TIME.search(line)
    if m:
        out["time"] = f"{m.group(1)}:{m.group(2)}:{m.group(3)}"
    m = _RE_SPEED.search(line)
    if m:
        out["speed"] = m.group(1) + "x"
    m = _RE_SIZE.search(line)
    if m:
        out["size"] = m.group(1).strip()
    return out


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


def _build_ffmpeg_cmd_list(url, message, output_path, header_block):
    cmd = [
        "ffmpeg",
        "-y",
        "-nostdin",
        "-loglevel",
        "info",
        "-stats",
        "-headers",
        header_block,
        "-i",
        url,
        "-c",
        "copy",
    ]
    if _use_hls_aac_bsf(url, message):
        cmd.extend(["-bsf:a", "aac_adtstoasc"])
    cmd.append(output_path)
    return cmd


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
    cmd = _build_ffmpeg_cmd_list(url, message, output_path, header_block)

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

    proc: Optional[subprocess.Popen] = None
    try:
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
        _CURRENT_JOB_ID = ""


def main():
    while True:
        message = read_message()
        if message is None:
            break
        mtype = (message.get("type") or "").lower()
        if mtype == "cancel":
            _request_cancel()
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
