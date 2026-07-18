#!/usr/bin/env python3
"""
Install script for Stuff Grabber native host.
Run this once after loading the extension.
Registers the host for Google Chrome and Firefox (personal / unpacked use).
"""

import os
import sys
import json
import stat
import shutil
import subprocess

NATIVE_HOST_NAME = "com.medzy.hlsgrabber"
# Must match browser_specific_settings.gecko.id in firefox/manifest.json
FIREFOX_EXTENSION_ID = "stuff-grabber@local"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HOST_SCRIPT = os.path.join(SCRIPT_DIR, "host.py")


def get_extension_id():
    for arg in sys.argv[1:]:
        a = arg.strip()
        if a and not a.startswith("-"):
            return a
    return input(
        "Paste your Chromium extension ID (from chrome://extensions or edge://extensions): "
    ).strip()


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(cmd, 1, "", str(e))


def _run_streaming(cmd, *, label=""):
    """Run a long install command and stream output so the terminal does not look frozen."""
    if label:
        print(label)
        sys.stdout.flush()
    print(f"  $ {' '.join(cmd)}")
    sys.stdout.flush()

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PIP_PROGRESS_BAR", "on")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(cmd, 1, "", str(e))

    chunks = []
    assert proc.stdout is not None
    for line in proc.stdout:
        chunks.append(line)
        print("  " + line.rstrip("\r\n"))
        sys.stdout.flush()
    code = proc.wait()
    out = "".join(chunks)
    return subprocess.CompletedProcess(cmd, code, out, "")


def install_ytdlp(python_exe):
    print("\nInstalling yt-dlp for the host Python...")
    print(f"  using: {python_exe}")
    sys.stdout.flush()
    base = [python_exe, "-m", "pip", "install", "-U", "yt-dlp"]
    r = _run_streaming(base, label="Downloading and installing yt-dlp (this can take a bit)...")
    if r.returncode != 0:
        print("Retrying with --user ...")
        sys.stdout.flush()
        r = _run_streaming(base + ["--user"], label="Retrying yt-dlp install for this user...")
    if r.returncode == 0:
        ver = _run([python_exe, "-m", "yt_dlp", "--version"]).stdout.strip()
        print(f"✓ yt-dlp ready ({ver or 'installed'})")
        return True
    print("WARNING: could not install yt-dlp automatically.")
    tail = (r.stderr or r.stdout or "").strip()[-400:]
    if tail:
        print("  " + tail.replace("\n", "\n  "))
    print(f'  Do it by hand:  "{python_exe}" -m pip install -U --user yt-dlp')
    return False


def ensure_ffmpeg():
    if shutil.which("ffmpeg"):
        print("✓ ffmpeg found")
        return True
    print("\nffmpeg not found on PATH.")
    if sys.platform == "win32" and shutil.which("winget"):
        print("Trying winget to install ffmpeg (this can take a minute)...")
        sys.stdout.flush()
        _run_streaming(
            [
                "winget",
                "install",
                "--id",
                "Gyan.FFmpeg",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            label="Running winget. You should see download progress below.",
        )
        if shutil.which("ffmpeg"):
            print("✓ ffmpeg installed")
            return True
        print("winget did not finish the ffmpeg install. Open a new terminal and check again.")
    print("Install ffmpeg yourself, then open a fresh terminal:")
    if sys.platform == "win32":
        print("  winget install Gyan.FFmpeg      or      choco install ffmpeg")
    elif sys.platform == "darwin":
        print("  brew install ffmpeg")
    else:
        print("  sudo apt install ffmpeg")
    return False


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _chrome_host_manifest(host_path, ext_id):
    return {
        "name": NATIVE_HOST_NAME,
        "description": "Stuff Grabber native host",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }


def _firefox_host_manifest(host_path):
    return {
        "name": NATIVE_HOST_NAME,
        "description": "Stuff Grabber native host",
        "path": host_path,
        "type": "stdio",
        "allowed_extensions": [FIREFOX_EXTENSION_ID],
    }


def _write_host_wrapper_bat(python_exe, host_script, bat_path):
    with open(bat_path, "w", newline="\r\n", encoding="utf-8") as f:
        f.write("@echo off\r\n")
        f.write("setlocal\r\n")
        f.write(
            "REM Optional: set User env var HLS_GRABBER_PYTHON to a full python.exe path "
            "(e.g. from python.org) if Store Python fails for Chrome/Firefox.\r\n"
        )
        f.write('if not "%HLS_GRABBER_PYTHON%"=="" (\r\n')
        f.write(f'  "%HLS_GRABBER_PYTHON%" -u "{host_script}"\r\n')
        f.write("  exit /b %ERRORLEVEL%\r\n")
        f.write(")\r\n")
        f.write(f'"{python_exe}" -u "{host_script}"\r\n')


def _register_windows_native_host(reg_subkey, manifest_path):
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_subkey) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)


