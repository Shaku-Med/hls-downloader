"""Native screen recorder with a floating control bar.

Captures through ffmpeg, which this project already depends on, so the app
itself needs nothing beyond the Python standard library.
"""

from .display import enable_dpi_awareness

# Before anything can import tkinter, or Tk caches the scaled screen size and
# every coordinate we hand ffmpeg is wrong on a scaled display.
enable_dpi_awareness()

__all__ = ["main"]


def main(output_dir: str = "") -> None:
    from .gui import run_app

    run_app(output_dir or None)
