from __future__ import annotations

from typing import Dict, List

from . import detect, osinfo
from .models import Package
from .platform_cmds import (
    deno_plans,
    ffmpeg_plans,
    node_plans,
    package_manager_hint,
    python_plans,
    ytdlp_plans,
)


def _has_pkg_manager() -> bool:
    return bool(osinfo.available_managers())


def _pkg_manager_summary() -> str:
    found = osinfo.available_managers()
    if found:
        return f"Found: {', '.join(found)}."
    return "winget/Chocolatey on Windows, Homebrew on macOS, apt/dnf/pacman/zypper/apk on Linux."


def build_catalog() -> List[Package]:
    packages: List[Package] = [
        Package(
            id="python",
            title=f"Python {'.'.join(str(p) for p in osinfo.MIN_PYTHON)}+",
            summary="Runs the Stuff Grabber helper and installs yt-dlp.",
            required=True,
            detect=detect.has_python,
            prerequisites=("pkg_manager",),
            build_plans=python_plans,
            missing_hint=osinfo.manual_python_steps(),
        ),
        Package(
            id="pip",
            title="pip",
            summary="Python package installer used for yt-dlp.",
            required=True,
            detect=detect.has_pip,
            prerequisites=("python",),
            build_plans=lambda: [],
            missing_hint="Reinstall Python and include pip, or repair the current Python install.",
        ),
        Package(
            id="pkg_manager",
            title="Package manager",
            summary=_pkg_manager_summary(),
            required=False,
            detect=_has_pkg_manager,
            build_plans=lambda: [],
            missing_hint=package_manager_hint(),
        ),
        Package(
            id="ffmpeg",
            title="ffmpeg",
            summary="Needed for HLS, DASH, and remux downloads.",
            required=True,
            detect=detect.has_ffmpeg,
            prerequisites=("pkg_manager",),
            build_plans=ffmpeg_plans,
            missing_hint=package_manager_hint(),
        ),
        Package(
            id="ytdlp",
            title="yt-dlp",
            summary="Needed for YouTube, Apple Music pages, Spotify, and other social sites.",
            required=True,
            detect=detect.has_ytdlp,
            prerequisites=("python", "pip"),
            build_plans=ytdlp_plans,
            missing_hint="Python and pip must work before yt-dlp can install.",
        ),
        Package(
            id="deno",
            title="Deno",
            summary="Optional JavaScript runtime that helps yt-dlp with YouTube.",
            required=False,
            detect=detect.has_deno,
            prerequisites=("pkg_manager",),
            build_plans=deno_plans,
            missing_hint=package_manager_hint()
            + " Node can be used instead if you prefer.",
        ),
        Package(
            id="node",
            title="Node.js",
            summary="Optional JavaScript runtime that helps yt-dlp with YouTube.",
            required=False,
            detect=detect.has_node,
            prerequisites=("pkg_manager",),
            build_plans=node_plans,
            missing_hint=package_manager_hint()
            + " Deno can be used instead if you prefer.",
        ),
    ]
    return packages


def catalog_by_id() -> Dict[str, Package]:
    return {item.id: item for item in build_catalog()}
