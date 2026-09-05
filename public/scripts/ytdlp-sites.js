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
  // The file ships inside the extension, so this is a sanity bound rather than
  // a defence against a hostile pattern. Anything longer is a mistake.
  const MAX_PATTERN = 200;

  let sites = [];
  let ready = false;
  const compiled = new Map();

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

  /**
   * How specifically this site claims the host, 0 for not at all.
   *
   * The score is the length of the name that matched, so music.youtube.com
   * beats youtube.com on its own pages. Without that the first entry whose
   * suffix fits won, and YouTube Music was answered by the YouTube entry, which
   * asks for video where the whole point there is audio.
   */
  function hostScore(site, host) {
    if (!host) return 0;
    let best = 0;
    const names = [site.hostname].concat(site.aliases || []);
    for (const n of names) {
      const d = String(n || '').toLowerCase();
      if (!d) continue;
      if (host === d || host.endsWith('.' + d)) best = Math.max(best, d.length);
    }
    // Amazon Music runs a domain per country, so a prefix stands in for a list.
    const prefix = String(site.hostnamePrefix || '').toLowerCase();
    if (prefix && host.startsWith(prefix)) best = Math.max(best, prefix.length);
    return best;
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

  /** Compile once, and treat a bad pattern as no pattern rather than throwing. */
  function patternFor(source) {
    if (compiled.has(source)) return compiled.get(source);
    let re = null;
    if (typeof source === 'string' && source && source.length <= MAX_PATTERN) {
      try {
        re = new RegExp(source);
      } catch (_) {
        re = null;
      }
    }
    compiled.set(source, re);
    return re;
  }

  /** First segment the site says never holds media. */
  function denied(site, paths) {
    for (const raw of site.deny || []) {
      const d = String(raw || '');
      if (d && paths.some((p) => p === d || p.startsWith(d + '/'))) return true;
    }
    return false;
  }

  /** The site entry for a URL, most specific host wins, or null. */
  function siteFor(url) {
    const host = normHost(url);
    if (!host) return null;
    let best = null;
    let bestScore = 0;
    for (const site of sites) {
      const score = hostScore(site, host);
      if (score > bestScore) {
        best = site;
        bestScore = score;
      }
    }
    return best;
  }

  /** Whether the registry says yt-dlp is simply not the tool for this site. */
  function isDisabled(url) {
    const site = siteFor(url);
    return !!(site && site.ytdlp === false);
  }

  /**
   * What this page holds, if anything yt-dlp can take.
   *
   * @returns {null | {label: string, role: string, searchFallback: boolean,
   *                   hostname: string, endpoint: string}}
   */
  function lookup(url) {
    const site = siteFor(url);
    if (!site || site.ytdlp === false) return null;
    const path = pathOf(url);
    if (!path) return null;
    // Several of these put the language in the path, so /us/album/... has to
    // match an endpoint of /album. Both spellings are tried.
    const paths = [path];
    const stripped = path.replace(LOCALE_PREFIX, '');
    if (stripped !== path) paths.push(stripped);
    if (denied(site, paths)) return null;

    let best = null;
    for (const page of site.pages || []) {
      const endpoint = String(page.endpoint || '');
      let hit = '';
      if (endpoint) {
        if (paths.some((p) => endpointInPath(endpoint, p))) hit = endpoint;
      } else {
        const re = patternFor(page.match);
        if (re && paths.some((p) => re.test(p))) hit = String(page.match);
      }
      if (!hit) continue;
      // Longest match wins, so /browse/track/ beats /.
      if (!best || hit.length > best.endpoint.length) {
        best = { endpoint: hit, role: page.role || site.role || 'video' };
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
    compiled.clear();
    return ready;
  }

  // Where the file lands inside the loaded extension. public/ is kept as a
  // folder in both browser roots, so the path includes it. Asking for the
  // short one fetched nothing, quietly, and every page check then failed at
  // its first line because the registry was never loaded.
  const DATA_PATHS = ['public/data/ytdlp-sites.json', 'data/ytdlp-sites.json'];

  /** Fetch the file from inside the extension. Safe to call more than once. */
  async function loadFromExtension() {
    if (ready) return true;
    const resolve = (p) =>
      global.chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(p) : p;
    for (const path of DATA_PATHS) {
      try {
        const res = await fetch(resolve(path));
        if (!res || !res.ok) continue;
        if (load(await res.json())) return true;
      } catch (_) {
        // Try the next spelling.
      }
    }
    return false;
  }

  global.HLS_YTDLP_SITES = {
    lookup,
    siteFor,
    isDisabled,
    load,
    loadFromExtension,
    isReady,
    normHost,
  };
})(typeof self !== 'undefined' ? self : this);
