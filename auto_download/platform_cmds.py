from __future__ import annotations

import sys
from typing import List, Optional

from . import detect
from .models import CommandPlan


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
            "--accept-source-agreements",
            "--accept-package-agreements",
        ],
    )


def _choco_install(package: str, label: str) -> Optional[CommandPlan]:
    choco = detect.which("choco")
    if not choco:
        return None
    return CommandPlan(
        label=label,
        argv=[choco, "install", package, "-y"],
    )


def _brew_install(package: str, label: str) -> Optional[CommandPlan]:
    brew = detect.which("brew")
    if not brew:
        return None
    return CommandPlan(
        label=label,
        argv=[brew, "install", package],
    )


def _apt_install(package: str, label: str) -> Optional[CommandPlan]:
    apt = detect.which("apt-get") or detect.which("apt")
    if not apt:
        return None
    return CommandPlan(
        label=label,
        argv=["sudo", apt, "install", "-y", package],
    )


def python_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    if sys.platform == "win32":
        plan = _winget_install("Python.Python.3.12", "Install Python 3.12 with winget")
        if plan:
            plans.append(plan)
        return plans
    if sys.platform == "darwin":
        plan = _brew_install("python", "Install Python with Homebrew")
        if plan:
            plans.append(plan)
        return plans
    plan = _apt_install("python3", "Install Python 3 with apt")
    if plan:
        plans.append(plan)
    plan = _apt_install("python3-pip", "Install pip with apt")
    if plan:
        plans.append(plan)
    return plans


def ffmpeg_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    if sys.platform == "win32":
        plan = _winget_install("Gyan.FFmpeg", "Install ffmpeg with winget")
        if plan:
            plans.append(plan)
        plan = _choco_install("ffmpeg", "Install ffmpeg with Chocolatey")
        if plan:
            plans.append(plan)
        return plans
    if sys.platform == "darwin":
        plan = _brew_install("ffmpeg", "Install ffmpeg with Homebrew")
        if plan:
            plans.append(plan)
        return plans
    plan = _apt_install("ffmpeg", "Install ffmpeg with apt")
    if plan:
        plans.append(plan)
    return plans


def ytdlp_plans() -> List[CommandPlan]:
    py = detect.python_executable()
    return [
        CommandPlan(
            label="Install yt-dlp with pip",
            argv=[py, "-m", "pip", "install", "-U", "yt-dlp"],
        )
    ]


def deno_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    if sys.platform == "win32":
        plan = _winget_install("DenoLand.Deno", "Install Deno with winget")
        if plan:
            plans.append(plan)
        return plans
    if sys.platform == "darwin":
        plan = _brew_install("deno", "Install Deno with Homebrew")
        if plan:
            plans.append(plan)
        return plans
    return plans


def node_plans() -> List[CommandPlan]:
    plans: List[CommandPlan] = []
    if sys.platform == "win32":
        plan = _winget_install("OpenJS.NodeJS.LTS", "Install Node.js LTS with winget")
        if plan:
            plans.append(plan)
        plan = _choco_install("nodejs-lts", "Install Node.js LTS with Chocolatey")
        if plan:
            plans.append(plan)
        return plans
    if sys.platform == "darwin":
        plan = _brew_install("node", "Install Node.js with Homebrew")
        if plan:
            plans.append(plan)
        return plans
    plan = _apt_install("nodejs", "Install Node.js with apt")
    if plan:
        plans.append(plan)
    return plans


def package_manager_hint() -> str:
    if sys.platform == "win32":
        return "Install winget (App Installer from Microsoft Store) or Chocolatey first."
    if sys.platform == "darwin":
        return "Install Homebrew first from https://brew.sh"
    return "Install apt tools, or install the package manually."
