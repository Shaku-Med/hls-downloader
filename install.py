#!/usr/bin/env python3
"""
Install script for HLS Grabber native host.
Run this once after loading the extension.
"""

import os
import sys
import json
import stat
import shutil
import subprocess

NATIVE_HOST_NAME = "com.medzy.hlsgrabber"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HOST_SCRIPT = os.path.join(SCRIPT_DIR, "host.py")


def get_extension_id():
    ext_id = input("Paste your Chrome extension ID (from chrome://extensions): ").strip()
    return ext_id


def install_windows(ext_id):
    """Install for WSL/Windows - writes to Windows registry via PowerShell"""
    # Create a wrapper batch file since Chrome on Windows can't call WSL python directly
    wrapper_path = os.path.join(SCRIPT_DIR, "host_wrapper.bat")
    
    # Find python in WSL
    python_path = shutil.which("python3") or shutil.which("python")
    if not python_path:
        print("ERROR: python3 not found in PATH")
        sys.exit(1)

    # We need a Windows-side wrapper. Let's create a PowerShell script instead.
    ps_wrapper = os.path.join(SCRIPT_DIR, "host_wrapper.ps1")
    # Convert WSL path to Windows path
    result = subprocess.run(["wslpath", "-w", HOST_SCRIPT], capture_output=True, text=True)
    win_host_path = result.stdout.strip()
    result2 = subprocess.run(["wslpath", "-w", python_path], capture_output=True, text=True)
    win_python = result2.stdout.strip()

    with open(ps_wrapper, "w") as f:
        f.write(f'& "{win_python}" "{win_host_path}"')

    manifest = {
        "name": NATIVE_HOST_NAME,
        "description": "HLS Grabber native host",
        "path": ps_wrapper.replace("/", "\\"),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"]
    }

    # Write manifest to Windows AppData via PowerShell
    manifest_dir_result = subprocess.run(
        ["powershell.exe", "-Command", "echo $env:LOCALAPPDATA"],
        capture_output=True, text=True
    )
    local_app_data = manifest_dir_result.stdout.strip()
    
    # Convert to WSL path
    local_app_data_wsl = subprocess.run(
        ["wslpath", local_app_data], capture_output=True, text=True
    ).stdout.strip()

    manifest_dir = os.path.join(local_app_data_wsl, "Google", "Chrome", "NativeMessagingHosts")
    os.makedirs(manifest_dir, exist_ok=True)
    manifest_path = os.path.join(manifest_dir, f"{NATIVE_HOST_NAME}.json")

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Register in Windows registry
    reg_key = f"HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}"
    win_manifest_path = subprocess.run(
        ["wslpath", "-w", manifest_path], capture_output=True, text=True
    ).stdout.strip()

    subprocess.run([
        "powershell.exe", "-Command",
        f'New-Item -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}" -Force | Set-ItemProperty -Name "(default)" -Value "{win_manifest_path}"'
    ])

    print(f"\n✓ Manifest written to: {manifest_path}")
    print(f"✓ Registry key set: {reg_key}")
    print(f"\nRestart Chrome and test the extension!")


