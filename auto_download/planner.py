from __future__ import annotations

from typing import Dict, List, Sequence

from .catalog import build_catalog
from .models import InstallStatus, Package, PackageView


def _prereq_ready(package: Package, status_map: Dict[str, InstallStatus]) -> List[str]:
    blocked: List[str] = []
    for pid in package.prerequisites:
        state = status_map.get(pid, InstallStatus.UNKNOWN)
        if state != InstallStatus.READY:
            blocked.append(pid)
    return blocked


def evaluate_packages(packages: Sequence[Package] | None = None) -> List[PackageView]:
    items = list(packages) if packages is not None else build_catalog()
    detected: Dict[str, bool] = {}
    for package in items:
        try:
            detected[package.id] = bool(package.detect())
        except Exception:
            detected[package.id] = False

    status_map: Dict[str, InstallStatus] = {}
    for package in items:
        status_map[package.id] = (
            InstallStatus.READY if detected.get(package.id) else InstallStatus.MISSING
        )

    views: List[PackageView] = []
    for package in items:
        if detected.get(package.id):
            views.append(
                PackageView(
                    package=package,
                    status=InstallStatus.READY,
                    detail="Installed",
                    plans=[],
                    blocked_by=[],
                )
            )
            continue

        blocked_by = _prereq_ready(package, status_map)
        plans = list(package.build_plans()) if not blocked_by else []

        if blocked_by:
            names = ", ".join(blocked_by)
            views.append(
                PackageView(
                    package=package,
                    status=InstallStatus.BLOCKED,
                    detail=f"Waiting on: {names}. {package.missing_hint}".strip(),
                    plans=[],
                    blocked_by=blocked_by,
                )
            )
            continue

        if not plans:
            views.append(
                PackageView(
                    package=package,
                    status=InstallStatus.MISSING,
                    detail=package.missing_hint or "Missing. Install this manually.",
                    plans=[],
                    blocked_by=[],
                )
            )
            continue

        views.append(
            PackageView(
                package=package,
                status=InstallStatus.MISSING,
                detail="Not installed. An install command is available.",
                plans=plans,
                blocked_by=[],
            )
        )
    return views


def installable_views(views: Sequence[PackageView]) -> List[PackageView]:
    return [
        view
        for view in views
        if view.status == InstallStatus.MISSING and view.plans
    ]
