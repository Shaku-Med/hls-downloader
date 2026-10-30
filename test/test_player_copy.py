#!/usr/bin/env python3
"""
Tests for rebuilding a video from the copy the player already loaded.
Run from the repo root:  python -m unittest discover test
"""

import base64
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

import host  # noqa: E402
import player_copy  # noqa: E402

BASE = "https://cdn.example/v/"


def playlist(names, durs=None, init="", finished=True):
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4"]
    if init:
        lines.append(f'#EXT-X-MAP:URI="{init}"')
    for i, n in enumerate(names):
        lines.append(f"#EXTINF:{(durs or [4.0] * len(names))[i]},")
        lines.append(n)
    if finished:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def part(role, index, name, data):
    return (role, index, BASE + name, data)


class ReadingTheParts(unittest.TestCase):
    def _feed(self, msgs):
        it = iter(msgs)
        return lambda: next(it, None)

    def test_chunks_are_joined_in_order_and_keep_their_url(self):
        raw = b"0123456789"
        msgs = [
            {"type": "player_copy_playlists", "jobId": "j", "playlists": [{"url": BASE + "a.m3u8", "text": "#EXTM3U"}]},
            {"type": "player_copy_part", "jobId": "j", "role": "segment", "index": 0, "url": BASE + "s0.ts",
             "chunkIndex": 1, "base64": base64.b64encode(raw[5:]).decode()},
            {"type": "player_copy_part", "jobId": "j", "role": "segment", "index": 0, "url": BASE + "s0.ts",
             "chunkIndex": 0, "base64": base64.b64encode(raw[:5]).decode()},
            {"type": "player_copy_end", "jobId": "j"},
        ]
        parts, playlists, state = player_copy._take_parts(self._feed(msgs), "j")
        self.assertEqual(state, "ok")
        self.assertEqual(parts, [("segment", 0, BASE + "s0.ts", raw)])
        self.assertEqual(playlists, [(BASE + "a.m3u8", "#EXTM3U")])

    def test_cancel_is_reported_as_cancel(self):
        _, _, state = player_copy._take_parts(self._feed([{"type": "cancel", "jobId": "j"}]), "j")
        self.assertEqual(state, "canceled")

    def test_an_aborted_transfer_is_not_a_cancel(self):
        _, _, state = player_copy._take_parts(
            self._feed([{"type": "player_copy_end", "jobId": "j", "abort": True}]), "j")
        self.assertEqual(state, "aborted")


