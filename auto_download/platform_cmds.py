from __future__ import annotations

import os
import re
import shutil
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from . import detect, osinfo
from .models import CommandPlan

_WINGET_PYTHON_FALLBACK = "Python.Python.3.13"

# manager -> (subcommand + assume-yes flags, extra env)
_LINUX_SPECS: Dict[str, Tuple[Tuple[str, ...], Dict[str, str]]] = {
    "apt-get": (("install", "-y"), {"DEBIAN_FRONTEND": "noninteractive"}),
    "apt": (("install", "-y"), {"DEBIAN_FRONTEND": "noninteractive"}),
    "dnf": (("install", "-y"), {}),
    "yum": (("install", "-y"), {}),
    "pacman": (("-S", "--noconfirm"), {}),
    "zypper": (("--non-interactive", "install"), {}),
    "apk": (("add", "--no-cache"), {}),
}


def _maybe_sudo() -> List[str]:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return []
    return ["sudo"] if shutil.which("sudo") else []


def _linux_install(
    packages: Mapping[str, Sequence[str]],
    label: str,
) -> Optional[CommandPlan]:
    for name in osinfo.available_managers():
        spec = _LINUX_SPECS.get(name)
        path = osinfo.manager_path(name)
        if not spec or not path:
            continue
        names = packages.get(name) or packages.get("default") or ()
        if not names:
            continue
        verb, env = spec
        return CommandPlan(
            label=label.format(manager=name),
            argv=[*_maybe_sudo(), path, *verb, *names],
            env=dict(env) if env else None,
        )
    return None


def _latest_winget_python_id() -> str:
    winget = detect.which("winget")
    if not winget:
        return _WINGET_PYTHON_FALLBACK
    ok, out = detect.run_probe(
        [
            winget,
            "search",
            "--id",
            "Python.Python.",
            "--source",
            "winget",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        timeout=90.0,
    )
    if not ok or not out:
        return _WINGET_PYTHON_FALLBACK
    best: Optional[Tuple[int, int]] = None
    for match in re.finditer(r"Python\.Python\.(\d+)\.(\d+)", out):
        version = (int(match.group(1)), int(match.group(2)))
        if version[0] == 3 and (best is None or version > best):
            best = version
    return f"Python.Python.{best[0]}.{best[1]}" if best else _WINGET_PYTHON_FALLBACK


def _winget_install(package_id: str, label: str) -> Optional[CommandPlan]:
    winget = detect.which("winget")
    if not winget:
        return None
    return CommandPlan(
        label=label,
        argv=[
            winget,
            "install",
            "--id",
            package_id,
            "-e",
            "--source",
            "winget",
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ],
    )


def _choco_install(package: str, label: str) -> Optional[CommandPlan]:
    choco = detect.which("choco")
    if not choco:
        return None
    return CommandPlan(
        label=label,
        argv=[choco, "install", package, "-y", "--no-progress"],
    )


def _brew_install(package: str, label: str) -> Optional[CommandPlan]:
    brew = detect.which("brew")
    if not brew:
        return None
    return CommandPlan(
        label=label,
        argv=[brew, "install", package],
        env={"NONINTERACTIVE": "1"},
    )


def python_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    family = osinfo.os_family()

    if family == osinfo.WINDOWS:
        package_id = _latest_winget_python_id()
        plan = _winget_install(package_id, f"Install latest Python ({package_id}) with winget")
        if plan:
            plans.append(plan)
        plan = _choco_install("python", "Install latest Python with Chocolatey")
        if plan:
            plans.append(plan)
        return plans

    if family == osinfo.MACOS:
        plan = _brew_install("python", "Install latest Python with Homebrew")
        if plan:
            plans.append(plan)
        return plans

    plan = _linux_install(
        {
            "apt-get": ("python3", "python3-pip", "python3-venv"),
            "apt": ("python3", "python3-pip", "python3-venv"),
            "pacman": ("python", "python-pip"),
            "apk": ("python3", "py3-pip"),
            "default": ("python3", "python3-pip"),
        },
        "Install Python 3 with {manager}",
    )
    if plan:
        plans.append(plan)
    return plans


def ffmpeg_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    family = osinfo.os_family()

    if family == osinfo.WINDOWS:
        plan = _winget_install("Gyan.FFmpeg", "Install ffmpeg with winget")
        if plan:
            plans.append(plan)
        plan = _choco_install("ffmpeg", "Install ffmpeg with Chocolatey")
        if plan:
            plans.append(plan)
        return plans

    if family == osinfo.MACOS:
        plan = _brew_install("ffmpeg", "Install ffmpeg with Homebrew")
        if plan:
            plans.append(plan)
        return plans

    plan = _linux_install({"default": ("ffmpeg",)}, "Install ffmpeg with {manager}")
    if plan:
        plans.append(plan)
    return plans


def ytdlp_plans() -> List[CommandPlan]:
    argv = detect.helper_python_argv()
    return [
        CommandPlan(
            label="Install yt-dlp with pip",
            argv=[*argv, "-m", "pip", "install", "-U", "yt-dlp"],
        )
    ]


def deno_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    family = osinfo.os_family()

    if family == osinfo.WINDOWS:
        plan = _winget_install("DenoLand.Deno", "Install Deno with winget")
        if plan:
            plans.append(plan)
        return plans

    if family == osinfo.MACOS:
        plan = _brew_install("deno", "Install Deno with Homebrew")
        if plan:
            plans.append(plan)
        return plans

    plan = _linux_install({"pacman": ("deno",), "apk": ("deno",)}, "Install Deno with {manager}")
    if plan:
        plans.append(plan)
    return plans


def node_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    family = osinfo.os_family()

    if family == osinfo.WINDOWS:
        plan = _winget_install("OpenJS.NodeJS.LTS", "Install Node.js LTS with winget")
        if plan:
            plans.append(plan)
        plan = _choco_install("nodejs-lts", "Install Node.js LTS with Chocolatey")
        if plan:
            plans.append(plan)
        return plans

    if family == osinfo.MACOS:
        plan = _brew_install("node", "Install Node.js with Homebrew")
        if plan:
            plans.append(plan)
        return plans

    plan = _linux_install(
        {"pacman": ("nodejs", "npm"), "default": ("nodejs",)},
        "Install Node.js with {manager}",
    )
    if plan:
        plans.append(plan)
    return plans


def package_manager_hint() -> str:
    family = osinfo.os_family()
    if family == osinfo.WINDOWS:
        return "Install winget (App Installer from the Microsoft Store) or Chocolatey first."
    if family == osinfo.MACOS:
        return "Install Homebrew first from https://brew.sh"
    return "No supported package manager found (apt, dnf, pacman, zypper, or apk)."
