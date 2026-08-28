from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional

from . import audio, display, platforms
from .platforms import LINUX, MACOS, WINDOWS
from .settings import QUALITY_PRESETS, Settings


@dataclass
class Region:
    x: int
    y: int
    width: int
    height: int

    def even(self) -> "Region":
        """h264 needs even dimensions; odd ones make ffmpeg refuse to start."""
        return Region(self.x, self.y, self.width - (self.width % 2), self.height - (self.height % 2))


def output_path_for(settings: Settings) -> Path:
    folder = Path(settings.output_dir)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d %H-%M-%S")
    return folder / f"Recording {stamp}.mp4"


def _video_input_args(settings: Settings, region: Optional[Region]) -> List[str]:
    fam = platforms.os_family()
    fps = str(settings.fps)
    cursor = "1" if settings.capture_cursor else "0"

    if fam == WINDOWS:
        args = ["-f", "gdigrab", "-framerate", fps, "-draw_mouse", cursor]
        if region:
            r = region.even()
            args += [
                "-offset_x", str(r.x), "-offset_y", str(r.y),
                "-video_size", f"{r.width}x{r.height}",
            ]
        return args + ["-i", "desktop"]

    if fam == MACOS:
        args = ["-f", "avfoundation", "-framerate", fps, "-capture_cursor", cursor]
        screen = str(settings.display_index or 1)
        # "N:" means that screen with no audio; the mic is added as its own
        # input. avfoundation cannot offset, so a region is cropped after.
        return args + ["-i", f"{screen}:"]

    args = ["-f", "x11grab", "-framerate", fps, "-draw_mouse", cursor]
    # Not "display": that is the module this file imports for screen geometry.
    screen_name = os.environ.get("DISPLAY", ":0.0")
    if region:
        r = region.even()
        args += ["-video_size", f"{r.width}x{r.height}"]
        return args + ["-i", f"{screen_name}+{r.x},{r.y}"]
    return args + ["-i", screen_name]


def _mic_input_args(settings: Settings) -> List[str]:
    if not settings.record_mic or not settings.mic_device:
        return []
    fam = platforms.os_family()
    if fam == WINDOWS:
        return ["-f", "dshow", "-thread_queue_size", "1024", "-i", f"audio={settings.mic_device}"]
    if fam == MACOS:
        return ["-f", "avfoundation", "-thread_queue_size", "1024", "-i", f":{settings.mic_device}"]
    return ["-f", "pulse", "-thread_queue_size", "1024", "-i", settings.mic_device or "default"]


# Brightest pixel below this means nothing reached the capture at all. Judged on
# the brightest pixel rather than the average on purpose: a dim scene averages
# close to black, so an average would call every dark film a failure.
BLANK_YMAX = 32


def capture_looks_blank(settings: Settings, region: Optional[Region]) -> Optional[bool]:
    """
    Grab one frame the way the recording does and see if anything is on it.

    Protected video is handed straight to the graphics card, and the screen
    grabber cannot see into that, so the recording comes out black. Nothing can
    be done about it from here, but finding out while there is still time to fix
    it beats finding out on playback. None means the check could not run.
    """
    ffmpeg = platforms.ffmpeg_path()
    if not ffmpeg:
        return None
    cmd = [ffmpeg, "-hide_banner", "-y"]
    cmd += _video_input_args(settings, region)
    cmd += ["-frames:v", "1", "-vf", "signalstats,metadata=print", "-f", "null", "-"]
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15,
            stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            if platforms.os_family() == WINDOWS else 0,
        )
    except Exception:
        return None
    for line in (p.stderr or "").splitlines():
        if "signalstats.YMAX" in line:
            try:
                return float(line.split("=")[1]) <= BLANK_YMAX
            except (ValueError, IndexError):
                return None
    return None


