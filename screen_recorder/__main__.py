from __future__ import annotations

import sys

from . import main
from .platforms import has_ffmpeg


def _warn_no_ffmpeg() -> None:
    print("ffmpeg was not found on this computer.", file=sys.stderr)
    print("The recorder needs it to capture. Install it, then run this again:", file=sys.stderr)
    print("  Windows:  winget install Gyan.FFmpeg", file=sys.stderr)
    print("  macOS:    brew install ffmpeg", file=sys.stderr)
    print("  Linux:    sudo apt-get install -y ffmpeg", file=sys.stderr)


def _output_dir_arg(argv) -> str:
    """--output-dir lets the extension point recordings at its own save folder."""
    for i, a in enumerate(argv):
        if a == "--output-dir" and i + 1 < len(argv):
            return argv[i + 1].strip()
        if a.startswith("--output-dir="):
            return a.split("=", 1)[1].strip()
    return ""


if __name__ == "__main__":
    if not has_ffmpeg():
        # Still open: the settings window says the same thing in the UI.
        _warn_no_ffmpeg()
    main(_output_dir_arg(sys.argv[1:]))
