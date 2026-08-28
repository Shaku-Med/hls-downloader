#!/bin/sh
# Launcher for macOS and Linux.
set -u

cd "$(dirname "$0")/.." || exit 1

is_ok_python() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)' >/dev/null 2>&1
}

PYCMD=""
for candidate in python3 python /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 && is_ok_python "$candidate"; then
        PYCMD="$candidate"
        break
    fi
done

if [ -z "$PYCMD" ]; then
    echo "Python 3.9 or newer was not found."
    echo "  macOS:  brew install python"
    echo "  Linux:  sudo apt-get install -y python3 python3-tk"
    exit 1
fi

if ! "$PYCMD" -c 'import tkinter' >/dev/null 2>&1; then
    echo "Python is missing tkinter, which the window needs."
    echo "  Debian or Ubuntu:  sudo apt-get install -y python3-tk"
    echo "  Fedora:            sudo dnf install -y python3-tkinter"
    exit 1
fi

exec "$PYCMD" -m screen_recorder