class OneStreamInPlaylistOrder(unittest.TestCase):
    """
    A tab can load an ad, another video, or the same video at another quality.
    Joining everything captured mixes them into a file that will not play.
    """

    MAIN = playlist(["m0.ts", "m1.ts", "m2.ts", "m3.ts"])
    AD = playlist(["ad0.ts", "ad1.ts"])

    def test_the_ad_is_dropped_and_the_order_is_the_playlists(self):
        parts = [
            part("segment", 0, "m2.ts", b"M2"),
            part("segment", 1, "ad0.ts", b"AD0"),
            part("segment", 2, "m0.ts", b"M0"),
            part("segment", 3, "m1.ts", b"M1"),
            part("segment", 4, "m3.ts", b"M3"),
        ]
        inits, segs, note, err = player_copy._choose_stream(
            parts, [(BASE + "ad.m3u8", self.AD), (BASE + "main.m3u8", self.MAIN)])
        self.assertEqual(err, "")
        self.assertEqual(segs, [b"M0", b"M1", b"M2", b"M3"])
        self.assertEqual(note, "")

    def test_a_partial_copy_says_how_much_it_is(self):
        parts = [part("segment", 0, "m0.ts", b"M0"), part("segment", 1, "m1.ts", b"M1")]
        _, segs, note, _ = player_copy._choose_stream(parts, [(BASE + "main.m3u8", self.MAIN)])
        self.assertEqual(segs, [b"M0", b"M1"])
        self.assertEqual(note, "Saved 0:08 of 0:16, the part the player had loaded")

    def test_a_hole_in_the_middle_is_called_out(self):
        parts = [part("segment", 0, "m0.ts", b"M0"), part("segment", 1, "m3.ts", b"M3")]
        _, _, note, _ = player_copy._choose_stream(parts, [(BASE + "main.m3u8", self.MAIN)])
        self.assertTrue(note.endswith(", with gaps"), note)

    def test_the_init_of_the_chosen_stream_only(self):
        hi = playlist(["h0.m4s", "h1.m4s"], init="hi-init.mp4")
        lo = playlist(["l0.m4s"], init="lo-init.mp4")
        parts = [
            part("init", 0, "lo-init.mp4", b"LOINIT"),
            part("init", 1, "hi-init.mp4", b"HIINIT"),
            part("segment", 0, "l0.m4s", b"L0"),
            part("segment", 1, "h0.m4s", b"H0"),
            part("segment", 2, "h1.m4s", b"H1"),
        ]
        inits, segs, _, err = player_copy._choose_stream(
            parts, [(BASE + "lo.m3u8", lo), (BASE + "hi.m3u8", hi)])
        self.assertEqual(err, "")
        self.assertEqual(inits, [b"HIINIT"])
        self.assertEqual(segs, [b"H0", b"H1"])

    def test_a_stream_whose_init_was_never_caught_is_refused(self):
        fmp4 = playlist(["h0.m4s"], init="hi-init.mp4")
        _, _, _, err = player_copy._choose_stream(
            [part("segment", 0, "h0.m4s", b"H0")], [(BASE + "hi.m3u8", fmp4)])
        self.assertIn("missing the start", err)

    def test_without_any_playlist_it_keeps_the_order_they_came_in(self):
        parts = [part("segment", 0, "x1.ts", b"X1"), part("segment", 1, "x0.ts", b"X0")]
        _, segs, note, err = player_copy._choose_stream(parts, [])
        self.assertEqual((segs, note, err), ([b"X1", b"X0"], "", ""))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
