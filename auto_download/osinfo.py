from __future__ import annotations

import platform
import shutil
import sys
from typing import Dict, List, Optional, Tuple

WINDOWS = "windows"
MACOS = "macos"
LINUX = "linux"

# yt-dlp needs 3.9 or newer, so that is the floor for the whole toolchain.
MIN_PYTHON: Tuple[int, int] = (3, 9)

_WINDOWS_MANAGERS = ("winget", "choco")
_MACOS_MANAGERS = ("brew", "port")
_LINUX_MANAGERS = ("apt-get", "apt", "dnf", "yum", "pacman", "zypper", "apk")


def os_family() -> str:
    if sys.platform.startswith("win"):
        return WINDOWS
    if sys.platform == "darwin":
        return MACOS
    return LINUX


def is_windows() -> bool:
    return os_family() == WINDOWS


def is_macos() -> bool:
    return os_family() == MACOS


def is_linux() -> bool:
    return os_family() == LINUX


def _os_release() -> Dict[str, str]:
    fields: Dict[str, str] = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as handle:
            for line in handle:
                key, sep, value = line.partition("=")
                if sep:
                    fields[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return {}
    return fields


def linux_distro() -> str:
    fields = _os_release()
    return fields.get("PRETTY_NAME") or fields.get("NAME") or "Linux"


def arch() -> str:
    return platform.machine() or "unknown"


def os_label() -> str:
    family = os_family()
    if family == WINDOWS:
        return f"Windows {platform.release()} ({arch()})"
    if family == MACOS:
        version = platform.mac_ver()[0] or platform.release()
        return f"macOS {version} ({arch()})"
    return f"{linux_distro()} ({arch()})"


def manager_candidates() -> Tuple[str, ...]:
    family = os_family()
    if family == WINDOWS:
        return _WINDOWS_MANAGERS
    if family == MACOS:
        return _MACOS_MANAGERS
    return _LINUX_MANAGERS


def available_managers() -> List[str]:
    return [name for name in manager_candidates() if shutil.which(name)]


def preferred_manager() -> Optional[str]:
    found = available_managers()
    return found[0] if found else None


def manager_path(name: str) -> Optional[str]:
    return shutil.which(name)


def install_help_url() -> str:
    family = os_family()
    if family == WINDOWS:
        return "https://www.python.org/downloads/windows/"
    if family == MACOS:
        return "https://www.python.org/downloads/macos/"
    return "https://www.python.org/downloads/source/"


def manual_python_steps() -> str:
    family = os_family()
    if family == WINDOWS:
        return (
            "Install Python yourself:\n"
            "  1. Open https://www.python.org/downloads/windows/\n"
            "  2. Download the latest stable Windows installer (64 bit).\n"
            "  3. Run it and tick 'Add python.exe to PATH' on the first screen.\n"
            "  4. Close every terminal, open a new one, then run:  python --version"
        )
    if family == MACOS:
        return (
            "Install Python yourself:\n"
            "  1. Install Homebrew from https://brew.sh if you do not have it.\n"
            "  2. Run:  brew install python\n"
            "  3. Or download the latest macOS installer from "
            "https://www.python.org/downloads/macos/\n"
            "  4. Open a new terminal, then run:  python3 --version"
        )
    return (
        "Install Python yourself with your distribution's package manager:\n"
        "  Debian or Ubuntu:  sudo apt-get install -y python3 python3-pip\n"
        "  Fedora or RHEL:    sudo dnf install -y python3 python3-pip\n"
        "  Arch:              sudo pacman -S --noconfirm python python-pip\n"
        "  openSUSE:          sudo zypper install -y python3 python3-pip\n"
        "  Alpine:            sudo apk add --no-cache python3 py3-pip\n"
        "Then open a new terminal and run:  python3 --version"
    )
