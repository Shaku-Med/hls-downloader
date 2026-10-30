"""Build a file from bytes the browser already received from the player."""

import base64
import os
import re
import shutil
import tempfile
import threading
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit, urlunsplit


def _sniff_container(data: bytes) -> str:
    if data[:1] == b"\x47":
        return "ts"
    if len(data) >= 8 and data[4:8] in (b"ftyp", b"styp", b"moof"):
        return "fmp4"
    return "fmp4"


def _take_parts(read_message: Callable[[], Optional[dict]], job_id: str):
    """
    Read parts until the extension says it is done.

    Returns (parts, playlists, state) where state is "ok", "aborted" or
    "canceled". Each part is (role, index, url, bytes).
    """
    buckets: Dict[tuple, Dict[int, bytes]] = {}
    urls: Dict[tuple, str] = {}
    playlists: List[Tuple[str, str]] = []
    while True:
        msg = read_message()
        if msg is None:
            return [], playlists, "aborted"
        if (msg.get("jobId") or "") not in ("", job_id):
            continue
        kind = (msg.get("type") or "").lower()
        if kind == "cancel":
            return [], playlists, "canceled"
        if kind == "player_copy_end":
            if msg.get("abort"):
                return [], playlists, "aborted"
            break
        if kind == "player_copy_playlists":
            for row in msg.get("playlists") or []:
                if isinstance(row, dict) and row.get("text"):
                    playlists.append((str(row.get("url") or ""), str(row.get("text"))))
            continue
        if kind != "player_copy_part":
            continue
        try:
            raw = base64.b64decode(msg.get("base64") or "")
        except Exception:
            continue
        role = "init" if msg.get("role") == "init" else "segment"
        index = int(msg.get("index") or 0)
        chunk_index = int(msg.get("chunkIndex") or 0)
        key = (role, index)
        buckets.setdefault(key, {})[chunk_index] = raw
        if msg.get("url"):
            urls[key] = str(msg.get("url"))
    parts = []
    for (role, index) in sorted(buckets, key=lambda item: (0 if item[0] == "init" else 1, item[1])):
        pieces = buckets[(role, index)]
        blob = b"".join(pieces[i] for i in sorted(pieces))
        if blob:
            parts.append((role, index, urls.get((role, index), ""), blob))
    return parts, playlists, "ok"


def _url_keys(url: str) -> Tuple[str, str]:
    """The URL without its fragment, and without its query as a looser second match."""
    try:
        s = urlsplit(url.strip())
    except ValueError:
        return "", ""
    exact = urlunsplit((s.scheme, s.netloc, s.path, s.query, ""))
    loose = urlunsplit((s.scheme, s.netloc, s.path, "", ""))
    return exact, loose


def _parse_media_playlist(text: str, base: str):
    """(init_url, [(segment_url, seconds)], finished) or None for a playlist we cannot map."""
    if "#EXT-X-STREAM-INF" in text.upper():
        return None
    # Byte ranges put many segments behind one URL, so URLs cannot tell them apart.
    if "#EXT-X-BYTERANGE" in text.upper():
        return None
    init_url = ""
    segs: List[Tuple[str, float]] = []
    pending = 0.0
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.upper().startswith("#EXT-X-MAP:"):
            m = re.search(r'URI\s*=\s*"([^"]+)"', s, re.I) or re.search(r"URI\s*=\s*([^,\s]+)", s, re.I)
            if m:
                init_url = urljoin(base, m.group(1).strip())
            continue
        if s.upper().startswith("#EXTINF:"):
            m = re.match(r"#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)", s, re.I)
            pending = float(m.group(1)) if m else 0.0
            continue
        if s.startswith("#"):
            continue
        segs.append((urljoin(base, s), pending))
        pending = 0.0
    if not segs:
        return None
    return init_url, segs, "#EXT-X-ENDLIST" in text.upper()