def install_windows_wsl(ext_id):
    """WSL: write Windows-side wrapper + Chrome/Firefox host manifests via PowerShell paths."""
    python_path = shutil.which("python3") or shutil.which("python")
    if not python_path:
        print("ERROR: python3 not found in PATH")
        sys.exit(1)

    ps_wrapper = os.path.join(SCRIPT_DIR, "host_wrapper.ps1")
    result = subprocess.run(["wslpath", "-w", HOST_SCRIPT], capture_output=True, text=True)
    win_host_path = result.stdout.strip()
    result2 = subprocess.run(["wslpath", "-w", python_path], capture_output=True, text=True)
    win_python = result2.stdout.strip()

    with open(ps_wrapper, "w", encoding="utf-8") as f:
        f.write(f'& "{win_python}" -u "{win_host_path}"\n')

    win_wrapper = subprocess.run(
        ["wslpath", "-w", ps_wrapper], capture_output=True, text=True
    ).stdout.strip()

    manifest_dir_result = subprocess.run(
        ["powershell.exe", "-Command", "echo $env:LOCALAPPDATA"],
        capture_output=True,
        text=True,
    )
    local_app_data = manifest_dir_result.stdout.strip()
    local_app_data_wsl = subprocess.run(
        ["wslpath", local_app_data], capture_output=True, text=True
    ).stdout.strip()

    chrome_dir = os.path.join(local_app_data_wsl, "Google", "Chrome", "NativeMessagingHosts")
    chrome_manifest_path = os.path.join(chrome_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(chrome_manifest_path, _chrome_host_manifest(win_wrapper.replace("/", "\\"), ext_id))

    firefox_dir = os.path.join(local_app_data_wsl, "Mozilla", "NativeMessagingHosts")
    # Firefox on Windows uses registry; also keep a copy under LocalAppData for reference.
    firefox_manifest_path = os.path.join(firefox_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(firefox_manifest_path, _firefox_host_manifest(win_wrapper.replace("/", "\\")))

    win_chrome_manifest = subprocess.run(
        ["wslpath", "-w", chrome_manifest_path], capture_output=True, text=True
    ).stdout.strip()
    win_firefox_manifest = subprocess.run(
        ["wslpath", "-w", firefox_manifest_path], capture_output=True, text=True
    ).stdout.strip()

    subprocess.run(
        [
            "powershell.exe",
            "-Command",
            f'New-Item -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}" -Force | Set-ItemProperty -Name "(default)" -Value "{win_chrome_manifest}"',
        ]
    )
    subprocess.run(
        [
            "powershell.exe",
            "-Command",
            f'New-Item -Path "HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\{NATIVE_HOST_NAME}" -Force | Set-ItemProperty -Name "(default)" -Value "{win_firefox_manifest}"',
        ]
    )

    print(f"\n✓ Wrapper written: {ps_wrapper}")
    print(f"✓ Chrome manifest: {chrome_manifest_path}")
    print(f"✓ Firefox manifest: {firefox_manifest_path}")
    print("✓ Registry: Chrome + Mozilla NativeMessagingHosts")
    print("\nRestart Chrome/Firefox and test the extension!")


def install_native_windows(ext_id):
    """
    Chrome: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name>
    Firefox: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\<name>
    """
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        print("ERROR: LOCALAPPDATA is not set")
        sys.exit(1)

    python_exe = os.path.normpath(sys.executable)
    host_script = os.path.normpath(HOST_SCRIPT)
    bat_path = os.path.normpath(os.path.join(SCRIPT_DIR, "host_wrapper.bat"))
    _write_host_wrapper_bat(python_exe, host_script, bat_path)

    low = python_exe.lower()
    if "windowsapps" in low:
        print(
            "\n*** NOTE: This installer is using Microsoft Store Python under WindowsApps."
        )
        print(
            "    Browsers often cannot run yt-dlp reliably with that build, or yt-dlp is missing."
        )
        print("    Fix A (same Python): open cmd and run:")
        print(f'        "{python_exe}" -m pip install -U "yt-dlp[default]"')
        print(
            "    Fix B (recommended): install Python from https://www.python.org/downloads/ ,"
        )
        print("        then in this folder run:  py -3.12 install.py   (or your version)")
        print(
            "        so host_wrapper.bat uses that python.exe instead of the Store shim.\n"
        )

    chrome_dir = os.path.join(
        local_app_data, "Google", "Chrome", "User Data", "NativeMessagingHosts"
    )
    chrome_manifest_path = os.path.join(chrome_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(chrome_manifest_path, _chrome_host_manifest(bat_path, ext_id))
    _register_windows_native_host(
        rf"Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}",
        chrome_manifest_path,
    )

    # Firefox reads the path from the Mozilla registry key (manifest file can live anywhere).
    firefox_dir = os.path.join(local_app_data, "Mozilla", "NativeMessagingHosts")
    firefox_manifest_path = os.path.join(firefox_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(firefox_manifest_path, _firefox_host_manifest(bat_path))
    _register_windows_native_host(
        rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST_NAME}",
        firefox_manifest_path,
    )

    print(f"\n✓ Wrapper written: {bat_path}")
    print(f"✓ Chrome manifest: {chrome_manifest_path}")
    print(f"✓ Firefox manifest: {firefox_manifest_path}")
    print(f"✓ Registry: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}")
    print(f"✓ Registry: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\{NATIVE_HOST_NAME}")
    print(f"✓ Firefox allowed extension id: {FIREFOX_EXTENSION_ID}")
    print("\nRestart Chrome and/or Firefox and test the extension!")
    print(
        "\n--- YouTube (yt-dlp) ---\n"
        "Music videos need JavaScript challenge solving (EJS). Install:\n"
        f'  {sys.executable} -m pip install -U "yt-dlp[default]"\n'
        "Plus one JS runtime on your PATH (pick one):\n"
        "  Node.js  https://nodejs.org   or   Deno  https://docs.deno.com/runtime/getting_started/installation/\n"
        "More info: https://github.com/yt-dlp/yt-dlp/wiki/EJS\n"
    )


def install_linux(ext_id):
    st = os.stat(HOST_SCRIPT)
    os.chmod(HOST_SCRIPT, st.st_mode | stat.S_IEXEC)
    host_path = os.path.normpath(HOST_SCRIPT)

    chrome_dir = os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts")
    chrome_manifest_path = os.path.join(chrome_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(chrome_manifest_path, _chrome_host_manifest(host_path, ext_id))

    # Chromium / Brave common paths (best effort)
    chromium_dir = os.path.expanduser("~/.config/chromium/NativeMessagingHosts")
    _write_json(
        os.path.join(chromium_dir, f"{NATIVE_HOST_NAME}.json"),
        _chrome_host_manifest(host_path, ext_id),
    )

    firefox_dir = os.path.expanduser("~/.mozilla/native-messaging-hosts")
    firefox_manifest_path = os.path.join(firefox_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(firefox_manifest_path, _firefox_host_manifest(host_path))

    print(f"\n✓ host.py made executable")
    print(f"✓ Chrome manifest: {chrome_manifest_path}")
    print(f"✓ Firefox manifest: {firefox_manifest_path}")
    print(f"✓ Firefox allowed extension id: {FIREFOX_EXTENSION_ID}")
    print("\nRestart Chrome/Firefox and test the extension!")


def install_macos(ext_id):
    st = os.stat(HOST_SCRIPT)
    os.chmod(HOST_SCRIPT, st.st_mode | stat.S_IEXEC)
    host_path = os.path.normpath(HOST_SCRIPT)

    chrome_dir = os.path.expanduser(
        "~/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    )
    chrome_manifest_path = os.path.join(chrome_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(chrome_manifest_path, _chrome_host_manifest(host_path, ext_id))

    firefox_dir = os.path.expanduser(
        "~/Library/Application Support/Mozilla/NativeMessagingHosts"
    )
    firefox_manifest_path = os.path.join(firefox_dir, f"{NATIVE_HOST_NAME}.json")
    _write_json(firefox_manifest_path, _firefox_host_manifest(host_path))

    print(f"\n✓ host.py made executable")
    print(f"✓ Chrome manifest: {chrome_manifest_path}")
    print(f"✓ Firefox manifest: {firefox_manifest_path}")
    print(f"✓ Firefox allowed extension id: {FIREFOX_EXTENSION_ID}")
    print("\nRestart Chrome/Firefox and test the extension!")


def ensure_browser_roots():
    """Create chromium/ + firefox/ folders (each with its own manifest.json)."""
    setup = os.path.join(SCRIPT_DIR, "setup_browser_roots.py")
    if not os.path.isfile(setup):
        return
    r = _run([sys.executable, setup])
    if r.stdout:
        print(r.stdout.rstrip())
    if r.returncode != 0:
        if r.stderr:
            print(r.stderr.rstrip())
        print("WARNING: could not set up chromium/firefox extension folders.")


def main():
    print("=== Stuff Grabber Native Host Installer ===\n")
    print(f"Firefox extension id (fixed): {FIREFOX_EXTENSION_ID}\n")
    ensure_browser_roots()
    print("")

    ext_id = get_extension_id()
    if not ext_id:
        print("ERROR: Chromium Extension ID required")
        sys.exit(1)

    is_wsl = (
        os.path.exists("/proc/version")
        and "microsoft" in open("/proc/version", encoding="utf-8", errors="ignore").read().lower()
    )

    if is_wsl:
        print("\nDetected WSL environment  installing for Windows Chrome + Firefox...")
        install_windows_wsl(ext_id)
    elif sys.platform == "win32":
        print("\nDetected native Windows  installing for Google Chrome + Firefox...")
        install_native_windows(ext_id)
    elif sys.platform == "darwin":
        print("\nDetected macOS  installing for Google Chrome + Firefox...")
        install_macos(ext_id)
    else:
        print("\nInstalling for Linux Chrome/Chromium + Firefox...")
        install_linux(ext_id)

    ensure_ffmpeg()
    install_ytdlp(sys.executable)

    print(
        "\nAll set. Fully quit and reopen your browser so it picks up the host.\n"
        "Chromium: Load unpacked → select the chromium/ folder.\n"
        "Firefox:  about:debugging → This Firefox → Load Temporary Add-on → firefox/manifest.json\n"
        "For YouTube music videos you also want one JS runtime on your PATH:\n"
        "  Node.js  https://nodejs.org   or   Deno  https://docs.deno.com/runtime/getting_started/installation/\n"
    )


if __name__ == "__main__":
    main()
