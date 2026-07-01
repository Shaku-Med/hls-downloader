# Stuff Grabber (Chrome extension + little helper on your PC)

This thing watches network requests in Chrome, lists video-ish URLs it thinks look useful, then your computer actually saves the file using **ffmpeg** through a small **Python** program (the "native host"). The extension by itself can not write to disk, which is why that extra step exists.

## What you need first

- **Google Chrome** (or Chromium-based browser that still supports the same extension + native messaging stuff, your mileage may vary)
- **Python 3** on your machine, and `python` / `py` in PATH so a terminal can start it
- **ffmpeg** for HLS/DASH work. The installer checks for it and tries to grab it on Windows if you have winget, so you usually do not have to do this by hand.
- **yt-dlp** for YouTube, Instagram and other social sites. The installer puts this in for you too.

## Get the extension loaded

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggles in the corner somewhere)
3. Click **Load unpacked** and point it at this folder, the one that has `manifest.json` in it

Chrome will show you a random-looking **extension ID** under the extension name. Copy the whole id string, you need it for the installer.

## One command install (does everything)

The extension only talks to Chrome. A small **host** on your PC is what runs ffmpeg and yt-dlp. One script sets all of it up: it registers the host, installs yt-dlp into the right Python, and checks or installs ffmpeg.

From a terminal, `cd` into this folder and run it with the Python you want the host to use:

```text
python python/install.py
```

It asks for the extension ID you copied. You can also pass it straight in so nothing is interactive:

```text
python python/install.py YOUR_EXTENSION_ID
```

Then **fully quit and reopen Chrome** (not just a tab) so it picks up the host.

**Which Python matters.** The host uses whatever Python you run `install.py` with, and yt-dlp gets installed into that same one. So if you have more than one Python, run the installer with the exact `python.exe` you want the extension to use. On Windows the wrapper honors a `HLS_GRABBER_PYTHON` user env var if you would rather point it at a specific `python.exe`.

If you **reload the extension** or get a new ID, run `python python/install.py` again with the new id. If you ever bump yt-dlp on the wrong Python and it still looks old, just run the installer again with the correct one.

## Where files save

1. Open the extension **Options** (right click the icon, or from the card on `chrome://extensions`, etc.)
2. Paste a **full folder path** on your computer, like `C:\Users\You\Videos\HLS` or similar
3. It saves to Chrome storage as you go (you can change it later)

The Python host will create the folder if it is missing, but the path has to be valid for your user.

## Actually using it

- Go to a page that plays a video and let it start
- Open the extension popup. It tries to list streams it saw for **that tab**
- For something with HLS, you usually want a line that looks like a **.m3u8** (or a single good **.mp4** link) rather than random tiny segment files
- Type a file name (no .mp4 needed, it will still output mp4) or leave the default, hit **Download**
- A few jobs can run at once, the rest queue; you can close the popup and it should keep chugging in the background

It is not magic. Some sites use DRM, blob URLs, or only pull video inside workers, so there will be nothing to catch. That is a limitation of this approach, not you.

**Netflix, Disney+, Prime Video, etc.** use **Widevine DRM**. The extension may detect manifest URLs on those sites, but segments are encrypted and **cannot** be saved by ffmpeg or yt-dlp. Use each service's official offline feature, or download from open (non-DRM) sources such as YouTube trailers.

## Regenerating icons (optional)

There is an `asset` folder with a master `icon.png` and fixed sizes. If you replace `asset/icon.png` and have ffmpeg in PATH, run:

- `asset\build-icons.cmd` on Windows

That overwrites the `icon-16`, `32`, `48`, `128` files the manifest points at.

## Running the tests

There is a small suite for the host logic that decides yt-dlp routing and cookie handling. From this folder run:

```text
python -m unittest discover test
```

It does not touch Chrome or your system, it just checks the pure logic, so it is safe to run anytime.

## If it feels broken

- **"Native host" errors / download never really starts**  
  Re-run `python/install.py` with the correct extension id, restart Chrome, make sure you did not move the project folder to a new path without re-installing (the host points at real paths on disk)

- **ffmpeg not found**  
  Install it, put it on PATH, open a new terminal, try `ffmpeg -version`

- **Permission / path errors**  
  The save folder in Options has to be a path your user can write to, not some random system folder

- **Too many junk URLs on some sites**  
  The extension tries to filter noise but social sites are messy; pick a playlist or obvious main url when in doubt

That is more or less it. The `python/host.py` file is the thing Chrome launches; you can read it if you are curious. Good luck
