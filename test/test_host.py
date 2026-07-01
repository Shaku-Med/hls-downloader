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


if __name__ == "__main__":
    unittest.main(verbosity=2)
