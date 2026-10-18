#!/bin/sh
set -u

cd "$(dirname "$0")/.." || exit 1

ERRLOG="${TMPDIR:-/tmp}/stuff-grabber-install-error.log"
PYCMD=""

is_ok_python() {
    "$1" -c 'import sys, tkinter; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)' >/dev/null 2>&1
}

find_python() {
    PYCMD=""
    for candidate in python3 python /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
        if command -v "$candidate" >/dev/null 2>&1 && is_ok_python "$candidate"; then
            PYCMD="$candidate"
            return 0
        fi
    done
    return 1
}

sudo_prefix() {
    if [ "$(id -u)" = "0" ]; then
        printf ''
    elif command -v sudo >/dev/null 2>&1; then
        printf 'sudo'
    else
        printf ''
    fi
}

manual_help() {
    reason="$1"
    os_name="$(uname -s)"
    echo ""
    echo "---------------------------------------------------------------"
    echo " Could not set up Python automatically."
    echo " Reason: $reason"
    echo ""
    if [ "$os_name" = "Darwin" ]; then
        echo " You can install it yourself:"
        echo "   1. Install Homebrew from https://brew.sh"
        echo "   2. Run:  brew install python"
        echo "   3. Or download an installer from"
        echo "      https://www.python.org/downloads/macos/"
        echo "   4. Open a new terminal, then run:"
        echo "      sh auto_download/run.sh"
    else
        echo " You can install it yourself with your package manager."
        echo " Include the tk package so the window can open:"
        echo "   Debian or Ubuntu:  sudo apt-get install -y python3 python3-pip python3-tk"
        echo "   Fedora or RHEL:    sudo dnf install -y python3 python3-pip python3-tkinter"
        echo "   Arch:              sudo pacman -S --noconfirm python python-pip tk"
        echo "   openSUSE:          sudo zypper --non-interactive install python3 python3-pip python3-tk"
        echo "   Alpine:            sudo apk add --no-cache python3 py3-pip python3-tkinter"
        echo "   Then run:  sh auto_download/run.sh"
    fi
    echo "---------------------------------------------------------------"
    echo ""
    {
        echo "Stuff Grabber install error"
        echo "Reason: $reason"
        echo "System: $(uname -a)"
        echo ""
        echo "Install Python 3.9 or newer with tkinter, then run auto_download/run.sh again."
    } > "$ERRLOG" 2>/dev/null && echo "Error log saved to: $ERRLOG"
    echo ""
}

install_command() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if command -v brew >/dev/null 2>&1; then
            echo "brew install python"
            return 0
        fi
        return 1
    fi
    sudo_cmd="$(sudo_prefix)"
    if command -v apt-get >/dev/null 2>&1; then
        echo "$sudo_cmd apt-get install -y python3 python3-pip python3-venv python3-tk"
    elif command -v dnf >/dev/null 2>&1; then
        echo "$sudo_cmd dnf install -y python3 python3-pip python3-tkinter"
    elif command -v pacman >/dev/null 2>&1; then
        echo "$sudo_cmd pacman -S --noconfirm python python-pip tk"
    elif command -v zypper >/dev/null 2>&1; then
        echo "$sudo_cmd zypper --non-interactive install python3 python3-pip python3-tk"
    elif command -v apk >/dev/null 2>&1; then
        echo "$sudo_cmd apk add --no-cache python3 py3-pip python3-tkinter"
    else
        return 1
    fi
    return 0
}

offer_install() {
    echo ""
    echo "No usable Python was found."
    echo "Stuff Grabber needs Python 3.9 or newer with tkinter so the window can open."
    echo ""

    cmd="$(install_command)" || {
        manual_help "No supported package manager was found."
        return 1
    }

    echo "I can install Python for you with this command:"
    echo ""
    echo "    $cmd"
    echo ""
    printf 'Install Python now? [y/N] '
    read -r answer
    case "$answer" in
        y | Y | yes | YES) ;;
        *)
            echo ""
            echo "Okay, nothing was installed."
            manual_help "You chose not to install Python."
            return 1
            ;;
    esac

    echo ""
    echo "Installing Python..."
    echo ""
    if [ "$(uname -s)" = "Darwin" ]; then
        NONINTERACTIVE=1 sh -c "$cmd"
    else
        DEBIAN_FRONTEND=noninteractive sh -c "$cmd"
    fi
    rc=$?
    if [ "$rc" -ne 0 ]; then
        manual_help "The install command failed with exit code $rc."
        return 1
    fi

    echo ""
    echo "Checking the new Python install..."
    if ! find_python; then
        manual_help "The install finished, but no working Python 3.9+ with tkinter was found."
        return 1
    fi
    echo "Python looks good: $PYCMD"
    echo ""
    return 0
}

if ! find_python; then
    offer_install || exit 1
fi

echo "Using Python: $PYCMD"
echo ""
exec "$PYCMD" -m auto_download
