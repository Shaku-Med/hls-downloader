from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Optional, Sequence, Tuple


def which(name: str) -> Optional[str]:
    return shutil.which(name)


def has_command(name: str) -> bool:
    return which(name) is not None


def run_probe(argv: Sequence[str], timeout: float = 20.0) -> Tuple[bool, str]:
    try:
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            check=False,
        )
    except FileNotFoundError:
        return False, "command not found"
    except subprocess.TimeoutExpired:
        return False, "timed out"
    except OSError as exc:
        return False, str(exc)

    out = ((completed.stdout or "") + (completed.stderr or "")).strip()
    return completed.returncode == 0, out


def python_executable() -> str:
    return sys.executable


def has_python() -> bool:
    ok, _ = run_probe([python_executable(), "--version"])
    return ok


def has_pip() -> bool:
    ok, _ = run_probe([python_executable(), "-m", "pip", "--version"])
    return ok


def has_ffmpeg() -> bool:
    return has_command("ffmpeg")


def has_ytdlp() -> bool:
    ok, _ = run_probe([python_executable(), "-m", "yt_dlp", "--version"])
    return ok


def has_deno() -> bool:
    return has_command("deno")


def has_node() -> bool:
    return has_command("node")


def has_winget() -> bool:
    return has_command("winget")


def has_choco() -> bool:
    return has_command("choco")


def has_brew() -> bool:
    return has_command("brew")


def has_apt() -> bool:
    return has_command("apt-get") or has_command("apt")


def has_js_runtime() -> bool:
    return has_deno() or has_node()
