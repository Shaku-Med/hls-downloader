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
from typing import Optional, Set, Any, Dict

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
    # playlists longer, and retry flaky HTTP / segments so full VOD length is read.
    if _is_hls_input(url, message):
        if resume_from_sec and resume_from_sec > 0.05:
            pre.extend(["-ss", f"{float(resume_from_sec):.3f}"])
        pre.extend(
            [
                "-reconnect",
                "1",
                "-reconnect_at_eof",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "8",
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
