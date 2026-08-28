"""
The floating control bar.

Laid out as labelled segments rather than a row of loose buttons, so related
controls sit together and read as groups: what to capture, what to listen to,
and everything else. It is frameless with real rounded corners, always on top,
and draggable by any part of itself that is not a button.

While recording it stays put and stays clickable, and on Windows it is kept out
of the capture, so Stop is always one click away without the bar appearing in
the video.
"""

from __future__ import annotations

import sys
import threading
import tkinter as tk
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from .. import audio, display, platforms, settings as settings_mod
from ..recorder import Recorder, Region, capture_looks_blank
from ..settings import Settings
from . import icons
from .overlay import CaptureOutline, CountdownOverlay
from .region import MIN_SIDE, RegionSelector, default_rect
from .theme import (
    ACCENT, BG, BG_RAISED, CHROMA, DANGER, FILL, FILL_HOVER, LINE, MUTED, OK, TEXT,
    IconButton, LevelMeter, PillButton, Tooltip, ui_font,
)

SOURCE_LABELS = {"screen": "Full screen", "region": "Area"}

BAR_H = 52
BTN = 34
ICON = 17
SMALL = 30
EDGE = 9          # padding at each end of the pill
GAP = 2           # between buttons inside a group
GROUP_GAP = 7     # either side of a separator
METER_GAP = 3
TIMER_W = 54
MARGIN_TOP = 24   # where the bar parks itself on first run


