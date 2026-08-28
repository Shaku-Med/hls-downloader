from __future__ import annotations

import sys
import tkinter as tk
from tkinter import font as tkfont
from typing import Callable, Optional

from . import icons

# Same palette as the extension so the two feel like one product.
BG = "#1c1c1e"
BG_RAISED = "#2c2c2e"
FILL = "#3a3a3c"
FILL_HOVER = "#48484a"
TEXT = "#ffffff"
MUTED = "#8e8e93"
LINE = "#3a3a3c"
ACCENT = "#0a84ff"
DANGER = "#ff453a"
OK = "#30d158"

# Grouped settings look, matching the extension's iOS styling: a black page
# with cards floating on it, hairline separators, green switches.
PAGE = "#000000"
GROUPED = "#1c1c1e"
SEPARATOR = "#38383a"
ON_GREEN = "#30d158"
RADIUS = 12

# Windows paints this exact colour as a hole, which is how the bar gets real
# rounded corners instead of a square block behind them.
CHROMA = "#010203"


def ui_font(root: tk.Misc, size: int = 10, bold: bool = False) -> tkfont.Font:
    if sys.platform.startswith("win"):
        family = "Segoe UI"
    elif sys.platform == "darwin":
        family = "SF Pro Text"
    else:
        family = "DejaVu Sans"
    try:
        return tkfont.Font(root=root, family=family, size=size, weight="bold" if bold else "normal")
    except tk.TclError:
        return tkfont.Font(root=root, size=size, weight="bold" if bold else "normal")


class IconButton(tk.Canvas):
    """
    A round icon button drawn on a canvas.

    tk.Button cannot be made to look like this, and text glyphs render
    differently on every machine, so both the shape and the icon are drawn.
    """

    def __init__(
        self,
        master: tk.Misc,
        icon: str,
        command: Optional[Callable[[], None]] = None,
        *,
        size: int = 34,
        icon_size: int = 17,
        bg: str = BG,
        fill: str = "",
        fill_hover: str = FILL,
        color: str = TEXT,
        tooltip: str = "",
    ) -> None:
        super().__init__(
            master, width=size, height=size, bg=bg,
            highlightthickness=0, bd=0, cursor="hand2",
        )
        self._icon = icon
        self._size = size
        self._icon_size = icon_size
        self._bg = bg
        self._fill = fill
        self._fill_hover = fill_hover
        self._color = color
        self._command = command
        self._enabled = True
        self._hovering = False
        self._tip: Optional[Tooltip] = None

        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)
        self.bind("<Button-1>", self._click)
        if tooltip:
            self._tip = Tooltip(self, tooltip)
        self._render()

    def _render(self) -> None:
        self.delete("all")
        pad = 1
        c = self._size / 2.0
        bg_now = self._fill_hover if (self._hovering and self._enabled) else self._fill
        if bg_now:
            self.create_oval(pad, pad, self._size - pad, self._size - pad, fill=bg_now, outline="")
        color = self._color if self._enabled else MUTED
        surface = bg_now or self._bg
        if self._icon == "gear":
            icons.gear_with_hole(self, c, c, self._icon_size, color, surface)
        else:
            icons.draw(self, self._icon, c, c, self._icon_size, color)

    def configure_icon(
        self, *, icon: Optional[str] = None, color: Optional[str] = None,
        fill: Optional[str] = None, fill_hover: Optional[str] = None,
    ) -> None:
        if icon is not None:
            self._icon = icon
        if color is not None:
            self._color = color
        if fill is not None:
            self._fill = fill
        if fill_hover is not None:
            self._fill_hover = fill_hover
        self._render()

    def set_tooltip(self, text: str) -> None:
        if self._tip:
            self._tip.text = text

    def set_enabled(self, on: bool) -> None:
        self._enabled = on
        self.configure(cursor="hand2" if on else "arrow")
        self._render()

    def _enter(self, _e) -> None:
        self._hovering = True
        self._render()

    def _leave(self, _e) -> None:
        self._hovering = False
        self._render()

    def _click(self, _e) -> None:
        if self._enabled and self._command:
            self._command()


class LevelMeter(tk.Canvas):
    """
    A slim column of segments showing how loud the capture is right now.

    Worth the space: the usual way to find out a recording had no sound is to
    play it back afterwards, and by then the moment is gone. This says so while
    there is still time to fix it.
    """

    SEGMENTS = 5

    def __init__(self, master: tk.Misc, *, height: int = 22, width: int = 5, bg: str = BG) -> None:
        super().__init__(master, width=width, height=height, bg=bg, highlightthickness=0, bd=0)
        # Not _w or _h: tkinter uses _w internally for the widget path name.
        self._bar_w, self._bar_h = width, height
        self._level = 0.0
        self._muted = True
        self._draw()

    def set_level(self, level: float) -> None:
        level = max(0.0, min(1.0, level))
        # Only repaint on a visible change; this ticks several times a second.
        if abs(level - self._level) < 0.02:
            return
        self._level = level
        self._draw()

    def set_muted(self, muted: bool) -> None:
        if muted == self._muted:
            return
        self._muted = muted
        if muted:
            self._level = 0.0
        self._draw()

    def _draw(self) -> None:
        self.delete("all")
        gap = 2
        seg_h = (self._bar_h - gap * (self.SEGMENTS - 1)) / self.SEGMENTS
        # A quiet room should still light the bottom segment, so the scale is
        # curved rather than linear.
        shown = 0 if self._muted else round((self._level ** 0.6) * self.SEGMENTS)
        for i in range(self.SEGMENTS):
            top = self._bar_h - (i + 1) * seg_h - i * gap
            lit = i < shown
            if lit:
                color = DANGER if i >= self.SEGMENTS - 1 else (ACCENT if i >= self.SEGMENTS - 2 else OK)
            else:
                color = FILL if not self._muted else "#2f2f31"
            self.create_rectangle(0, top, self._bar_w, top + seg_h, fill=color, outline="")


