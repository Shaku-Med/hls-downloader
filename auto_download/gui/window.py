from __future__ import annotations

import threading
import tkinter as tk
from tkinter import ttk
from typing import List, Optional, Set

from .. import detect, osinfo
from ..executor import run_with_approval
from ..models import CommandPlan, InstallStatus, Package, PackageView
from ..paths import app_icon_path, write_error_log
from ..planner import evaluate_packages, installable_views
from .dialogs import (
    ask_run_command,
    choose_plan,
    show_error,
    show_info,
    show_install_failure,
)


def apply_app_icon(root: tk.Tk) -> Optional[tk.PhotoImage]:
    path = app_icon_path()
    if not path.is_file():
        return None
    try:
        image = tk.PhotoImage(file=str(path))
        root.iconphoto(True, image)
        return image
    except tk.TclError:
        return None


class AutoDownloadApp(ttk.Frame):
    def __init__(self, master: tk.Tk) -> None:
        super().__init__(master, padding=16)
        self.master = master
        self.views: List[PackageView] = []
        self._busy = False
        self._busy_pulse = 0
        self._failed = False
        self._rows: dict[str, dict] = {}

        master.title("Stuff Grabber Auto Download")
        master.minsize(760, 520)
        master.columnconfigure(0, weight=1)
        master.rowconfigure(0, weight=1)
        self.grid(row=0, column=0, sticky="nsew")
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)
        self.rowconfigure(4, weight=1)

        self._build_header()
        self._build_actions()
        self._build_package_list()
        self._build_log()
        self.refresh()

    def _build_header(self) -> None:
        header = ttk.Frame(self)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        header.columnconfigure(0, weight=1)
        ttk.Label(
            header,
            text="Auto Download",
            font=("", 16, "bold"),
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            header,
            text=(
                "Checks what Stuff Grabber needs, then installs missing tools. "
                "Every command is shown first. Nothing runs until you click Allow."
            ),
            wraplength=700,
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))
        self.system_label = ttk.Label(header, text=self._system_text(), wraplength=700)
        self.system_label.grid(row=2, column=0, sticky="w", pady=(6, 0))

    def _system_text(self) -> str:
        managers = osinfo.available_managers()
        manager_text = ", ".join(managers) if managers else "none found"
        found = detect.find_python()
        want = ".".join(str(part) for part in osinfo.MIN_PYTHON)
        if found:
            python_text = f"Python {found.version_text()} ({found.executable})"
        else:
            python_text = f"no Python {want}+ on PATH"
        return f"Detected: {osinfo.os_label()}  |  Package managers: {manager_text}  |  {python_text}"

    def _build_actions(self) -> None:
        actions = ttk.Frame(self)
        actions.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        self.refresh_btn = ttk.Button(actions, text="Refresh", command=self.refresh)
        self.refresh_btn.grid(row=0, column=0, padx=(0, 8))
        self.install_all_btn = ttk.Button(
            actions, text="Auto download missing", command=self.install_all_missing
        )
        self.install_all_btn.grid(row=0, column=1, padx=(0, 8))
        self.status_label = ttk.Label(actions, text="")
        self.status_label.grid(row=0, column=2, sticky="w")

    def _build_package_list(self) -> None:
        wrap = ttk.LabelFrame(self, text="Tools", padding=8)
        wrap.grid(row=2, column=0, sticky="nsew", pady=(0, 10))
        wrap.columnconfigure(0, weight=1)
        wrap.rowconfigure(0, weight=1)

        self.tree = ttk.Treeview(
            wrap,
            columns=("status", "required", "detail"),
            show="tree headings",
            height=10,
        )
        self.tree.heading("#0", text="Tool")
        self.tree.heading("status", text="Status")
        self.tree.heading("required", text="Need")
        self.tree.heading("detail", text="Details")
        self.tree.column("#0", width=140, stretch=False)
        self.tree.column("status", width=90, stretch=False)
        self.tree.column("required", width=80, stretch=False)
        self.tree.column("detail", width=420, stretch=True)
        self.tree.grid(row=0, column=0, sticky="nsew")

        scroll = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=scroll.set)

        row_actions = ttk.Frame(wrap)
        row_actions.grid(row=1, column=0, columnspan=2, sticky="e", pady=(8, 0))
        self.install_one_btn = ttk.Button(
            row_actions, text="Install selected", command=self.install_selected
        )
        self.install_one_btn.grid(row=0, column=0)

    def _build_log(self) -> None:
        wrap = ttk.LabelFrame(self, text="Log and errors", padding=8)
        wrap.grid(row=4, column=0, sticky="nsew")
        wrap.columnconfigure(0, weight=1)
        wrap.rowconfigure(0, weight=1)
        self.log = tk.Text(wrap, height=12, wrap="word")
        self.log.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(wrap, orient="vertical", command=self.log.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=scroll.set)

    def append_log(self, message: str) -> None:
        self.log.insert("end", message.rstrip() + "\n")
        self.log.see("end")

    def set_busy(self, busy: bool) -> None:
        self._busy = busy
        state = "disabled" if busy else "normal"
        self.refresh_btn.configure(state=state)
        self.install_all_btn.configure(state=state)
        self.install_one_btn.configure(state=state)
        if busy:
            self._busy_pulse = 0
            self.status_label.configure(text="Working...")
            self._pulse_busy_status()
        else:
            self.status_label.configure(text="")

    def _pulse_busy_status(self) -> None:
        if not self._busy:
            return
        dots = "." * ((self._busy_pulse % 3) + 1)
        self.status_label.configure(text=f"Working{dots} (see log for live output)")
        self._busy_pulse += 1
        self.master.after(700, self._pulse_busy_status)

    def refresh(self) -> None:
        if self._busy:
            return
        self.views = evaluate_packages()
        self.system_label.configure(text=self._system_text())
        for item in self.tree.get_children():
            self.tree.delete(item)
        self._rows.clear()
        for view in self.views:
            status = view.status.value
            need = "Required" if view.package.required else "Optional"
            item_id = self.tree.insert(
                "",
                "end",
                text=view.package.title,
                values=(status, need, view.detail),
            )
            self._rows[item_id] = {"view": view}
        ready = sum(1 for view in self.views if view.status == InstallStatus.READY)
        missing = sum(1 for view in self.views if view.status != InstallStatus.READY)
        self.status_label.configure(text=f"{ready} ready, {missing} not ready")
        js_ok = detect.has_js_runtime()
        if js_ok:
            self.append_log("JavaScript runtime found (Deno or Node).")
        else:
            self.append_log(
                "No JavaScript runtime found yet. Deno or Node is recommended for YouTube."
            )

    def _selected_view(self) -> Optional[PackageView]:
        selected = self.tree.selection()
        if not selected:
            return None
        row = self._rows.get(selected[0])
        if not row:
            return None
        return row["view"]

    def install_selected(self) -> None:
        view = self._selected_view()
        if not view:
            show_info(self.master, "Select a tool", "Click a tool in the list first.")
            return
        self._start_install([view])

    def install_all_missing(self) -> None:
        targets = installable_views(self.views)
        if not targets:
            blocked = [
                view
                for view in self.views
                if view.status in (InstallStatus.BLOCKED, InstallStatus.MISSING)
                and view.package.required
            ]
            if blocked:
                lines = [f"{view.package.title}: {view.detail}" for view in blocked]
                show_error(
                    self.master,
                    "Cannot auto download yet",
                    "Some required tools are blocked by missing prerequisites:\n\n"
                    + "\n".join(lines),
                )
            else:
                show_info(
                    self.master,
                    "All set",
                    "Nothing installable is missing right now.",
                )
            return
        self._start_install(targets)

    def _start_install(self, views: List[PackageView]) -> None:
        if self._busy:
            return
        self.set_busy(True)
        thread = threading.Thread(
            target=self._install_worker,
            args=(views,),
            daemon=True,
        )
        thread.start()

    def _approve(self, plan: CommandPlan) -> bool:
        box: dict[str, Optional[bool]] = {"value": None}
        event = threading.Event()

        def ask() -> None:
            box["value"] = ask_run_command(self.master, plan)
            event.set()

        self.master.after(0, ask)
        event.wait()
        return bool(box["value"])

    def _choose_plan(self, plans: List[CommandPlan]) -> Optional[CommandPlan]:
        box: dict[str, Optional[CommandPlan]] = {"value": None}
        event = threading.Event()

        def ask() -> None:
            box["value"] = choose_plan(self.master, plans)
            event.set()

        self.master.after(0, ask)
        event.wait()
        return box["value"]

    def _log_threadsafe(self, message: str) -> None:
        self.master.after(0, lambda: self.append_log(message))

    def _show_failure(
        self,
        title: str,
        summary: str,
        details: str,
        manual_steps: str,
        log_path: Optional[str],
    ) -> None:
        event = threading.Event()

        def show() -> None:
            show_install_failure(self.master, title, summary, details, manual_steps, log_path)
            event.set()

        self.master.after(0, show)
        event.wait()

    def _fail_and_stop(self, package: Package, details: str) -> None:
        if package.id == "python":
            manual = osinfo.manual_python_steps()
        else:
            manual = package.missing_hint or "Install this tool yourself, then run Auto Download again."
        managers = ", ".join(osinfo.available_managers()) or "none found"
        report = (
            f"Tool: {package.title}\n"
            f"System: {osinfo.os_label()}\n"
            f"Package managers: {managers}\n\n"
            f"{details}\n\n{manual}"
        )
        log_path = write_error_log(report)
        self._failed = True
        self._log_threadsafe(f"STOPPED. {package.title} could not be installed.")
        if log_path:
            self._log_threadsafe(f"Error log saved to: {log_path}")
        self._show_failure(
            f"Install failed: {package.title}",
            f"{package.title} could not be installed, so the rest of the run was stopped.",
            details,
            manual,
            str(log_path) if log_path else None,
        )

    def _install_worker(self, views: List[PackageView]) -> None:
        installed_js = detect.has_js_runtime()
        seen_optional_js: Set[str] = set()
        self._failed = False

        try:
            for view in views:
                package = view.package
                if package.id in ("deno", "node"):
                    if installed_js or seen_optional_js:
                        self._log_threadsafe(
                            f"Skipping {package.title}. A JavaScript runtime is already enough."
                        )
                        continue

                fresh = evaluate_packages()
                current = next((item for item in fresh if item.package.id == package.id), None)
                if current is None:
                    continue
                if current.status == InstallStatus.READY:
                    self._log_threadsafe(f"{package.title} is already installed.")
                    if package.id in ("deno", "node"):
                        installed_js = True
                    continue
                if current.status == InstallStatus.BLOCKED or not current.plans:
                    self._log_threadsafe(
                        f"Cannot install {package.title} yet. {current.detail}"
                    )
                    self.master.after(
                        0,
                        lambda title=package.title, detail=current.detail: show_error(
                            self.master,
                            f"Blocked: {title}",
                            detail,
                        ),
                    )
                    continue

                plan = self._choose_plan(list(current.plans))
                if plan is None:
                    self._log_threadsafe(f"Cancelled install for {package.title}.")
                    continue

                self._log_threadsafe(f"Preparing {package.title}...")
                result = run_with_approval(
                    plan,
                    approve=self._approve,
                    on_log=self._log_threadsafe,
                )
                if result.error == "User declined to run the command.":
                    self._log_threadsafe(f"Denied command for {package.title}.")
                    continue
                if not result.ok:
                    err = result.combined_output() or "Unknown error"
                    self._log_threadsafe(f"ERROR installing {package.title}:\n{err}")
                    if package.required:
                        self._fail_and_stop(package, err)
                        return
                    self._log_threadsafe(f"Skipping optional {package.title}.")
                    continue

                self._log_threadsafe(f"{package.title} install finished.")

                if package.id == "python":
                    self._log_threadsafe("Testing the new Python install...")
                    ok, report = detect.verify_python_install()
                    self._log_threadsafe(report)
                    if not ok:
                        self._fail_and_stop(package, report)
                        return
                    self._log_threadsafe("Python test passed.")

                if package.id in ("deno", "node"):
                    installed_js = True
                    seen_optional_js.add(package.id)
        finally:
            self.master.after(0, self._finish_install)

    def _finish_install(self) -> None:
        self.set_busy(False)
        self.refresh()
        if self._failed:
            return
        show_info(
            self.master,
            "Done",
            "Finished the auto download pass. Check the list and log for anything still missing.",
        )


_ICON_REF: Optional[tk.PhotoImage] = None


def run_app() -> None:
    global _ICON_REF
    root = tk.Tk()
    _ICON_REF = apply_app_icon(root)
    try:
        style = ttk.Style()
        if "vista" in style.theme_names():
            style.theme_use("vista")
        elif "clam" in style.theme_names():
            style.theme_use("clam")
    except tk.TclError:
        pass
    AutoDownloadApp(root)
    root.mainloop()
