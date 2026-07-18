from __future__ import annotations

import os
import subprocess
import time
from typing import Callable, List, Optional

from .models import CommandPlan, RunResult

ApproveFn = Callable[[CommandPlan], bool]
LogFn = Callable[[str], None]


def _stream_process(
    argv: List[str],
    *,
    timeout: Optional[float],
    on_log: Optional[LogFn],
) -> RunResult:
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    # Help pip show progress when stdout is not a TTY (GUI / captured).
    env.setdefault("PIP_PROGRESS_BAR", "on")

    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
            env=env,
        )
    except FileNotFoundError:
        return RunResult(
            ok=False,
            returncode=127,
            stdout="",
            stderr="",
            error="Executable not found.",
        )
    except OSError as exc:
        return RunResult(
            ok=False,
            returncode=1,
            stdout="",
            stderr="",
            error=str(exc),
        )

    chunks: List[str] = []
    last_heartbeat = time.monotonic()
    deadline = (time.monotonic() + timeout) if timeout else None

    assert proc.stdout is not None
    try:
        while True:
            if deadline is not None and time.monotonic() > deadline:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                return RunResult(
                    ok=False,
                    returncode=124,
                    stdout="".join(chunks),
                    stderr="",
                    error="Command timed out.",
                )

            line = proc.stdout.readline()
            if line:
                chunks.append(line)
                text = line.rstrip("\r\n")
                if text and on_log:
                    on_log(text)
                last_heartbeat = time.monotonic()
            elif proc.poll() is not None:
                break
            else:
                # No new line yet — keep the UI alive during long quiet stretches.
                now = time.monotonic()
                if on_log and now - last_heartbeat >= 8.0:
                    on_log("Still working... (installer has not printed new output yet)")
                    last_heartbeat = now
                time.sleep(0.15)

        leftover = proc.stdout.read()
        if leftover:
            chunks.append(leftover)
            if on_log:
                for part in leftover.splitlines():
                    if part.strip():
                        on_log(part)
    finally:
        if proc.poll() is None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    code = proc.returncode if proc.returncode is not None else 1
    output = "".join(chunks)
    return RunResult(
        ok=code == 0,
        returncode=code,
        stdout=output,
        stderr="",
        error=None if code == 0 else f"Exit code {code}",
    )


def run_command(
    plan: CommandPlan,
    *,
    timeout: Optional[float] = None,
    on_log: Optional[LogFn] = None,
) -> RunResult:
    if on_log:
        on_log(f"$ {plan.display()}")
        on_log("Running... live output below.")

    return _stream_process(list(plan.argv), timeout=timeout, on_log=on_log)


def run_with_approval(
    plan: CommandPlan,
    *,
    approve: ApproveFn,
    on_log: Optional[LogFn] = None,
    timeout: Optional[float] = 3600.0,
) -> RunResult:
    if not approve(plan):
        if on_log:
            on_log("Skipped. User did not approve the command.")
        return RunResult(
            ok=False,
            returncode=0,
            stdout="",
            stderr="",
            error="User declined to run the command.",
        )
    return run_command(plan, timeout=timeout, on_log=on_log)
