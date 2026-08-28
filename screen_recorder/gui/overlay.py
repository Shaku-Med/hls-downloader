"""
On screen overlays: the capture outline, and the countdown.

Both float above everything, ignore the mouse entirely, and are kept out of the
recording, so they tell you what is happening without getting in the way or
ending up in the file.

The outline is drawn as four thin strips rather than one big transparent window.
A window with a hole in it needs colour keying, which is Windows only and makes
the keyed pixels click through in a way that is hard to control; four solid
strips behave the same on every platform.
"""

from __future__ import annotations

import tkinter as tk
from typing import List, Optional, Tuple

from .. import display
from .theme import ACCENT, BG, DANGER, FILL, FILL_HOVER, LINE, MUTED, TEXT, ui_font

THICKNESS = 3
IDLE_COLOR = ACCENT
LIVE_COLOR = DANGER


class CaptureOutline:
    """
    A border around whatever is about to be recorded, or is being recorded.

    Sits outside the capture area where there is room, so on a platform that
    cannot hide it from the recording it still stays out of shot. At a screen
    edge there is nowhere outside to go, so it tucks just inside instead.
    """

    def __init__(self, master: tk.Misc) -> None:
        self.master = master
        self._strips: List[tk.Toplevel] = []
        self._rect: Optional[Tuple[int, int, int, int]] = None
        self._color = IDLE_COLOR
        self._visible = False

    def _ensure_strips(self) -> None:
        if self._strips:
            return
        for _ in range(4):
            win = tk.Toplevel(self.master)
            win.overrideredirect(True)
            win.attributes("-topmost", True)
            win.configure(bg=self._color)
            try:
                win.attributes("-alpha", 0.9)
            except tk.TclError:
                pass
            display.exclude_from_capture(win)
            display.click_through(win)
            win.withdraw()
            self._strips.append(win)

    def show(self, rect: Optional[Tuple[int, int, int, int]], *, live: bool = False) -> None:
        """Draw the border around `rect`, or hide it when rect is None."""
        if not rect or rect[2] <= 0 or rect[3] <= 0:
            self.hide()
            return
        self._ensure_strips()
        self._rect = rect
        self._color = LIVE_COLOR if live else IDLE_COLOR

        x, y, w, h = rect
        sw = self.master.winfo_screenwidth()
        sh = self.master.winfo_screenheight()
        t = THICKNESS

        # Outside the area where the screen allows, inside where it does not.
        top_y = y - t if y - t >= 0 else y
        bottom_y = y + h if y + h + t <= sh else y + h - t
        left_x = x - t if x - t >= 0 else x
        right_x = x + w if x + w + t <= sw else x + w - t
        span_x = min(left_x, x)
        span_w = (max(right_x + t, x + w)) - span_x

        places = [
            (span_x, top_y, span_w, t),
            (span_x, bottom_y, span_w, t),
            (left_x, y, t, h),
            (right_x, y, t, h),
        ]
        for win, (px, py, pw, ph) in zip(self._strips, places):
            win.configure(bg=self._color)
            win.geometry(f"{max(1, pw)}x{max(1, ph)}+{px}+{py}")
            win.deiconify()
            win.attributes("-topmost", True)
        self._visible = True

    def set_live(self, live: bool) -> None:
        if self._rect:
            self.show(self._rect, live=live)

    def lift(self) -> None:
        for win in self._strips:
            try:
                win.attributes("-topmost", True)
            except tk.TclError:
                pass

    def hide(self) -> None:
        for win in self._strips:
            try:
                win.withdraw()
            except tk.TclError:
                pass
        self._visible = False

    def destroy(self) -> None:
        for win in self._strips:
            try:
                win.destroy()
            except tk.TclError:
                pass
        self._strips = []
        self._visible = False


class CountdownOverlay(tk.Toplevel):
    """
    The big number before recording starts, with a way out.

    Centred and large enough to read from across the room, because the point of
    a countdown is to be noticed. Cancel is a button rather than a key, so
    nothing depends on knowing a shortcut.
    """

    WIDTH = 340
    HEIGHT = 300

    def __init__(self, master: tk.Misc, seconds: int, on_done, on_cancel) -> None:
        super().__init__(master)
        self.on_done = on_done
        self.on_cancel = on_cancel
        self._left = seconds
        self._job: Optional[str] = None
        self._cancelled = False

        self.overrideredirect(True)
        self.attributes("-topmost", True)
        display.exclude_from_capture(self)

        # A hairline frame around a fixed size card. The size is set rather than
        # measured: a 96pt digit is not laid out yet when the window is first
        # placed, and asking then gives a card narrower than its own contents.
        self.configure(bg=LINE)
        wrap = tk.Frame(self, bg=BG)
        wrap.pack(fill="both", expand=True, padx=1, pady=1)

        self.number = tk.Label(
            wrap, text=str(seconds), bg=BG, fg=TEXT, font=ui_font(self, 72, True),
        )
        self.number.pack(pady=(30, 0))
        tk.Label(
            wrap, text="Recording starts", bg=BG, fg=MUTED, font=ui_font(self, 11),
        ).pack(pady=(4, 20))

        self.cancel_btn = tk.Label(
            wrap, text="Cancel", bg=FILL, fg=TEXT, font=ui_font(self, 11, True),
            padx=30, pady=10, cursor="hand2",
        )
        self.cancel_btn.pack(pady=(0, 26))
        self.cancel_btn.bind("<Enter>", lambda _e: self.cancel_btn.configure(bg=FILL_HOVER))
        self.cancel_btn.bind("<Leave>", lambda _e: self.cancel_btn.configure(bg=FILL))
        self.cancel_btn.bind("<Button-1>", lambda _e: self.cancel())

        x = (self.winfo_screenwidth() - self.WIDTH) // 2
        y = (self.winfo_screenheight() - self.HEIGHT) // 2
        self.geometry(f"{self.WIDTH}x{self.HEIGHT}+{x}+{y}")
        self._tick()

    def _tick(self) -> None:
        if self._cancelled:
            return
        if self._left <= 0:
            self._finish()
            return
        self.number.configure(text=str(self._left))
        self._left -= 1
        self._job = self.after(1000, self._tick)

    def _finish(self) -> None:
        self._close()
        self.on_done()

    def cancel(self) -> None:
        if self._cancelled:
            return
        self._cancelled = True
        self._close()
        self.on_cancel()

    def _close(self) -> None:
        if self._job:
            try:
                self.after_cancel(self._job)
            except tk.TclError:
                pass
            self._job = None
        try:
            self.destroy()
        except tk.TclError:
            pass
