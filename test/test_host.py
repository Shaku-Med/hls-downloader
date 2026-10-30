#!/usr/bin/env python3
"""
Tests for the native host logic that decides yt-dlp routing and cookie handling.
Run from the repo root:  python -m unittest discover test
Or directly:             python test/test_host.py
"""

import glob
import http.server
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

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


class ReportedTrackWins(unittest.TestCase):
    """
    What the page says is playing beats anything derived from the page title.

    On an album page the title is the album, so without this a whole album
    resolves to one wrong file.
    """

    ALBUM = "https://music.amazon.com/albums/B0FD256Q8D"
    ALBUM_TITLE = "Play Some Album by Various Artists on Amazon Music"

    def test_reported_track_is_preferred(self):
        meta = host._music_track_meta(
            self.ALBUM, self.ALBUM,
            {"pageTitle": self.ALBUM_TITLE,
             "trackTitle": "What It Sounds Like",
             "trackArtist": "HUNTR/X, EJAE"},
        )
        self.assertEqual(meta["title"], "What It Sounds Like")
        self.assertEqual(meta["artists"], ["HUNTR/X", "EJAE"])

    def test_duration_is_carried_for_ranking(self):
        meta = host._music_track_meta(
            self.ALBUM, self.ALBUM,
            {"trackTitle": "X", "trackArtist": "Y", "trackDuration": 250},
        )
        self.assertEqual(meta["duration"], 250.0)

    def test_a_bad_duration_does_not_break_it(self):
        meta = host._music_track_meta(
            self.ALBUM, self.ALBUM,
            {"trackTitle": "X", "trackDuration": "not a number"},
        )
        self.assertEqual(meta["duration"], 0.0)

    def test_falls_back_to_the_page_title_without_a_track(self):
        meta = host._music_track_meta(
            self.ALBUM, self.ALBUM, {"pageTitle": self.ALBUM_TITLE}
        )
        self.assertEqual(meta["title"], "Play Some Album")


class SiteRegistry(unittest.TestCase):
    """public/data/ytdlp-sites.json, the file both sides read."""

    def test_the_file_loads(self):
        self.assertTrue(len(host._ytdlp_sites()) > 10)

    def test_media_pages_are_recognised(self):
        for url, label, role in (
            ("https://open.spotify.com/track/abc", "Spotify", "audio"),
            ("https://music.amazon.com/albums/B0F", "Amazon Music", "audio"),
            ("https://www.youtube.com/watch?v=abc", "YouTube", "video"),
            ("https://www.youtube.com/shorts/x", "YouTube", "video"),
            ("https://www.instagram.com/reel/abc/", "Instagram", "video"),
        ):
            found = host._ytdlp_page_role(url)
            self.assertIsNotNone(found, url)
            self.assertEqual(found["label"], label, url)
            self.assertEqual(found["role"], role, url)

    def test_a_language_in_the_path_still_matches(self):
        # Apple Music, Deezer and Qobuz put /us/ or /en/ in front of the path.
        for url in ("https://music.apple.com/us/album/x/1",
                    "https://www.deezer.com/en/track/1109731",
                    "https://www.qobuz.com/us-en/album/x/y"):
            self.assertIsNotNone(host._ytdlp_page_role(url), url)

    def test_a_variable_segment_in_front_still_matches(self):
        # /{user}/status/{id} and /r/{sub}/comments/{id}.
        self.assertIsNotNone(host._ytdlp_page_role("https://x.com/someone/status/1"))
        self.assertIsNotNone(host._ytdlp_page_role("https://reddit.com/r/x/comments/1/t/"))

    def test_pages_holding_nothing_are_left_alone(self):
        for url in ("https://open.spotify.com/",
                    "https://www.youtube.com/feed/subscriptions",
                    "https://www.instagram.com/accounts/edit/",
                    "https://example.com/whatever"):
            self.assertIsNone(host._ytdlp_page_role(url), url)

    def test_a_video_on_an_audio_service_stays_video(self):
        found = host._ytdlp_page_role("https://music.apple.com/us/music-video/x/1")
        self.assertEqual(found["role"], "video")
        self.assertFalse(host._wants_yt_dlp_audio_extract({}, "https://music.apple.com/us/music-video/x/1"))


# One real shaped URL per registry site. These are what the checks below run
# against, so a site added to the registry has to bring one with it.
SITE_SAMPLES = {
    "youtu.be": "https://youtu.be/dQw4w9WgXcQ",
    "youtube.com": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "music.youtube.com": "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "open.spotify.com": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    "music.apple.com": "https://music.apple.com/us/song/x/6797549954",
    "music.amazon.com": "https://music.amazon.com/albums/B08XYZ1234",
    "tidal.com": "https://tidal.com/browse/track/12345678",
    "deezer.com": "https://www.deezer.com/track/123456789",
    "pandora.com": "https://www.pandora.com/artist/x/y/z",
    "qobuz.com": "https://open.qobuz.com/album/abcdefghijklm",
    "anghami.com": "https://play.anghami.com/song/12345678",
    "boomplay.com": "https://www.boomplay.com/songs/12345678",
    "napster.com": "https://us.napster.com/track/abc",
    "soundcloud.com": "https://soundcloud.com/forss/flickermood",
    "bandcamp.com": "https://artist.bandcamp.com/track/song-name",
    "mixcloud.com": "https://www.mixcloud.com/dholbach/cryptkeeper/",
    "audiomack.com": "https://audiomack.com/kizzdaniel/song/buga",
    "threads.net": "https://www.threads.net/@user/post/ABC123",
    "crunchyroll.com": "https://www.crunchyroll.com/watch/ABC123/title",
    "instagram.com": "https://www.instagram.com/p/CxAbCdEfGhI/",
    "tiktok.com": "https://www.tiktok.com/@user/video/7300000000000000000",
    "x.com": "https://x.com/user/status/1700000000000000000",
    "facebook.com": "https://www.facebook.com/watch/?v=123456789",
    "reddit.com": "https://www.reddit.com/r/videos/comments/abc123/t/",
    "twitch.tv": "https://www.twitch.tv/videos/123456789",
    "vimeo.com": "https://vimeo.com/123456789",
    "dailymotion.com": "https://www.dailymotion.com/video/x8abcde",
    "bilibili.com": "https://www.bilibili.com/video/BV1xx411c7mD",
    "rumble.com": "https://rumble.com/v6abcd-some-video.html",
    "kick.com": "https://kick.com/chan/videos/12345678-1234-1234-1234-123456789abc",
    "pinterest.com": "https://www.pinterest.com/pin/123456789012345678/",
    "linkedin.com": "https://www.linkedin.com/posts/x_s-activity-7123456789012345678-Ab3x/",
    "snapchat.com": "https://www.snapchat.com/spotlight/W7_ABCDEFG",
    "mega.nz": "https://mega.nz/file/AbCdEfGh#abcdefghijklmnopqr-stuvwx",
}


class EverySiteHasASample(unittest.TestCase):
    def test_nothing_slipped_in_unchecked(self):
        listed = {s["hostname"] for s in host._ytdlp_sites()}
        self.assertEqual(listed - set(SITE_SAMPLES), set())


class RegistryAndRoutingAgree(unittest.TestCase):
    """
    The registry decides whether a This page row is offered. The host rules
    decide whether the download actually goes to yt-dlp. When those two drift
    apart you get a row that cannot work, or a page yt-dlp handles with nothing
    offered on it, which is how Kick and Threads went wrong.
    """

    def test_a_row_is_offered_exactly_where_the_download_will_use_ytdlp(self):
        for site in host._ytdlp_sites():
            url = SITE_SAMPLES[site["hostname"]]
            offers = host._ytdlp_page_role(url) is not None
            if site.get("handler") == "mega":
                self.assertTrue(offers, url)
                self.assertTrue(host._is_mega_public_url(url), url)
                self.assertIsNone(host._social_platform_for_yt_dlp(url, url, {}))
                continue
            routes = bool(host._social_platform_for_yt_dlp(url, url, {}))
            self.assertEqual(offers, routes, f"{site['hostname']} ({url})")


