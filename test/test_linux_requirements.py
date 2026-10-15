#!/usr/bin/env python3
"""Linux-only requirement install plans. Windows and macOS plans stay as they were."""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from auto_download import catalog, osinfo, platform_cmds  # noqa: E402
import host  # noqa: E402


class LinuxRequirementPlans(unittest.TestCase):
    def setUp(self):
        self._family = osinfo.os_family
        self._managers = osinfo.available_managers
        self._manager_path = osinfo.manager_path

    def tearDown(self):
        osinfo.os_family = self._family
        osinfo.available_managers = self._managers
        osinfo.manager_path = self._manager_path

    def _as(self, family, managers):
        osinfo.os_family = lambda: family
        osinfo.available_managers = lambda: list(managers)
        osinfo.manager_path = lambda name: f"/usr/bin/{name}" if name in managers else None

    def test_fedora_deno_uses_the_official_installer(self):
        self._as(osinfo.LINUX, ["dnf", "yum"])
        plans = platform_cmds.deno_plans()
        self.assertEqual(len(plans), 1)
        shown = " ".join(plans[0].argv)
        self.assertIn("deno.land/install.sh", shown)
        self.assertNotIn("dnf", plans[0].argv)

    def test_arch_still_uses_pacman(self):
        self._as(osinfo.LINUX, ["pacman"])
        plans = platform_cmds.deno_plans()
        self.assertIn("/usr/bin/pacman", plans[0].argv)
        self.assertIn("deno", plans[0].argv)
        self.assertNotIn("deno.land", " ".join(plans[0].argv))

    def test_windows_and_macos_do_not_get_the_linux_installer(self):
        self._as(osinfo.WINDOWS, ["winget"])
        for plan in platform_cmds.deno_plans():
            self.assertNotIn("deno.land", " ".join(plan.argv))
        self._as(osinfo.MACOS, ["brew"])
        for plan in platform_cmds.deno_plans():
            self.assertNotIn("deno.land", " ".join(plan.argv))

    def test_only_linux_lists_the_download_helper(self):
        self._as(osinfo.LINUX, ["dnf"])
        self.assertIn("native_host", catalog.catalog_by_id())
        self._as(osinfo.WINDOWS, ["winget"])
        self.assertNotIn("native_host", catalog.catalog_by_id())
        self._as(osinfo.MACOS, ["brew"])
        self.assertNotIn("native_host", catalog.catalog_by_id())


class LinuxOpenSavedFile(unittest.TestCase):
    def test_linux_uses_xdg_open_inside_the_save_folder(self):
        work = tempfile.mkdtemp()
        self.addCleanup(lambda: os.path.isdir(work) and __import__("shutil").rmtree(work, True))
        target = os.path.join(work, "clip.mp4")
        with open(target, "wb") as fh:
            fh.write(b"not a real video")
        sent = []
        ran = []
        real = (host.send_message, host.subprocess.run, host.sys.platform)
        host.send_message = sent.append
        host.sys.platform = "linux"

        def fake_run(argv, **kwargs):
            ran.append(argv)
            return type("Proc", (), {"returncode": 0, "stderr": b""})()

        host.subprocess.run = fake_run
        try:
            host._handle_open_path({
                "requestId": "r1",
                "path": target,
                "outputDirectory": work,
            })
        finally:
            host.send_message, host.subprocess.run, host.sys.platform = real
        self.assertEqual(ran, [["xdg-open", os.path.abspath(target)]])
        self.assertTrue(sent[-1]["success"])
        self.assertEqual(sent[-1]["requestId"], "r1")

    def test_a_path_outside_the_save_folder_is_refused(self):
        work = tempfile.mkdtemp()
        outside = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(work, True))
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, True))
        target = os.path.join(outside, "clip.mp4")
        with open(target, "wb") as fh:
            fh.write(b"x")
        sent = []
        real = (host.send_message, host.subprocess.run, host.sys.platform)
        host.send_message = sent.append
        host.sys.platform = "linux"
        host.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(AssertionError("opened"))
        try:
            host._handle_open_path({
                "requestId": "r2",
                "path": target,
                "outputDirectory": work,
            })
        finally:
            host.send_message, host.subprocess.run, host.sys.platform = real
        self.assertFalse(sent[-1]["success"])
        self.assertIn("outside", sent[-1]["error"])

    def test_windows_and_macos_are_not_opened_here(self):
        sent = []
        real = (host.send_message, host.subprocess.run, host.sys.platform)
        host.send_message = sent.append
        host.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(AssertionError("opened"))
        try:
            for plat in ("win32", "darwin"):
                sent.clear()
                host.sys.platform = plat
                host._handle_open_path({
                    "requestId": "r3",
                    "path": "/tmp/clip.mp4",
                    "outputDirectory": "/tmp",
                })
                self.assertFalse(sent[-1]["success"])
                self.assertIn("Linux", sent[-1]["error"])
        finally:
            host.send_message, host.subprocess.run, host.sys.platform = real


if __name__ == "__main__":
    unittest.main()
