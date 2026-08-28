"""
Settings, laid out as an iOS grouped list to match the extension.

Cards on a black page, hairline separators inset from the label, a value and a
chevron on anything that opens a list of choices, and pill switches instead of
tick boxes. ttk has none of that, so the cards and controls are drawn.
"""

from __future__ import annotations

import ctypes
import sys
import tkinter as tk
from dataclasses import replace
from tkinter import filedialog
from typing import Callable, List, Optional

from .. import audio, display, platforms
from ..settings import FPS_CHOICES, QUALITY_PRESETS, Settings
from . import icons
from .theme import (
    ACCENT, CHROMA, DANGER, FILL, FILL_HOVER, GROUPED, MUTED, PAGE, RADIUS,
    SEPARATOR, TEXT, PillButton, Switch, ui_font,
)

POPUP_BG = "#2c2c2e"

WIDTH = 396
PAD = 18            # page margin
ROW_H = 46
INSET = 16          # separators start here, as on iOS
VALUE_CHARS = 24    # a row value longer than this is shortened to fit


def elide(text: str, limit: int = VALUE_CHARS) -> str:
    """Shorten a value so it cannot run past its row and into the label."""
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def elide_path(text: str, limit: int = 34) -> str:
    """Paths lose their middle, since both ends carry the meaning."""
    text = str(text)
    if len(text) <= limit:
        return text
    keep = (limit - 3) // 2
    return text[:keep] + "…" + text[-keep:]


class Card(tk.Canvas):
    """
    One rounded group of rows.

    Rows are real widgets placed on a canvas that draws the rounded background
    behind them, since a tk.Frame cannot have rounded corners.
    """

    def __init__(self, master: tk.Misc, width: int) -> None:
        super().__init__(master, width=width, height=10, bg=PAGE,
                         highlightthickness=0, bd=0)
        # Not _w: tkinter stores the widget's Tcl path name there.
        self._card_w = width
        self._rows: List[tk.Widget] = []

    def add(self, row: tk.Widget) -> None:
        self._rows.append(row)

    def finish(self) -> None:
        height = ROW_H * len(self._rows)
        self.configure(height=height)
        icons.rounded_rect(self, 0, 0, self._card_w, height, RADIUS, fill=GROUPED, outline="")
        for i, row in enumerate(self._rows):
            y = i * ROW_H
            self.create_window(0, y, window=row, anchor="nw", width=self._card_w, height=ROW_H)
            if i:
                self.create_line(INSET, y, self._card_w, y, fill=SEPARATOR, width=1)


class Row(tk.Frame):
    """A label on the left, whatever the row offers on the right."""

    def __init__(self, master: tk.Misc, label: str) -> None:
        super().__init__(master, bg=GROUPED)
        self.label = tk.Label(self, text=label, bg=GROUPED, fg=TEXT,
                              font=ui_font(master, 10), anchor="w")
        self.label.pack(side="left", padx=(INSET, 8))

    def set_dimmed(self, dimmed: bool) -> None:
        self.label.configure(fg=MUTED if dimmed else TEXT)


class SwitchRow(Row):
    def __init__(self, master: tk.Misc, label: str, value: bool, command=None) -> None:
        super().__init__(master, label)
        self.switch = Switch(self, value, bg=GROUPED, command=command)
        self.switch.pack(side="right", padx=(0, INSET))

    def get(self) -> bool:
        return self.switch.get()


class ChoiceRow(Row):
    """
    A row that opens a list of choices, the way an iOS settings row does.

    A ttk.Combobox was used here before and looked like a Windows control
    dropped into an iOS panel, so the popup below is drawn to match.
    """

    def __init__(self, master: tk.Misc, label: str, values: List[str], initial: str) -> None:
        super().__init__(master, label)
        self._values = list(values) or [""]
        self._value = initial if initial in self._values else self._values[0]
        self.popup: Optional["ChoicePopup"] = None

        self.chevron = tk.Canvas(self, width=14, height=ROW_H, bg=GROUPED,
                                 highlightthickness=0, bd=0, cursor="hand2")
        icons.draw(self.chevron, "chevron", 7, ROW_H / 2, 13, MUTED)
        self.chevron.pack(side="right", padx=(4, INSET))

        self.value_label = tk.Label(self, text=elide(self._value), bg=GROUPED, fg=MUTED,
                                    font=ui_font(master, 10), anchor="e", cursor="hand2")
        self.value_label.pack(side="right")

        for w in (self, self.label, self.value_label, self.chevron):
            w.bind("<Button-1>", self._open)
        self.configure(cursor="hand2")

    def get(self) -> str:
        return self._value

    def set_values(self, values: List[str]) -> None:
        self._values = list(values) or [""]
        if self._value not in self._values:
            self._value = self._values[0]
            self.value_label.configure(text=elide(self._value))

    def _open(self, _e=None) -> None:
        # Only one list open at a time, so a second press does not stack them.
        if self.popup is not None:
            try:
                self.popup.destroy()
            except tk.TclError:
                pass
        self.popup = ChoicePopup(self, self._values, self._value, self._pick)

    def _pick(self, value: str) -> None:
        self._value = value
        self.value_label.configure(text=elide(value))