class SitesWhereYtDlpIsNotTheTool(unittest.TestCase):
    """
    Some sites are known and still not yt-dlp's job. Offering a download that
    can only fail is worse than offering nothing, so these get no row and are
    never routed there either.
    """

    NOT_YTDLP = (
        # Extractor exists but its metadata API 404s; the page serves plain
        # audio the network capture picks up instead.
        "https://audiomack.com/kizzdaniel/song/buga",
        # No extractor at all. Meta's other domains used to route it here.
        "https://www.threads.net/@user/post/ABC123",
        # yt-dlp recognises it only to say it is DRM protected.
        "https://www.crunchyroll.com/watch/ABC123/title",
    )

    def test_no_row_is_offered(self):
        for url in self.NOT_YTDLP:
            self.assertIsNone(host._ytdlp_page_role(url), url)
            self.assertTrue(host._ytdlp_site_disabled(url), url)

    def test_the_download_is_not_routed_there(self):
        for url in self.NOT_YTDLP:
            self.assertIsNone(host._social_platform_for_yt_dlp(url, url, {}), url)


class PagesThatHoldNoTrack(unittest.TestCase):
    """
    A bare / endpoint matched a whole site, so the row turned up on library and
    settings pages where there is nothing to download.
    """

    def test_browsing_and_settings_pages_offer_nothing(self):
        for url in (
            "https://soundcloud.com/discover",
            "https://soundcloud.com/you/library",
            "https://soundcloud.com/feed",
            "https://soundcloud.com/",
            "https://soundcloud.com/forss",
            "https://soundcloud.com/forss/likes",
            "https://soundcloud.com/forss/tracks",
            "https://www.mixcloud.com/dholbach/uploads/",
            "https://www.mixcloud.com/dholbach/",
            "https://vimeo.com/settings",
            "https://vimeo.com/upgrade",
            "https://rumble.com/browse/live",
            "https://rumble.com/videos",
            "https://www.snapchat.com/add/someuser",
            "https://www.linkedin.com/in/someone/",
            "https://www.tiktok.com/@someuser",
        ):
            self.assertIsNone(host._ytdlp_page_role(url), url)

    def test_the_real_pages_still_work(self):
        for url in (
            "https://soundcloud.com/forss/flickermood",
            "https://soundcloud.com/forss/sets/soulhack",
            "https://soundcloud.com/forss/likeable-track",
            "https://www.mixcloud.com/dholbach/cryptkeeper/",
            "https://vimeo.com/123456789",
            "https://vimeo.com/channels/staffpicks/123456789",
            "https://rumble.com/v6abcd-some-video.html",
        ):
            self.assertIsNotNone(host._ytdlp_page_role(url), url)


