from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from .osinfo import MIN_PYTHON, is_windows

_PROBE_SNIPPET = "import sys;print('%d.%d.%d' % sys.version_info[:3]);print(sys.executable)"


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


@dataclass(frozen=True)
class PythonInfo:
    argv: Tuple[str, ...]
    version: Tuple[int, int, int]
    executable: str

    def command(self) -> str:
        return " ".join(self.argv)

    def version_text(self) -> str:
        return ".".join(str(part) for part in self.version)

    def display(self) -> str:
        return f"{self.command()} -> {self.executable} ({self.version_text()})"

    def meets(self, minimum: Tuple[int, int] = MIN_PYTHON) -> bool:
        return self.version[:2] >= minimum


def _candidate_argvs() -> List[Tuple[str, ...]]:
    if is_windows():
        return [("py", "-3"), ("python",), ("python3",)]
    return [("python3",), ("python",)]


def _probe_python(argv: Sequence[str]) -> Optional[PythonInfo]:
    ok, out = run_probe(list(argv) + ["-c", _PROBE_SNIPPET])
    if not ok or not out:
        return None
    lines = [line.strip() for line in out.strip().splitlines() if line.strip()]
    if len(lines) < 2:
        return None
    parts = lines[-2].split(".")
    if len(parts) < 3:
        return None
    try:
        version = (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    return PythonInfo(argv=tuple(argv), version=version, executable=lines[-1])


def _installed_python_paths() -> List[Path]:
    """Known install locations, checked because PATH is stale right after an install."""
    found: List[Path] = []
    if is_windows():
        roots = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python",
            Path(os.environ.get("PROGRAMFILES", "C:/Program Files")),
            Path("C:/"),
        ]
        for root in roots:
            if not root.is_dir():
                continue
            try:
                for child in sorted(root.glob("Python3*"), reverse=True):
                    exe = child / "python.exe"
                    if exe.is_file():
                        found.append(exe)
            except OSError:
                continue
        return found
    for base in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        directory = Path(base)
        if not directory.is_dir():
            continue
        try:
            for child in sorted(directory.glob("python3*"), reverse=True):
                if child.is_file() and os.access(child, os.X_OK):
                    found.append(child)
        except OSError:
            continue
    return found


def find_python(minimum: Tuple[int, int] = MIN_PYTHON) -> Optional[PythonInfo]:
    for argv in _candidate_argvs():
        if not which(argv[0]):
            continue
        info = _probe_python(argv)
        if info and info.meets(minimum):
            return info
    return None


def find_python_anywhere(minimum: Tuple[int, int] = MIN_PYTHON) -> Optional[PythonInfo]:
    found = find_python(minimum)
    if found:
        return found
    for path in _installed_python_paths():
        info = _probe_python([str(path)])
        if info and info.meets(minimum):
            return info
    return None


def helper_python(minimum: Tuple[int, int] = MIN_PYTHON) -> Optional[PythonInfo]:
    """The interpreter the native host will run, mirroring python/install.py.

    yt-dlp has to be installed into this one, not just any Python on PATH.
    """
    override = os.environ.get("HLS_GRABBER_PYTHON")
    if override and Path(override).is_file():
        info = _probe_python([override])
        if info and info.meets(minimum):
            return info
    for name in ("python3", "python"):
        path = which(name)
        if not path:
            continue
        info = _probe_python([path])
        if info and info.meets(minimum):
            return info
    return find_python(minimum)


def helper_python_argv() -> List[str]:
    info = helper_python()
    return list(info.argv) if info else [sys.executable]


def python_argv() -> List[str]:
    found = find_python()
    return list(found.argv) if found else [sys.executable]


def python_executable() -> str:
    found = find_python()
    return found.executable if found else sys.executable


def has_python() -> bool:
    return find_python() is not None


def has_pip() -> bool:
    ok, _ = run_probe(helper_python_argv() + ["-m", "pip", "--version"])
    return ok


def verify_python_install(minimum: Tuple[int, int] = MIN_PYTHON) -> Tuple[bool, str]:
    """Post install check: a new enough Python plus a working pip."""
    found = find_python_anywhere(minimum)
    want = ".".join(str(part) for part in minimum)
    if not found:
        return False, (
            f"No Python {want} or newer could be found after the install.\n"
            "PATH may not have picked it up yet."
        )

    lines = [f"Found Python {found.version_text()} at: {found.executable}"]
    if found.command() != found.executable:
        lines.append(f"Launched as: {found.command()}")
    if not found.meets(minimum):
        lines.append(f"That is older than the required {want}.")
        return False, "\n".join(lines)

    pip_ok, pip_out = run_probe(list(found.argv) + ["-m", "pip", "--version"])
    if not pip_ok:
        lines.append("pip is not working for that Python:")
        lines.append(pip_out or "no output")
        return False, "\n".join(lines)

    lines.append(f"pip is working: {pip_out.splitlines()[0] if pip_out else 'ok'}")
    return True, "\n".join(lines)


def has_ffmpeg() -> bool:
    return has_command("ffmpeg")


def has_ytdlp() -> bool:
    ok, _ = run_probe(helper_python_argv() + ["-m", "yt_dlp", "--version"])
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
