from __future__ import annotations

import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent
ASSET_DIR = PROJECT_ROOT / "asset"
ERROR_LOG_NAME = "stuff-grabber-install-error.log"


def write_error_log(text: str) -> Optional[Path]:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"Stuff Grabber install error\n{stamp}\n\n{text.rstrip()}\n"
    for target in (PROJECT_ROOT / ERROR_LOG_NAME, Path(tempfile.gettempdir()) / ERROR_LOG_NAME):
        try:
            target.write_text(body, encoding="utf-8")
            return target
        except OSError:
            continue
    return None


def app_icon_path() -> Path:
    for name in ("icon-32.png", "icon-48.png", "icon-128.png", "icon.png"):
        candidate = ASSET_DIR / name
        if candidate.is_file():
            return candidate
    return ASSET_DIR / "icon.png"
