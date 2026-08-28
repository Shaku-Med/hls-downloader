"""
Screen geometry in real pixels.

Windows lies about screen size to programs that have not declared themselves
DPI aware: on a 125% display it reports 1536x864 for a 1920x1080 screen. That
made the region overlay cover only part of the screen, and the captured area
came out wrong, because ffmpeg's gdigrab works in physical pixels either way.

Awareness has to be set before Tk creates anything, so this is imported at
package import time.
"""

from __future__ import annotations

import ctypes
import sys
from typing import Tuple

_enabled = False


def enable_dpi_awareness() -> bool:
    """Must run before tkinter initialises, or Tk caches the scaled size."""
    global _enabled
    if _enabled or not sys.platform.startswith("win"):
        _enabled = True
        return True
    try:
        # 2 = per monitor aware; best available on Windows 8.1 and newer.
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        _enabled = True
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
            _enabled = True
        except Exception:
            return False
    return True


def exclude_from_capture(widget) -> bool:
    """
    Keep a window on screen but out of any recording.

    Windows can leave a window off screen captures while still drawing it for
    the person at the machine, which is exactly what the control bar wants: you
    can still reach Stop, but the bar is not baked into the video.
    """
    if not sys.platform.startswith("win"):
        return False
    try:
        widget.update_idletasks()
        u = ctypes.windll.user32
        # Tk hands out the inner window; the affinity has to go on the real top
        # level, which GA_ROOT walks up to. GetParent would give the desktop.
        hwnd = u.GetAncestor(widget.winfo_id(), 2) or widget.winfo_id()
        WDA_EXCLUDEFROMCAPTURE = 0x00000011
        return bool(u.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE))
    except Exception:
        return False


def click_through(widget) -> bool:
    """
    Let clicks pass straight through a window to whatever is behind it.

    The capture outline sits on top of everything the whole time the recorder is
    open, so it must not swallow a single click. It also refuses focus, so it
    never steals the caret from what is being recorded.
    """
    if not sys.platform.startswith("win"):
        return False
    try:
        widget.update_idletasks()
        u = ctypes.windll.user32
        hwnd = u.GetAncestor(widget.winfo_id(), 2) or widget.winfo_id()
        GWL_EXSTYLE = -20
        WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_NOACTIVATE = 0x80000, 0x20, 0x08000000
        current = u.GetWindowLongW(hwnd, GWL_EXSTYLE)
        u.SetWindowLongW(
            hwnd, GWL_EXSTYLE,
            current | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
        )
        return True
    except Exception:
        return False


def virtual_screen() -> Tuple[int, int, int, int]:
    """(x, y, width, height) spanning every monitor, in physical pixels."""
    if sys.platform.startswith("win"):
        try:
            u = ctypes.windll.user32
            # SM_XVIRTUALSCREEN 76, SM_YVIRTUALSCREEN 77, CX 78, CY 79
            return (
                u.GetSystemMetrics(76),
                u.GetSystemMetrics(77),
                u.GetSystemMetrics(78),
                u.GetSystemMetrics(79),
            )
        except Exception:
            pass
    try:
        import tkinter as tk

        root = tk._default_root
        made = root is None
        if made:
            root = tk.Tk()
            root.withdraw()
        size = (0, 0, root.winfo_screenwidth(), root.winfo_screenheight())
        if made:
            root.destroy()
        return size
    except Exception:
        return (0, 0, 1920, 1080)