def _region_pad_filter(region: Optional[Region]) -> str:
    """
    Put an area recording back where it was on a full screen canvas.

    Recording a small area and playing it back fills the player with it, so
    everything looks blown up and shifted compared to what was on screen. Padding
    the area back to its real position at its real size keeps the point of view:
    play it back and it looks like the screen did, with black where nothing was
    being captured.

    Only the area is actually grabbed, so this costs nothing at capture time.
    """
    if region is None:
        return ""
    vx, vy, vw, vh = display.virtual_screen()
    r = region.even()
    vw -= vw % 2
    vh -= vh % 2
    # An area can never be larger than the screen it came from, but a stale
    # saved region could be, and pad refuses to shrink its input.
    if r.width >= vw and r.height >= vh:
        return ""
    x = max(0, min(r.x - vx, vw - r.width))
    y = max(0, min(r.y - vy, vh - r.height))
    return f"pad={vw}:{vh}:{x}:{y}:black"


def build_command(
    settings: Settings,
    region: Optional[Region],
    out_path: Path,
    feed=None,
) -> List[str]:
    """
    Full ffmpeg invocation for one recording.

    `feed` is the Windows system audio capture, whose pipe becomes an input.
    On other platforms ffmpeg reads system audio itself and feed is None.
    """
    quality = QUALITY_PRESETS.get(settings.quality, QUALITY_PRESETS["high"])
    cmd: List[str] = [platforms.ffmpeg_path() or "ffmpeg", "-hide_banner", "-y"]
    cmd += _video_input_args(settings, region)

    # Input order matters: the filter graph refers to these by index.
    audio_inputs: List[str] = []
    system_args = audio.input_args(feed) if settings.record_system else []
    if system_args:
        cmd += system_args
        audio_inputs.append("system")
    mic_args = _mic_input_args(settings)
    if mic_args:
        cmd += mic_args
        audio_inputs.append("mic")

    video_filters = []
    # macOS captures the whole screen, so a region becomes a crop.
    if region and platforms.os_family() == MACOS:
        r = region.even()
        video_filters.append(f"crop={r.width}:{r.height}:{r.x}:{r.y}")
    # Odd sizes break yuv420p, and some capture sizes are odd by a pixel.
    video_filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
    pad = _region_pad_filter(region)
    if pad:
        video_filters.append(pad)

    if len(audio_inputs) == 2:
        # Two sources have to be mixed, and normalising the layout first stops a
        # surround endpoint or a mono mic from breaking amix.
        graph = (
            f"[0:v]{','.join(video_filters)}[v];"
            "[1:a]aformat=channel_layouts=stereo,aresample=async=1[sysa];"
            "[2:a]aformat=channel_layouts=stereo,aresample=async=1[mica];"
            "[sysa][mica]amix=inputs=2:duration=first:dropout_transition=0,"
            "alimiter=limit=0.95[a]"
        )
        cmd += ["-filter_complex", graph, "-map", "[v]", "-map", "[a]"]
    elif len(audio_inputs) == 1:
        graph = (
            f"[0:v]{','.join(video_filters)}[v];"
            "[1:a]aformat=channel_layouts=stereo,aresample=async=1[a]"
        )
        cmd += ["-filter_complex", graph, "-map", "[v]", "-map", "[a]"]
    else:
        cmd += ["-vf", ",".join(video_filters)]

    cmd += [
        # Hold the requested frame rate rather than letting the video timeline
        # follow the inputs. Without this, adding any live audio source drags
        # the recording down to a few frames a second: measured on a 1080p30
        # capture, 3 fps with sound on and 29 without, because ffmpeg paces the
        # video against the jittery audio clock. Pinning it puts that back to a
        # steady 30, and it is the whole reason recordings looked stuttery.
        "-fps_mode", "cfr",
        "-r", str(settings.fps),
        "-c:v", "libx264",
        "-preset", str(quality["preset"]),
        "-crf", str(quality["crf"]),
        "-pix_fmt", "yuv420p",
        # Play well in browsers and players that stream the file.
        "-movflags", "+faststart",
    ]
    if audio_inputs:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        # Without this a live audio input can hold the file open past the video.
        cmd += ["-shortest"]
    cmd += [str(out_path)]
    return cmd


