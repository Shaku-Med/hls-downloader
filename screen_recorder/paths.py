from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent
ASSET_DIR = PROJECT_ROOT / "asset"

APP_NAME = "Stuff Grabber Recorder"


def config_dir() -> Path:
    """Per user config location, following each platform's convention."""
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    elif os.sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    path = Path(base) / "stuff-grabber-recorder"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return Path.home()
    return path


def settings_file() -> Path:
    return config_dir() / "settings.json"


def default_output_dir() -> Path:
    """Videos folder when there is one, otherwise the home directory."""
    for name in ("Videos", "Movies"):
        candidate = Path.home() / name
        if candidate.is_dir():
            return candidate / "Screen Recordings"
    return Path.home() / "Screen Recordings"


def app_icon_path() -> Path:
    for name in ("icon-48.png", "icon-32.png", "icon-128.png", "icon.png"):
        candidate = ASSET_DIR / name
        if candidate.is_file():
            return candidate
    return ASSET_DIR / "icon.png"
