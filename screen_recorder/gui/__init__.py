from typing import Optional

from .bar import RecorderBar


def run_app(output_dir: Optional[str] = None) -> None:
    RecorderBar(output_dir=output_dir).mainloop()
