"""
System audio capture on Windows, straight against the Core Audio API.

ffmpeg has no loopback input on Windows. Its only audio input is DirectShow,
which can capture microphones but not what is coming out of the speakers, and
the usual workarounds all need something installed first: Stereo Mix enabled in
the sound control panel where the driver still offers it, or a virtual cable.
Neither is present on a typical machine.

So the capture is done here instead, through WASAPI loopback, which every
Windows 10 and 11 machine supports with nothing installed. It is reached with
ctypes rather than a package, so the recorder keeps needing only the standard
library. The frames are handed to ffmpeg through a pipe, see pipe.py.
"""

from __future__ import annotations

import array
import ctypes
import threading
import time
from ctypes import POINTER, byref, c_int, c_uint64, c_void_p, cast
from ctypes.wintypes import DWORD, LPCWSTR, UINT, WORD
from typing import Callable, Optional, Tuple

_ole32 = ctypes.windll.ole32 if hasattr(ctypes, "windll") else None

# COM plumbing ─────────────────────────────────────────────────────────────
CLSCTX_ALL = 0x17
COINIT_MULTITHREADED = 0x0
AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2
REFTIMES_PER_SEC = 10_000_000

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE

# How long the level meter takes to fall back to zero, in seconds.
PEAK_FALL = 0.4


class _GUID(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("d1", DWORD), ("d2", WORD), ("d3", WORD), ("d4", ctypes.c_ubyte * 8)]


def _guid(text: str) -> _GUID:
    g = _GUID()
    _ole32.CLSIDFromString(LPCWSTR(text), byref(g))
    return g


class WAVEFORMATEX(ctypes.Structure):
    # Windows lays this out as exactly 18 bytes. Left to itself ctypes would pad
    # it to 20 for alignment, which silently shifts every field of the extended
    # struct below and turns the format GUID into nonsense.
    _pack_ = 1
    _fields_ = [
        ("wFormatTag", WORD),
        ("nChannels", WORD),
        ("nSamplesPerSec", DWORD),
        ("nAvgBytesPerSec", DWORD),
        ("nBlockAlign", WORD),
        ("wBitsPerSample", WORD),
        ("cbSize", WORD),
    ]


class WAVEFORMATEXTENSIBLE(ctypes.Structure):
    """The mix format is virtually always this, with a sub format GUID."""

    _pack_ = 1
    _fields_ = [
        ("Format", WAVEFORMATEX),
        ("wValidBitsPerSample", WORD),
        ("dwChannelMask", DWORD),
        ("SubFormat", _GUID),
    ]


def _method(ptr, index: int, restype, *argtypes):
    """Bind one entry of a COM vtable so it can be called."""
    vt = cast(ptr, POINTER(POINTER(c_void_p)))[0]
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vt[index])


def _check(hr: int, what: str) -> None:
    if hr < 0:
        raise OSError(f"{what} failed (0x{hr & 0xFFFFFFFF:08X})")


def _release(ptr) -> None:
    if ptr and ptr.value:
        try:
            _method(ptr, 2, ctypes.c_ulong)(ptr)
        except Exception:
            pass
        ptr.value = None


class AudioFormat:
    """What the endpoint hands us, in the terms ffmpeg wants."""

    def __init__(self, sample_rate: int, channels: int, ffmpeg_format: str, block_align: int):
        self.sample_rate = sample_rate
        self.channels = channels
        self.ffmpeg_format = ffmpeg_format
        self.block_align = block_align

    @property
    def is_float(self) -> bool:
        return self.ffmpeg_format == "f32le"

    def __repr__(self) -> str:
        return (
            f"AudioFormat({self.sample_rate}Hz, {self.channels}ch, "
            f"{self.ffmpeg_format})"
        )


def _describe(fmt_ptr) -> AudioFormat:
    f = fmt_ptr.contents
    tag = f.wFormatTag
    bits = f.wBitsPerSample
    if tag == WAVE_FORMAT_EXTENSIBLE and f.cbSize >= 22:
        ext = cast(fmt_ptr, POINTER(WAVEFORMATEXTENSIBLE)).contents
        # Only the first field separates float from integer PCM.
        tag = WAVE_FORMAT_IEEE_FLOAT if ext.SubFormat.d1 == 3 else WAVE_FORMAT_PCM
    if tag == WAVE_FORMAT_IEEE_FLOAT and bits == 32:
        name = "f32le"
    elif tag == WAVE_FORMAT_PCM and bits == 16:
        name = "s16le"
    elif tag == WAVE_FORMAT_PCM and bits == 32:
        name = "s32le"
    elif tag == WAVE_FORMAT_PCM and bits == 24:
        name = "s24le"
    else:
        raise OSError(f"Unsupported endpoint format (tag {tag}, {bits} bit)")
    return AudioFormat(f.nSamplesPerSec, f.nChannels, name, f.nBlockAlign)


