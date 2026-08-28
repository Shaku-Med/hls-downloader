/**
 * Sites whose media is protected, shared by the background and the page script.
 *
 * The background needs this too: a content script only loads when a page loads,
 * so on a tab that was already open the extension would know nothing. Matching
 * the tab URL here means the notice is right straight away.
 */
(function (global) {
  if (global.HLS_DRM_HOSTS) return;

  /**
   * Protected video. Screen recording is the way out on these, and the in page
   * recorder is not: a protected video element yields black frames.
   */
  const VIDEO = [
    'netflix.com',
    'disneyplus.com',
    'hotstar.com',
    'primevideo.com',
    'hulu.com',
    'max.com',
    'hbomax.com',
    'peacocktv.com',
    'paramountplus.com',
    'crunchyroll.com',
    'funimation.com',
    'tv.apple.com',
    'channel4.com',
    'itv.com',
    'itvx.com',
    'nowtv.com',
    'discoveryplus.com',
    'britbox.com',
    'showtime.com',
    'starz.com',
    'stan.com.au',
    'binge.com.au',
    'mubi.com',
    'kanopy.com',
    'curiositystream.com',
    'vudu.com',
    'fubo.tv',
    'pluto.tv',
    'sling.com',
    'philo.com',
    'plex.tv',
    'shudder.com',
    'criterionchannel.com',
    'viki.com',
    'iq.com',
    'wetv.vip',
    'zee5.com',
    'sonyliv.com',
    'jiocinema.com',
    'videoland.com',
    'canalplus.com',
    'rakuten.tv',
    'joyn.de',
  ];

  /** Protected audio. Recording the screen does not help here. */
  const AUDIO = [
    'open.spotify.com',
    'spotify.com',
    'music.apple.com',
    'music.amazon.com',
    'tidal.com',
    'deezer.com',
    'audible.com',
    'music.youtube.com',
  ];

  function hostOf(urlOrHost) {
    let h = String(urlOrHost || '').trim();
    if (!h) return '';
    if (h.includes('://')) {
      try {
        h = new URL(h).hostname;
      } catch (_) {
        return '';
      }
    }
    return h.toLowerCase().replace(/^www\./, '');
  }

  function inList(host, list) {
    for (const d of list) {
      if (host === d || host.endsWith('.' + d)) return d;
    }
    return '';
  }

  /** @returns {'video' | 'audio' | ''} */
  function kindFor(urlOrHost) {
    const h = hostOf(urlOrHost);
    if (!h) return '';
    if (inList(h, VIDEO)) return 'video';
    if (inList(h, AUDIO)) return 'audio';
    return '';
  }

  function matchedHost(urlOrHost) {
    const h = hostOf(urlOrHost);
    return inList(h, VIDEO) || inList(h, AUDIO) || '';
  }

  global.HLS_DRM_HOSTS = { VIDEO, AUDIO, hostOf, kindFor, matchedHost };
})(typeof self !== 'undefined' ? self : this);
