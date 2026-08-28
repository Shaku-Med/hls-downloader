Screen recorder

A native screen recorder with a floating control bar, in the same style as the
rest of Stuff Grabber. It captures through ffmpeg, which this project already
needs, so the app itself uses nothing beyond the Python standard library.


Running it

There are three ways in. Pick whichever suits.


1. From the extension, when a site protects its video

This is the usual one. Open the Stuff Grabber popup or the floating panel on a
site like Netflix and you get a card saying the video is protected, with a
button that opens the recorder for you. Nothing to install separately, as long
as the PC helper is already set up.

That works because the browser cannot start a program on its own. The extension
asks the helper, and the helper opens the recorder.


2. Double click the launcher

On Windows:

```text
screen_recorder\run.bat
```

On macOS or Linux:

```text
sh screen_recorder/run.sh
```

The launchers find a suitable Python for you and say what is missing if they
cannot.


3. Straight from the command line

From the project folder:

```text
python -m screen_recorder
```


What you need

```text
Python 3.9 or newer
ffmpeg on PATH
tkinter (Linux packages this separately as python3-tk)
```

Check the first two quickly:

```text
python --version
ffmpeg -version
```

If ffmpeg is missing, the recorder still opens but will not capture, and the
settings window says so. Install it with `winget install Gyan.FFmpeg` on
Windows, `brew install ffmpeg` on macOS, or your package manager on Linux.


The bar

A small frameless bar sits on top of everything, and any part of it that is not
a button drags it.

```text
drag | record  00:14 | screen  area | sound |  mic | | settings  close
```

Grouped rather than laid out as one long row of buttons: what to capture, what
to listen to, then everything else. Beside each of the two sound toggles is a
small level meter, so you can see sound arriving while you record instead of
finding out afterwards that the file was silent.

The whole bar is a drag handle, not just the dots on the left.


What is on screen while it runs

A border marks the capture area from the moment the recorder opens, so what is
about to be recorded is never a guess. It never shows at the same time as the
area selector, which draws its own box. Blue while idle, red while recording, and
around the whole screen in full screen mode. It ignores the mouse completely, so
it never intercepts a click, and it is kept out of the recording.

The area cannot be moved once recording has started. Press stop, adjust, start
again.

The countdown is a large panel in the middle of the screen with a Cancel button,
rather than a small number tucked into the bar.


What it can record

Full screen. Pick which monitor in settings when you have more than one.

An area. Click the dotted square and drag out a box; the size is shown as you
go. The box stays live after you let go, so you can keep adjusting it: drag
inside to move it, drag an edge or a corner to resize, or drag out a new box
somewhere else. There is no key to press and no hint bar telling you which one.

It stays editable until you actually start recording, which is the moment it
locks in. The bar is on screen the whole time, so pressing record settles the
area and begins. Pressing the area button again settles it without recording. A
stray click leaves the box alone rather than throwing it away. The box is
remembered between sessions.

An area recording is saved on a full screen canvas, with the area sitting where
it was and black around it, rather than as a file the size of the box. Play a
small area back as its own file and it fills the player, so everything looks
blown up and moved compared to what you saw. Keeping it in place keeps the point
of view. Only the area is actually captured, so this costs nothing while
recording.

Sound from the computer, meaning whatever you are hearing. On by default,
because a screen recording with no sound is rarely what anyone wanted, and it is
the whole point on sites whose video cannot be downloaded. Nothing to install.

The microphone, as a separate toggle. Choose which input in settings. With both
on they are mixed into one track, with a limiter so the two together cannot clip.


Quality

Three presets, which map to real encoder settings rather than vague labels:

```text
High        crf 18   crisp, larger files
Balanced    crf 23
Smaller     crf 28
```

Frame rate is 24, 30 or 60. 60 is fine for a small area but not for a whole
1080p screen, where the grabber tops out around 43. Everything is written as
h264 in an mp4 with the index at the front, so the file opens straight away and
plays anywhere.


Why recordings are not stuttery

Two things were making them stutter, and both are worth knowing about.

The first and by far the larger: ffmpeg was pacing the video against the audio
clock. Turning sound on dropped a 1080p30 capture from 29 frames a second to
about 3, because a live audio input arrives in jittery bursts and the video
timeline was following it. Pinning the output with `-fps_mode cfr` puts it back
to a steady 30:

```text
with sound, before      3.3 fps
with sound, after      30.0 fps
without sound          30.0 fps
```

The second: the encoder competes with the capture for the same CPU, and every
cycle it takes is a frame that never gets grabbed. Over 8 seconds of 1080p30,
out of 240 frames:

```text
ultrafast   240 captured, none dropped
superfast   239, 1 dropped
veryfast    237, 3 dropped
faster      234, 6 dropped
```

So all the presets encode fast and quality comes from the CRF instead. The old
"smaller file" setting used "faster", which despite the name is slower than
"veryfast" in x264, and so made the cheapest looking option the most likely to
stutter.

Hardware encoding was measured and rejected. Quick Sync works on this machine
but managed 84 frames where software managed 240, because every frame has to be
copied to the GPU first. NVENC and AMF are listed by ffmpeg but fail on any
machine without that hardware, so listing them proves nothing.


Where recordings go

When the extension starts the recorder, straight into the save folder you set in
Options, so recordings sit with the rest of your grabs instead of in a second
place you have to remember. Started on its own, it uses your Videos folder in a
Screen Recordings subfolder. Either way you can change it in settings, and the
name is the date and time. When a recording finishes a small card appears with
the file name and a button to show it in your file manager.

You can also point it anywhere from the command line:

```bash
python -m screen_recorder --output-dir "D:\Grabs"
```


Notes

The bar stays on screen and stays clickable the whole time you are recording, so
Stop is always one click away, but it is left out of the capture. Same for the
settings window and the little cards. That is a Windows feature, so on macOS and
Linux the bar is visible in the recording and is best parked outside the area
you are capturing.

Settings that cannot change part way through a take, like the source and the
microphone, say so if you press them rather than going grey and unreadable.

Recording what you hear is done differently on each platform, because ffmpeg has
no loopback input of its own on Windows:

```text
Windows   captured through WASAPI loopback and passed to ffmpeg over a pipe.
          Nothing to install, and no need for Stereo Mix or a virtual cable.
Linux     the PulseAudio monitor source of your default output. Nothing to
          install.
macOS     not possible on its own. Apple ships no loopback device, so install a
          free driver such as BlackHole and the recorder will pick it up. Until
          then the toggle explains why it is unavailable rather than recording
          silence.
```

Stopping asks ffmpeg to finish rather than killing it. That matters: an mp4 that
is killed part way through has no index and most players refuse to open it.

Settings live in your user config folder, so they survive updates:

```text
Windows   %APPDATA%\stuff-grabber-recorder\settings.json
macOS     ~/Library/Application Support/stuff-grabber-recorder/settings.json
Linux     ~/.config/stuff-grabber-recorder/settings.json
```

On macOS the system asks for screen recording permission the first time, and
the app will not capture until you grant it in System Settings under Privacy
and Security. On Wayland, x11grab does not work; run under Xorg for now.