def probe_format() -> Optional[AudioFormat]:
    """The default playback device's mix format, or None if there is none."""
    try:
        cap = LoopbackCapture()
        fmt = cap.open()
        cap.close()
        return fmt
    except Exception:
        return None


class LoopbackCapture:
    """
    One WASAPI loopback session on the default playback device.

    Loopback delivers nothing at all while the device is idle rather than
    delivering silence, so a caller that needs a continuous stream has to pad
    the gaps itself. run() does that, which is what keeps audio lined up with
    video when nothing is playing for a while.
    """

    def __init__(self) -> None:
        self._enum = c_void_p()
        self._device = c_void_p()
        self._client = c_void_p()
        self._capture = c_void_p()
        self._fmt_ptr = None
        self.format: Optional[AudioFormat] = None
        self._com_ready = False
        self._started = False
        self._peak = 0.0
        self._peak_at = 0.0
        self._stop = threading.Event()

    # ── setup ──
    def open(self) -> AudioFormat:
        hr = _ole32.CoInitializeEx(None, COINIT_MULTITHREADED)
        # S_OK and S_FALSE both mean we added a reference, so we owe an
        # uninitialise. RPC_E_CHANGED_MODE means COM was already running here in
        # another mode: still usable, but it is not ours to tear down. Tk sets
        # up an apartment on the main thread, and uninitialising that from under
        # it wedges the whole app.
        self._com_ready = hr >= 0

        _check(
            _ole32.CoCreateInstance(
                byref(_guid("{BCDE0395-E52F-467C-8E3D-C4579291692E}")),
                None,
                CLSCTX_ALL,
                byref(_guid("{A95664D2-9614-4F35-A746-DE8DB63617E6}")),
                byref(self._enum),
            ),
            "Opening the audio device list",
        )

        # GetDefaultAudioEndpoint(eRender, eConsole, **device)
        _check(
            _method(self._enum, 4, ctypes.HRESULT, c_int, c_int, POINTER(c_void_p))(
                self._enum, 0, 0, byref(self._device)
            ),
            "Finding the default speakers",
        )

        _check(
            _method(self._device, 3, ctypes.HRESULT, c_void_p, DWORD, c_void_p, POINTER(c_void_p))(
                self._device,
                byref(_guid("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")),
                CLSCTX_ALL,
                None,
                byref(self._client),
            ),
            "Opening the audio client",
        )

        self._fmt_ptr = POINTER(WAVEFORMATEX)()
        _check(
            _method(self._client, 8, ctypes.HRESULT, POINTER(POINTER(WAVEFORMATEX)))(
                self._client, byref(self._fmt_ptr)
            ),
            "Reading the audio format",
        )
        self.format = _describe(self._fmt_ptr)
        return self.format

    def start(self) -> None:
        if self._started:
            return
        _check(
            _method(
                self._client, 3, ctypes.HRESULT, c_int, DWORD, c_uint64, c_uint64,
                POINTER(WAVEFORMATEX), c_void_p,
            )(
                self._client,
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                REFTIMES_PER_SEC,   # one second of buffer
                0,
                self._fmt_ptr,
                None,
            ),
            "Starting loopback capture",
        )
        _check(
            _method(self._client, 14, ctypes.HRESULT, c_void_p, POINTER(c_void_p))(
                self._client,
                byref(_guid("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")),
                byref(self._capture),
            ),
            "Opening the capture service",
        )
        _check(_method(self._client, 10, ctypes.HRESULT)(self._client), "Start")
        self._started = True

    # ── capture ──
    def run(self, sink: Callable[[bytes], bool]) -> None:
        """
        Pump audio into `sink` in real time until stop() or the sink says stop.

        Gaps where nothing is playing are filled with silence so that one second
        of wall clock is always one second of audio, which is what keeps the
        finished file in sync.
        """
        assert self.format is not None
        fmt = self.format
        get_buffer = _method(
            self._capture, 3, ctypes.HRESULT,
            POINTER(POINTER(ctypes.c_byte)), POINTER(UINT), POINTER(DWORD),
            POINTER(c_uint64), POINTER(c_uint64),
        )
        release_buffer = _method(self._capture, 4, ctypes.HRESULT, UINT)
        next_packet = _method(self._capture, 5, ctypes.HRESULT, POINTER(UINT))

        silence_block = bytes(fmt.block_align * 480)  # 10ms
        started_at = time.monotonic()
        frames_out = 0

        while not self._stop.is_set():
            n = UINT()
            if next_packet(self._capture, byref(n)) < 0:
                break

            if n.value:
                data = POINTER(ctypes.c_byte)()
                frames = UINT()
                flags = DWORD()
                if get_buffer(self._capture, byref(data), byref(frames), byref(flags), None, None) < 0:
                    break
                count = frames.value
                if count:
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT:
                        chunk = bytes(count * fmt.block_align)
                    else:
                        chunk = ctypes.string_at(data, count * fmt.block_align)
                        self._note_peak(self._measure(chunk, fmt))
                    if not sink(chunk):
                        release_buffer(self._capture, count)
                        return
                    frames_out += count
                release_buffer(self._capture, count)
                continue

            # Nothing queued: top up with silence so the timeline keeps moving.
            expected = int((time.monotonic() - started_at) * fmt.sample_rate)
            behind = expected - frames_out
            if behind >= 480:
                pad = min(behind, fmt.sample_rate)  # never dump more than a second
                whole, rest = divmod(pad, 480)
                for _ in range(whole):
                    if not sink(silence_block):
                        return
                if rest and not sink(bytes(rest * fmt.block_align)):
                    return
                frames_out += pad
            else:
                self._stop.wait(0.004)

    @staticmethod
    def _measure(chunk: bytes, fmt: AudioFormat) -> float:
        """
        Rough peak for the level meter.

        Sampled rather than exhaustive because this runs on every buffer, and
        via array rather than ctypes because a bytes object cannot be cast to a
        pointer, which is a quiet way to get a meter that never moves.
        """
        try:
            if fmt.is_float:
                width, code, scale = 4, "f", 1.0
            elif fmt.ffmpeg_format == "s16le":
                width, code, scale = 2, "h", 32768.0
            elif fmt.ffmpeg_format == "s32le":
                width, code, scale = 4, "i", 2147483648.0
            else:
                return 0.0
            count = len(chunk) // width
            if not count:
                return 0.0
            values = array.array(code)
            values.frombytes(chunk[: count * width])
            step = max(1, count // 64)
            peak = max(abs(values[i]) for i in range(0, count, step)) / scale
            return min(1.0, peak)
        except Exception:
            return 0.0

    def _note_peak(self, value: float) -> None:
        """Rise instantly, fall gradually, the way a level meter should."""
        if value >= self.peak:
            self._peak = value
            self._peak_at = time.monotonic()

    @property
    def peak(self) -> float:
        """
        Current level with decay.

        Loopback goes quiet between packets rather than streaming zeroes, so a
        meter that reset on every empty poll would read zero almost always. The
        last peak falls away over PEAK_FALL instead.
        """
        if self._peak <= 0.0:
            return 0.0
        age = time.monotonic() - self._peak_at
        if age >= PEAK_FALL:
            return 0.0
        return self._peak * (1.0 - age / PEAK_FALL)

    # ── teardown ──
    def stop(self) -> None:
        self._stop.set()

    def close(self) -> None:
        self.stop()
        if self._started:
            try:
                _method(self._client, 11, ctypes.HRESULT)(self._client)
            except Exception:
                pass
            self._started = False
        _release(self._capture)
        _release(self._client)
        _release(self._device)
        _release(self._enum)
        if self._fmt_ptr:
            try:
                _ole32.CoTaskMemFree(self._fmt_ptr)
            except Exception:
                pass
            self._fmt_ptr = None
        if self._com_ready:
            try:
                _ole32.CoUninitialize()
            except Exception:
                pass
            self._com_ready = False


def available() -> Tuple[bool, str]:
    """Whether system audio can be captured here, and why not when it cannot."""
    if _ole32 is None:
        return False, "This only works on Windows."
    fmt = probe_format()
    if fmt is None:
        return False, "No playback device was found to record from."
    return True, ""
