"""
System audio, the sound the machine is playing, as opposed to the microphone.

Every platform gets there differently:

Windows   ffmpeg has no loopback input, so the capture is done in process
          through WASAPI and handed over via a pipe. Nothing to install.
Linux     PulseAudio and PipeWire expose a monitor source for each output, and
          ffmpeg reads it directly. Nothing to install.
macOS     There is no system route at all. Apple gives no loopback device, so a
          free driver such as BlackHole has to be installed first, and then it
          shows up as an ordinary input. We detect it and say so when it is
          missing rather than recording silence and leaving you to wonder.
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .. import platforms
from ..platforms import LINUX, MACOS, WINDOWS

# Known loopback drivers on macOS, in the order we would rather use them.
_MAC_LOOPBACK_HINTS = ("blackhole", "soundflower", "loopback audio", "existential audio")


def supported() -> Tuple[bool, str]:
    """
    Can system audio be captured on this machine?

    Returns (yes, reason it cannot). The reason is shown in the UI, so it says
    what to do rather than only what went wrong.
    """
    fam = platforms.os_family()
    if fam == WINDOWS:
        from . import wasapi

        return wasapi.available()
    if fam == LINUX:
        if _pulse_monitor():
            return True, ""
        return False, "No PulseAudio monitor source was found to record from."
    device = _mac_loopback_device()
    if device:
        return True, ""
    return False, (
        "macOS has no built in way to record what you are hearing. Install a "
        "free loopback driver such as BlackHole, set it as your output, then "
        "turn this on again."
    )


def _pulse_monitor() -> Optional[str]:
    """The monitor source of the default sink, which is what you hear."""
    code, text = platforms._run(["pactl", "get-default-sink"], timeout=4.0)
    if code == 0:
        sink = text.strip().splitlines()[0].strip() if text.strip() else ""
        if sink:
            return sink + ".monitor"
    # Older pactl has no get-default-sink; fall back to the first monitor listed.
    code, text = platforms._run(["pactl", "list", "short", "sources"], timeout=4.0)
    if code == 0:
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1].endswith(".monitor"):
                return parts[1]
    return None


def _mac_loopback_device() -> Optional[str]:
    for name in platforms.list_audio_inputs():
        low = name.lower()
        if any(h in low for h in _MAC_LOOPBACK_HINTS):
            return name
    return None


def mac_loopback_index() -> Optional[str]:
    """avfoundation wants the device index, not its name."""
    code, text = platforms._run(
        ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
    )
    block = text.split("AVFoundation audio devices:")
    if len(block) < 2:
        return None
    for m in re.finditer(r"\[(\d+)\]\s+(.+)", block[1]):
        if any(h in m.group(2).lower() for h in _MAC_LOOPBACK_HINTS):
            return m.group(1)
    return None


def input_args(feed) -> List[str]:
    """
    ffmpeg input arguments for system audio.

    On Windows this reads the pipe that `feed` is writing. Elsewhere ffmpeg
    talks to the platform directly and `feed` is None.
    """
    fam = platforms.os_family()
    if fam == WINDOWS:
        if feed is None or feed.format is None:
            return []
        f = feed.format
        return [
            "-f", f.ffmpeg_format,
            "-ar", str(f.sample_rate),
            "-ac", str(f.channels),
            # The pipe is live, so let ffmpeg buffer rather than race it.
            "-thread_queue_size", "1024",
            "-i", feed.name,
        ]
    if fam == LINUX:
        monitor = _pulse_monitor()
        if not monitor:
            return []
        return ["-f", "pulse", "-thread_queue_size", "1024", "-i", monitor]
    index = mac_loopback_index()
    if index is None:
        return []
    return ["-f", "avfoundation", "-thread_queue_size", "1024", "-i", f":{index}"]


def make_feed():
    """A running capture on Windows, or None where ffmpeg handles it itself."""
    if platforms.os_family() != WINDOWS:
        return None
    from .pipe import SystemAudioFeed

    return SystemAudioFeed()
