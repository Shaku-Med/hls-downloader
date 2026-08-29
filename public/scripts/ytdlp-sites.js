/**
 * Reads data/ytdlp-sites.json and answers questions about a page.
 *
 * The helper reads the same file, so a site added there is known to both sides
 * at once. Everything here works off the page URL only: what the traffic looks
 * like is a separate question, answered elsewhere.
 */
(function (global) {
  if (global.HLS_YTDLP_SITES) return;

  const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i;

  let sites = [];
  let ready = false;

  function normHost(urlOrHost) {
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

  function pathOf(url) {
    try {
      return new URL(String(url || '')).pathname || '/';
    } catch (_) {
      return '';
    }
  }

  function hostMatches(site, host) {
    if (!host) return false;
    const names = [site.hostname].concat(site.aliases || []);
    for (const n of names) {
      const d = String(n || '').toLowerCase();
      if (d && (host === d || host.endsWith('.' + d))) return true;
    }
    // Amazon Music runs a domain per country, so a prefix stands in for a list.
    const prefix = site.hostnamePrefix;
    return !!(prefix && host.startsWith(String(prefix).toLowerCase()));
  }

  /**
   * Does this path hold that endpoint?
   *
   * Not a plain prefix: most of these sites put something variable in front,
   * as in /{user}/status/{id} or /r/{sub}/comments/{id}. The endpoint has to
   * land on a segment boundary at both ends though, so /watch does not match
   * /watchlist.
   */
  function endpointInPath(endpoint, path) {
    let at = path.indexOf(endpoint);
    while (at !== -1) {
      const after = at + endpoint.length;
      if (endpoint.endsWith('/') || after >= path.length || path[after] === '/') return true;
      at = path.indexOf(endpoint, at + 1);
    }
    return false;
  }

  /** The site entry for a URL, or null. */
  function siteFor(url) {
    const host = normHost(url);
    if (!host) return null;
    for (const site of sites) {
      if (hostMatches(site, host)) return site;
    }
    return null;
  }

  /**
   * What this page holds, if anything yt-dlp can take.
   *
   * @returns {null | {label: string, role: string, searchFallback: boolean,
   *                   hostname: string, endpoint: string}}
   */
  function lookup(url) {
    const site = siteFor(url);
    if (!site) return null;
    const path = pathOf(url);
    if (!path) return null;
    // Several of these put the language in the path, so /us/album/... has to
    // match an endpoint of /album. Both spellings are tried.
    const paths = [path];
    const stripped = path.replace(LOCALE_PREFIX, '');
    if (stripped !== path) paths.push(stripped);

    let best = null;
    for (const page of site.pages || []) {
      const endpoint = String(page.endpoint || '');
      if (!endpoint || !paths.some((p) => endpointInPath(endpoint, p))) continue;
      // Longest match wins, so /browse/track/ beats /.
      if (!best || endpoint.length > best.endpoint.length) {
        best = { endpoint, role: page.role || site.role || 'video' };
      }
    }
    if (!best) return null;
    return {
      label: site.label || site.hostname,
      role: best.role,
      searchFallback: !!site.searchFallback,
      hostname: site.hostname,
      endpoint: best.endpoint,
    };
  }

  function isReady() {
    return ready;
  }

  function load(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      sites = (data && data.sites) || [];
      ready = sites.length > 0;
    } catch (_) {
      sites = [];
      ready = false;
    }
    return ready;
  }

  /** Fetch the file from inside the extension. Safe to call more than once. */
  async function loadFromExtension() {
    if (ready) return true;
    try {
      const url = global.chrome && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL('data/ytdlp-sites.json')
        : 'data/ytdlp-sites.json';
      const res = await fetch(url);
      return load(await res.json());
    } catch (_) {
      return false;
    }
  }

  global.HLS_YTDLP_SITES = { lookup, siteFor, load, loadFromExtension, isReady, normHost };
})(typeof self !== 'undefined' ? self : this);
