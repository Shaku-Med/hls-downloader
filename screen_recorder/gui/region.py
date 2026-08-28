from __future__ import annotations

import os
import subprocess
import tempfile
import tkinter as tk
from typing import Callable, Optional, Tuple

from .. import platforms
from .. import display
from ..display import virtual_screen
from ..recorder import Region
from .theme import ACCENT, BG_RAISED, LINE, TEXT, ui_font

HANDLE = 10
MIN_SIDE = 40
DEFAULT_W = 640
DEFAULT_H = 360


def default_rect(vw: int, vh: int) -> Tuple[int, int, int, int]:
    """
    The starting box, as (x, y, width, height) in screen space.

    Small on purpose: growing a box is easier than shrinking one, and a large
    default hides the very thing being aimed at. Shared with the bar, which
    needs the same box when the saved source is an area but no area was ever
    chosen, so there is always something to show.
    """
    w = min(DEFAULT_W, max(MIN_SIDE * 2, vw // 3))
    h = min(DEFAULT_H, max(MIN_SIDE * 2, vh // 3))
    return ((vw - w) // 2, (vh - h) // 2, w, h)


class RegionSelector(tk.Toplevel):
    """
    Full screen overlay for choosing the capture area.

    A still of the desktop is grabbed first and drawn as the backdrop, then
    everything outside the selection is dimmed over it. Keying pixels out
    instead would make the middle of the window click through, so the box could
    not be dragged from inside, and the screen would go black wherever the
    backdrop was missing.
    """

    def __init__(
        self, master: tk.Misc, initial: Optional[Region],
        on_done: Callable[[Optional[Region]], None],
    ) -> None:
        super().__init__(master)
        self.on_done = on_done
        self._drag_mode: Optional[str] = None
        self._drag_origin: Tuple[int, int] = (0, 0)
        self._start_rect: Tuple[int, int, int, int] = (0, 0, 0, 0)

        self.vx, self.vy, self.vw, self.vh = virtual_screen()

        self.withdraw()  # hidden while grabbing, or it captures itself
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.geometry(f"{self.vw}x{self.vh}+{self.vx}+{self.vy}")
        self.configure(bg="#0b0b0d", cursor="crosshair")

        self.canvas = tk.Canvas(self, bg="#0b0b0d", highlightthickness=0, bd=0, cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)

        display.exclude_from_capture(self)
        self._backdrop: Optional[tk.PhotoImage] = None
        self._shot_path: Optional[str] = None
        self._grab_backdrop()

        if initial and initial.width >= MIN_SIDE and initial.height >= MIN_SIDE:
            # Stored coordinates are screen space; the canvas is virtual space.
            x1, y1 = initial.x - self.vx, initial.y - self.vy
            self.rect = (x1, y1, x1 + initial.width, y1 + initial.height)
        else:
            x, y, w, h = default_rect(self.vw, self.vh)
            self.rect = (x, y, x + w, y + h)

        self.canvas.bind("<Button-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._motion)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.canvas.bind("<Motion>", self._hover)
        self.bind("<Escape>", lambda _e: self._finish(None))
        self.bind("<Return>", lambda _e: self._confirm())
        for key, dx, dy in (("Left", -1, 0), ("Right", 1, 0), ("Up", 0, -1), ("Down", 0, 1)):
            self.bind(f"<{key}>", lambda _e, a=dx, b=dy: self._nudge(a, b))
            self.bind(f"<Shift-{key}>", lambda _e, a=dx, b=dy: self._nudge(a * 10, b * 10))

        self.deiconify()
        self.after(10, self._grab_focus)
        self._redraw()

    def _grab_backdrop(self) -> None:
        """One still of the desktop to sit behind the selection."""
        ffmpeg = platforms.ffmpeg_path()
        if not ffmpeg:
            return
        fam = platforms.os_family()
        if fam == platforms.WINDOWS:
            args = ["-f", "gdigrab", "-video_size", f"{self.vw}x{self.vh}", "-i", "desktop"]
        elif fam == platforms.MACOS:
            args = ["-f", "avfoundation", "-i", "1:"]
        else:
            args = ["-f", "x11grab", "-video_size", f"{self.vw}x{self.vh}",
                    "-i", os.environ.get("DISPLAY", ":0.0")]
        fd, path = tempfile.mkstemp(suffix=".png", prefix="sg_region_")
        os.close(fd)
        try:
            subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args,
                 "-frames:v", "1", path],
                timeout=20, stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                if fam == platforms.WINDOWS else 0,
            )
            if os.path.getsize(path) > 0:
                self._backdrop = tk.PhotoImage(master=self, file=path)
                self._shot_path = path
                return
        except Exception:
            # Without a backdrop the overlay still works, just plainer.
            pass
        try:
            os.remove(path)
        except OSError:
            pass

    def _grab_focus(self) -> None:
        # Focus, but deliberately no grab_set. A grab would make this modal and
        # the control bar, which now stays on screen throughout, unclickable.
        try:
            self.focus_force()
        except tk.TclError:
            pass

    def _nudge(self, dx: int, dy: int) -> None:
        x1, y1, x2, y2 = self._norm()
        w, h = x2 - x1, y2 - y1
        nx = max(0, min(self.vw - w, x1 + dx))
        ny = max(0, min(self.vh - h, y1 + dy))
        self.rect = (nx, ny, nx + w, ny + h)
        self._redraw()

    # ── geometry ──
    def _norm(self) -> Tuple[int, int, int, int]:
        x1, y1, x2, y2 = self.rect
        return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))

    def _zone(self, x: int, y: int) -> Optional[str]:
        x1, y1, x2, y2 = self._norm()
        if not (x1 - HANDLE <= x <= x2 + HANDLE and y1 - HANDLE <= y <= y2 + HANDLE):
            return None
        l, r = abs(x - x1) <= HANDLE, abs(x - x2) <= HANDLE
        t, b = abs(y - y1) <= HANDLE, abs(y - y2) <= HANDLE
        if t and l:
            return "nw"
        if t and r:
            return "ne"
        if b and l:
            return "sw"
        if b and r:
            return "se"
        if t:
            return "n"
        if b:
            return "s"
        if l:
            return "w"
        if r:
            return "e"
        if x1 < x < x2 and y1 < y < y2:
            return "move"
        return None

    _CURSORS = {
        "nw": "size_nw_se", "se": "size_nw_se", "ne": "size_ne_sw", "sw": "size_ne_sw",
        "n": "sb_v_double_arrow", "s": "sb_v_double_arrow",
        "w": "sb_h_double_arrow", "e": "sb_h_double_arrow", "move": "fleur",
    }

    def _hover(self, ev) -> None:
        try:
            self.canvas.configure(cursor=self._CURSORS.get(self._zone(ev.x, ev.y) or "", "crosshair"))
        except tk.TclError:
            pass

    # ── interaction ──
    def _press(self, ev) -> None:
        zone = self._zone(ev.x, ev.y)
        self._drag_origin = (ev.x, ev.y)
        self._start_rect = self._norm()
        if zone is None:
            self._drag_mode = "new"
            self.rect = (ev.x, ev.y, ev.x, ev.y)
        else:
            self._drag_mode = zone
        self._redraw()

    def _motion(self, ev) -> None:
        if not self._drag_mode:
            return
        dx, dy = ev.x - self._drag_origin[0], ev.y - self._drag_origin[1]
        x1, y1, x2, y2 = self._start_rect
        mode = self._drag_mode
        if mode == "new":
            self.rect = (self._drag_origin[0], self._drag_origin[1],
                         self._clamp_x(ev.x), self._clamp_y(ev.y))
        elif mode == "move":
            w, h = x2 - x1, y2 - y1
            nx = max(0, min(self.vw - w, x1 + dx))
            ny = max(0, min(self.vh - h, y1 + dy))
            self.rect = (nx, ny, nx + w, ny + h)
        else:
            if "n" in mode:
                y1 = self._clamp_y(y1 + dy)
            if "s" in mode:
                y2 = self._clamp_y(y2 + dy)
            if "w" in mode:
                x1 = self._clamp_x(x1 + dx)
            if "e" in mode:
                x2 = self._clamp_x(x2 + dx)
            self.rect = (x1, y1, x2, y2)
        self._redraw()

    # An area reaching past the desktop is not capturable: ffmpeg refuses a
    # capture region that extends outside the screen, so the box is held inside.
    def _clamp_x(self, x: int) -> int:
        return max(0, min(self.vw, x))

    def _clamp_y(self, y: int) -> int:
        return max(0, min(self.vh, y))

    def _release(self, _ev) -> None:
        """
        Letting go ends this drag, not the selection.

        The box stays live so it can be nudged, resized and redrawn as many
        times as needed. It is committed when recording actually starts.
        """
        self._drag_mode = None
        x1, y1, x2, y2 = self._norm()
        if x2 - x1 < MIN_SIDE or y2 - y1 < MIN_SIDE:
            # A stray click, or a box too small to mean anything. Put the
            # previous one back rather than throwing the selection away.
            self.rect = self._start_rect
        self._redraw()

    def _confirm(self) -> None:
        x1, y1, x2, y2 = self._norm()
        if x2 - x1 < MIN_SIDE or y2 - y1 < MIN_SIDE:
            return
        # Back to screen coordinates for ffmpeg.
        self._finish(Region(x1 + self.vx, y1 + self.vy, x2 - x1, y2 - y1))

    def reopen(self) -> None:
        """Bring this back to the front without disturbing the box."""
        try:
            self.deiconify()
            self.attributes("-topmost", True)
            self.lift()
            self.focus_force()
        except tk.TclError:
            pass

    def cancel(self) -> None:
        """Close without choosing, when something else needs the screen."""
        self._finish(None)

    def commit(self) -> None:
        """
        Take the box as it stands and close.

        Called when recording is about to start, which is the moment the area
        stops being editable. It also has to happen before ffmpeg opens, since
        this window covers the screen and would otherwise be in the recording.
        """
        x1, y1, x2, y2 = self._norm()
        if x2 - x1 < MIN_SIDE or y2 - y1 < MIN_SIDE:
            # Nothing usable was drawn. Close anyway rather than leaving this
            # covering the screen while ffmpeg records it.
            self._finish(None)
            return
        self._confirm()

    def _finish(self, region: Optional[Region]) -> None:
        cb = self.on_done
        self.on_done = lambda _r: None
        if self._shot_path:
            try:
                os.remove(self._shot_path)
            except OSError:
                pass
        try:
            self.grab_release()
        except tk.TclError:
            pass
        try:
            self.destroy()
        except tk.TclError:
            pass
        cb(region)

    # ── painting ──
    def _redraw(self) -> None:
        c = self.canvas
        c.delete("all")
        x1, y1, x2, y2 = self._norm()

        if self._backdrop is not None:
            c.create_image(0, 0, image=self._backdrop, anchor="nw")

        # A Canvas has no per pixel alpha, so the dimming is two stipple passes
        # over the backdrop. Heavy enough that the selection clearly stands out,
        # while the rest of the screen stays readable for lining a shot up.
        for bx1, by1, bx2, by2 in (
            (0, 0, self.vw, y1),
            (0, y2, self.vw, self.vh),
            (0, y1, x1, y2),
            (x2, y1, self.vw, y2),
        ):
            if bx2 > bx1 and by2 > by1:
                for pattern in ("gray75", "gray50"):
                    c.create_rectangle(bx1, by1, bx2, by2, fill="#000000",
                                       stipple=pattern, outline="")

        c.create_rectangle(x1, y1, x2, y2, outline=ACCENT, width=2)

        for i in (1, 2):
            gx = x1 + (x2 - x1) * i / 3
            gy = y1 + (y2 - y1) * i / 3
            c.create_line(gx, y1, gx, y2, fill=ACCENT, width=1, stipple="gray25")
            c.create_line(x1, gy, x2, gy, fill=ACCENT, width=1, stipple="gray25")

        for hx, hy in ((x1, y1), (x2, y1), (x1, y2), (x2, y2),
                       ((x1 + x2) // 2, y1), ((x1 + x2) // 2, y2),
                       (x1, (y1 + y2) // 2), (x2, (y1 + y2) // 2)):
            c.create_rectangle(hx - HANDLE // 2, hy - HANDLE // 2,
                               hx + HANDLE // 2, hy + HANDLE // 2,
                               fill=ACCENT, outline="#ffffff", width=1)

        size = f"{x2 - x1} x {y2 - y1}"
        ly = y1 - 30 if y1 > 34 else y2 + 10
        c.create_rectangle(x1, ly, x1 + 108, ly + 24, fill=BG_RAISED, outline=LINE)
        c.create_text(x1 + 54, ly + 12, text=size, fill=TEXT, font=ui_font(self, 9, True))

        # No shortcut hints and no keyboard step to finish: the bar stays on
        # screen throughout, so letting go of the mouse settles the area and the
        # record button on the bar is right there.
