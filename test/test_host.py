#!/usr/bin/env python3
"""
Tests for the native host logic that decides yt-dlp routing and cookie handling.
Run from the repo root:  python -m unittest discover test
Or directly:             python test/test_host.py
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

import host  # noqa: E402


class NetscapeCookieFile(unittest.TestCase):
    def _read(self, path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def test_writes_expected_lines(self):
        jar = [
            {
                "name": "sessionid",
                "value": "ABC123",
                "domain": ".instagram.com",
                "path": "/",
                "secure": True,
                "httpOnly": True,
                "hostOnly": False,
                "session": False,
                "expirationDate": 1893456000.5,
            },
            {
                "name": "csrftoken",
                "value": "XYZ",
                "domain": "www.instagram.com",
                "path": "/",
                "secure": True,
                "httpOnly": False,
                "hostOnly": True,
                "session": True,
            },
        ]
        path = host._write_netscape_cookie_file(jar)
        self.addCleanup(host._remove_temp_file_quietly, path)
        text = self._read(path)
        self.assertIn("# Netscape HTTP Cookie File", text)
        # httpOnly cookie keeps the prefix, gets the leading dot and subdomain flag, whole expiry.
        self.assertIn(
            "#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tABC123", text
        )
        # host only cookie has no dot, no subdomain flag, and a session expiry of 0.
        self.assertIn("www.instagram.com\tFALSE\t/\tTRUE\t0\tcsrftoken\tXYZ", text)

    def test_empty_or_bad_jar_returns_none(self):
        self.assertIsNone(host._write_netscape_cookie_file([]))
        self.assertIsNone(host._write_netscape_cookie_file(None))
        self.assertIsNone(host._write_netscape_cookie_file([{"name": "", "domain": ""}]))


class CookieArgs(unittest.TestCase):
    def test_youtube_gets_no_cookies(self):
        self.assertEqual(
            host._yt_dlp_cookies_args({"cookieJar": [1]}, "https://www.youtube.com/watch?v=x"),
            [],
        )

    def test_jar_file_is_preferred(self):
        path = host._write_netscape_cookie_file(
            [{"name": "a", "value": "b", "domain": ".instagram.com"}]
        )
        self.addCleanup(host._remove_temp_file_quietly, path)
        args = host._yt_dlp_cookies_args(
            {"_ytDlpCookieFile": path}, "https://www.instagram.com/reel/x/"
        )
        self.assertEqual(args, ["--cookies", path])

    def test_falls_back_to_browser_when_no_jar(self):
        args = host._yt_dlp_cookies_args({}, "https://www.instagram.com/reel/x/")
        self.assertEqual(args, ["--cookies-from-browser", "chrome"])

    def test_browser_override_and_disable(self):
        self.assertEqual(
            host._yt_dlp_cookies_from_browser_args(
                {"ytDlpCookiesFromBrowser": "edge"}, "https://instagram.com/x/"
            ),
            ["--cookies-from-browser", "edge"],
        )
        self.assertEqual(
            host._yt_dlp_cookies_from_browser_args(
                {"ytDlpCookiesFromBrowser": "none"}, "https://instagram.com/x/"
            ),
            [],
        )


class SocialRouting(unittest.TestCase):
    def test_instagram_cdn_routes_to_ytdlp(self):
        url = "https://scontent-lga3-1.cdninstagram.com/o1/v/t2/f2/m86/AQO.mp4?_nc_cat=109"
        label = host._social_platform_for_yt_dlp(url, "https://www.instagram.com/reel/x/", {})
        self.assertTrue(label)

    def test_plain_site_is_not_social(self):
        self.assertIsNone(
            host._social_platform_for_yt_dlp(
                "https://example.com/media/movie.mp4", "https://example.com/watch", {}
            )
        )

    def test_youtube_page_detection(self):
        self.assertTrue(host._url_is_youtube_page("https://www.youtube.com/watch?v=abc"))
        self.assertTrue(host._url_is_youtube_page("https://youtu.be/abc"))
        self.assertFalse(host._url_is_youtube_page("https://www.instagram.com/reel/x/"))

    def test_netloc_host_strips_www(self):
        self.assertEqual(host._netloc_host("https://www.instagram.com/reel/x/"), "instagram.com")


class TrackNaming(unittest.TestCase):
    """Saved music should be named after the song, not after a database id."""

    def test_placeholders_are_recognised(self):
        for name in ("video", "audio", "track", "", "   ",
                     "spotify track 4cOdK2wGLETKBW3PvgPWqT",
                     "spotify album 1ATL5GLyefJaxhQzSPVrLX",
                     "4cOdK2wGLETKBW3PvgPWqT"):
            self.assertTrue(host._looks_generic_stem(name), name)

    def test_real_names_are_left_alone(self):
        for name in ("Never Gonna Give You Up",
                     "Rick Astley - Never Gonna Give You Up",
                     "my song", "Interview 2024"):
            self.assertFalse(host._looks_generic_stem(name), name)

    def test_music_stem_puts_artist_first(self):
        self.assertEqual(
            host._music_stem("Blinding Lights", ["The Weeknd"]),
            "The Weeknd - Blinding Lights",
        )

    def test_music_stem_without_artist(self):
        self.assertEqual(host._music_stem("Some Track", []), "Some Track")

    def test_music_stem_keeps_at_most_two_artists(self):
        self.assertEqual(
            host._music_stem("Song", ["A", "B", "C"]), "A, B - Song"
        )

    def test_music_stem_handles_nothing(self):
        self.assertEqual(host._music_stem("", ["A"]), "")


class MusicFallbackRouting(unittest.TestCase):
    """Which music services get the search fallback, and which must not."""

    def test_services_needing_a_fallback(self):
        for url, want in (
            ("https://music.amazon.com/albums/B08L5T7L1F", "Amazon Music"),
            ("https://music.amazon.co.uk/albums/B08L5T7L1F", "Amazon Music"),
            ("https://tidal.com/browse/track/155705159", "Tidal"),
            ("https://listen.tidal.com/album/1/track/2", "Tidal"),
            ("https://www.deezer.com/en/track/1109731", "Deezer"),
            ("https://open.spotify.com/track/abc", "Spotify"),
            ("https://music.apple.com/us/album/x/1?i=2", "Apple Music"),
            ("https://play.anghami.com/song/1", "Anghami"),
        ):
            self.assertEqual(host._music_fallback_service(url, url), want, url)

    def test_sites_yt_dlp_handles_are_left_alone(self):
        # Diverting these to a YouTube search would replace a real download
        # with a lookalike. Audiomack is excluded for its own reason.
        for url in ("https://soundcloud.com/artist/track",
                    "https://artist.bandcamp.com/track/x",
                    "https://audiomack.com/artist/song/x",
                    "https://www.youtube.com/watch?v=abc"):
            self.assertEqual(host._music_fallback_service(url, url), "", url)


class MusicTitleParsing(unittest.TestCase):
    def test_service_name_is_stripped(self):
        for raw, want in (
            ("Blinding Lights by The Weeknd on Amazon Music", "Blinding Lights by The Weeknd"),
            ("Bad Guy by Billie Eilish on TIDAL", "Bad Guy by Billie Eilish"),
            ("Take Five by Dave Brubeck | Qobuz", "Take Five by Dave Brubeck"),
        ):
            self.assertEqual(host._clean_music_page_title(raw), want)

    def test_artist_is_split_off(self):
        title, artists = host._split_title_and_artists("Numb, a song by Linkin Park")
        self.assertEqual(title, "Numb")
        self.assertEqual(artists, ["Linkin Park"])

    def test_several_artists(self):
        title, artists = host._split_title_and_artists("3 Daqat by Abu, Yousra")
        self.assertEqual(title, "3 Daqat")
        self.assertEqual(artists, ["Abu", "Yousra"])

    def test_a_plain_dash_is_not_guessed_at(self):
        # Some services put the song first, others the artist. Guessing sends
        # the search after the wrong thing, so it is left whole.
        title, artists = host._split_title_and_artists("Artist - Song")
        self.assertEqual(title, "Artist - Song")
        self.assertEqual(artists, [])

    def test_ids_are_not_mistaken_for_names(self):
        for slug in ("B08L5T7L1F", "155705159", "1109731", "aGVsbG93b3JsZDEyMzQ1"):
            self.assertTrue(host._looks_like_identifier(slug), slug)

    def test_readable_slugs_survive(self):
        for slug in ("never gonna give you up", "bohemian rhapsody", "numb"):
            self.assertFalse(host._looks_like_identifier(slug), slug)


if __name__ == "__main__":
    unittest.main(verbosity=2)