class RecorderBar(tk.Tk):
    def __init__(self, output_dir: Optional[str] = None) -> None:
        super().__init__()
        self.settings: Settings = settings_mod.load()
        if output_dir and output_dir.strip() != self.settings.output_dir:
            # The extension passes its own save folder so recordings land with
            # the rest of the downloads instead of somewhere separate.
            self.settings.output_dir = output_dir.strip()
            settings_mod.save(self.settings)

        self.recorder = Recorder()
        self.region: Optional[Region] = None
        if self.settings.region:
            r = self.settings.region
            saved = Region(r.get("x", 0), r.get("y", 0), r.get("width", 0), r.get("height", 0))
            if saved.width >= MIN_SIDE and saved.height >= MIN_SIDE:
                self.region = saved
        if self.settings.source == "region" and self.region is None:
            # The source says area but no usable area was ever stored, so there
            # would be no border and nothing to record: the app looks dead on
            # launch until you go and draw one. Start from the same box the
            # selector would offer instead.
            vx, vy, vw, vh = display.virtual_screen()
            x, y, w, h = default_rect(vw, vh)
            self.region = Region(vx + x, vy + y, w, h)

        self._drag: Optional[Tuple[int, int]] = None
        self._counting = False
        self._tick_job: Optional[str] = None
        self._meter_job: Optional[str] = None
        self._settings_win: Optional[tk.Toplevel] = None
        self._selector: Optional[RegionSelector] = None
        self._blank_answer: Optional[bool] = None
        self._system_ok, self._system_why = audio.supported()

        self.title("Screen recorder")
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self._rounded = self._enable_transparency()
        self.configure(bg=CHROMA if self._rounded else BG)

        self._build()
        self._place_initial()
        self.protocol("WM_DELETE_WINDOW", self._quit)
        self._hidden_from_capture = display.exclude_from_capture(self)
        # The outline is up from the moment the recorder opens, so what is about
        # to be captured is never a guess.
        self.outline = CaptureOutline(self)
        self._countdown_win: Optional[CountdownOverlay] = None
        self._sync_all()
        self._pump_meters()

    def _enable_transparency(self) -> bool:
        """Key out the corners so the pill is actually round, not a dark block."""
        if not sys.platform.startswith("win"):
            return False
        try:
            self.attributes("-transparentcolor", CHROMA)
            return True
        except tk.TclError:
            return False

    def _hide_from_capture(self, win: tk.Misc) -> None:
        if getattr(self, "_hidden_from_capture", False):
            display.exclude_from_capture(win)

    # ── layout ───────────────────────────────────────────────────────────
    def _build(self) -> None:
        self.canvas = tk.Canvas(
            self, height=BAR_H, bg=CHROMA if self._rounded else BG,
            highlightthickness=0, bd=0,
        )
        self.canvas.pack(fill="both", expand=True)

        x = EDGE

        self.grip = tk.Canvas(self.canvas, width=13, height=BTN, bg=BG,
                              highlightthickness=0, bd=0, cursor="fleur")
        icons.draw(self.grip, "grip", 6.5, BTN / 2, 15, MUTED)
        x = self._place(self.grip, x, 13) + 3
        Tooltip(self.grip, "Drag to move, or drag the bar itself")

        x = self._separator(x)

        # ── capture group ──
        self.record_btn = IconButton(
            self.canvas, "record", self._toggle_record, size=BTN, icon_size=ICON + 2,
            bg=BG, fill="", fill_hover=FILL, color=DANGER, tooltip="Start recording",
        )
        x = self._place(self.record_btn, x, BTN) + 1

        self.timer = tk.Label(self.canvas, text="00:00", bg=BG, fg=MUTED,
                              font=ui_font(self, 11, True), anchor="w", width=6)
        x = self._place(self.timer, x, TIMER_W)

        x = self._separator(x)

        # ── source group ──
        self.screen_btn = IconButton(self.canvas, "screen", lambda: self._set_source("screen"),
                                     size=SMALL, icon_size=ICON, bg=BG, tooltip="Whole screen")
        x = self._place(self.screen_btn, x, SMALL) + GAP
        self.region_btn = IconButton(self.canvas, "region", self._choose_region,
                                     size=SMALL, icon_size=ICON, bg=BG, tooltip="Choose an area")
        x = self._place(self.region_btn, x, SMALL)

        x = self._separator(x)

        # ── sound group ──
        self.system_btn = IconButton(self.canvas, "speaker", self._toggle_system,
                                     size=SMALL, icon_size=ICON, bg=BG,
                                     tooltip="Record what you hear")
        x = self._place(self.system_btn, x, SMALL) + METER_GAP
        self.system_meter = LevelMeter(self.canvas, height=20, bg=BG)
        x = self._place(self.system_meter, x, 5) + GAP + 4

        self.mic_btn = IconButton(self.canvas, "mic", self._toggle_mic,
                                  size=SMALL, icon_size=ICON, bg=BG,
                                  tooltip="Record the microphone")
        x = self._place(self.mic_btn, x, SMALL) + METER_GAP
        self.mic_meter = LevelMeter(self.canvas, height=20, bg=BG)
        x = self._place(self.mic_meter, x, 5)

        x = self._separator(x)

        self.settings_btn = IconButton(self.canvas, "gear", self._open_settings,
                                       size=SMALL, icon_size=ICON - 1, bg=BG, tooltip="Settings")
        x = self._place(self.settings_btn, x, SMALL) + GAP
        self.close_btn = IconButton(self.canvas, "close", self._quit,
                                    size=SMALL, icon_size=ICON - 3, bg=BG,
                                    fill_hover=DANGER, tooltip="Close")
        x = self._place(self.close_btn, x, SMALL)

        self._width = x + EDGE
        self.canvas.configure(width=self._width)
        self.geometry(f"{self._width}x{BAR_H}")
        self._paint_pill()
        self._bind_drag_surface()

    def _place(self, widget: tk.Widget, x: int, width: int) -> int:
        self.canvas.create_window(x, BAR_H // 2, window=widget, anchor="w")
        return x + width

    def _separator(self, x: int) -> int:
        x += GROUP_GAP
        self.canvas.create_line(x, 15, x, BAR_H - 15, fill="#48484a", width=1)
        return x + GROUP_GAP + 1

    def _paint_pill(self) -> None:
        """The pill sits behind everything, so draw it then push it to the back."""
        self.canvas.delete("pill")
        icons.rounded_rect(
            self.canvas, 1, 1, self._width - 1, BAR_H - 1, BAR_H / 2 - 1,
            fill=BG, outline=LINE, width=1, tags="pill",
        )
        self.canvas.tag_lower("pill")

    def _bind_drag_surface(self) -> None:
        """
        Anywhere that is not a control drags the bar.

        Making people aim for a small handle to move a window that floats over
        their work is needless precision, so the grip is only a hint about what
        the whole bar already does.
        """
        for widget in (self.canvas, self.grip, self.timer):
            widget.bind("<Button-1>", self._drag_start, add="+")
            widget.bind("<B1-Motion>", self._drag_move, add="+")
            widget.bind("<ButtonRelease-1>", self._drag_end, add="+")
        self.canvas.configure(cursor="fleur")
        self.timer.configure(cursor="fleur")

    def _place_initial(self) -> None:
        self.update_idletasks()
        x = (self.winfo_screenwidth() - self._width) // 2
        self.geometry(f"{self._width}x{BAR_H}+{max(0, x)}+{MARGIN_TOP}")

    # ── dragging ─────────────────────────────────────────────────────────
    def _drag_start(self, ev) -> None:
        self._drag = (ev.x_root - self.winfo_x(), ev.y_root - self.winfo_y())

    def _drag_move(self, ev) -> None:
        if not self._drag:
            return
        x, y = ev.x_root - self._drag[0], ev.y_root - self._drag[1]
        # Keep at least a sliver on screen so the bar can never be lost.
        max_x = self.winfo_screenwidth() - 60
        max_y = self.winfo_screenheight() - BAR_H
        self.geometry(f"+{max(-self._width + 60, min(x, max_x))}+{max(0, min(y, max_y))}")

    def _drag_end(self, _ev) -> None:
        self._drag = None

    # ── source ───────────────────────────────────────────────────────────
    def _set_source(self, source: str) -> None:
        if self._busy():
            return
        if self._selector is not None:
            # Finish choosing the area first, or the area box and the full
            # screen border end up drawn on top of each other.
            self._selector.cancel()
            self._selector = None
        self.settings.source = source
        settings_mod.save(self.settings)
        self._sync_all()

    def _choose_region(self) -> None:
        if self._busy():
            return
        if self._selector is not None:
            # Already choosing. Pressing the button again used to settle the box
            # and close, which threw away the overlay just as people pressed it
            # expecting to carry on adjusting. Keep it, and only make sure it is
            # still on top and taking input.
            self._selector.reopen()
            self.after(60, self._raise_bar)
            return
        # The bar stays up while the area is chosen. It used to hide itself,
        # which meant losing the controls at the exact moment you wanted them.
        self.outline.hide()

        def done(region: Optional[Region]) -> None:
            self._selector = None
            self.attributes("-topmost", True)
            self.lift()
            if region:
                self.region = region
                self.settings.source = "region"
                self.settings.region = {
                    "x": region.x, "y": region.y,
                    "width": region.width, "height": region.height,
                }
                settings_mod.save(self.settings)
            self._sync_all()

        self._selector = RegionSelector(self, self.region, done)
        # Repaint so the area button lights up straight away, and put the bar
        # back on top of the selector, which covers the screen.
        self._sync_all()
        self.after(60, self._raise_bar)

    def _raise_bar(self) -> None:
        try:
            self.attributes("-topmost", True)
            self.lift()
        except tk.TclError:
            pass

    # ── sound ────────────────────────────────────────────────────────────
    def _toggle_system(self) -> None:
        if self._busy():
            return
        if not self.settings.record_system and not self._system_ok:
            self._toast(self._system_why)
            return
        self.settings.record_system = not self.settings.record_system
        settings_mod.save(self.settings)
        self._sync_all()

    def _toggle_mic(self) -> None:
        if self._busy():
            return
        if not self.settings.record_mic:
            devices = platforms.list_audio_inputs()
            if not devices:
                self._toast("No microphone was found.")
                return
            if not self.settings.mic_device or self.settings.mic_device not in devices:
                self.settings.mic_device = devices[0]
        self.settings.record_mic = not self.settings.record_mic
        settings_mod.save(self.settings)
        self._sync_all()

    def _pump_meters(self) -> None:
        """Drive the level meters while recording, and idle cheaply when not."""
        recording = self.recorder.is_recording
        if recording and self.settings.record_system:
            self.system_meter.set_muted(False)
            self.system_meter.set_level(self.recorder.audio_peak)
        else:
            self.system_meter.set_muted(True)
        # The microphone goes straight into ffmpeg, so there is no level to read
        # back for it. It shows as armed rather than as a moving meter.
        self.mic_meter.set_muted(not (recording and self.settings.record_mic))
        if recording and self.settings.record_mic:
            self.mic_meter.set_level(0.55)
        self._meter_job = self.after(100 if recording else 400, self._pump_meters)

    # ── recording ────────────────────────────────────────────────────────
    def _toggle_record(self) -> None:
        if self.recorder.is_recording:
            self._stop()
            return
        # The area stays editable right up to this point, so take it now. This
        # also closes the selector, which covers the screen and would otherwise
        # end up in the recording.
        if self._selector is not None:
            self._selector.commit()
            self._selector = None

        if self._counting:
            if self._countdown_win:
                self._countdown_win.cancel()
            else:
                self._counting = False
                self._sync_all()
        elif self.settings.countdown and self.settings.countdown_seconds > 0:
            self._counting = True
            self.timer.configure(text="ready", fg=ACCENT)
            self._countdown_win = CountdownOverlay(
                self, self.settings.countdown_seconds,
                on_done=self._countdown_done, on_cancel=self._countdown_cancelled,
            )
        else:
            self._start()

    def _countdown_done(self) -> None:
        self._countdown_win = None
        self._counting = False
        self._start()

    def _countdown_cancelled(self) -> None:
        self._countdown_win = None
        self._counting = False
        self._sync_all()

    def _busy(self) -> bool:
        """
        True while a recording is running or about to start.

        Nothing is greyed out in that state. The bar has to stay usable so Stop
        is always one click away rather than something you have to remember a
        shortcut for, so the settings that cannot change mid take say so instead.
        """
        if self.recorder.is_recording:
            self._toast("Stop the recording first to change this.")
            return True
        return self._counting

    def _start(self) -> None:
        region = self.region if self.settings.source == "region" else None
        if self.settings.source == "region" and not region:
            self._toast("Choose an area first.")
            self._sync_all()
            return
        ok, msg = self.recorder.start(self.settings, region)
        if not ok:
            self._sync_all()
            self._toast(msg or "The recording could not be started.")
            return
        self.record_btn.configure_icon(icon="stop", fill=DANGER, fill_hover=DANGER, color=TEXT)
        self.record_btn.set_tooltip("Stop recording")
        # Red border for the whole take, so what is being captured stays
        # obvious, and it cannot be moved now that recording has begun.
        self.outline.show(self._capture_rect(), live=True)
        note = self.recorder.audio_note
        if note:
            self._toast(note)
        self._tick()
        # Check a few seconds in, once whatever is being recorded has had time
        # to draw, rather than letting someone film twenty minutes of black.
        self.after(4000, self._check_not_blank)

    def _check_not_blank(self) -> None:
        """
        Warn if the capture is coming through empty.

        The probe runs ffmpeg, so it goes on a thread to keep the bar
        responsive. The answer is picked up by polling from here rather than
        handed back with after(): tkinter calls are not thread safe, and
        scheduling one from the worker raises "main thread is not in main loop"
        where nobody sees it, leaving the warning silently dead.
        """
        if not self.recorder.is_recording:
            return
        region = self.region if self.settings.source == "region" else None
        settings = self.settings
        self._blank_answer: Optional[bool] = None

        def probe() -> None:
            self._blank_answer = capture_looks_blank(settings, region)

        threading.Thread(target=probe, name="blank-check", daemon=True).start()
        self.after(300, self._collect_blank, 40)

    def _collect_blank(self, tries_left: int) -> None:
        if not self.recorder.is_recording:
            return
        if self._blank_answer is None and tries_left > 0:
            self.after(300, self._collect_blank, tries_left - 1)
            return
        if self._blank_answer:
            self._warn_blank()

    def _warn_blank(self) -> None:
        if not self.recorder.is_recording:
            return
        self._toast(
            "Nothing is reaching the recording, so this will come out black. "
            "Sites that protect their video hand it straight to the graphics "
            "card, where screen recording cannot see it. Turn off hardware "
            "acceleration in the browser, restart it, then record again."
        )

    def _stop(self) -> None:
        if self._tick_job:
            self.after_cancel(self._tick_job)
            self._tick_job = None
        self.timer.configure(text="saving", fg=MUTED)
        self.update_idletasks()
        ok, msg = self.recorder.stop()
        self.record_btn.configure_icon(icon="record", fill="", fill_hover=FILL, color=DANGER)
        self.record_btn.set_tooltip("Start recording")
        self.outline.set_live(False)
        if ok:
            self.timer.configure(text="saved", fg=OK)
            self.after(2600, self._sync_all)
            SavedToast(self, Path(msg))
        else:
            self.timer.configure(text="failed", fg=DANGER)
            self._toast(msg or "The recording did not produce a file.")

    def _tick(self) -> None:
        if not self.recorder.is_recording:
            return
        secs = int(self.recorder.elapsed())
        self.timer.configure(text=f"{secs // 60:02d}:{secs % 60:02d}", fg=DANGER)
        self._tick_job = self.after(500, self._tick)

    # ── state to pixels ──────────────────────────────────────────────────
    def _sync_all(self) -> None:
        # While an area is being drawn, the area button is the active one even
        # though the source only changes when the box is settled. Without this
        # the full screen button stayed lit the whole time you were drawing.
        for name, btn in (("screen", self.screen_btn), ("region", self.region_btn)):
            picked = (name == "region") if self._selector else (self.settings.source == name)
            btn.configure_icon(
                fill=FILL if picked else "",
                fill_hover=FILL_HOVER if picked else FILL,
                color=TEXT if picked else MUTED,
            )
        self.region_btn.set_tooltip(
            f"Area {self.region.width} by {self.region.height}" if self.region else "Choose an area"
        )

        on = self.settings.record_system and self._system_ok
        self.system_btn.configure_icon(
            icon="speaker" if on else "speaker-off",
            fill=FILL if on else "", fill_hover=FILL_HOVER if on else FILL,
            color=TEXT if on else MUTED,
        )
        self.system_btn.set_tooltip(
            "Recording what you hear" if on
            else (self._system_why or "Sound from this computer is off")
        )

        mic_on = self.settings.record_mic
        self.mic_btn.configure_icon(
            icon="mic" if mic_on else "mic-off",
            fill=FILL if mic_on else "", fill_hover=FILL_HOVER if mic_on else FILL,
            color=TEXT if mic_on else MUTED,
        )
        self.mic_btn.set_tooltip(
            f"Microphone: {self.settings.mic_device}" if mic_on else "Record the microphone"
        )

        if not self.recorder.is_recording and not self._counting:
            self.timer.configure(text="00:00", fg=MUTED)

        if self._selector is None:
            self.outline.show(self._capture_rect(), live=self.recorder.is_recording)
        else:
            # The selector is drawing its own box over the whole screen. Two
            # borders at once is what made it unreadable.
            self.outline.hide()

    def _capture_rect(self) -> Optional[Tuple[int, int, int, int]]:
        """The area the outline should frame, for whichever source is chosen."""
        source = self.settings.source
        if source == "region":
            r = self.region
            return (r.x, r.y, r.width, r.height) if r else None
        # Full screen means the whole desktop, which is what ffmpeg captures.
        return display.virtual_screen()

    # ── windows ──────────────────────────────────────────────────────────
    def _open_settings(self) -> None:
        from .settings_window import SettingsWindow

        if self._settings_win is not None:
            try:
                if self._settings_win.winfo_exists():
                    self._settings_win.lift()
                    return
            except tk.TclError:
                pass
        self._settings_win = SettingsWindow(self, self.settings, self._on_settings_saved)

    def _on_settings_saved(self, updated: Settings) -> None:
        self.settings = updated
        settings_mod.save(self.settings)
        self._sync_all()

    def _toast(self, message: str) -> None:
        Notice(self, message)

    def _quit(self) -> None:
        if self.recorder.is_recording:
            self.recorder.stop()
        self.outline.destroy()
        if self._meter_job:
            try:
                self.after_cancel(self._meter_job)
            except tk.TclError:
                pass
        settings_mod.save(self.settings)
        self.destroy()


class _Popover(tk.Toplevel):
    """Shared chrome for the small cards that appear under the bar."""

    def __init__(self, master: tk.Misc) -> None:
        super().__init__(master)
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg=LINE)
        self.inner = tk.Frame(self, bg=BG_RAISED)
        self.inner.pack(padx=1, pady=1)
        display.exclude_from_capture(self)

    def place_under(self, master: tk.Misc) -> None:
        self.update_idletasks()
        try:
            x = master.winfo_rootx() + (master.winfo_width() - self.winfo_width()) // 2
            y = master.winfo_rooty() + master.winfo_height() + 10
        except tk.TclError:
            x, y = 120, 120
        self.geometry(f"+{max(0, x)}+{y}")

    def close(self) -> None:
        try:
            self.destroy()
        except tk.TclError:
            pass


