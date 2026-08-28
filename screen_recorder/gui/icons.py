"""
Vector icons drawn straight onto a Canvas.

Emoji glyphs render as boxes or wildly different shapes depending on the font
the system happens to pick, so every icon here is drawn from primitives. That
also keeps them crisp at any scale and correctly coloured for each state.
"""

from __future__ import annotations

import math
import tkinter as tk
from typing import List


def _r(canvas: tk.Canvas, x1, y1, x2, y2, **kw) -> int:
    return canvas.create_rectangle(x1, y1, x2, y2, **kw)


def rounded_rect(
    canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, radius: float,
    steps: int = 10, **kw
) -> int:
    """
    A rounded rectangle, with the corners walked as real arcs.

    Canvas has no rounded rectangle. Feeding the corner points to a smoothed
    polygon is the usual trick, but the spline cuts inside the corner and never
    reaches a true quarter circle, so a shape asking for a full pill comes back
    looking like a mildly rounded box. Plotting the arcs gives the radius that
    was actually asked for, which matters most at the pill end of the range.
    """
    radius = max(0.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
    if radius <= 0:
        return canvas.create_polygon([x1, y1, x2, y1, x2, y2, x1, y2], **kw)

    pts: List[float] = []
    # Centre and starting angle of each corner, clockwise from the top right.
    for cx, cy, start in (
        (x2 - radius, y1 + radius, -90),
        (x2 - radius, y2 - radius, 0),
        (x1 + radius, y2 - radius, 90),
        (x1 + radius, y1 + radius, 180),
    ):
        for i in range(steps + 1):
            a = math.radians(start + 90.0 * i / steps)
            pts += [cx + radius * math.cos(a), cy + radius * math.sin(a)]
    return canvas.create_polygon(pts, smooth=False, **kw)


def draw(canvas: tk.Canvas, name: str, cx: float, cy: float, size: float, color: str) -> List[int]:
    """Draw one icon centred on (cx, cy). Returns the item ids created."""
    s = size / 2.0
    w = max(1.6, size * 0.11)   # stroke weight that still reads when small
    ids: List[int] = []

    if name == "record":
        ids.append(canvas.create_oval(cx - s, cy - s, cx + s, cy + s, fill=color, outline=""))

    elif name == "stop":
        q = s * 0.82
        ids.append(rounded_rect(canvas, cx - q, cy - q, cx + q, cy + q, q * 0.28, fill=color, outline=""))

    elif name == "screen":
        ids.append(rounded_rect(canvas, cx - s, cy - s * 0.82, cx + s, cy + s * 0.42,
                                s * 0.22, outline=color, width=w, fill=""))
        ids.append(canvas.create_line(cx - s * 0.42, cy + s * 0.86, cx + s * 0.42, cy + s * 0.86,
                                      fill=color, width=w, capstyle="round"))
        ids.append(canvas.create_line(cx, cy + s * 0.42, cx, cy + s * 0.86, fill=color, width=w))

    elif name == "region":
        # Corner brackets read as "select an area" more clearly than a dashed box.
        arm = s * 0.62
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            x, y = cx + sx * s, cy + sy * s
            ids.append(canvas.create_line(x, y, x - sx * arm, y, fill=color, width=w, capstyle="round"))
            ids.append(canvas.create_line(x, y, x, y - sy * arm, fill=color, width=w, capstyle="round"))

    elif name == "window":
        back = s * 0.96
        ids.append(rounded_rect(canvas, cx - back, cy - back, cx + back * 0.34, cy + back * 0.34,
                                back * 0.22, outline=color, width=w, fill=""))
        ids.append(rounded_rect(canvas, cx - back * 0.34, cy - back * 0.34, cx + back, cy + back,
                                back * 0.22, outline=color, width=w, fill=""))

    elif name == "mic":
        cap_w, cap_h = s * 0.46, s * 0.72
        ids.append(rounded_rect(canvas, cx - cap_w, cy - s * 0.92, cx + cap_w, cy + cap_h * 0.2,
                                cap_w, fill=color, outline=""))
        ids.append(canvas.create_arc(cx - s * 0.72, cy - s * 0.34, cx + s * 0.72, cy + s * 0.74,
                                     start=200, extent=140, style="arc", outline=color, width=w))
        ids.append(canvas.create_line(cx, cy + s * 0.74, cx, cy + s * 1.0, fill=color, width=w, capstyle="round"))

    elif name in ("mic-off", "mic_off"):
        cap_w, cap_h = s * 0.46, s * 0.72
        ids.append(rounded_rect(canvas, cx - cap_w, cy - s * 0.92, cx + cap_w, cy + cap_h * 0.2,
                                cap_w, fill=color, outline=""))
        ids.append(canvas.create_arc(cx - s * 0.72, cy - s * 0.34, cx + s * 0.72, cy + s * 0.74,
                                     start=200, extent=140, style="arc", outline=color, width=w))
        ids.append(canvas.create_line(cx, cy + s * 0.74, cx, cy + s * 1.0, fill=color, width=w, capstyle="round"))
        # The slash reads as "off" at a glance, which a colour change alone does not.
        ids.append(canvas.create_line(cx - s * 0.95, cy - s * 1.05, cx + s * 0.95, cy + s * 1.05,
                                      fill=color, width=w * 1.15, capstyle="round"))

    elif name in ("speaker", "speaker-off", "speaker_off"):
        mouth = cx - s * 0.18
        cone = [
            cx - s * 0.92, cy - s * 0.3, cx - s * 0.46, cy - s * 0.3,
            mouth, cy - s * 0.88, mouth, cy + s * 0.88,
            cx - s * 0.46, cy + s * 0.3, cx - s * 0.92, cy + s * 0.3,
        ]
        ids.append(canvas.create_polygon(cone, fill=color, outline=color, width=w * 0.5,
                                         joinstyle="round"))
        if name == "speaker":
            for rad in (s * 0.44, s * 0.78):
                ids.append(canvas.create_arc(
                    mouth - rad, cy - rad, mouth + rad, cy + rad,
                    start=-52, extent=104, style="arc", outline=color, width=w,
                ))
        else:
            d, ox = s * 0.32, cx + s * 0.52
            ids.append(canvas.create_line(ox - d, cy - d, ox + d, cy + d,
                                          fill=color, width=w, capstyle="round"))
            ids.append(canvas.create_line(ox + d, cy - d, ox - d, cy + d,
                                          fill=color, width=w, capstyle="round"))

    elif name == "gear":
        teeth, outer, inner = 8, s * 0.98, s * 0.68
        pts = []
        for i in range(teeth * 2):
            ang = (math.pi / teeth) * i - math.pi / 2
            rad = outer if i % 2 == 0 else inner
            pts += [cx + rad * math.cos(ang), cy + rad * math.sin(ang)]
        ids.append(canvas.create_polygon(pts, fill=color, outline="", smooth=False))
        hole = s * 0.3
        # Punched centre: filled with the button's own background by the caller.
        ids.append(canvas.create_oval(cx - hole, cy - hole, cx + hole, cy + hole,
                                      fill="", outline="", tags="gear-hole"))

    elif name == "close":
        d = s * 0.66
        ids.append(canvas.create_line(cx - d, cy - d, cx + d, cy + d, fill=color, width=w, capstyle="round"))
        ids.append(canvas.create_line(cx + d, cy - d, cx - d, cy + d, fill=color, width=w, capstyle="round"))

    elif name == "chevron":
        # Points right, as on a settings row that opens a list of choices.
        d = s * 0.42
        ids.append(canvas.create_line(cx - d * 0.5, cy - d, cx + d * 0.5, cy,
                                      cx - d * 0.5, cy + d, fill=color, width=w,
                                      capstyle="round", joinstyle="round"))

    elif name == "check":
        ids.append(canvas.create_line(cx - s * 0.7, cy, cx - s * 0.15, cy + s * 0.55,
                                      cx + s * 0.72, cy - s * 0.6, fill=color, width=w * 1.1,
                                      capstyle="round", joinstyle="round"))

    elif name == "grip":
        dot = max(1.2, size * 0.085)
        for row in (-1, 0, 1):
            for col in (-1, 1):
                x, y = cx + col * size * 0.16, cy + row * size * 0.26
                ids.append(canvas.create_oval(x - dot, y - dot, x + dot, y + dot, fill=color, outline=""))

    elif name == "folder":
        ids.append(rounded_rect(canvas, cx - s, cy - s * 0.5, cx + s, cy + s * 0.78,
                                s * 0.2, outline=color, width=w, fill=""))
        ids.append(canvas.create_line(cx - s, cy - s * 0.5, cx - s * 0.3, cy - s * 0.5,
                                      cx - s * 0.05, cy - s * 0.82, cx + s * 0.4, cy - s * 0.82,
                                      fill=color, width=w, capstyle="round", joinstyle="round"))

    return ids


def gear_with_hole(canvas: tk.Canvas, cx: float, cy: float, size: float, color: str, hole_bg: str) -> List[int]:
    """A gear needs its centre filled with the surface behind it to read properly."""
    ids = draw(canvas, "gear", cx, cy, size, color)
    hole = (size / 2.0) * 0.34
    ids.append(canvas.create_oval(cx - hole, cy - hole, cx + hole, cy + hole, fill=hole_bg, outline=""))
    return ids