class Recorder:
    """
    Wraps one ffmpeg capture process.

    Stopping writes "q" to ffmpeg's stdin rather than killing it. Killing leaves
    an mp4 without its index, which most players refuse to open.
    """

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._path: Optional[Path] = None
        self._started_at: float = 0.0
        self._log: List[str] = []
        self._lock = threading.Lock()
        self._feed = None
        self._audio_note = ""

    @property
    def is_recording(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    @property
    def output_path(self) -> Optional[Path]:
        return self._path

    def elapsed(self) -> float:
        return (time.monotonic() - self._started_at) if self._started_at else 0.0

    def start(self, settings: Settings, region: Optional[Region]) -> tuple[bool, str]:
        if self.is_recording:
            return False, "Already recording"
        if not platforms.has_ffmpeg():
            return False, "ffmpeg was not found on this computer"
        self._audio_note = ""

        out = output_path_for(settings)

        # The pipe has to exist before ffmpeg is told to open it.
        feed = None
        if settings.record_system and platforms.os_family() == WINDOWS:
            feed = audio.make_feed()
            try:
                feed.open()
            except Exception as e:
                # Losing sound is not worth losing the recording over.
                self._audio_note = f"System audio is off: {e}"
                feed = None
        self._feed = feed

        cmd = build_command(settings, region, out, feed)
        kwargs = {
            "stdin": subprocess.PIPE,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
        }
        if platforms.os_family() == WINDOWS:
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            proc = subprocess.Popen(cmd, **kwargs)
        except FileNotFoundError:
            self._end_feed()
            return False, "ffmpeg could not be started"
        except OSError as e:
            self._end_feed()
            return False, str(e)

        # Serving only begins once ffmpeg opens its end, which is what ties the
        # first audio sample to the start of the video.
        if feed is not None:
            feed.start()

        with self._lock:
            self._proc = proc
            self._path = out
            self._log = []
        self._started_at = time.monotonic()
        threading.Thread(target=self._drain, args=(proc,), daemon=True).start()

        # A capture that is going to fail usually does so immediately.
        time.sleep(0.7)
        if proc.poll() is not None:
            self._started_at = 0.0
            self._end_feed()
            return False, self.last_error() or "The capture stopped straight away"

        if feed is not None and not feed.wait_connected(3.0):
            self._audio_note = "System audio did not connect, recording without it."
        return True, str(out)

    @property
    def audio_note(self) -> str:
        """Set when sound was wanted but could not be captured."""
        note = self._audio_note
        if not note and self._feed and self._feed.error:
            return f"System audio stopped: {self._feed.error}"
        return note

    @property
    def audio_peak(self) -> float:
        """Live level, 0 to 1, for the meter in the bar."""
        return self._feed.peak if self._feed else 0.0

    def _end_feed(self) -> None:
        if self._feed:
            try:
                self._feed.stop()
            except Exception:
                pass
            self._feed = None

    def _drain(self, proc: subprocess.Popen) -> None:
        if not proc.stderr:
            return
        for line in proc.stderr:
            text = line.rstrip()
            if not text:
                continue
            with self._lock:
                self._log.append(text)
                if len(self._log) > 200:
                    del self._log[:100]

    def last_error(self) -> str:
        with self._lock:
            tail = [l for l in self._log[-12:] if l.strip()]
        for line in reversed(tail):
            if "error" in line.lower() or "invalid" in line.lower() or "could not" in line.lower():
                return line
        return tail[-1] if tail else ""

    def stop(self, timeout: float = 12.0) -> tuple[bool, str]:
        with self._lock:
            proc = self._proc
            path = self._path
        if proc is None:
            return False, "Not recording"

        if proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.write("q")
                    proc.stdin.flush()
            except (OSError, ValueError):
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Last resort: the file may still be usable thanks to faststart.
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

        self._end_feed()
        with self._lock:
            self._proc = None
        self._started_at = 0.0

        if path and path.is_file() and path.stat().st_size > 1024:
            return True, str(path)
        return False, self.last_error() or "The recording produced no file"
