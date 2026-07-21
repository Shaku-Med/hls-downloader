from __future__ import annotations

import tkinter as tk
from tkinter import messagebox, ttk
from typing import Optional

from ..models import CommandPlan


def ask_run_command(parent: tk.Misc, plan: CommandPlan) -> bool:
    dialog = tk.Toplevel(parent)
    dialog.title("Allow this command?")
    dialog.transient(parent)
    dialog.grab_set()
    dialog.resizable(True, True)

    frame = ttk.Frame(dialog, padding=16)
    frame.grid(row=0, column=0, sticky="nsew")
    dialog.columnconfigure(0, weight=1)
    dialog.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    frame.rowconfigure(2, weight=1)

    ttk.Label(
        frame,
        text="Stuff Grabber wants to run this command on your computer.",
        wraplength=460,
    ).grid(row=0, column=0, sticky="w", pady=(0, 8))

    ttk.Label(frame, text=plan.label, font=("", 10, "bold")).grid(
        row=1, column=0, sticky="w", pady=(0, 6)
    )

    text = tk.Text(frame, height=6, width=72, wrap="word")
    text.grid(row=2, column=0, sticky="nsew")
    text.insert("1.0", plan.display())
    text.configure(state="disabled")

    ttk.Label(
        frame,
        text="Only approve commands you understand. Nothing runs until you click Allow.",
        wraplength=460,
    ).grid(row=3, column=0, sticky="w", pady=(10, 12))

    result = {"ok": False}

    def on_allow() -> None:
        result["ok"] = True
        dialog.destroy()

    def on_deny() -> None:
        result["ok"] = False
        dialog.destroy()

    buttons = ttk.Frame(frame)
    buttons.grid(row=4, column=0, sticky="e")
    ttk.Button(buttons, text="Deny", command=on_deny).grid(row=0, column=0, padx=(0, 8))
    ttk.Button(buttons, text="Allow", command=on_allow).grid(row=0, column=1)

    dialog.protocol("WM_DELETE_WINDOW", on_deny)
    dialog.wait_window()
    return bool(result["ok"])


def show_error(parent: tk.Misc, title: str, message: str) -> None:
    messagebox.showerror(title, message, parent=parent)


def _readonly_text(parent: tk.Misc, content: str, height: int) -> tk.Text:
    box = tk.Text(parent, height=height, width=88, wrap="word")
    box.insert("1.0", content)
    box.configure(state="disabled")
    return box


def show_install_failure(
    parent: tk.Misc,
    title: str,
    summary: str,
    details: str,
    manual_steps: str,
    log_path: Optional[str],
) -> None:
    dialog = tk.Toplevel(parent)
    dialog.title(title)
    dialog.transient(parent)
    dialog.grab_set()

    frame = ttk.Frame(dialog, padding=16)
    frame.grid(row=0, column=0, sticky="nsew")
    dialog.columnconfigure(0, weight=1)
    dialog.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    frame.rowconfigure(2, weight=1)
    frame.rowconfigure(5, weight=1)

    ttk.Label(frame, text=summary, wraplength=620, font=("", 10, "bold")).grid(
        row=0, column=0, sticky="w", pady=(0, 10)
    )

    ttk.Label(frame, text="Error log").grid(row=1, column=0, sticky="w")
    _readonly_text(frame, details or "No output was captured.", 10).grid(
        row=2, column=0, sticky="nsew", pady=(4, 10)
    )

    if log_path:
        ttk.Label(
            frame,
            text=f"Saved to: {log_path}",
            wraplength=620,
        ).grid(row=3, column=0, sticky="w", pady=(0, 10))

    ttk.Label(frame, text="What to do yourself").grid(row=4, column=0, sticky="w")
    _readonly_text(frame, manual_steps, 8).grid(
        row=5, column=0, sticky="nsew", pady=(4, 12)
    )

    ttk.Button(frame, text="Close", command=dialog.destroy).grid(row=6, column=0, sticky="e")
    dialog.protocol("WM_DELETE_WINDOW", dialog.destroy)
    dialog.wait_window()


def show_info(parent: tk.Misc, title: str, message: str) -> None:
    messagebox.showinfo(title, message, parent=parent)


def choose_plan(parent: tk.Misc, plans: list[CommandPlan]) -> Optional[CommandPlan]:
    if not plans:
        return None
    if len(plans) == 1:
        return plans[0]

    dialog = tk.Toplevel(parent)
    dialog.title("Choose install method")
    dialog.transient(parent)
    dialog.grab_set()

    frame = ttk.Frame(dialog, padding=16)
    frame.grid(row=0, column=0, sticky="nsew")

    ttk.Label(frame, text="More than one install command is available.").grid(
        row=0, column=0, sticky="w", pady=(0, 10)
    )

    choice = tk.IntVar(value=0)
    for index, plan in enumerate(plans):
        ttk.Radiobutton(
            frame,
            text=f"{plan.label}\n{plan.display()}",
            variable=choice,
            value=index,
        ).grid(row=index + 1, column=0, sticky="w", pady=4)

    picked: dict[str, Optional[CommandPlan]] = {"plan": None}

    def on_ok() -> None:
        picked["plan"] = plans[choice.get()]
        dialog.destroy()

    def on_cancel() -> None:
        picked["plan"] = None
        dialog.destroy()

    buttons = ttk.Frame(frame)
    buttons.grid(row=len(plans) + 2, column=0, sticky="e", pady=(12, 0))
    ttk.Button(buttons, text="Cancel", command=on_cancel).grid(
        row=0, column=0, padx=(0, 8)
    )
    ttk.Button(buttons, text="Continue", command=on_ok).grid(row=0, column=1)

    dialog.protocol("WM_DELETE_WINDOW", on_cancel)
    dialog.wait_window()
    return picked["plan"]
