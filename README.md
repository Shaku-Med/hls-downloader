Stuff Grabber

Personal use only. This is not on the Chrome Web Store, the Edge Add ons store, Firefox Add-ons (AMO), or any other store. Use it by cloning the GitHub repo and loading it yourself.

It works in Chromium based browsers (Google Chrome, Microsoft Edge, Brave, Opera, and similar) as an unpacked extension, and in Firefox as a temporary add-on for personal use. Firefox temporary add-ons go away when you quit Firefox, so you load it again next time. That is expected for this personal setup.

The extension watches what a page loads when a video or track plays, then hands the useful links to a small helper on your computer. That helper is a Python program. It runs ffmpeg and yt-dlp so the file can land on your disk. The extension alone cannot save files, so you have to install the helper once.


Auto Download GUI

Easiest way to get the tools. From this folder run:

```text
python -m auto_download
```

On Windows you can also double click:

```text
auto_download\run.bat
```

You need Python 3 already installed so the window can open. The app checks helper tools like ffmpeg, yt-dlp, Deno, and Node. If something is missing, it shows the exact install command and asks you to Allow or Deny before anything runs. Prerequisites are checked first, so a package will not try to install until what it needs is ready. Errors show in the log and in a popup.

After the tools are ready, keep going with Load the extension and Install the helper below.


Install everything first

Do these before you expect downloads to work if you are installing by hand instead of using Auto Download.


1. A supported browser

Install one of these and use that browser for Stuff Grabber:

```text
Google Chrome
Microsoft Edge
Brave
Opera
Firefox
```

Any Chromium based browser with unpacked extension support should be fine. Firefox is supported for personal use via temporary add-on load (see Load the extension below).


2. Python 3

Install Python 3 from python.org if you can. During setup on Windows, turn on the option that adds Python to PATH.

Check that a terminal can see it:

```text
python --version
```

or:

```text
py -3 --version
```

You also need pip with that same Python:

```text
python -m pip --version
```


3. ffmpeg

ffmpeg is required for HLS, DASH, and a lot of remux work. Check if you already have it:

```text
ffmpeg -version
```

If that fails, install it.

On Windows with winget:

```text
winget install Gyan.FFmpeg
```

On Windows with Chocolatey:

```text
choco install ffmpeg
```

On macOS with Homebrew:

```text
brew install ffmpeg
```

On Debian or Ubuntu:

```text
sudo apt install ffmpeg
```

Close the terminal and open a new one after installing, then run `ffmpeg -version` again.


4. yt-dlp

yt-dlp is required for YouTube, Instagram, Spotify, Apple Music page downloads, and other social style sites. The install script below puts yt-dlp into the same Python the helper uses. You can also install it yourself the old way from this folder:

```text
python -m pip install -r requirements.txt
```

or:

```text
python -m pip install -U yt-dlp
```

Check it:

```text
python -m yt_dlp --version
```


5. A JavaScript runtime for YouTube (recommended)

For a lot of YouTube downloads, yt-dlp wants Deno or Node on your PATH. Install one of them if YouTube keeps failing with challenge or solver style errors.

Deno:

```text
winget install DenoLand.Deno
```

or see the Deno install docs for your OS.

Node:

```text
winget install OpenJS.NodeJS.LTS
```

or install Node from nodejs.org.


6. This project folder

Clone the repo from GitHub, then keep this Stuff Grabber folder somewhere stable on disk. If you move it later, you have to run the helper installer again.


Load the extension

Chromium (stays loaded until you remove it)

1. Open the extensions page in your Chromium browser:

Google Chrome or Brave:

```text
chrome://extensions
```

Microsoft Edge:

```text
edge://extensions
```

Opera:

```text
opera://extensions
```

2. Turn on Developer mode.
3. Click Load unpacked.
4. Choose this folder, the one that contains `manifest.json` (Chromium uses `manifest.json`; Firefox uses `manifest.firefox.json`).

The browser shows an Extension ID under the name. Copy that full ID. You need it when you run the helper installer.


Firefox (personal temporary add-on)

1. Open:

```text
about:debugging#/runtime/this-firefox
```

2. Click Load Temporary Add-on.
3. Choose `manifest.firefox.json` in this folder (not `manifest.json`). Chromium browsers reject Firefox’s `background.scripts` field, so Firefox uses its own manifest file.

Firefox will unload the add-on when you quit the browser. Load it again the same way next time. That is the supported personal Firefox path. The Firefox id is fixed as `stuff-grabber@local`, so you do not paste a Firefox id into the installer.


Install the helper

Open a terminal in this folder and run:

```text
python python/install.py
```

It will ask for your Chromium Extension ID (from Load unpacked). You can also pass that ID on the same line:

```text
python python/install.py YOUR_EXTENSION_ID
```

