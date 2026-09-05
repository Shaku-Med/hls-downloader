#!/usr/bin/env python3
"""
Tests for the native host logic that decides yt-dlp routing and cookie handling.
Run from the repo root:  python -m unittest discover test
Or directly:             python test/test_host.py
"""

import os
import re
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