class Switch(tk.Canvas):
    """
    The pill toggle from iOS, drawn rather than themed.

    ttk has no switch, and a tk.Checkbutton looks like nothing else in this
    project. Drawing it keeps the settings window matching the extension.
    """

    W, H = 42, 25

    def __init__(self, master: tk.Misc, value: bool = False, *,
                 bg: str = GROUPED, command=None, enabled: bool = True) -> None:
        super().__init__(master, width=self.W, height=self.H, bg=bg,
                         highlightthickness=0, bd=0,
                         cursor="hand2" if enabled else "arrow")
        self._value = bool(value)
        self._command = command
        self._enabled = enabled
        self.bind("<Button-1>", self._click)
        self._draw()

    def _draw(self) -> None:
        self.delete("all")
        on = self._value
        track = ON_GREEN if on else FILL
        if not self._enabled:
            track = FILL if not on else "#2f6b3c"
        icons.rounded_rect(self, 1, 1, self.W - 1, self.H - 1, (self.H - 2) / 2,
                           fill=track, outline="")
        r = (self.H - 8) / 2
        cx = (self.W - 4 - r) if on else (4 + r)
        cy = self.H / 2
        self.create_oval(cx - r, cy - r, cx + r, cy + r,
                         fill="#ffffff" if self._enabled else "#d1d1d6", outline="")

    def get(self) -> bool:
        return self._value

    def set(self, value: bool) -> None:
        if bool(value) == self._value:
            return
        self._value = bool(value)
        self._draw()

    def set_enabled(self, on: bool) -> None:
        self._enabled = on
        self.configure(cursor="hand2" if on else "arrow")
        self._draw()

    def _click(self, _e) -> None:
        if not self._enabled:
            return
        self._value = not self._value
        self._draw()
        if self._command:
            self._command(self._value)


class PillButton(tk.Canvas):
    """
    A fully rounded button, drawn.

    The extension puts a 980px radius on its buttons, which is a pill. A
    tk.Label cannot be rounded at all, so the shape and the text are drawn on a
    canvas and the surface behind is painted in so the corners read as round.
    """

    def __init__(
        self, master: tk.Misc, text: str, command, *,
        bg: str = FILL, hover: str = FILL_HOVER, fg: str = TEXT,
        surface: str = PAGE, font: Optional[tkfont.Font] = None,
        padx: int = 18, height: int = 34, min_width: int = 0,
    ) -> None:
        self._font = font or ui_font(master, 10)
        width = max(min_width, self._font.measure(text) + padx * 2)
        super().__init__(master, width=width, height=height, bg=surface,
                         highlightthickness=0, bd=0, cursor="hand2")
        self._text, self._command = text, command
        self._bg, self._hover, self._fg = bg, hover, fg
        self._btn_w, self._btn_h = width, height
        self._hovering = False
        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)
        self.bind("<Button-1>", self._click)
        self._draw()

    def _draw(self) -> None:
        self.delete("all")
        fill = self._hover if self._hovering else self._bg
        icons.rounded_rect(self, 0, 0, self._btn_w, self._btn_h,
                           self._btn_h / 2, fill=fill, outline="")
        self.create_text(self._btn_w / 2, self._btn_h / 2, text=self._text,
                         fill=self._fg, font=self._font)

    def _enter(self, _e) -> None:
        self._hovering = True
        self._draw()

    def _leave(self, _e) -> None:
        self._hovering = False
        self._draw()

    def _click(self, _e) -> None:
        if self._command:
            self._command()


class Tooltip:
    def __init__(self, widget: tk.Misc, text: str) -> None:
        self.widget = widget
        self.text = text
        self.tip: Optional[tk.Toplevel] = None
        self._after: Optional[str] = None
        widget.bind("<Enter>", self._schedule, add="+")
        widget.bind("<Leave>", self._hide, add="+")
        widget.bind("<Button-1>", self._hide, add="+")

    def _schedule(self, _e=None) -> None:
        self._cancel()
        self._after = self.widget.after(600, self._show)

    def _cancel(self) -> None:
        if self._after:
            try:
                self.widget.after_cancel(self._after)
            except tk.TclError:
                pass
            self._after = None

    def _show(self) -> None:
        if self.tip or not self.text:
            return
        try:
            x = self.widget.winfo_rootx() + self.widget.winfo_width() // 2
            y = self.widget.winfo_rooty() + self.widget.winfo_height() + 10
        except tk.TclError:
            return
        self.tip = tk.Toplevel(self.widget)
        self.tip.wm_overrideredirect(True)
        self.tip.attributes("-topmost", True)
        self.tip.configure(bg=LINE)
        tk.Label(
            self.tip, text=self.text, bg=BG_RAISED, fg=TEXT,
            font=ui_font(self.widget, 8), padx=9, pady=5,
        ).pack(padx=1, pady=1)
        self.tip.update_idletasks()
        self.tip.wm_geometry(f"+{max(0, x - self.tip.winfo_width() // 2)}+{y}")

    def _hide(self, _e=None) -> None:
        self._cancel()
        if self.tip:
            try:
                self.tip.destroy()
            except tk.TclError:
                pass
            self.tip = None