One run registers the native host for both Google Chrome and Firefox. The Firefox side uses the fixed id `stuff-grabber@local`. The script also installs or updates yt-dlp for that Python and checks for ffmpeg. On Windows it may try winget for ffmpeg if ffmpeg is missing.

You can still load the unpacked extension in Edge, Brave, and other Chromium browsers. If downloads do not start from those browsers, use Google Chrome for the download step, or re run the installer after loading the extension there.

When it finishes, fully quit the browser and open it again so the helper connects. Closing one tab is not enough. On Firefox, after a full quit you will also need to Load Temporary Add-on again.

Use the same Python you want the helper to keep using. If you have more than one Python, run the installer with the exact one you care about.

On Windows you can set a user environment variable named `HLS_GRABBER_PYTHON` to a full path to `python.exe` if you want to lock which Python the helper uses.

If you reload the Chromium extension and the ID changes, run the installer again with the new ID:

```text
python python/install.py YOUR_EXTENSION_ID
```

If you move this folder to a new place on disk, run the installer again too.


Pick a save folder

Open the extension Options. Paste a full folder path on your computer where you want files to go, for example:

```text
C:\Users\You\Videos\Grabs
```

The helper will create the folder if it is missing, as long as your user account can write there.


How to download a normal video

Go to the page and start playback for a moment so the browser starts fetching media. Open the Stuff Grabber popup or the floating panel. You should see one or more entries for that tab.

For many sites you want a playlist style link that ends in `.m3u8`, or a clear `.mp4` style link, not a pile of tiny segment files. Type a file name if you want, or leave the default. You do not need to type `.mp4` yourself. Hit Download.

A few jobs can run at once and the rest wait in line. You can close the popup while downloads keep going.


How to download YouTube and similar pages

On YouTube and a bunch of other social sites, Stuff Grabber offers a page download instead of chasing every CDN blob. That row uses the page URL and sends it to yt-dlp. Pick Download this video, name the file if you want, and go.

If the page looks like a playlist, you may get asked whether you want one video or the whole playlist.


How to download Apple Music

Open a song, album, or playlist page on `music.apple.com`. Stuff Grabber should show Download this track with that page link. It works like YouTube here. The helper sends the `music.apple.com` page URL to yt-dlp.

Do not expect the raw Apple stream links to work. Those are usually locked with FairPlay, so the extension ignores them on purpose and sticks to the page URL. If Apple or yt-dlp cannot give you a real file, the download fails with an error instead of leaving a silent unplayable file.


Spotify

On Spotify web you can paste or use a track style URL and try an audio extract through yt-dlp. A lot of Spotify sources are protected, so this often fails or falls back to a YouTube search for the same title. That is a site limit, not something the extension can crack.


Where things can fail

Some sites wrap media in DRM. Netflix and similar services are a good example. The extension might see a manifest, but the segments stay encrypted and neither ffmpeg nor yt-dlp can unlock them. Use the official offline download from that service, or grab something that is not DRM locked.

Some pages only play inside workers or blob URLs that never show up as a normal request. In those cases the list stays empty. Play the media, wait a second, and open the popup again. If it is still empty, that page may simply not expose anything we can catch.


If something feels broken

Native host missing or downloads never start. Run this again with the current Chromium Extension ID, then fully restart the browser. On Firefox, load the temporary add-on again after restart:

```text
python python/install.py YOUR_EXTENSION_ID
```

Make sure you did not move the project folder without reinstalling. If you are on Edge or Brave and the helper never connects, try Google Chrome, since the installer currently registers the host for Chrome.

ffmpeg not found. Install ffmpeg, put it on PATH, open a new terminal, then check:

```text
ffmpeg -version
```

yt-dlp missing or stale for the helper Python:

```text
python -m pip install -U yt-dlp
python -m yt_dlp --version
```

Then run `python python/install.py` again with the same Python.

Saves fail with path or permission errors. Change the Options folder to a place your user can write.

The list is noisy. Pick the page download when you see one, or pick the main playlist style URL and ignore the tiny junk links.


Optional icon rebuild

If you replace `asset/icon.png` and have ffmpeg available, on Windows you can run:

```text
asset\build-icons.cmd
```

That refreshes the icon sizes the manifest uses.


Tests

From this folder:

```text
python -m unittest discover test
```

That only checks helper logic. It does not open a browser.


Quick checklist

Before first use you should have:

```text
A Chromium browser (Chrome, Edge, Brave, or similar)
Python 3 with pip
ffmpeg on PATH
yt-dlp installed for that Python
Deno or Node on PATH if you care about YouTube
This repo cloned and the folder loaded as an unpacked extension
python python/install.py run with your Extension ID
A save folder set in Options
Browser fully restarted after install
```

That is the whole loop. Clone the repo, load the unpacked extension in a Chromium browser, install the helper once, set a save folder, play the media, download from the popup. The heavy lifting lives in `python/host.py` if you ever want to poke around.
