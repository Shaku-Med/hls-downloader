from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, List, Optional, Sequence


class InstallStatus(str, Enum):
    READY = "ready"
    MISSING = "missing"
    BLOCKED = "blocked"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class CommandPlan:
    label: str
    argv: Sequence[str]
    shell: bool = False

    def display(self) -> str:
        if self.shell:
            return " ".join(self.argv)
        return argv_to_display(self.argv)


def argv_to_display(argv: Sequence[str]) -> str:
    parts: List[str] = []
    for part in argv:
        if not part:
            parts.append('""')
            continue
        if any(ch.isspace() for ch in part) or '"' in part:
            escaped = part.replace('"', '\\"')
            parts.append(f'"{escaped}"')
        else:
            parts.append(part)
    return " ".join(parts)


@dataclass
class Package:
    id: str
    title: str
    summary: str
    required: bool
    detect: Callable[[], bool]
    build_plans: Callable[[], List[CommandPlan]]
    prerequisites: Sequence[str] = field(default_factory=tuple)
    missing_hint: str = ""


@dataclass
class PackageView:
    package: Package
    status: InstallStatus
    detail: str
    plans: List[CommandPlan] = field(default_factory=list)
    blocked_by: List[str] = field(default_factory=list)


@dataclass
class RunResult:
    ok: bool
    returncode: int
    stdout: str
    stderr: str
    error: Optional[str] = None

    def combined_output(self) -> str:
        chunks: List[str] = []
        if self.stdout.strip():
            chunks.append(self.stdout.strip())
        if self.stderr.strip():
            chunks.append(self.stderr.strip())
        if self.error:
            chunks.append(self.error)
        return "\n".join(chunks)
