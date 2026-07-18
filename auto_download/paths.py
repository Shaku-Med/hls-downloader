from __future__ import annotations

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent
ASSET_DIR = PROJECT_ROOT / "asset"


def app_icon_path() -> Path:
    for name in ("icon-32.png", "icon-48.png", "icon-128.png", "icon.png"):
        candidate = ASSET_DIR / name
        if candidate.is_file():
            return candidate
    return ASSET_DIR / "icon.png"
