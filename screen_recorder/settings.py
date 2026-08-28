from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional

from .paths import default_output_dir, settings_file

# Quality presets map to what ffmpeg actually does, rather than vague labels.
#
# All of them encode fast. In a screen recorder the encoder is competing with
# the capture for the same CPU, and every cycle it takes is a frame gdigrab does
# not get. Measured over 8 seconds of 1080p30, out of 240 frames:
#
#   ultrafast   240 captured, none dropped
#   superfast   239, 1 dropped
#   veryfast    237, 3 dropped
#   faster      234, 6 dropped
#
# So quality is carried by the CRF, not by a slower preset. The old "smaller
# file" setting used "faster", which is slower than "veryfast" in x264's naming
# and made the cheapest looking option the most likely to stutter.
QUALITY_PRESETS = {
    "high": {"label": "High (crisp, larger files)", "crf": 18, "preset": "ultrafast"},
    "balanced": {"label": "Balanced", "crf": 23, "preset": "ultrafast"},
    "small": {"label": "Smaller file", "crf": 28, "preset": "superfast"},
}

FPS_CHOICES = [24, 30, 60]


@dataclass
class Settings:
    output_dir: str = ""
    quality: str = "high"
    fps: int = 30
    # "screen" | "region"
    source: str = "screen"
    display_index: int = 0
    region: Optional[Dict[str, int]] = None
    # What you hear. On by default: a screen recording with no sound is almost
    # never what someone wanted, and this is the whole point on protected sites.
    record_system: bool = True
    record_mic: bool = False
    mic_device: str = ""
    countdown: bool = True
    countdown_seconds: int = 3
    capture_cursor: bool = True

    def normalized(self) -> "Settings":
        if self.quality not in QUALITY_PRESETS:
            self.quality = "high"
        if self.fps not in FPS_CHOICES:
            self.fps = 30
        if self.source not in ("screen", "region"):
            self.source = "screen"
        if not self.output_dir:
            self.output_dir = str(default_output_dir())
        self.countdown_seconds = max(0, min(10, int(self.countdown_seconds or 0)))
        return self


def load() -> Settings:
    path = settings_file()
    if not path.is_file():
        return Settings().normalized()
    try:
        raw: Dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Settings().normalized()
    known = {f for f in Settings().__dict__}
    return Settings(**{k: v for k, v in raw.items() if k in known}).normalized()


def save(settings: Settings) -> bool:
    try:
        settings_file().write_text(
            json.dumps(asdict(settings), indent=2), encoding="utf-8"
        )
        return True
    except OSError:
        return False