class RebuildsAPlayableFile(unittest.TestCase):
    """End to end through collect_player_copy and the real remux."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        src = os.path.join(cls.dir, "src")
        os.makedirs(src)
        for name, seconds, colour in (("main", 16, "blue"), ("ad", 8, "red")):
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error",
                 "-f", "lavfi", "-i", f"color=c={colour}:size=320x180:rate=25:duration={seconds}",
                 "-f", "lavfi", "-i", f"sine=duration={seconds}",
                 "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-c:a", "aac",
                 "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
                 "-hls_segment_filename", os.path.join(src, f"{name}%d.ts"),
                 os.path.join(src, f"{name}.m3u8")],
                check=True, capture_output=True,
            )
        cls.src = src

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def _read(self, name):
        with open(os.path.join(self.src, name), "rb") as fh:
            return fh.read()

    def _run(self, order):
        msgs = [{
            "type": "player_copy_playlists", "jobId": "pc",
            "playlists": [
                {"url": BASE + "ad.m3u8", "text": self._read("ad.m3u8").decode()},
                {"url": BASE + "main.m3u8", "text": self._read("main.m3u8").decode()},
            ],
        }]
        for i, name in enumerate(order):
            msgs.append({"type": "player_copy_part", "jobId": "pc", "role": "segment", "index": i,
                         "url": BASE + name, "chunkIndex": 0,
                         "base64": base64.b64encode(self._read(name)).decode()})
        msgs.append({"type": "player_copy_end", "jobId": "pc"})
        it = iter(msgs)
        sent = []
        out_dir = os.path.join(self.dir, "out")
        done = threading.Event()

        def send(m):
            sent.append(m)
            if m.get("type") == "done":
                done.set()

        saved = host.send_message
        host.send_message = send
        try:
            player_copy.collect_player_copy(
                {"type": "player_copy", "jobId": "pc", "filename": "pc", "outputDirectory": out_dir},
                {
                    "read": lambda: next(it, None), "send": send, "job": host.with_job_id,
                    "remux": host._ffmpeg_remux_combined_to_output, "dir": host._resolve_output_dir,
                    "path": host._resolve_output_path, "cancel": threading.Event(),
                },
            )
            self.assertTrue(done.wait(120), "never finished")
        finally:
            host.send_message = saved
        return [m for m in sent if m.get("type") == "done"][-1], out_dir

    def test_scrambled_with_an_ad_it_keeps_only_the_video_and_says_it_is_partial(self):
        # The player fetched part of the video out of order, with an ad in between.
        done, out_dir = self._run(["main2.ts", "ad0.ts", "main0.ts", "ad1.ts", "main1.ts"])
        self.assertTrue(done.get("success"), done.get("error"))
        self.assertEqual(done.get("detail"), "Saved 0:12 of 0:16, the part the player had loaded")
        out = os.path.join(out_dir, os.listdir(out_dir)[0])
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
            capture_output=True, text=True).stdout.strip())
        # 12 seconds of the video; the 8 second ad would have made it 20.
        self.assertAlmostEqual(dur, 12.0, delta=0.6)

    def test_the_whole_video_is_just_saved(self):
        done, _ = self._run(["main0.ts", "main1.ts", "main2.ts", "main3.ts"])
        self.assertTrue(done.get("success"), done.get("error"))
        self.assertEqual(done.get("detail"), "Finished")


class CancelWhileCollecting(unittest.TestCase):
    def test_it_says_canceled_not_that_the_video_was_missing(self):
        sent = []
        player_copy.collect_player_copy(
            {"type": "player_copy", "jobId": "c"},
            {
                "read": iter([{"type": "cancel", "jobId": "c"}]).__next__, "send": sent.append,
                "job": host.with_job_id, "remux": None, "dir": None, "path": None,
                "cancel": threading.Event(),
            },
        )
        done = [m for m in sent if m.get("type") == "done"][-1]
        self.assertTrue(done.get("canceled"))
        self.assertEqual(done.get("error"), "Canceled")


class TheFirstFailureIsNotHidden(unittest.TestCase):
    def test_both_reasons_reach_the_card(self):
        sent = []
        player_copy.collect_player_copy(
            {"type": "player_copy", "jobId": "e", "playerCopyFirstError": "HTTP Error 403: Forbidden."},
            {
                "read": iter([{"type": "player_copy_end", "jobId": "e"}]).__next__, "send": sent.append,
                "job": host.with_job_id, "remux": None, "dir": None, "path": None,
                "cancel": threading.Event(),
            },
        )
        error = [m for m in sent if m.get("type") == "done"][-1]["error"]
        self.assertTrue(error.startswith("HTTP Error 403: Forbidden."), error)
        self.assertIn("did not have the video", error)


class FirefoxRootStaysRight(unittest.TestCase):
    """
    setup_browser_roots.py rewrites both manifests. It dropped the fallback
    from Firefox's background scripts and handed Firefox Chrome's debugger
    permission, which Firefox does not have.
    """

    def test_regenerated_manifests(self):
        import json
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        root = os.path.join(HERE, "..")
        for d in ("python", "chromium", "firefox", "public", "asset", "style"):
            os.makedirs(os.path.join(work, d))
        shutil.copy(os.path.join(root, "python", "setup_browser_roots.py"), os.path.join(work, "python"))
        shutil.copy(os.path.join(root, "chromium", "manifest.json"), os.path.join(work, "chromium"))
        subprocess.run([sys.executable, os.path.join(work, "python", "setup_browser_roots.py")],
                       check=True, capture_output=True)
        with open(os.path.join(work, "firefox", "manifest.json"), encoding="utf-8") as fh:
            ff = json.load(fh)
        scripts = ff["background"]["scripts"]
        self.assertIn("public/scripts/player-copy-fallback.js", scripts)
        self.assertLess(scripts.index("public/scripts/player-copy-fallback.js"),
                        scripts.index("public/scripts/background.js"))
        self.assertNotIn("debugger", ff["permissions"])
        with open(os.path.join(work, "chromium", "manifest.json"), encoding="utf-8") as fh:
            self.assertIn("debugger", json.load(fh)["permissions"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
