# HLS Grabber (Chrome extension + little helper on your PC)

This thing watches network requests in Chrome, lists video-ish URLs it thinks look useful, then your computer actually saves the file using **ffmpeg** through a small **Python** program (the "native host"). The extension by itself can not write to disk, which is why that extra step exists.

## What you need first

- **Google Chrome** (or Chromium-based browser that still supports the same extension + native messaging stuff, your mileage may vary)
- **Python 3** on your machine, and `python` / `py` in PATH so a terminal can start it
- **ffmpeg** installed and on your PATH, because all the real work is basically `ffmpeg` copying the stream to an mp4 file on disk

If ffmpeg is missing the downloads will just fail in a sad way, so do that before blaming the extension.

## Get the extension loaded

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggles in the corner somewhere)
3. Click **Load unpacked** and point it at this folder, the one that has `manifest.json` in it (the `native-host` folder if you are reading this from the repo)

Chrome will show you a random-looking **extension ID** under the extension name. You need that in a second for the installer. Copy the whole id string.

## Wire up the native host (one-time)

The extension only talks to Chrome; the **host** is what runs ffmpeg. There is a script for that.

From a terminal, `cd` into this same folder and run:

```text
python install.py
```

It will ask for the extension ID you copied. On Windows it writes a small `host_wrapper.bat` and registers the JSON manifest + registry so Chrome can find the host. On Linux it drops files under your Chrome config. WSL is sort of supported but weirder, read the script comments if you live there.

After that, **fully quit and reopen Chrome** (not just a tab) so it picks up the new native messaging registration.

If you **reload the extension** or get a new ID, run `install.py` again with the new id.

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

## Regenerating icons (optional)

There is an `asset` folder with a master `icon.png` and fixed sizes. If you replace `asset/icon.png` and have ffmpeg in PATH, run:

- `asset\build-icons.cmd` on Windows

That overwrites the `icon-16`, `32`, `48`, `128` files the manifest points at.

## If it feels broken

- **"Native host" errors / download never really starts**  
  Re-run `install.py` with the correct extension id, restart Chrome, make sure you did not move the project folder to a new path without re-installing (the host points at real paths on disk)

- **ffmpeg not found**  
  Install it, put it on PATH, open a new terminal, try `ffmpeg -version`

- **Permission / path errors**  
  The save folder in Options has to be a path your user can write to, not some random system folder

- **Too many junk URLs on some sites**  
  The extension tries to filter noise but social sites are messy; pick a playlist or obvious main url when in doubt

That is more or less it. The `host.py` file is the thing Chrome launches; you can read it if you are curious. Good luck
