"""
A named pipe carrying captured audio into ffmpeg.

ffmpeg's stdin is already spoken for: stopping a recording writes "q" there so
ffmpeg finishes the file properly instead of being killed without an index. So
the audio takes its own channel, a Windows named pipe that ffmpeg opens as an
ordinary input.

Writing only starts once ffmpeg has opened its end. That is deliberate: the
first sample written becomes time zero for the audio stream, so tying it to the
moment ffmpeg opens the input keeps it lined up with the video rather than with
whenever our capture thread happened to warm up.
"""

from __future__ import annotations

import ctypes
import os
import threading
import time
from ctypes import wintypes
from typing import Optional

from .wasapi import AudioFormat, LoopbackCapture

_k32 = ctypes.windll.kernel32 if hasattr(ctypes, "windll") else None

PIPE_ACCESS_OUTBOUND = 0x00000002
PIPE_TYPE_BYTE = 0x00000000
ERROR_PIPE_CONNECTED = 535
ERROR_NO_DATA = 232
ERROR_BROKEN_PIPE = 109
GENERIC_READ = 0x80000000
OPEN_EXISTING = 3
_INVALID = ctypes.c_void_p(-1).value


class SystemAudioFeed:
    """
    Captures the speakers and serves the bytes to ffmpeg over a named pipe.

    Owns its own thread. Failures are recorded rather than raised: losing audio
    should never take the recording down with it, since a silent video still
    beats no video.
    """

    def __init__(self) -> None:
        self.name = r"\\.\pipe\sgrec_%d_%d" % (os.getpid(), int(time.time() * 1000) % 100000)
        self.format: Optional[AudioFormat] = None
        self.error: str = ""
        self._handle = None
        self._capture: Optional[LoopbackCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._connected = threading.Event()

    # ── lifecycle ──
    def open(self) -> AudioFormat:
        """Create the pipe and work out the format. Call before starting ffmpeg."""
        if _k32 is None:
            raise OSError("Named pipes are a Windows feature.")
        probe = LoopbackCapture()
        self.format = probe.open()
        probe.close()

        _k32.CreateNamedPipeW.restype = wintypes.HANDLE
        handle = _k32.CreateNamedPipeW(
            self.name,
            PIPE_ACCESS_OUTBOUND,
            PIPE_TYPE_BYTE,
            1,              # one client, ffmpeg
            1 << 20,        # generous buffers so a stalled reader does not drop audio
            1 << 20,
            0,
            None,
        )
        if not handle or handle == _INVALID:
            raise OSError("Could not create the audio pipe (%d)" % ctypes.get_last_error())
        self._handle = handle
        return self.format

    def start(self) -> None:
        """Wait for ffmpeg to connect, then pump audio until stopped."""
        self._thread = threading.Thread(target=self._serve, name="system-audio", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        try:
            ok = _k32.ConnectNamedPipe(self._handle, None)
            if not ok and ctypes.get_last_error() != ERROR_PIPE_CONNECTED:
                # ffmpeg never opened its end, usually because it failed to start.
                self.error = "ffmpeg did not open the audio pipe."
                return
            # stop() releases a pending connect by dialling our own pipe, so a
            # connection here does not necessarily mean ffmpeg is on the line.
            if self._stop.is_set():
                return
            self._connected.set()

            capture = LoopbackCapture()
            self._capture = capture
            capture.open()
            capture.start()
            capture.run(self._write)
        except Exception as e:
            self.error = str(e)
        finally:
            self._close_capture()
            self._close_pipe()

    def _write(self, chunk: bytes) -> bool:
        if self._stop.is_set() or self._handle is None:
            return False
        written = wintypes.DWORD()
        ok = _k32.WriteFile(self._handle, chunk, len(chunk), ctypes.byref(written), None)
        if not ok:
            err = ctypes.get_last_error()
            if err in (ERROR_NO_DATA, ERROR_BROKEN_PIPE):
                return False  # ffmpeg closed its end, which is the normal stop
            self.error = "Audio pipe write failed (%d)" % err
            return False
        return True

    def wait_connected(self, timeout: float = 5.0) -> bool:
        return self._connected.wait(timeout)

    def stop(self) -> None:
        self._stop.set()
        if self._capture:
            self._capture.stop()
        # A pending ConnectNamedPipe cannot be cancelled, and closing the handle
        # while a thread is blocked inside it deadlocks both. Connecting to our
        # own pipe completes the wait so the thread can see the stop flag and
        # unwind. This is the path taken whenever ffmpeg fails to start.
        if self._thread and self._thread.is_alive() and not self._connected.is_set():
            self._nudge()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self._close_capture()
        self._close_pipe()

    def _nudge(self) -> None:
        """Open and immediately drop a client connection, to release the server."""
        try:
            _k32.CreateFileW.restype = wintypes.HANDLE
            h = _k32.CreateFileW(self.name, GENERIC_READ, 0, None, OPEN_EXISTING, 0, None)
            if h and h != _INVALID:
                _k32.CloseHandle(h)
        except Exception:
            pass

    @property
    def peak(self) -> float:
        return self._capture.peak if self._capture else 0.0

    # ── cleanup ──
    def _close_capture(self) -> None:
        if self._capture:
            try:
                self._capture.close()
            except Exception:
                pass
            self._capture = None

    def _close_pipe(self) -> None:
        if self._handle is not None:
            try:
                _k32.CloseHandle(self._handle)
            except Exception:
                pass
            self._handle = None
