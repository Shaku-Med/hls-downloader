#!/usr/bin/env python3
"""
The protected-content Record button asks the helper to open the screen recorder.

Success used to mean "the process was spawned". The process then exited at once
(no tkinter, or a startup crash) and the button still said the recorder was
open. These tests cover that, and that Windows, macOS, and Linux each detach
in the way that lets the window outlive the helper.
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

import host  # noqa: E402


class _Alive:
    def poll(self):
        return None


class _Dead:
    def __init__(self, code=1):
        self.code = code

    def poll(self):
        return self.code


class LaunchRecorder(unittest.TestCase):
    def setUp(self):
        self._saved = (
            host.sys.platform,
            host.sys.executable,
            host._RECORDER_START_GRACE_SEC,
            host.send_message,
            host.subprocess.run,
            host.subprocess.Popen,
            host.shutil.which,
            host.os.path.isdir,
        )
        host._RECORDER_START_GRACE_SEC = 0
        self.sent = []
        host.send_message = self.sent.append
        host.subprocess.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0)
        host.subprocess.Popen = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("recorder was launched")
        )

    def tearDown(self):
        (
            host.sys.platform,
            host.sys.executable,
            host._RECORDER_START_GRACE_SEC,
            host.send_message,
            host.subprocess.run,
            host.subprocess.Popen,
            host.shutil.which,
            host.os.path.isdir,
        ) = self._saved

    def _last(self):
        self.assertTrue(self.sent, "helper sent no reply")
        return self.sent[-1]

    def test_missing_package_is_an_error(self):
        real_isdir = host.os.path.isdir

        def isdir(path):
            if str(path).endswith("screen_recorder"):
                return False
            return real_isdir(path)

        host.os.path.isdir = isdir
        host._handle_launch_recorder({"requestId": "r", "outputDirectory": ""})
        reply = self._last()
        self.assertFalse(reply["success"])
        self.assertEqual(reply["requestId"], "r")
        self.assertIn("not installed", reply["error"])

    def test_a_python_without_tkinter_does_not_count_as_opened(self):
        # The Linux hint; the Windows one has its own test below.
        host.sys.platform = "linux"
        host.subprocess.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 1)
        host.shutil.which = lambda name: "/usr/bin/dnf" if name == "dnf" else None
        host._handle_launch_recorder({"requestId": "r", "outputDirectory": ""})
        reply = self._last()
        self.assertFalse(reply["success"])
        self.assertIn("python3-tkinter", reply["error"])
        self.assertNotIn("brew", reply["error"])
        self.assertNotIn("python.org", reply["error"])

    def test_windows_tkinter_hint_does_not_use_a_linux_package_manager(self):
        host.sys.platform = "win32"
        host.shutil.which = lambda name: "/usr/bin/dnf"
        self.assertIn("python.org", host._tkinter_missing_message())
        self.assertNotIn("dnf", host._tkinter_missing_message())
        self.assertNotIn("apt-get", host._tkinter_missing_message())
        self.assertNotIn("brew", host._tkinter_missing_message())

    def test_macos_tkinter_hint_does_not_use_a_linux_package_manager(self):
        host.sys.platform = "darwin"
        host.shutil.which = lambda name: "/usr/bin/dnf"
        message = host._tkinter_missing_message()
        self.assertIn("brew install python-tk", message)
        self.assertNotIn("dnf", message)
        self.assertNotIn("apt-get", message)

    def test_debian_and_arch_hints_follow_the_manager_that_is_installed(self):
        host.sys.platform = "linux"
        host.shutil.which = lambda name: "/usr/bin/apt-get" if name == "apt-get" else None
        self.assertIn("python3-tk", host._tkinter_missing_message())
        self.assertNotIn("python3-tkinter", host._tkinter_missing_message())
        host.shutil.which = lambda name: "/usr/bin/pacman" if name == "pacman" else None
        self.assertIn("pacman", host._tkinter_missing_message())

    def test_startup_crash_is_reported_instead_of_success(self):
        def popen(argv, **kwargs):
            kwargs["stderr"].write(
                b"ModuleNotFoundError: No module named 'tkinter'\n"
            )
            return _Dead(1)

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r", "outputDirectory": ""})
        reply = self._last()
        self.assertEqual(reply["type"], "launch_recorder_result")
        self.assertFalse(reply["success"])
        self.assertIn("tkinter", reply["error"])

    def test_other_startup_errors_are_the_recorder_message(self):
        def popen(argv, **kwargs):
            kwargs["stderr"].write(
                b"_tkinter.TclError: no display name and no $DISPLAY environment variable\n"
            )
            return _Dead(1)

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r"})
        reply = self._last()
        self.assertFalse(reply["success"])
        self.assertIn("no display", reply["error"])
        self.assertNotIn("python3-tkinter", reply["error"])

    def test_a_recorder_that_stays_up_is_success_and_keeps_the_save_folder(self):
        # The POSIX launch. Windows starts pythonw detached, tested below.
        host.sys.platform = "linux"
        launched = []
        work = tempfile.mkdtemp()
        self.addCleanup(lambda: os.path.isdir(work) and __import__("shutil").rmtree(work, True))

        def popen(argv, **kwargs):
            launched.append((list(argv), kwargs))
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({
            "requestId": "r",
            "outputDirectory": work,
        })
        reply = self._last()
        self.assertTrue(reply["success"])
        argv, kwargs = launched[0]
        self.assertEqual(argv[0], host.sys.executable)
        self.assertEqual(argv[1:3], ["-m", "screen_recorder"])
        self.assertEqual(argv[3:], ["--output-dir", work])
        self.assertTrue(kwargs.get("start_new_session"))
        self.assertNotIn("creationflags", kwargs)
        self.assertEqual(kwargs.get("cwd"), os.path.dirname(os.path.dirname(os.path.abspath(host.__file__))))

    def test_a_missing_save_folder_is_not_passed_through(self):
        launched = []

        def popen(argv, **kwargs):
            launched.append(list(argv))
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({
            "requestId": "r",
            "outputDirectory": os.path.join(tempfile.gettempdir(), "sg-no-such-folder"),
        })
        self.assertTrue(self._last()["success"])
        self.assertNotIn("--output-dir", launched[0])

    def test_macos_uses_a_new_session_like_linux(self):
        launched = []
        host.sys.platform = "darwin"

        def popen(argv, **kwargs):
            launched.append(kwargs)
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r"})
        self.assertTrue(self._last()["success"])
        self.assertTrue(launched[0].get("start_new_session"))
        self.assertNotIn("creationflags", launched[0])

    def test_windows_breaks_out_of_the_browser_job_and_prefers_pythonw(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(folder, True))
        python_exe = os.path.join(folder, "python.exe")
        pythonw = os.path.join(folder, "pythonw.exe")
        for path in (python_exe, pythonw):
            with open(path, "wb") as fh:
                fh.write(b"")
        host.sys.platform = "win32"
        host.sys.executable = python_exe
        # which() follows sys.platform, which is the same object as host.sys.
        host.shutil.which = lambda name: None
        launched = []

        def popen(argv, **kwargs):
            launched.append((list(argv), kwargs))
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r"})
        self.assertTrue(self._last()["success"])
        argv, kwargs = launched[0]
        self.assertEqual(os.path.basename(argv[0]), "pythonw.exe")
        flags = kwargs.get("creationflags") or 0
        self.assertTrue(flags & 0x00000008)  # DETACHED_PROCESS
        self.assertTrue(flags & 0x00000200)  # CREATE_NEW_PROCESS_GROUP
        self.assertTrue(flags & 0x01000000)  # CREATE_BREAKAWAY_FROM_JOB
        self.assertNotIn("start_new_session", kwargs)

    def test_windows_falls_back_when_the_job_refuses_breakaway(self):
        host.sys.platform = "win32"
        host.shutil.which = lambda name: None
        launched = []

        def popen(argv, **kwargs):
            flags = kwargs.get("creationflags") or 0
            if flags & 0x01000000:
                raise OSError("breakaway denied")
            launched.append(kwargs)
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r"})
        self.assertTrue(self._last()["success"])
        flags = launched[0].get("creationflags") or 0
        self.assertTrue(flags & 0x00000008)
        self.assertFalse(flags & 0x01000000)


class UnbufferedHost(unittest.TestCase):
    def test_detection_does_not_need_the_removed_flag(self):
        flags = type("F", (), {})()
        stdout = type("O", (), {"write_through": False})()
        self.assertFalse(host._host_stdout_is_unbuffered(flags, stdout, {}))
        stdout.write_through = True
        self.assertTrue(host._host_stdout_is_unbuffered(flags, stdout, {}))
        flags.unbuffered = 1
        stdout.write_through = False
        self.assertTrue(host._host_stdout_is_unbuffered(flags, stdout, {}))
        flags.unbuffered = 0
        self.assertTrue(host._host_stdout_is_unbuffered(flags, stdout, {"PYTHONUNBUFFERED": "1"}))

    def test_already_unbuffered_is_left_alone(self):
        self.assertIsNone(host._unbuffered_host_argv(True, "/usr/bin/python3", "/tmp/host.py"))

    def test_a_buffered_host_is_restarted_with_python_u(self):
        argv = host._unbuffered_host_argv(False, "/usr/bin/python3", "/tmp/host.py")
        self.assertEqual(argv, ["/usr/bin/python3", "-u", "/tmp/host.py"])

    def test_missing_pieces_do_not_invent_a_command(self):
        self.assertIsNone(host._unbuffered_host_argv(False, "", "/tmp/host.py"))
        self.assertIsNone(host._unbuffered_host_argv(False, "/usr/bin/python3", ""))


class LaunchRecorderOnWindows(LaunchRecorder):
    def test_it_starts_pythonw_detached_so_no_console_flashes(self):
        host.sys.platform = "win32"
        launched = []
        work = tempfile.mkdtemp()
        self.addCleanup(lambda: os.path.isdir(work) and __import__("shutil").rmtree(work, True))

        def popen(argv, **kwargs):
            launched.append((list(argv), kwargs))
            return _Alive()

        host.subprocess.Popen = popen
        host._handle_launch_recorder({"requestId": "r", "outputDirectory": work})
        self.assertTrue(self._last()["success"])
        argv, kwargs = launched[0]
        beside = os.path.join(os.path.dirname(os.path.abspath(host.sys.executable)), "pythonw.exe")
        # pythonw whenever the install has it; only without it the helper's own Python.
        self.assertEqual(argv[0], beside if os.path.isfile(beside) else host.sys.executable)
        self.assertTrue(kwargs.get("creationflags"))
        self.assertNotIn("start_new_session", kwargs)


if __name__ == "__main__":
    unittest.main()
