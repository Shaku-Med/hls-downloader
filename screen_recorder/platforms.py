from __future__ import annotations

import ctypes
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

WINDOWS = "windows"
MACOS = "macos"
LINUX = "linux"


def os_family() -> str:
    if sys.platform.startswith("win"):
        return WINDOWS
    if sys.platform == "darwin":
        return MACOS
    return LINUX


def ffmpeg_path() -> Optional[str]:
    return shutil.which("ffmpeg")


def has_ffmpeg() -> bool:
    return ffmpeg_path() is not None


def _run(argv: List[str], timeout: float = 20.0) -> Tuple[int, str]:
    """ffmpeg writes device listings to stderr and exits non zero by design."""
    try:
        p = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os_family() == WINDOWS else 0,
        )
    except Exception:
        return 1, ""
    return p.returncode, (p.stdout or "") + (p.stderr or "")


@dataclass(frozen=True)
class Display:
    index: int
    label: str
    width: int
    height: int
    x: int = 0
    y: int = 0


def list_displays() -> List[Display]:
    """Physical monitors. Falls back to one screen when detection is unavailable."""
    fam = os_family()
    if fam == WINDOWS:
        return _windows_displays()
    if fam == MACOS:
        return _macos_displays()
    return _linux_displays()


def _windows_displays() -> List[Display]:
    out: List[Display] = []
    try:
        user32 = ctypes.windll.user32
        user32.SetProcessDPIAware()

        monitors: List[Tuple[int, int, int, int]] = []

        # HMONITOR, HDC, LPRECT, LPARAM
        proto = ctypes.WINFUNCTYPE(
            ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_long), ctypes.c_double,
        )

        def cb(_h, _hdc, lprect, _data):
            r = lprect
            monitors.append((r[0], r[1], r[2], r[3]))
            return 1

        user32.EnumDisplayMonitors(0, 0, proto(cb), 0)
        for i, (left, top, right, bottom) in enumerate(monitors):
            out.append(
                Display(
                    index=i,
                    label=f"Display {i + 1}  ({right - left} x {bottom - top})",
                    width=right - left,
                    height=bottom - top,
                    x=left,
                    y=top,
                )
            )
    except Exception:
        out = []
    if not out:
        w, h = _fallback_screen_size()
        out = [Display(index=0, label=f"Main display  ({w} x {h})", width=w, height=h)]
    return out


def _macos_displays() -> List[Display]:
    # avfoundation lists "Capture screen N" entries.
    _, text = _run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
    out: List[Display] = []
    for m in re.finditer(r"\[(\d+)\]\s+Capture screen\s*(\d+)", text):
        idx = int(m.group(1))
        out.append(Display(index=idx, label=f"Display {int(m.group(2)) + 1}", width=0, height=0))
    if not out:
        w, h = _fallback_screen_size()
        out = [Display(index=1, label=f"Main display  ({w} x {h})", width=w, height=h)]
    return out


def _linux_displays() -> List[Display]:
    out: List[Display] = []
    code, text = _run(["xrandr", "--query"], timeout=10.0)
    if code == 0:
        for i, m in enumerate(re.finditer(r"^(\S+)\s+connected\D*(\d+)x(\d+)\+(\d+)\+(\d+)", text, re.M)):
            out.append(
                Display(
                    index=i,
                    label=f"{m.group(1)}  ({m.group(2)} x {m.group(3)})",
                    width=int(m.group(2)),
                    height=int(m.group(3)),
                    x=int(m.group(4)),
                    y=int(m.group(5)),
                )
            )
    if not out:
        w, h = _fallback_screen_size()
        out = [Display(index=0, label=f"Main display  ({w} x {h})", width=w, height=h)]
    return out


def _fallback_screen_size() -> Tuple[int, int]:
    try:
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        size = (root.winfo_screenwidth(), root.winfo_screenheight())
        root.destroy()
        return size
    except Exception:
        return (1920, 1080)


def list_audio_inputs() -> List[str]:
    """Microphone names ffmpeg will accept for this platform."""
    fam = os_family()
    if fam == WINDOWS:
        _, text = _run(["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        names = re.findall(r'"([^"]+)"\s*\n?\s*.*?\(audio\)', text)
        if not names:
            # Older builds put the type marker on the same line.
            names = [m.group(1) for m in re.finditer(r'\[dshow[^\]]*\]\s+"([^"]+)"', text)]
        seen, out = set(), []
        for n in names:
            # ffmpeg also prints the raw alternative name; keep the readable one.
            if n.startswith("@device_") or n in seen:
                continue
            seen.add(n)
            out.append(n)
        return out
    if fam == MACOS:
        _, text = _run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        block = text.split("AVFoundation audio devices:")
        if len(block) < 2:
            return []
        return [m.group(2) for m in re.finditer(r"\[(\d+)\]\s+(.+)", block[1])]
    # PulseAudio default works for the vast majority of desktops.
    return ["default"]


def reveal(path) -> bool:
    """Show a finished recording in the file manager, selected where possible."""
    target = str(path)
    fam = os_family()
    try:
        if fam == WINDOWS:
            # explorer returns non zero even when it works, so ignore the code.
            subprocess.Popen(["explorer", "/select,", target])
            return True
        if fam == MACOS:
            subprocess.Popen(["open", "-R", target])
            return True
        # Most Linux file managers have no select flag, so open the folder.
        subprocess.Popen(["xdg-open", str(Path(target).parent)])
        return True
    except OSError:
        return False