class ChoicePopup(tk.Toplevel):
    """
    The list of options, as a floating rounded panel with a tick.

    Drawn entirely on one canvas rather than built from child frames. Child
    widgets are rectangles, so a highlighted row would poke square corners out
    through the panel's rounded ones; canvas items can be rounded to match.
    """

    ROW_H = 36
    PANEL_PAD = 6
    TICK_W = 30

    def __init__(self, anchor: tk.Widget, values: List[str], current: str, on_pick) -> None:
        super().__init__(anchor)
        self.on_pick = on_pick
        self._values = values
        self._current = current
        self._hover_index: Optional[int] = None
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        display.exclude_from_capture(self)

        self._font = ui_font(anchor, 10)
        text_w = max((self._font.measure(v) for v in values), default=80)
        # Not _w / _h: those are tkinter's own widget path fields.
        self._panel_w = self.TICK_W + text_w + 26
        self._panel_h = self.ROW_H * len(values) + self.PANEL_PAD * 2

        # Keying the corners out is what makes them genuinely round instead of
        # round-looking on top of a square window.
        rounded = False
        if sys.platform.startswith("win"):
            try:
                self.attributes("-transparentcolor", CHROMA)
                rounded = True
            except tk.TclError:
                pass
        self.configure(bg=CHROMA if rounded else POPUP_BG)

        self.canvas = tk.Canvas(self, width=self._panel_w, height=self._panel_h,
                                bg=CHROMA if rounded else POPUP_BG,
                                highlightthickness=0, bd=0, cursor="hand2")
        self.canvas.pack()
        self.canvas.bind("<Motion>", self._motion)
        self.canvas.bind("<Leave>", lambda _e: self._set_hover(None))
        self.canvas.bind("<Button-1>", self._click)
        self._draw()

        self.update_idletasks()
        self._place_near(anchor)
        self.bind("<FocusOut>", lambda _e: self._close())
        self.after(10, self._take_focus)

    def _row_at(self, y: float) -> Optional[int]:
        i = int((y - self.PANEL_PAD) // self.ROW_H)
        return i if 0 <= i < len(self._values) else None

    def _draw(self) -> None:
        c = self.canvas
        c.delete("all")
        icons.rounded_rect(c, 0.5, 0.5, self._panel_w - 0.5, self._panel_h - 0.5, RADIUS,
                           fill=POPUP_BG, outline=SEPARATOR, width=1)
        for i, value in enumerate(self._values):
            y = self.PANEL_PAD + i * self.ROW_H
            if i == self._hover_index:
                icons.rounded_rect(c, 4, y + 1, self._panel_w - 4, y + self.ROW_H - 1,
                                   8, fill="#3a3a3c", outline="")
            if value == self._current:
                icons.draw(c, "check", self.TICK_W / 2 + 2, y + self.ROW_H / 2, 13, ACCENT)
            c.create_text(self.TICK_W + 4, y + self.ROW_H / 2, text=value, anchor="w",
                          fill=TEXT if value == self._current else "#e5e5ea",
                          font=self._font)

    def _set_hover(self, index: Optional[int]) -> None:
        if index == self._hover_index:
            return
        self._hover_index = index
        self._draw()

    def _motion(self, ev) -> None:
        self._set_hover(self._row_at(ev.y))

    def _click(self, ev) -> None:
        i = self._row_at(ev.y)
        if i is not None:
            self._choose(self._values[i])

    def _take_focus(self) -> None:
        try:
            self.focus_force()
        except tk.TclError:
            pass

    def _place_near(self, anchor: tk.Widget) -> None:
        try:
            x = anchor.winfo_rootx() + anchor.winfo_width() - self.winfo_width() - INSET
            y = anchor.winfo_rooty() + anchor.winfo_height()
        except tk.TclError:
            x, y = 200, 200
        # Keep it on screen when the row sits near the bottom.
        if y + self.winfo_height() > self.winfo_screenheight():
            y = anchor.winfo_rooty() - self.winfo_height()
        self.geometry(f"+{max(0, x)}+{max(0, y)}")

    def _choose(self, value: str) -> None:
        self.on_pick(value)
        self._close()

    def _close(self) -> None:
        try:
            self.destroy()
        except tk.TclError:
            pass


class SettingsWindow(tk.Toplevel):
    def __init__(self, master: tk.Misc, current: Settings, on_save: Callable[[Settings], None]) -> None:
        super().__init__(master)
        self.on_save = on_save
        self.current = current

        self.title("Screen recorder settings")
        self.configure(bg=PAGE)
        self.resizable(False, False)
        self.attributes("-topmost", True)
        self._use_dark_titlebar()
        display.exclude_from_capture(self)

        body = tk.Frame(self, bg=PAGE)
        body.pack(fill="both", expand=True, padx=PAD, pady=(PAD, 0))
        inner_w = WIDTH - PAD * 2

        # ── video ──
        self._group(body, "Video")
        card = Card(body, inner_w)
        self.quality = ChoiceRow(
            card, "Quality", [QUALITY_PRESETS[k]["label"] for k in QUALITY_PRESETS],
            QUALITY_PRESETS[current.quality]["label"],
        )
        card.add(self.quality)
        self.fps = ChoiceRow(card, "Frame rate", [f"{n} fps" for n in FPS_CHOICES],
                             f"{current.fps} fps")
        card.add(self.fps)

        displays = platforms.list_displays()
        self._display_labels = [d.label for d in displays] or ["Main display"]
        self._display_indexes = [d.index for d in displays] or [0]
        idx = (self._display_indexes.index(current.display_index)
               if current.display_index in self._display_indexes else 0)
        self.display = ChoiceRow(card, "Screen", self._display_labels, self._display_labels[idx])
        card.add(self.display)

        self.cursor_row = SwitchRow(card, "Show the mouse pointer", current.capture_cursor)
        card.add(self.cursor_row)
        card.finish()
        card.pack(fill="x")

        # ── audio ──
        self._group(body, "Audio")
        self._system_ok, system_why = audio.supported()
        card = Card(body, inner_w)
        self.system_row = SwitchRow(card, "Record what you hear",
                                    current.record_system and self._system_ok)
        if not self._system_ok:
            self.system_row.switch.set(False)
            self.system_row.switch.set_enabled(False)
            self.system_row.set_dimmed(True)
        card.add(self.system_row)

        mics = platforms.list_audio_inputs()
        self._mic_choices = mics or ["No microphone found"]
        self.mic_row = SwitchRow(card, "Record the microphone",
                                 current.record_mic and bool(mics),
                                 command=lambda _v: self._sync_mic_row())
        if not mics:
            self.mic_row.switch.set_enabled(False)
            self.mic_row.set_dimmed(True)
        card.add(self.mic_row)

        chosen = (current.mic_device if current.mic_device in self._mic_choices
                  else self._mic_choices[0])
        self.mic = ChoiceRow(card, "Input", self._mic_choices, chosen)
        card.add(self.mic)
        card.finish()
        card.pack(fill="x")
        if not self._system_ok:
            self._note(body, system_why)
        self._sync_mic_row()

        # ── countdown ──
        self._group(body, "Before recording")
        card = Card(body, inner_w)
        self.countdown_row = SwitchRow(card, "Count down first", current.countdown,
                                       command=lambda _v: self._sync_countdown_row())
        card.add(self.countdown_row)
        self.countdown_secs = ChoiceRow(
            card, "Count down for", [f"{n} seconds" for n in (1, 3, 5, 10)],
            f"{current.countdown_seconds} seconds"
            if current.countdown_seconds in (1, 3, 5, 10) else "3 seconds",
        )
        card.add(self.countdown_secs)
        card.finish()
        card.pack(fill="x")
        self._sync_countdown_row()

        # ── save location ──
        self._group(body, "Save recordings to")
        folder_card = Card(body, inner_w)
        row = tk.Frame(folder_card, bg=GROUPED)
        self._folder = current.output_dir
        # The button is packed first so the expanding label cannot squeeze it
        # off the edge of the row.
        PillButton(row, "Change", self._browse, bg=FILL, hover=FILL_HOVER,
                   surface=GROUPED, font=ui_font(self, 9), padx=14,
                   height=30).pack(side="right", padx=(8, INSET))
        self.folder_label = tk.Label(row, text=elide_path(self._folder), bg=GROUPED,
                                     fg=MUTED, font=ui_font(self, 9), anchor="w")
        self.folder_label.pack(side="left", padx=(INSET, 0), fill="x", expand=True)
        folder_card.add(row)
        folder_card.finish()
        folder_card.pack(fill="x")

        if not platforms.has_ffmpeg():
            self._note(body, "ffmpeg was not found, so recording will not start.", DANGER)

        footer = tk.Frame(self, bg=PAGE)
        footer.pack(fill="x", padx=PAD, pady=(PAD, PAD))
        PillButton(footer, "Save", self._save, bg=ACCENT, hover="#409cff",
                   fg=TEXT, surface=PAGE, font=ui_font(self, 10, True),
                   min_width=96, height=36).pack(side="right")
        PillButton(footer, "Cancel", self._close, bg=FILL, hover=FILL_HOVER,
                   surface=PAGE, font=ui_font(self, 10),
                   min_width=88, height=36).pack(side="right", padx=8)

        self.bind("<Escape>", lambda _e: self._close())
        self.update_idletasks()
        self.geometry(f"{WIDTH}x{self.winfo_reqheight()}")

    # ── pieces ──
    def _group(self, parent: tk.Misc, title: str) -> None:
        tk.Label(parent, text=title.upper(), bg=PAGE, fg=MUTED,
                 font=ui_font(self, 8, True), anchor="w").pack(
            fill="x", padx=(4, 0), pady=(16, 6))

    def _note(self, parent: tk.Misc, text: str, color: str = MUTED) -> None:
        """Explains a control that is unavailable, rather than leaving it dead."""
        tk.Label(parent, text=text, bg=PAGE, fg=color, font=ui_font(self, 8),
                 wraplength=WIDTH - PAD * 2 - 8, justify="left", anchor="w").pack(
            fill="x", padx=(4, 0), pady=(6, 0))

    def _sync_mic_row(self) -> None:
        """The input picker only means something once the microphone is on."""
        on = self.mic_row.get()
        self.mic.set_dimmed(not on)
        self.mic.value_label.configure(fg=MUTED if on else "#5a5a5e")

    def _sync_countdown_row(self) -> None:
        on = self.countdown_row.get()
        self.countdown_secs.set_dimmed(not on)
        self.countdown_secs.value_label.configure(fg=MUTED if on else "#5a5a5e")

    def _use_dark_titlebar(self) -> None:
        """Windows keeps a light title bar unless the window opts in."""
        if not sys.platform.startswith("win"):
            return
        try:
            self.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id()) or self.winfo_id()
            for attr in (20, 19):  # 20 on current Windows 10/11, 19 on older builds
                val = ctypes.c_int(1)
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                    hwnd, attr, ctypes.byref(val), ctypes.sizeof(val)
                ) == 0:
                    break
        except Exception:
            pass

    def _browse(self) -> None:
        chosen = filedialog.askdirectory(
            parent=self, title="Where should recordings go?",
            initialdir=self._folder or None,
        )
        if chosen:
            self._folder = chosen
            self.folder_label.configure(text=elide_path(chosen))

    def _save(self) -> None:
        quality = next(
            (k for k, v in QUALITY_PRESETS.items() if v["label"] == self.quality.get()),
            self.current.quality,
        )
        fps = int(self.fps.get().split()[0])
        try:
            display_index = self._display_indexes[self._display_labels.index(self.display.get())]
        except ValueError:
            display_index = self.current.display_index
        mic = self.mic.get()
        has_mic = mic != "No microphone found"
        updated = replace(
            self.current,
            quality=quality,
            fps=fps,
            display_index=display_index,
            capture_cursor=bool(self.cursor_row.get()),
            record_system=bool(self.system_row.get()) and self._system_ok,
            record_mic=bool(self.mic_row.get()) and has_mic,
            mic_device=mic if has_mic else "",
            countdown=bool(self.countdown_row.get()),
            countdown_seconds=int(self.countdown_secs.get().split()[0]),
            output_dir=self._folder.strip() or self.current.output_dir,
        ).normalized()
        self.on_save(updated)
        self._close()

    def _close(self) -> None:
        try:
            self.destroy()
        except tk.TclError:
            pass