def _clock(sec: float) -> str:
    sec = int(max(0.0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _choose_stream(parts, playlists, preferred_url: str = ""):
    """
    Pick the one stream the captured segments belong to and lay them out in its order.

    A tab can load several streams: an ad, a second video, the same video at
    another quality after the player switched. Joining everything that was
    captured mixes them into a file that will not play, so only the segments of
    the playlist most of them came from are used, in that playlist's order and
    with that playlist's own init segment.

    Returns (inits, segments, note, error). note says how much of the video
    this is when it is not all of it.
    """
    captured: Dict[str, bytes] = {}
    for role, _index, url, blob in parts:
        if not url:
            continue
        exact, loose = _url_keys(url)
        captured.setdefault(exact, blob)
        captured.setdefault(loose, blob)

    best = None
    for pl_url, text in playlists:
        parsed = _parse_media_playlist(text, pl_url)
        if not parsed:
            continue
        init_url, segs, finished = parsed
        hits = 0
        for seg_url, _dur in segs:
            exact, loose = _url_keys(seg_url)
            if exact in captured or loose in captured:
                hits += 1
        if not hits:
            continue
        rank = (hits, pl_url == preferred_url)
        if best is None or rank > best[0]:
            best = (rank, init_url, segs, finished)

    if best is None:
        # Nothing to go by: keep the order the player fetched them in.
        inits = [blob for role, _i, _u, blob in parts if role == "init"]
        segs_out = [blob for role, _i, _u, blob in parts if role != "init"]
        return inits, segs_out, "", ""

    _rank, init_url, segs, finished = best
    inits: List[bytes] = []
    if init_url:
        exact, loose = _url_keys(init_url)
        init_blob = captured.get(exact) or captured.get(loose)
        if not init_blob:
            return [], [], "", (
                "The player copy is missing the start of that stream, so it cannot be "
                "rebuilt. Play the video from the beginning and try again."
            )
        inits.append(init_blob)

    out: List[bytes] = []
    total = covered = 0.0
    missing = 0
    started = ended = False
    gaps = False
    for seg_url, dur in segs:
        total += dur
        exact, loose = _url_keys(seg_url)
        blob = captured.get(exact) or captured.get(loose)
        if blob:
            if ended:
                gaps = True
            started = True
            out.append(blob)
            covered += dur
        else:
            missing += 1
            if started:
                ended = True

    note = ""
    if missing and finished and total > 0:
        note = f"Saved {_clock(covered)} of {_clock(total)}, the part the player had loaded"
        if gaps:
            note += ", with gaps"
    return inits, out, note, ""


def collect_player_copy(message: dict, api: dict) -> None:
    read_message = api["read"]
    send = api["send"]
    job = api["job"]
    remux = api["remux"]
    resolve_dir = api["dir"]
    resolve_path = api["path"]
    cancel_event = api["cancel"]

    job_id = (message.get("jobId") or "").strip()

    first_error = str(message.get("playerCopyFirstError") or "").strip()

    def fail(error: str) -> None:
        # This only runs after the normal download already failed. Showing just
        # this message would hide the reason that one failed, which is the one
        # worth knowing.
        if first_error:
            error = f"{first_error} Tried the copy the player had loaded too: {error}"
        send(job({"type": "done", "success": False, "error": error}, job_id))

    send(job(message_progress("Reading the player copy"), job_id))
    parts, playlists, state = _take_parts(read_message, job_id)
    if state == "canceled":
        send(job({"type": "done", "success": False, "canceled": True, "error": "Canceled"}, job_id))
        return
    if state != "ok" or not any(role != "init" for role, *_ in parts):
        fail("The player copy did not have the video.")
        return

    own_text = str(message.get("playlistText") or "")
    own_url = str(message.get("playlistUrl") or message.get("url") or "")
    if own_text:
        playlists = [(own_url, own_text)] + playlists
    inits, segs, note, error = _choose_stream(parts, playlists, own_url)
    if error:
        fail(error)
        return

    blob = b"".join(inits) + b"".join(segs)
    if len(blob) < 64 or not segs:
        fail("The player copy did not have the video.")
        return

    container = _sniff_container(blob)
    out_dir = resolve_dir(message)
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as exc:
        fail(f"Cannot create output folder: {exc}")
        return
    filename = message.get("filename") or "video"
    output_path = resolve_path(message, out_dir, filename, ".mp4")
    temp_root = tempfile.mkdtemp(prefix="hgr_player_copy_")
    combined = os.path.join(temp_root, "combined.mp4" if container == "fmp4" else "combined.ts")
    try:
        with open(combined, "wb") as handle:
            handle.write(blob)
    except OSError as exc:
        shutil.rmtree(temp_root, ignore_errors=True)
        fail(f"Could not write the player copy: {exc}")
        return

    if note:
        send(job(message_progress(note), job_id))

    def finish() -> None:
        try:
            if cancel_event.is_set():
                send(
                    job(
                        {"type": "done", "success": False, "canceled": True, "error": "Canceled"},
                        job_id,
                    )
                )
                return
            remux(
                combined, output_path, job_id,
                container=container, message=message, done_detail=note or None,
            )
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

    threading.Thread(target=finish, daemon=True).start()


def message_progress(detail: str) -> dict:
    return {"type": "progress", "phase": "fetch", "detail": detail}