class TheMostSpecificHostWins(unittest.TestCase):
    """
    music.youtube.com ends with youtube.com, so the YouTube entry answered for
    it and asked for video on a service whose whole point is audio.
    """

    def test_youtube_music_is_audio(self):
        found = host._ytdlp_page_role("https://music.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(found["label"], "YouTube Music")
        self.assertEqual(found["role"], "audio")
        self.assertTrue(
            host._wants_yt_dlp_audio_extract({}, "https://music.youtube.com/watch?v=dQw4w9WgXcQ")
        )

    def test_youtube_itself_is_still_video(self):
        found = host._ytdlp_page_role("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(found["role"], "video")

    def test_a_short_link_is_recognised(self):
        self.assertIsNotNone(host._ytdlp_page_role("https://youtu.be/dQw4w9WgXcQ"))


class RegistryAgreesWithYtDlp(unittest.TestCase):
    """
    The list is only worth having if it matches what yt-dlp actually does, so
    it is checked against yt-dlp's own URL matching rather than against memory.
    Skipped where yt-dlp is not installed.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from yt_dlp.extractor import gen_extractor_classes
        except ImportError:
            raise unittest.SkipTest("yt-dlp is not installed")
        cls.classes = [ie for ie in gen_extractor_classes() if ie.IE_NAME != "generic"]

    @staticmethod
    def _refuses(name):
        # These match a URL only to report a better error, not to download it.
        low = name.lower()
        return name in ("DRM", "Piracy") or "truncated" in low or low.startswith("unsupported")

    def _extractors(self, url):
        real, refusing = [], []
        for ie in self.classes:
            try:
                if not ie.suitable(url):
                    continue
            except Exception:
                continue
            (refusing if self._refuses(ie.IE_NAME) else real).append(ie.IE_NAME)
        return real, refusing

    def test_every_site_we_offer_is_one_yt_dlp_can_take(self):
        for site in host._ytdlp_sites():
            url = SITE_SAMPLES[site["hostname"]]
            real, refusing = self._extractors(url)
            if site.get("ytdlp") is False:
                continue
            if site.get("searchFallback"):
                # No working extractor is the whole reason for the fallback.
                continue
            self.assertTrue(
                real,
                f"{site['hostname']}: offered as a yt-dlp page but yt-dlp has no "
                f"extractor for {url} (only {refusing or 'nothing'})",
            )

    def test_the_fallback_flag_is_set_where_yt_dlp_cannot_help(self):
        for site in host._ytdlp_sites():
            if site.get("ytdlp") is False:
                continue
            url = SITE_SAMPLES[site["hostname"]]
            real, _ = self._extractors(url)
            if not real:
                self.assertTrue(
                    site.get("searchFallback"),
                    f"{site['hostname']}: yt-dlp cannot take {url}, so it needs "
                    f"searchFallback or ytdlp:false",
                )


class QualitySelectionUnchanged(unittest.TestCase):
    """The registry must not disturb how quality is chosen."""

    YT = "https://www.youtube.com/watch?v=abc"

    def test_your_own_format_wins(self):
        self.assertEqual(host._yt_dlp_format_string({"ytDlpFormat": "137+140"}, self.YT), "137+140")

    def test_video_pages_take_video_plus_audio(self):
        fmt = host._yt_dlp_format_string({}, self.YT)
        self.assertIn("bestvideo*", fmt)
        self.assertIn("+bestaudio", fmt)

    def test_the_height_cap_is_honoured(self):
        fmt = host._yt_dlp_format_string({"ytDlpMaxHeight": 1080}, self.YT)
        self.assertIn("height<=1080", fmt)

    def test_the_merge_is_still_asked_for(self):
        cmd = host._yt_dlp_build_cmd(["yt-dlp"], {}, "out.mp4", self.YT)
        self.assertIn("--merge-output-format", cmd)
        self.assertNotIn("--extract-audio", cmd)

    def test_music_pages_take_audio(self):
        fmt = host._yt_dlp_format_string({}, "https://open.spotify.com/track/abc")
        self.assertEqual(fmt, "bestaudio/best")


class RegistryIsWhereTheCodeLooks(unittest.TestCase):
    """
    The path the extension fetches has to exist in the loaded browser roots.

    This shipped broken once: the code asked for data/ytdlp-sites.json while
    the file sits under public/, so the fetch 404d, the registry never loaded,
    and every page check failed at its first line with nothing to show for it.
    """

    def _paths_the_code_tries(self):
        js = os.path.join(HERE, "..", "public", "scripts", "ytdlp-sites.js")
        with open(js, encoding="utf-8") as fh:
            block = fh.read().split("DATA_PATHS = [", 1)[1].split("]", 1)[0]
        return re.findall(r"'([^']+)'", block)

    def test_the_first_path_tried_actually_exists(self):
        tried = self._paths_the_code_tries()
        self.assertTrue(tried, "no DATA_PATHS found in ytdlp-sites.js")
        root = os.path.join(HERE, "..")
        self.assertTrue(
            os.path.isfile(os.path.join(root, tried[0])),
            "%s does not exist; the extension would fetch nothing" % tried[0],
        )

    def test_each_browser_root_has_it(self):
        tried = self._paths_the_code_tries()
        for browser in ("chromium", "firefox"):
            folder = os.path.join(HERE, "..", browser)
            if not os.path.isdir(folder):
                continue  # setup_browser_roots.py has not been run here
            self.assertTrue(
                any(os.path.isfile(os.path.join(folder, p)) for p in tried),
                "%s has none of %s" % (browser, tried),
            )


class HeadersDoNotFollowToAnotherSite(unittest.TestCase):
    """
    A search fallback downloads from a different site than the page it started
    on, and the page's referer and auth header have no business going there.
    """

    APPLE = "https://music.apple.com/us/song/x/6797549954"
    MSG = {"pageUrl": APPLE, "userAgent": "UA", "authorization": "Bearer secret"}

    def test_nothing_private_reaches_the_other_site(self):
        args = host._yt_dlp_header_args(self.MSG, "https://www.youtube.com/watch?v=abc")
        joined = " ".join(args)
        self.assertNotIn("apple", joined.lower())
        self.assertNotIn("secret", joined)
        self.assertIn("User-Agent:UA", joined)

    def test_they_are_kept_when_staying_put(self):
        args = host._yt_dlp_header_args(self.MSG, self.APPLE)
        joined = " ".join(args)
        self.assertIn("Referer:" + self.APPLE, joined)
        self.assertIn("Bearer secret", joined)

    def test_a_subdomain_still_counts_as_the_same_site(self):
        msg = {"pageUrl": "https://example.com/a", "userAgent": "UA"}
        args = host._yt_dlp_header_args(msg, "https://cdn.example.com/b.mp4")
        self.assertIn("Referer:https://example.com/a", " ".join(args))


class YoutubeRefusalIsRetried(unittest.TestCase):
    """Found the right video, but YouTube turned the player away this time."""

    def test_the_real_failure_is_recognised(self):
        tail = (
            "WARNING: [youtube] XJ_qgsVtTOY: Unable to download API page: "
            "HTTP Error 401: Unauthorized WARNING: Only images are available "
            "for download. ERROR: [youtube] XJ_qgsVtTOY: Requested format is "
            "not available."
        )
        self.assertTrue(host._looks_like_youtube_blocked(tail))

    def test_other_failures_are_left_alone(self):
        for tail in ("ERROR: Video unavailable",
                     "ERROR: unable to connect to host",
                     "ERROR: [youtube] private video",
                     ""):
            self.assertFalse(host._looks_like_youtube_blocked(tail), tail)


class LocalHlsPlaylist(unittest.TestCase):
    """Signed CDNs often reject a second GET of the same m3u8; ffmpeg then reports I/O."""

    BASE = "https://cdn.example/pl/token/master.m3u8"

    def test_relative_uris_become_absolute(self):
        text = (
            "#EXTM3U\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
            "#EXTINF:4.0,\n"
            "seg0.ts\n"
        )
        out = host._rewrite_m3u8_absolute(text, self.BASE)
        self.assertIn('URI="https://cdn.example/pl/token/key.bin"', out)
        self.assertIn("https://cdn.example/pl/token/seg0.ts", out)

    def test_cached_playlist_is_used_without_fetching(self):
        media = "#EXTM3U\n#EXTINF:1,\nseg.ts\n"
        url, text = host._hls_playlist_from_message(
            {"playlistText": media, "playlistUrl": self.BASE},
            "https://cdn.example/other.m3u8",
            "User-Agent: test\r\n",
        )
        self.assertEqual(url, self.BASE)
        self.assertIn("#EXTM3U", text)
        self.assertIn("seg.ts", text)

    def test_ffmpeg_io_error_is_treated_as_a_network_fail(self):
        err = (
            "ffmpeg exited with code 4294967291: r Error opening input file "
            "https://example/master.m3u8. Error opening input files: I/O error"
        )
        self.assertTrue(host._ffmpeg_looks_like_network_fail(err))
        self.assertFalse(host._ffmpeg_looks_like_network_fail("Invalid data found"))

    def test_local_file_is_the_ffmpeg_input(self):
        cmd, _ = host._build_ffmpeg_cmd_list(
            self.BASE,
            {"streamKind": "hls", "userAgent": "UA"},
            "C:\\tmp\\out.ts",
            "Referer: https://example/\r\n",
            playlist_text="#EXTM3U\n#EXTINF:1,\nhttps://cdn.example/seg.ts\n",
            playlist_url=self.BASE,
            ffmpeg_input="C:\\tmp\\sg_hls_local.m3u8",
        )
        i = cmd.index("-i")
        self.assertTrue(cmd[i + 1].startswith("file:"))
        self.assertIn("sg_hls_local.m3u8", cmd[i + 1].replace("\\", "/"))
        self.assertNotIn("https://cdn.example/pl/token/master.m3u8", cmd)
        self.assertIn("file,http,https,tcp,tls,crypto,ffurl", cmd)

    def test_gzip_path_tokens_are_one_shot(self):
        url = (
            "https://claritybusinessacademy.site/OJadn7Aal/pl/"
            "H4sIAAAAAAAAAw3OW46DIBQA0C2BWBrnszNio_Um8vDBH6IJLWqNdax19TNnBQeFEUHd"
            "OQwtophSGmLURxb3lAbn3p7NV4b9rj6vXZJUtPWcVZN72GTV.Y_FhrGp/master.m3u8"
        )
        self.assertTrue(host._hls_url_looks_one_shot(url))
        self.assertFalse(host._hls_url_looks_one_shot("https://cdn.example/hls/master.m3u8"))

    def test_openssl_wrong_version_is_an_ssl_fail(self):
        exc = OSError("[SSL: WRONG_VERSION_NUMBER] wrong version number (_ssl.c:1028)")
        self.assertTrue(host._http_error_looks_like_ssl(exc))
        self.assertFalse(host._http_error_looks_like_ssl(OSError("timed out")))

    def test_playlist_fetch_error_is_not_windows_specific(self):
        msg = host._format_playlist_fetch_error(
            urllib.error.URLError("extension fetch timed out")
        )
        self.assertIn("browser", msg.lower())
        self.assertNotIn("powershell", msg.lower())
        self.assertNotIn("curl", msg.lower())
        ssl_msg = host._format_playlist_fetch_error(
            OSError("[SSL: WRONG_VERSION_NUMBER] wrong version number")
        )
        self.assertNotIn("Windows", ssl_msg)
        self.assertNotIn("curl", ssl_msg.lower())

    def test_disguised_html_playlist_is_still_hls(self):
        self.assertTrue(
            host._is_hls_input("https://cdn.example/hls/playlist.html", {"streamKind": ""})
        )

    def _master(self):
        return (
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=1312915,RESOLUTION=1280x720\n"
            "lo.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=6127636,RESOLUTION=1920x1080\n"
            "hi.m3u8\n"
        )

    def test_one_shot_master_is_followed_to_the_variant(self):
        media = (
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\n"
            "hi0.ts\n#EXT-X-ENDLIST\n"
        )
        seen = []
        real = host._http_get_text

        def fake(url, header_block, timeout=60.0):
            seen.append(url)
            return media

        host._http_get_text = fake
        try:
            url, text = host._hls_playlist_from_message(
                {
                    "playlistText": self._master(),
                    "playlistUrl": self.BASE,
                    "oneShotHls": True,
                },
                self.BASE,
                "User-Agent: test\r\n",
            )
        finally:
            host._http_get_text = real
        self.assertEqual(seen, ["https://cdn.example/pl/token/hi.m3u8"])
        self.assertEqual(url, "https://cdn.example/pl/token/hi.m3u8")
        self.assertIn("hi0.ts", text)
        self.assertFalse(host._is_master_playlist(text))
        self.assertIsNotNone(host._hls_segment_timeline(text))

    def test_one_shot_media_playlist_is_not_fetched_again(self):
        media = "#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n"
        real = host._http_get_text
        host._http_get_text = lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched"))
        try:
            url, text = host._hls_playlist_from_message(
                {"playlistText": media, "playlistUrl": self.BASE, "oneShotHls": True},
                self.BASE,
                "User-Agent: test\r\n",
            )
        finally:
            host._http_get_text = real
        self.assertEqual(url, self.BASE)
        self.assertIn("seg.ts", text)

    BLOCK = (
        "Referer: https://lesson.example/watch\r\n"
        "User-Agent: UA\r\n"
        "Cookie: session=secret\r\n"
        "Authorization: Bearer secret\r\n"
    )

    def test_same_site_variant_keeps_the_page_cookies(self):
        media = "#EXTM3U\n#EXTINF:1,\nhi0.ts\n#EXT-X-ENDLIST\n"
        seen = []
        real = host._http_get_text

        def fake(url, header_block, timeout=60.0):
            seen.append((url, header_block))
            return media

        host._http_get_text = fake
        try:
            host._hls_playlist_from_message(
                {"playlistText": self._master(), "playlistUrl": self.BASE},
                self.BASE,
                self.BLOCK,
            )
        finally:
            host._http_get_text = real
        self.assertEqual(seen[0][0], "https://cdn.example/pl/token/hi.m3u8")
        self.assertIn("Cookie: session=secret", seen[0][1])
        self.assertIn("Referer: https://lesson.example/watch", seen[0][1])
        self.assertIn("User-Agent: UA", seen[0][1])

    def test_variant_on_another_host_is_fetched_without_those_cookies(self):
        master = (
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=6127636,RESOLUTION=1920x1080\n"
            "https://cdn.other/hi.m3u8\n"
        )
        media = "#EXTM3U\n#EXTINF:1,\nhi0.ts\n#EXT-X-ENDLIST\n"
        seen = []
        real = host._http_get_text

        def fake(url, header_block, timeout=60.0):
            seen.append((url, header_block))
            return media

        host._http_get_text = fake
        try:
            host._hls_playlist_from_message(
                {"playlistText": master, "playlistUrl": self.BASE},
                self.BASE,
                self.BLOCK,
            )
        finally:
            host._http_get_text = real
        self.assertEqual(seen[0][0], "https://cdn.other/hi.m3u8")
        self.assertNotIn("Cookie", seen[0][1])
        self.assertNotIn("Authorization", seen[0][1])
        self.assertIn("Referer: https://lesson.example/watch", seen[0][1])
        self.assertIn("User-Agent: UA", seen[0][1])

    def test_a_failed_variant_fetch_is_not_turned_into_the_master(self):
        real = host._http_get_text

        def boom(url, header_block, timeout=60.0):
            raise urllib.error.URLError("variant rejected")

        host._http_get_text = boom
        try:
            with self.assertRaises(urllib.error.URLError):
                host._hls_playlist_from_message(
                    {
                        "playlistText": self._master(),
                        "playlistUrl": self.BASE,
                        "oneShotHls": True,
                    },
                    self.BASE,
                    "User-Agent: test\r\n",
                )
        finally:
            host._http_get_text = real

    def test_captured_variant_is_used_when_urlopen_would_report_403(self):
        """
        Firefox's fetch answers HTTP 403 and the helper wraps that as
        URLError("HTTP 403"). The card then says
        "Could not open the playlist: <urlopen error HTTP 403>".
        The page already received a variant, so that fetch must not run.
        """
        shown = host._format_playlist_fetch_error(urllib.error.URLError("HTTP 403"))
        self.assertIn("<urlopen error HTTP 403>", shown)
        self.assertTrue(shown.startswith("Could not open the playlist:"))

        lo = "https://cdn.example/pl/token/lo.m3u8?e=1"
        media = "#EXTM3U\n#EXTINF:1,\nlo0.ts\n#EXT-X-ENDLIST\n"
        real = host._http_get_text

        def boom(url, header_block, timeout=60.0):
            raise urllib.error.URLError("HTTP 403")

        host._http_get_text = boom
        try:
            url, text = host._hls_playlist_from_message(
                {
                    "playlistText": self._master(),
                    "playlistUrl": self.BASE,
                    "oneShotHls": True,
                    "capturedPlaylists": [{"url": lo, "text": media}],
                },
                self.BASE,
                self.BLOCK,
            )
        finally:
            host._http_get_text = real
        self.assertEqual(url, lo)
        self.assertIn("lo0.ts", text)
        self.assertFalse(host._is_master_playlist(text))

    def test_captured_playlist_skips_the_urlopen_that_403s(self):
        media = "#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n"
        real = host._http_get_text
        host._http_get_text = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.URLError("HTTP 403")
        )
        try:
            url, text = host._hls_playlist_from_message(
                {"capturedPlaylists": [{"url": self.BASE, "text": media}]},
                self.BASE,
                self.BLOCK,
            )
        finally:
            host._http_get_text = real
        self.assertEqual(url, self.BASE)
        self.assertIn("seg.ts", text)

    def test_ffmpeg_opens_the_variant_not_the_master_file(self):
        local = os.path.join(tempfile.gettempdir(), "sg_hls_master.m3u8")
        cmd, _ = host._build_ffmpeg_cmd_list(
            self.BASE,
            {"streamKind": "hls", "oneShotHls": True, "userAgent": "UA"},
            os.path.join(tempfile.gettempdir(), "out.mp4"),
            "Referer: https://cdn.example/\r\n",
            playlist_text=self._master(),
            playlist_url=self.BASE,
            ffmpeg_input=local,
        )
        i = cmd.index("-i")
        self.assertEqual(cmd[i + 1], "https://cdn.example/pl/token/hi.m3u8")
        self.assertNotIn("sg_hls_master.m3u8", " ".join(cmd))
        self.assertIn("-headers", cmd)
        self.assertIn("-user_agent", cmd)


class MasterPlaylistDoesNotMuxAnEmptyMp4(unittest.TestCase):
    """
    ffmpeg exit 234 is EINVAL. A multi-variant master opens as programs with
    variant_bitrate and, when those playlists never become elementary streams,
    -map 0:v:0? / 0:a:0? matches nothing. The mp4 muxer then reports
    "Output file does not contain any stream" and "Invalid argument".
    """

    def _segment_encode_args(self):
        listed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True,
        )
        names = set()
        for line in (listed.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].startswith("V"):
                names.add(parts[1])
        if "mpeg4" in names:
            return ["-c:v", "mpeg4", "-q:v", "5"]
        if "libx264" in names:
            return ["-c:v", "libx264", "-preset", "ultrafast"]
        self.skipTest("ffmpeg has neither mpeg4 nor libx264")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_a_master_with_no_media_exits_234(self):
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        master = os.path.join(work, "master.m3u8")
        with open(master, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(
                "#EXTM3U\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=6127636,RESOLUTION=1920x1080\n"
                "hi.m3u8\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=1312915,RESOLUTION=1280x720\n"
                "lo.m3u8\n"
            )
        out = os.path.join(work, "out.mp4")
        cmd = [
            "ffmpeg", "-y", "-nostdin", "-loglevel", "info",
            "-allowed_extensions", "ALL", "-extension_picky", "0",
            "-protocol_whitelist", "file,http,https,tcp,tls,crypto,ffurl",
            "-f", "hls",
            "-i", "file:" + master,
            "-map", "0:v:0?", "-map", "0:a:0?",
            "-c", "copy",
            out,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        err = r.stderr or ""
        # ffmpeg exits with -22. Linux keeps the low byte, 234; Windows reports
        # the whole 32 bit value, 4294967274. The low byte is 234 on both.
        self.assertEqual(r.returncode & 0xFF, 234, err[-500:])
        self.assertIn("does not contain any stream", err)
        self.assertIn("Invalid argument", err)
        self.assertIn("variant_bitrate", err)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_the_variant_playlist_muxes_to_mp4(self):
        encode = self._segment_encode_args()
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "testsrc2=size=160x90:rate=10:duration=1",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
             *encode, "-c:a", "aac", "-f", "mpegts",
             os.path.join(work, "seg0.ts")],
            check=True, capture_output=True,
        )
        local = os.path.join(work, "index.m3u8")
        media = (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n"
            "#EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
        )
        with open(local, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(media)
        out = os.path.join(work, "out.mp4")
        old = os.environ.get("HLS_GRABBER_FFMPEG_STREAM_COPY")
        os.environ["HLS_GRABBER_FFMPEG_STREAM_COPY"] = "1"
        self.addCleanup(
            lambda: os.environ.__setitem__("HLS_GRABBER_FFMPEG_STREAM_COPY", old)
            if old is not None else os.environ.pop("HLS_GRABBER_FFMPEG_STREAM_COPY", None)
        )
        cmd, _ = host._build_ffmpeg_cmd_list(
            "http://cdn.example/index.m3u8",
            {"streamKind": "hls", "userAgent": "UA"},
            out,
            "Referer: http://cdn.example/\r\n",
            playlist_text=media,
            playlist_url="http://cdn.example/index.m3u8",
            ffmpeg_input=local,
        )
        self.assertNotIn("-headers", cmd)
        self.assertNotIn("-user_agent", cmd)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, (r.stderr or "")[-500:])
        self.assertGreater(os.path.getsize(out), 1000)


class MegaPublicLinks(unittest.TestCase):
    FILE = "https://mega.nz/file/AbCdEfGh#abcdefghijklmnopqr-stuvwx"
    FOLDER = "https://mega.nz/folder/AbCdEfGh#abcdefghijklmnopqr-stuvwx"
    OLD_FILE = "https://mega.nz/#!AbCdEfGh!abcdefghijklmnop"
    OLD_FOLDER = "https://mega.nz/#F!AbCdEfGh!abcdefghijklmnop"

    def setUp(self):
        host._YTDLP_SITES_CACHE = None

    def test_file_and_folder_urls_parse(self):
        import mega_fetch

        f = mega_fetch.parse_mega_url(self.FILE)
        self.assertIsNotNone(f)
        self.assertEqual(f.kind, "file")
        self.assertEqual(f.handle, "AbCdEfGh")
        d = mega_fetch.parse_mega_url(self.FOLDER)
        self.assertEqual(d.kind, "folder")
        self.assertEqual(mega_fetch.parse_mega_url(self.OLD_FILE).kind, "file")
        self.assertEqual(mega_fetch.parse_mega_url(self.OLD_FOLDER).kind, "folder")
        self.assertIsNone(mega_fetch.parse_mega_url("https://mega.nz/file/AbCdEfGh"))
        self.assertIsNone(mega_fetch.parse_mega_url("https://mega.nz/"))
        self.assertIsNone(mega_fetch.parse_mega_url("https://example.com/file/x#y"))

    def test_row_is_offered_only_with_the_key(self):
        found = host._ytdlp_page_role(self.FILE)
        self.assertIsNotNone(found)
        self.assertEqual(found["label"], "MEGA")
        self.assertEqual(found.get("handler"), "mega")
        self.assertIsNotNone(host._ytdlp_page_role(self.OLD_FILE))
        self.assertIsNone(host._ytdlp_page_role("https://mega.nz/file/AbCdEfGh"))
        self.assertIsNone(host._ytdlp_page_role("https://mega.nz/"))

    def test_download_does_not_go_to_ytdlp(self):
        self.assertTrue(host._is_mega_public_url(self.FILE))
        self.assertIsNone(host._social_platform_for_yt_dlp(self.FILE, self.FILE, {}))
        self.assertEqual(host._pick_mega_url("https://example.com/", self.FILE), self.FILE)


class DecryptPackageHints(unittest.TestCase):
    def test_pycryptodomex_missing_is_recognised(self):
        self.assertTrue(
            host._looks_like_missing_pycryptodomex(
                "ERROR: pycryptodomex not found. Please install"
            )
        )
        self.assertFalse(host._looks_like_missing_pycryptodomex("HTTP 403"))
        hint = host._pycryptodomex_help_message()
        self.assertIn("pycryptodomex", hint)
        self.assertIn("pip install", hint)


class ProgressSurvivesCarriageReturns(unittest.TestCase):
    """
    ffmpeg ends every -stats update with \\r, never \\n. Reading with readline
    held every update back until the process exited, so the card sat on
    "Starting ffmpeg" for as long as the download took.
    """

    STATS = (
        b"Input #0, mov,mp4\n"
        b"frame=  100 fps=25 time=00:00:04.00 speed=1.0x\r"
        b"frame=  200 fps=25 time=00:00:08.00 speed=1.0x\r"
        b"frame=  300 fps=25 time=00:00:12.00 speed=1.0x\r"
    )

    def test_each_update_arrives_on_its_own(self):
        lines = [ln for ln in host._iter_proc_lines(io.BytesIO(self.STATS)) if "time=" in ln]
        self.assertEqual(len(lines), 3)
        self.assertIn("00:00:04.00", lines[0])
        self.assertIn("00:00:12.00", lines[-1])

    def test_readline_would_have_held_them_back(self):
        held = [ln for ln in io.BytesIO(self.STATS).readlines() if b"time=" in ln]
        # One blob, all three updates, released only at the end of the run.
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0].count(b"time="), 3)

    def test_a_trailing_line_without_a_terminator_is_not_dropped(self):
        self.assertEqual(list(host._iter_proc_lines(io.BytesIO(b"one\rtwo"))), ["one", "two"])

    def test_a_child_that_never_ends_a_line_cannot_grow_the_buffer(self):
        chunks = list(host._iter_proc_lines(io.BytesIO(b"x" * (300 * 1024))))
        self.assertTrue(chunks)
        self.assertTrue(all(len(c) <= 64 * 1024 + 256 for c in chunks))


class DeadSocketsTimeOut(unittest.TestCase):
    def test_network_input_gets_a_read_timeout(self):
        self.assertEqual(
            host._ffmpeg_network_timeout_args("https://cdn.example.com/a.mp4"),
            ["-rw_timeout", "60000000"],
        )

    def test_local_input_is_left_alone(self):
        self.assertEqual(host._ffmpeg_network_timeout_args(r"C:\clips\a.mp4"), [])


class _Serve(http.server.BaseHTTPRequestHandler):
    """Stands in for a CDN. Class attributes set per test."""

    protocol_version = "HTTP/1.1"
    body = b""
    ctype = "video/mp4"
    honor_range = False
    cut_after = 0  # bytes to send before hanging up, 0 for none

    def log_message(self, *a):
        pass

    def do_GET(self):
        start, end, status = 0, len(self.body) - 1, 200
        if self.honor_range and (self.headers.get("Range") or "").startswith("bytes="):
            a, _, b = self.headers["Range"][6:].partition("-")
            start = int(a or 0)
            end = int(b) if b else len(self.body) - 1
            status = 206
        chunk = self.body[start : end + 1]
        self.send_response(status)
        self.send_header("Content-Type", self.ctype)
        self.send_header("Content-Length", str(len(chunk)))
        if self.honor_range:
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.body)}")
        self.end_headers()
        try:
            if self.cut_after and len(chunk) > self.cut_after:
                self.wfile.write(chunk[: self.cut_after])
                self.close_connection = True
                type(self).cut_after = 0  # only break the first attempt
                return
            self.wfile.write(chunk)
        except ConnectionError:
            # The client hung up mid-body. On Linux that is a broken pipe;
            # the handler thread would otherwise print a traceback.
            self.close_connection = True


class PlainFilesAreCopiedNotDemuxed(unittest.TestCase):
    """
    A progressive MP4 keeps its index at the end, so ffmpeg cannot write a frame
    until it has read the whole download, and a CDN that ignores Range leaves it
    writing an empty file and exiting 0. Copy the bytes instead.
    """

    BODY = bytes(range(256)) * 4096  # 1 MiB, no two chunks alike

    def setUp(self):
        host._CANCEL_EVENT.clear()
        self.sent = []
        real_send = host.send_message
        host.send_message = self.sent.append
        self.addCleanup(setattr, host, "send_message", real_send)
        self.addCleanup(host._CANCEL_EVENT.clear)

        _Serve.body = self.BODY
        _Serve.ctype = "video/mp4"
        _Serve.honor_range = False
        _Serve.cut_after = 0
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Serve)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/clip.mp4"

        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.out = os.path.join(self.dir, "clip.mp4")

    def _fetch(self):
        probe = host._probe_progressive_media(self.url, "")
        self.assertIsNotNone(probe)
        ext, total, ranged = probe
        ok, err = host._download_progressive_media(
            self.url, "", self.out, "job", total=total, supports_range=ranged
        )
        return ext, ok, err

    def test_bytes_come_through_untouched(self):
        ext, ok, err = self._fetch()
        self.assertEqual(ext, ".mp4")
        self.assertTrue(ok, err)
        with open(self.out, "rb") as fh:
            self.assertEqual(fh.read(), self.BODY)

    def test_the_card_gets_a_real_percentage(self):
        self._fetch()
        pcts = [m["percent"] for m in self.sent if "percent" in m]
        self.assertTrue(pcts)
        self.assertAlmostEqual(max(pcts), 100.0, places=3)

    def test_no_part_file_is_left_behind(self):
        self._fetch()
        self.assertFalse(os.path.exists(self.out + ".part"))

    def test_a_dropped_connection_is_picked_back_up(self):
        _Serve.honor_range = True
        _Serve.cut_after = 300_000
        _, ok, err = self._fetch()
        self.assertTrue(ok, err)
        with open(self.out, "rb") as fh:
            self.assertEqual(fh.read(), self.BODY)

    def test_an_error_page_is_not_saved_as_a_video(self):
        _Serve.ctype = "text/html"
        _Serve.body = b"<html>Access denied</html>"
        self.assertIsNone(host._probe_progressive_media(self.url, ""))

    def test_media_with_no_extension_is_still_recognised(self):
        url = f"http://127.0.0.1:{self.srv.server_address[1]}/stream/9f2c1"
        probe = host._probe_progressive_media(url, "")
        self.assertIsNotNone(probe)
        self.assertEqual(probe[0], ".mp4")

    def test_a_different_container_is_left_to_ffmpeg(self):
        _Serve.ctype = "video/webm"
        # The caller only copies when this matches the container it is writing.
        self.assertEqual(host._probe_progressive_media(self.url, "")[0], ".webm")


class _Bounce(http.server.BaseHTTPRequestHandler):
    """Redirects /go elsewhere and records what the follow-up request carried."""

    protocol_version = "HTTP/1.1"
    target = ""
    seen = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/go":
            self.send_response(302)
            self.send_header("Location", self.target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        type(self).seen = {k.lower(): v for k, v in self.headers.items()}
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", "4")
        self.end_headers()
        self.wfile.write(b"data")


class CredentialsDoNotFollowARedirect(unittest.TestCase):
    """
    urllib repeats every header on a redirect. A CDN link that bounces to
    another host would otherwise hand it the cookies, referer and bearer token
    belonging to the site the link came from.
    """

    BLOCK = (
        "User-Agent: UA\r\n"
        "Referer: https://tube.example/watch\r\n"
        "Cookie: session=secret\r\n"
        "Authorization: Bearer secret\r\n"
    )

    def setUp(self):
        _Bounce.seen = {}
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Bounce)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.port = self.srv.server_address[1]

    def test_another_host_gets_nothing_private(self):
        _Bounce.target = f"http://localhost:{self.port}/take"
        host._http_get_bytes(f"http://127.0.0.1:{self.port}/go", self.BLOCK)
        for name in ("authorization", "cookie", "referer"):
            self.assertNotIn(name, _Bounce.seen)
        self.assertEqual(_Bounce.seen.get("user-agent"), "UA")

    def test_the_same_host_still_gets_them(self):
        _Bounce.target = f"http://127.0.0.1:{self.port}/take"
        host._http_get_bytes(f"http://127.0.0.1:{self.port}/go", self.BLOCK)
        self.assertEqual(_Bounce.seen.get("authorization"), "Bearer secret")
        self.assertEqual(_Bounce.seen.get("cookie"), "session=secret")

    def test_a_redirect_off_http_is_refused(self):
        _Bounce.target = "file:///C:/Windows/win.ini"
        with self.assertRaises(urllib.error.HTTPError) as caught:
            host._http_get_bytes(f"http://127.0.0.1:{self.port}/go", self.BLOCK)
        # Python 3.14 warns if this response is left for the garbage collector.
        caught.exception.close()


class _Forbid(http.server.BaseHTTPRequestHandler):
    """Answers every GET with 403, the way a CDN rejects Python's TLS."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = b"no"
        self.send_response(403)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class BrowserFetchCarriesThePageHeaders(unittest.TestCase):
    """
    A 403 from urllib is Python being turned away. The retry goes through the
    browser, without the Cookie header that would make that fetch omit cookies.
    """

    BLOCK = (
        "Referer: https://lesson.example/watch\r\n"
        "User-Agent: UA\r\n"
        "Cookie: session=secret\r\n"
    )

    def setUp(self):
        self.job = host._CURRENT_JOB_ID
        self.browser = host._CURRENT_BROWSER_HTTP
        self.ext = host._http_get_bytes_extension
        self.addCleanup(setattr, host, "_CURRENT_JOB_ID", self.job)
        self.addCleanup(setattr, host, "_CURRENT_BROWSER_HTTP", self.browser)
        self.addCleanup(setattr, host, "_http_get_bytes_extension", self.ext)

    def _capture(self):
        seen = {}

        def fake(url, headers, **kwargs):
            seen["url"] = url
            seen["headers"] = headers
            return b"#EXTM3U\n"

        host._http_get_bytes_extension = fake
        return seen

    def test_the_browser_fetch_keeps_referer_and_drops_cookie(self):
        host._CURRENT_JOB_ID = "job"
        host._CURRENT_BROWSER_HTTP = True
        seen = self._capture()
        data = host._http_get_bytes("https://cdn.example/hi.m3u8", self.BLOCK)
        self.assertEqual(data, b"#EXTM3U\n")
        names = {k.lower() for k in seen["headers"]}
        self.assertNotIn("cookie", names)
        self.assertEqual(seen["headers"].get("Referer"), "https://lesson.example/watch")
        self.assertEqual(seen["headers"].get("User-Agent"), "UA")

    def test_a_python_403_is_retried_through_the_browser(self):
        host._CURRENT_JOB_ID = "job"
        host._CURRENT_BROWSER_HTTP = False
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Forbid)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        seen = self._capture()
        url = f"http://127.0.0.1:{srv.server_address[1]}/hi.m3u8"
        data = host._http_get_bytes(url, self.BLOCK)
        self.assertEqual(data, b"#EXTM3U\n")
        self.assertEqual(seen["url"], url)
        self.assertNotIn("cookie", {k.lower() for k in seen["headers"]})
        self.assertEqual(seen["headers"].get("Referer"), "https://lesson.example/watch")
        self.assertEqual(seen["headers"].get("User-Agent"), "UA")


class FallbackFetchersDoNotLeakTheReferer(unittest.TestCase):
    """
    curl and PowerShell follow redirects too. Both drop the credentials on a
    cross host hop by themselves, but each would resend the referer as given.
    """

    HEADERS = {
        "User-Agent": "UA",
        "Referer": "https://tube.example/watch",
        "Cookie": "s=secret",
    }

    def _argv(self):
        captured = {}

        class R:
            returncode = 0
            stdout = b"x"
            stderr = b""

        real = host.subprocess.run
        host.subprocess.run = lambda cmd, *a, **k: (captured.update(cmd=cmd), R())[1]
        try:
            host._http_get_bytes_curl(
                "https://cdn.example/a.mp4", dict(self.HEADERS),
                timeout=30, max_bytes=None, byte_range=None,
            )
        finally:
            host.subprocess.run = real
        return captured["cmd"]

    @unittest.skipUnless(host._curl_executable(), "curl not available")
    def test_curl_hands_the_referer_over_for_curl_to_manage(self):
        argv = self._argv()
        # -e "<url>;auto" makes curl replace it with the redirecting URL per hop.
        self.assertIn("-e", argv)
        self.assertEqual(argv[argv.index("-e") + 1], "https://tube.example/watch;auto")
        self.assertFalse(any(str(x).lower().startswith("referer:") for x in argv))

    @unittest.skipUnless(host._curl_executable(), "curl not available")
    def test_curl_still_sends_the_other_headers(self):
        self.assertTrue(any("Cookie:" in str(x) for x in self._argv()))


@unittest.skipUnless(os.name == "nt", "the stale PATH problem is a Windows one")
class ToolsInstalledAfterTheBrowserOpened(unittest.TestCase):
    """
    The browser hands the helper the PATH it had when it opened, and Windows
    never updates a running process. ffmpeg installed with winget while the
    browser was open was in the registry PATH but not ours, so every download
    said it was missing.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        open(os.path.join(self.dir, "sgfaketool.exe"), "wb").close()

        old_path = os.environ.get("PATH", "")
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        self.addCleanup(setattr, host, "_PATH_REFRESHED_AT", host._PATH_REFRESHED_AT)
        self.reads = 0
        real = host._registry_path_dirs

        def fake():
            self.reads += 1
            return [self.dir]

        host._registry_path_dirs = fake
        self.addCleanup(setattr, host, "_registry_path_dirs", real)
        # What the browser passed in: none of our folders.
        os.environ["PATH"] = os.pathsep.join([r"C:\Windows\System32", r"C:\Windows"])

    def test_a_tool_only_the_registry_knows_about_is_found(self):
        self.assertIsNone(shutil.which("sgfaketool"))
        host._refresh_tool_path(force=True)
        self.assertIsNotNone(shutil.which("sgfaketool"))

    def test_the_browsers_own_entries_stay_first(self):
        before = os.environ["PATH"].split(os.pathsep)
        host._refresh_tool_path(force=True)
        after = os.environ["PATH"].split(os.pathsep)
        self.assertEqual(after[: len(before)], before)

    def test_a_folder_is_never_added_twice(self):
        host._refresh_tool_path(force=True)
        host._refresh_tool_path(force=True)
        hits = [p for p in os.environ["PATH"].split(os.pathsep)
                if os.path.normcase(p) == os.path.normcase(self.dir)]
        self.assertEqual(len(hits), 1)

    def test_folders_that_do_not_exist_are_skipped(self):
        host._registry_path_dirs = lambda: [os.path.join(self.dir, "missing")]
        host._refresh_tool_path(force=True)
        self.assertNotIn("missing", os.environ["PATH"])

    def test_the_registry_is_not_read_on_every_message(self):
        host._refresh_tool_path(force=True)
        host._refresh_tool_path()
        host._refresh_tool_path()
        self.assertEqual(self.reads, 1)


VOD_PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXTINF:2.5,
seg2.ts
#EXT-X-ENDLIST
"""


class HlsPlaylistFacts(unittest.TestCase):
    def test_a_finished_playlist_gives_every_segment_start(self):
        self.assertEqual(host._hls_segment_timeline(VOD_PLAYLIST), [0.0, 4.0, 8.0, 10.5])

    def test_a_live_playlist_has_no_length_yet(self):
        live = VOD_PLAYLIST.replace("#EXT-X-ENDLIST\n", "")
        self.assertIsNone(host._hls_segment_timeline(live))

    def test_a_master_playlist_lists_variants_not_segments(self):
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n#EXT-X-ENDLIST\n"
        self.assertIsNone(host._hls_segment_timeline(master))

    def test_a_nonsense_duration_is_not_believed(self):
        broken = VOD_PLAYLIST.replace("#EXTINF:2.5,", "#EXTINF:99999,")
        self.assertIsNone(host._hls_segment_timeline(broken))

    def test_aes128_is_recognised_as_encrypted(self):
        enc = VOD_PLAYLIST.replace("#EXTINF:4.0,", '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,', 1)
        self.assertTrue(host._hls_is_encrypted(enc))

    def test_method_none_and_no_key_are_clear(self):
        self.assertFalse(host._hls_is_encrypted(VOD_PLAYLIST))
        self.assertFalse(host._hls_is_encrypted(
            VOD_PLAYLIST.replace("#EXTINF:4.0,", "#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,", 1)))


class ProgressReadsLikeTheSegmentDownloader(unittest.TestCase):
    """
    ffmpeg reports how far into the video it is. Against the playlist that
    becomes [N/M], a percentage and an estimate, instead of a clock with
    nothing to measure it by.
    """

    TIMELINE = [0.0, 4.0, 8.0, 10.5]

    def test_segment_count_percent_and_time_left(self):
        detail, pct = host._ffmpeg_progress_view(
            {"tsec": 5.0, "speed": "2.0x"}, self.TIMELINE)
        self.assertTrue(detail.startswith("[2/3]"), detail)
        self.assertIn("0:05 of 0:10", detail)
        self.assertIn("2s left", detail)
        self.assertAlmostEqual(pct, 5.0 * 100 / 10.5, places=3)

    def test_no_zero_seconds_left_at_the_very_end(self):
        detail, pct = host._ffmpeg_progress_view(
            {"tsec": 10.4, "speed": "2.0x"}, self.TIMELINE)
        self.assertNotIn("left", detail)

    def test_past_the_end_is_held_at_100(self):
        _, pct = host._ffmpeg_progress_view({"tsec": 99.0}, self.TIMELINE)
        self.assertEqual(pct, 100.0)

    def test_a_step_label_comes_first(self):
        detail, _ = host._ffmpeg_progress_view({"tsec": 1.0}, [0.0, 10.0], "Re-encoding")
        self.assertTrue(detail.startswith("Re-encoding"), detail)
        self.assertNotIn("[", detail)  # one span, no segment count

    def test_without_a_timeline_it_says_what_it_always_said(self):
        detail, pct = host._ffmpeg_progress_view(
            {"time": "00:16:12.24", "tsec": 972.24, "size": "96512KiB", "speed": "7.96x"})
        self.assertEqual(detail, "time 00:16:12.24, size 96512KiB, 7.96x")
        self.assertIsNone(pct)


class SavedPlaylistStartsOnCurrentFfmpeg(unittest.TestCase):
    """
    -headers and -user_agent are HTTP options. Against a playlist saved to disk
    nothing consumes them, and ffmpeg 9 refuses to start when an input option
    goes unused, so every one of these jobs failed before fetching a byte.
    """

    def _cmd(self, local):
        cmd, _ = host._build_ffmpeg_cmd_list(
            "http://cdn.example/index.m3u8",
            {"streamKind": "hls", "userAgent": "UA"},
            os.path.join(os.path.dirname(local), "out.mkv"),
            "Referer: http://cdn.example/\r\n",
            playlist_text=VOD_PLAYLIST,
            playlist_url="http://cdn.example/index.m3u8",
            ffmpeg_input=local,
        )
        return cmd

    def test_no_http_options_against_a_file(self):
        cmd = self._cmd(os.path.join(tempfile.gettempdir(), "x.m3u8"))
        self.assertNotIn("-headers", cmd)
        self.assertNotIn("-user_agent", cmd)

    def test_they_stay_for_a_url(self):
        cmd, _ = host._build_ffmpeg_cmd_list(
            "http://cdn.example/a.mp4", {"userAgent": "UA"},
            os.path.join(tempfile.gettempdir(), "out.mkv"),
            "Referer: http://cdn.example/\r\n",
        )
        self.assertIn("-headers", cmd)
        self.assertIn("-user_agent", cmd)

    def _segment_encode_args(self):
        """
        The fixture only has to be a real transport stream. libx264 is the
        usual encoder, but some Linux builds (Fedora's) compile it out, and
        the remux under test is a stream copy.
        """
        listed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True,
        )
        names = set()
        for line in (listed.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].startswith("V"):
                names.add(parts[1])
        if "libx264" in names:
            return ["-c:v", "libx264", "-preset", "ultrafast"]
        if "mpeg4" in names:
            return ["-c:v", "mpeg4", "-q:v", "5"]
        self.skipTest("ffmpeg has neither libx264 nor mpeg4")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_ffmpeg_actually_runs_it(self):
        encode = self._segment_encode_args()
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        for i in range(3):
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                 f"testsrc2=size=160x90:rate=10:duration={2.5 if i == 2 else 4}",
                 *encode, "-f", "mpegts",
                 os.path.join(work, f"seg{i}.ts")],
                check=True, capture_output=True,
            )
        local = os.path.join(work, "index.m3u8")
        with open(local, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(VOD_PLAYLIST)
        r = subprocess.run(self._cmd(local), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        self.assertTrue(os.path.getsize(os.path.join(work, "out.mkv")) > 1000)


class QualityListAnswers(unittest.TestCase):
    """
    Asking yt-dlp for a page's formats named a variable that did not exist, so
    it died in its thread without replying, after writing the browser's
    cookies to a temp file and before the code that deletes it.
    """

    def test_it_replies_and_cleans_up_the_cookie_file(self):
        sent, written, ran = [], [], []
        real = (host.send_message, host._yt_dlp_invocation_prefix,
                host.subprocess.run, host._write_netscape_cookie_file)

        def fake_cookie_file(jar):
            fd, path = tempfile.mkstemp(prefix="sg_cookies_test_", suffix=".txt")
            os.close(fd)
            written.append(path)
            return path

        class Done:
            returncode = 0
            stdout = '{"formats": []}'
            stderr = ""

        host.send_message = sent.append
        host._yt_dlp_invocation_prefix = lambda: ["yt-dlp"]
        host.subprocess.run = lambda cmd, **kw: (ran.append(cmd), Done())[1]
        host._write_netscape_cookie_file = fake_cookie_file
        try:
            host._handle_ytdlp_formats({
                "requestId": "r1",
                "pageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "cookieJar": [{"name": "a", "value": "b", "domain": ".youtube.com"}],
            })
        finally:
            (host.send_message, host._yt_dlp_invocation_prefix,
             host.subprocess.run, host._write_netscape_cookie_file) = real

        replies = [m for m in sent if m.get("type") == "ytdlp_formats_result"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["requestId"], "r1")
        self.assertTrue(ran, "yt-dlp was never reached")
        self.assertTrue(written)
        self.assertFalse(os.path.exists(written[0]), "the cookie file was left behind")


class YoutubeChallengeRuntime(unittest.TestCase):
    """
    Firefox launches the helper with the desktop PATH. Deno installed for the
    user lives in ~/.deno/bin, which that PATH does not include, so the
    n-challenge never ran and yt-dlp reported that only images were available.
    """

    URL = "https://www.youtube.com/watch?v=ZUEVS8EwOcI"

    @staticmethod
    def _fake(work, name):
        # Windows only runs and finds deno.exe and node.exe, never a bare name.
        path = os.path.join(work, name + (".exe" if os.name == "nt" else ""))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\n")
        os.chmod(path, 0o755)
        return path

    @staticmethod
    def _at(args, runtime, path):
        # shutil.which on Windows hands back PATHEXT's casing, deno.EXE.
        want = os.path.normcase(os.path.abspath(path))
        for i, a in enumerate(args):
            if a.startswith(runtime + ":") and os.path.normcase(a[len(runtime) + 1:]) == want:
                return i
        raise AssertionError(f"{runtime}:{path} not in {args}")

    def test_a_runtime_outside_path_is_named_by_absolute_path(self):
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        deno = self._fake(work, "deno")
        real_dirs = host._js_runtime_search_dirs
        old_path = os.environ.get("PATH", "")
        host._js_runtime_search_dirs = lambda: [work]
        os.environ["PATH"] = ""
        self.addCleanup(setattr, host, "_js_runtime_search_dirs", real_dirs)
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        args = host._yt_dlp_youtube_cli_extras({}, self.URL)
        self._at(args, "deno", deno)
        self.assertNotIn("--no-js-runtimes", args)

    def test_node_is_enabled_only_after_the_default_deno_is_cleared(self):
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        node = self._fake(work, "node")
        real_dirs = host._js_runtime_search_dirs
        old_path = os.environ.get("PATH", "")
        host._js_runtime_search_dirs = lambda: [work]
        # Any node already installed would be found on PATH instead of this one.
        os.environ["PATH"] = ""
        self.addCleanup(setattr, host, "_js_runtime_search_dirs", real_dirs)
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        args = host._yt_dlp_youtube_cli_extras({}, self.URL)
        self.assertLess(args.index("--no-js-runtimes"), args.index("--js-runtimes"))
        self._at(args, "node", node)

    def test_deno_and_node_are_both_passed_when_both_exist(self):
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        deno = self._fake(work, "deno")
        node = self._fake(work, "node")
        real_dirs = host._js_runtime_search_dirs
        old_path = os.environ.get("PATH", "")
        host._js_runtime_search_dirs = lambda: [work]
        os.environ["PATH"] = work
        self.addCleanup(setattr, host, "_js_runtime_search_dirs", real_dirs)
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        args = host._yt_dlp_youtube_cli_extras({}, self.URL)
        self.assertNotIn("--no-js-runtimes", args)
        deno_at = self._at(args, "deno", deno)
        node_at = self._at(args, "node", node)
        self.assertLess(deno_at, node_at)


class SegmentsOnAnotherSiteGetNoCookies(unittest.TestCase):
    """
    The cookie and auth token were captured for the playlist's site. A playlist
    can list segments on any host, and a browser would never send one site's
    cookies to another.
    """

    BLOCK = (
        "Referer: https://tube.example/watch\r\n"
        "User-Agent: UA\r\n"
        "Cookie: session=secret\r\n"
        "Authorization: Bearer secret\r\n"
    )
    PLAYLIST = "https://tube.example/hls/index.m3u8"

    def test_another_site_gets_neither(self):
        out = host._scope_header_block(self.BLOCK, self.PLAYLIST, "https://evil.example/seg1.ts")
        self.assertNotIn("Cookie", out)
        self.assertNotIn("Authorization", out)
        self.assertIn("Referer: https://tube.example/watch", out)
        self.assertIn("User-Agent: UA", out)

    def test_the_same_site_and_its_cdn_keep_them(self):
        for target in ("https://tube.example/seg1.ts", "https://cdn.tube.example/seg1.ts"):
            self.assertEqual(host._scope_header_block(self.BLOCK, self.PLAYLIST, target), self.BLOCK)


YT_JAR = [{"name": "SID", "value": "x", "domain": ".youtube.com", "path": "/", "secure": True}]
YT_PAGE = "https://www.youtube.com/watch?v=d2RVycC06gI"
BOT_CHECK = (
    "ERROR: [youtube] d2RVycC06gI: Sign in to confirm you\ufffdre not a bot. "
    "Use --cookies-from-browser or --cookies for the authentication."
)


class YoutubeSignInIsRecognised(unittest.TestCase):
    def test_the_bot_check_as_it_actually_arrived(self):
        # The apostrophe came through mangled; the match must not depend on it.
        self.assertTrue(host._looks_like_youtube_sign_in(BOT_CHECK))

    def test_the_age_gate_needs_the_login_too(self):
        self.assertTrue(host._looks_like_youtube_sign_in(
            "ERROR: [youtube] x: Sign in to confirm your age."))

    def test_other_failures_are_left_alone(self):
        for tail in ("ERROR: Video unavailable", "HTTP Error 404", ""):
            self.assertFalse(host._looks_like_youtube_sign_in(tail), tail)

    def test_only_youtube_cookies_count(self):
        self.assertTrue(host._jar_has_youtube(YT_JAR))
        self.assertFalse(host._jar_has_youtube(
            [{"name": "sp_dc", "value": "x", "domain": ".spotify.com"}]))
        self.assertFalse(host._jar_has_youtube(None))


class YoutubeCookiesOnlyAfterYoutubeAsks(unittest.TestCase):
    def setUp(self):
        fd, self.jar = tempfile.mkstemp(prefix="sg_cookies_t_", suffix=".txt")
        os.close(fd)
        self.addCleanup(host._remove_temp_file_quietly, self.jar)

    def test_anonymous_by_default(self):
        self.assertEqual(host._yt_dlp_cookies_args({"_ytDlpCookieFile": self.jar}, YT_PAGE), [])

    def test_the_login_goes_once_youtube_has_asked(self):
        msg = {"_ytDlpCookieFile": self.jar, "_ytDlpYoutubeCookies": True}
        self.assertEqual(host._yt_dlp_cookies_args(msg, YT_PAGE), ["--cookies", self.jar])

    def test_never_the_browser_store_for_youtube(self):
        msg = {"_ytDlpYoutubeCookies": True, "ytDlpCookiesFromBrowser": "chrome"}
        self.assertNotIn("--cookies-from-browser", host._yt_dlp_cookies_args(msg, YT_PAGE))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
class YoutubeBotCheckIsRetriedWithTheLogin(unittest.TestCase):
    """
    The full download path, with yt-dlp swapped for a stand-in that refuses
    anonymous requests the way YouTube's bot check does.
    """

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.video = os.path.join(cls.dir, "small.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=2",
             "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-preset", "ultrafast",
             "-c:a", "aac", "-shortest", cls.video],
            check=True, capture_output=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def _run(self, jar):
        attempts, sent = [], []
        out = os.path.join(self.dir, "out.mp4")
        if os.path.exists(out):
            os.remove(out)
        video = self.video
        real_popen = host.subprocess.Popen

        class Proc:
            def __init__(self, cmd):
                jar_file = cmd[cmd.index("--cookies") + 1] if "--cookies" in cmd else None
                attempts.append(bool(jar_file and os.path.isfile(jar_file)))
                if attempts[-1]:
                    shutil.copyfile(video, out)
                    self.code, self.stderr = 0, io.BytesIO(b"[download] 100%\n")
                else:
                    self.code, self.stderr = 1, io.BytesIO(BOT_CHECK.encode("utf-8") + b"\n")

            def wait(self, timeout=None):
                return self.code

            def poll(self):
                return self.code

        saved = (host.subprocess.Popen, host.send_message, host._yt_dlp_invocation_prefix)
        host.subprocess.Popen = lambda cmd, *a, **k: (
            Proc(cmd) if cmd and cmd[0] == "yt-dlp" else real_popen(cmd, *a, **k))
        host.send_message = sent.append
        host._yt_dlp_invocation_prefix = lambda: ["yt-dlp"]
        try:
            msg = {"pageUrl": YT_PAGE, "url": "", "jobId": "t"}
            if jar is not None:
                msg["cookieJar"] = jar
            ok, err = host.run_yt_dlp_with_updates(YT_PAGE, msg, out, "t", "YouTube")
        finally:
            host.subprocess.Popen, host.send_message, host._yt_dlp_invocation_prefix = saved
        return ok, err, attempts

    def test_signed_in_it_retries_with_the_login_and_succeeds(self):
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "sg_cookies_*")))
        ok, err, attempts = self._run(YT_JAR)
        self.assertEqual(attempts, [False, True], "anonymous first, then with the login")
        self.assertTrue(ok, err)
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "sg_cookies_*")))
        self.assertEqual(after - before, set(), "the cookie file was left behind")

    def test_signed_out_it_says_to_sign_in_instead_of_naming_flags(self):
        ok, err, attempts = self._run([])
        self.assertEqual(attempts, [False], "nothing to retry with")
        self.assertFalse(ok)
        self.assertIn("Sign in to YouTube", err)
        self.assertNotIn("--cookies", err)


class QualityListGetsTheSameRetry(unittest.TestCase):
    def test_it_retries_with_the_login_and_answers(self):
        sent, cmds = [], []

        class R:
            def __init__(self, code, out, err):
                self.returncode, self.stdout, self.stderr = code, out, err

        def fake_run(cmd, **kw):
            cmds.append(cmd)
            if "--cookies" in cmd:
                return R(0, '{"formats": []}', "")
            return R(1, "", BOT_CHECK)

        saved = (host.send_message, host._yt_dlp_invocation_prefix, host.subprocess.run)
        host.send_message = sent.append
        host._yt_dlp_invocation_prefix = lambda: ["yt-dlp"]
        host.subprocess.run = fake_run
        try:
            host._handle_ytdlp_formats({"requestId": "q", "pageUrl": YT_PAGE, "cookieJar": YT_JAR})
        finally:
            host.send_message, host._yt_dlp_invocation_prefix, host.subprocess.run = saved
        self.assertEqual(["--cookies" in c for c in cmds], [False, True])
        reply = [m for m in sent if m.get("type") == "ytdlp_formats_result"][0]
        self.assertNotEqual(reply.get("success"), False, reply.get("error"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