def install_native_windows(ext_id):
    """
    Chrome on Windows looks up HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name>
    and does NOT read ~/.config (that is Linux). Use a .bat launcher because the manifest
    \"path\" must be a single executable (Chrome does not pass script args).
    """
    import winreg

    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        print("ERROR: LOCALAPPDATA is not set")
        sys.exit(1)

    python_exe = os.path.normpath(sys.executable)
    host_script = os.path.normpath(HOST_SCRIPT)
    bat_path = os.path.join(SCRIPT_DIR, "host_wrapper.bat")
    with open(bat_path, "w", newline="\r\n") as f:
        f.write("@echo off\r\n")
        f.write("setlocal\r\n")
        f.write(
            "REM Optional: set User env var HLS_GRABBER_PYTHON to a full python.exe path "
            "(e.g. from python.org) if Store Python fails for Chrome.\r\n"
        )
        f.write('if not "%HLS_GRABBER_PYTHON%"=="" (\r\n')
        f.write(f'  "%HLS_GRABBER_PYTHON%" -u "{host_script}"\r\n')
        f.write("  exit /b %ERRORLEVEL%\r\n")
        f.write(")\r\n")
        # -u: unbuffered stdio (required for native messaging over pipes)
        f.write(f'"{python_exe}" -u "{host_script}"\r\n')

    low = python_exe.lower()
    if "windowsapps" in low:
        print(
            "\n*** NOTE: This installer is using Microsoft Store Python under WindowsApps."
        )
        print(
            "    Chrome often cannot run yt-dlp reliably with that build, or yt-dlp is missing."
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

    manifest_dir = os.path.join(
        local_app_data, "Google", "Chrome", "User Data", "NativeMessagingHosts"
    )
    os.makedirs(manifest_dir, exist_ok=True)
    manifest_path = os.path.join(manifest_dir, f"{NATIVE_HOST_NAME}.json")

    manifest = {
        "name": NATIVE_HOST_NAME,
        "description": "HLS Grabber native host",
        "path": os.path.normpath(bat_path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    reg_subkey = rf"Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_subkey) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)

    print(f"\n✓ Wrapper written: {bat_path}")
    print(f"✓ Manifest written to: {manifest_path}")
    print(f"✓ Registry: HKCU\\{reg_subkey}")
    print("\nRestart Chrome and test the extension!")
    print(
        "\n--- YouTube (yt-dlp) ---\n"
        "Music videos need JavaScript challenge solving (EJS). Install:\n"
        f'  {sys.executable} -m pip install -U "yt-dlp[default]"\n'
        "Plus one JS runtime on your PATH (pick one):\n"
        "  Node.js  https://nodejs.org   or   Deno  https://docs.deno.com/runtime/getting_started/installation/\n"
        "More info: https://github.com/yt-dlp/yt-dlp/wiki/EJS\n"
    )


def install_linux(ext_id):
    manifest = {
        "name": NATIVE_HOST_NAME,
        "description": "HLS Grabber native host",
        "path": HOST_SCRIPT,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"]
    }

    manifest_dir = os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts")
    os.makedirs(manifest_dir, exist_ok=True)
    manifest_path = os.path.join(manifest_dir, f"{NATIVE_HOST_NAME}.json")

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Make host.py executable
    st = os.stat(HOST_SCRIPT)
    os.chmod(HOST_SCRIPT, st.st_mode | stat.S_IEXEC)

    print(f"\n✓ Manifest written to: {manifest_path}")
    print(f"✓ host.py made executable")
    print(f"\nRestart Chrome and test the extension!")


def main():
    print("=== HLS Grabber Native Host Installer ===\n")

    # Check ffmpeg
    if not shutil.which("ffmpeg"):
        print("WARNING: ffmpeg not found in PATH. Make sure it's installed.")
    else:
        print("✓ ffmpeg found")

    ext_id = get_extension_id()
    if not ext_id:
        print("ERROR: Extension ID required")
        sys.exit(1)

    # Detect if running in WSL
    is_wsl = os.path.exists("/proc/version") and "microsoft" in open("/proc/version").read().lower()

    if is_wsl:
        print("\nDetected WSL environment — installing for Windows Chrome...")
        install_windows(ext_id)
    elif sys.platform == "win32":
        print("\nDetected native Windows — installing for Google Chrome...")
        install_native_windows(ext_id)
    else:
        print("\nInstalling for Linux Chrome...")
        install_linux(ext_id)

    print(
        "\n--- YouTube (yt-dlp) ---\n"
        "Music videos need JavaScript challenge solving (EJS). Install:\n"
        f'  "{sys.executable}" -m pip install -U "yt-dlp[default]"\n'
        "Plus one JS runtime on your PATH (pick one):\n"
        "  Node.js  https://nodejs.org   or   Deno  https://docs.deno.com/runtime/getting_started/installation/\n"
        "More info: https://github.com/yt-dlp/yt-dlp/wiki/EJS\n"
    )


if __name__ == "__main__":
    main()