class Notice(_Popover):
    def __init__(self, master: tk.Misc, message: str, seconds: float = 5.0) -> None:
        super().__init__(master)
        tk.Label(
            self.inner, text=message, bg=BG_RAISED, fg=TEXT, font=ui_font(master, 9),
            wraplength=330, justify="left", padx=14, pady=11,
        ).pack()
        self.place_under(master)
        self.after(int(seconds * 1000), self.close)
        self.bind("<Button-1>", lambda _e: self.close())


class SavedToast(_Popover):
    def __init__(self, master: tk.Misc, path: Path) -> None:
        super().__init__(master)
        row = tk.Frame(self.inner, bg=BG_RAISED)
        row.pack(padx=14, pady=11)
        text = tk.Frame(row, bg=BG_RAISED)
        text.pack(side="left", padx=(0, 14))
        tk.Label(text, text="Recording saved", bg=BG_RAISED, fg=TEXT,
                 font=ui_font(master, 9, True), anchor="w").pack(anchor="w")
        tk.Label(text, text=path.name, bg=BG_RAISED, fg=MUTED,
                 font=ui_font(master, 8), anchor="w").pack(anchor="w")
        PillButton(row, "Show", lambda: self._reveal(path), surface=BG_RAISED,
                   font=ui_font(master, 9), height=30).pack(side="left")
        self.place_under(master)
        self.after(9000, self.close)

    def _reveal(self, path: Path) -> None:
        platforms.reveal(path)
        self.close()
