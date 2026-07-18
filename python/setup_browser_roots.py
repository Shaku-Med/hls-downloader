"""
Create chromium/ and firefox/ extension roots.

Each folder has its own manifest.json. Shared assets (public, asset, style)
are linked from the repo root so we do not duplicate files.

  Chrome / Edge / Brave:  Load unpacked -> select the chromium/ folder
  Firefox:                Load Temporary Add-on -> pick any file inside firefox/
"""

from __future__ import annotations

import json
import os
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)

SHARED_DIRS = ("public", "asset", "style")

CHROMIUM_BACKGROUND = {"service_worker": "public/scripts/background.js"}
FIREFOX_BACKGROUND = {"scripts": ["public/scripts/background.js"]}
FIREFOX_GECKO = {
    "gecko": {
        "id": "stuff-grabber@local",
        "strict_min_version": "121.0",
    }
}

# Root-level manifests are legacy; browser folders are the load targets.
LEGACY_ROOT_MANIFESTS = (
    "manifest.json",
    "manifest.firefox.json",
    "manifest.chromium.json",
)


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _base_manifest() -> dict:
    candidates = [
        os.path.join(ROOT, "chromium", "manifest.json"),
        os.path.join(ROOT, "firefox", "manifest.json"),
        os.path.join(ROOT, "manifest.chromium.json"),
        os.path.join(ROOT, "manifest.json"),
        os.path.join(ROOT, "manifest.firefox.json"),
    ]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        data = _load_json(path)
        data.pop("browser_specific_settings", None)
        data.pop("applications", None)
        return data
    raise SystemExit("No template manifest found under the repo root.")


def _write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def _is_reparse_point(path: str) -> bool:
    if os.path.islink(path):
        return True
    if os.name == "nt" and os.path.isdir(path):
        try:
            import ctypes

            FILE_ATTRIBUTE_REPARSE_POINT = 0x400
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
            return attrs != -1 and bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)
        except Exception:
            return False
    return False


def _remove_link(path: str) -> None:
    if not (os.path.isdir(path) or os.path.islink(path)):
        return
    if os.name == "nt" and _is_reparse_point(path):
        os.rmdir(path)
        return
    if os.path.islink(path):
        os.unlink(path)
        return
    raise SystemExit(
        f"{path} exists as a real directory (not a link). Move it aside and re-run."
    )


def _link_shared(browser_dir: str, name: str) -> None:
    target = os.path.join(ROOT, name)
    link_path = os.path.join(browser_dir, name)
    if not os.path.isdir(target):
        raise SystemExit(f"Missing shared folder: {target}")

    if os.path.isdir(link_path) or os.path.islink(link_path):
        _remove_link(link_path)

    if os.name == "nt":
        r = subprocess.run(
            ["cmd", "/c", "mklink", "/J", link_path, target],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            raise SystemExit(
                f"Failed to create junction {link_path} -> {target}\n{r.stderr or r.stdout}"
            )
    else:
        os.symlink(target, link_path, target_is_directory=True)


def setup() -> None:
    base = _base_manifest()

    chromium_dir = os.path.join(ROOT, "chromium")
    firefox_dir = os.path.join(ROOT, "firefox")
    os.makedirs(chromium_dir, exist_ok=True)
    os.makedirs(firefox_dir, exist_ok=True)

    chromium_manifest = dict(base)
    chromium_manifest["background"] = dict(CHROMIUM_BACKGROUND)
    _write_json(os.path.join(chromium_dir, "manifest.json"), chromium_manifest)

    firefox_manifest = dict(base)
    firefox_manifest["background"] = dict(FIREFOX_BACKGROUND)
    firefox_manifest["browser_specific_settings"] = dict(FIREFOX_GECKO)
    _write_json(os.path.join(firefox_dir, "manifest.json"), firefox_manifest)

    for browser_dir in (chromium_dir, firefox_dir):
        for name in SHARED_DIRS:
            _link_shared(browser_dir, name)

    # Remove root manifests so nobody loads the wrong browser from the repo root.
    for name in LEGACY_ROOT_MANIFESTS:
        path = os.path.join(ROOT, name)
        if os.path.isfile(path):
            os.remove(path)

    print("Browser roots ready:")
    print(f"  Chromium -> {chromium_dir}")
    print(f"  Firefox  -> {firefox_dir}")
    print("")
    print("Chrome/Edge: Load unpacked -> select the chromium folder")
    print("Firefox:     about:debugging -> Load Temporary Add-on -> pick firefox/manifest.json")


if __name__ == "__main__":
    setup()
