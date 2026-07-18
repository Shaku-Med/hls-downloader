// tabId -> [{ url, streamKind, capturedHeaders }]
const detectedStreams = {};
const CTX_IMG_ROOT = 'sg_ctx_img_root';
const CTX_IMG_FMT_PREFIX = 'sg_ctx_img_fmt_';
const CTX_IMG_FMTS = ['png', 'jpg', 'jpeg', 'webp'];

try {
  importScripts('zip-store.js');
} catch (e) {
  console.warn('Stuff Grabber: zip-store failed to load', e);
}
try {
  importScripts('social-post-urls.js');
} catch (e) {
  console.warn('Stuff Grabber: social-post-urls failed to load', e);
}

/** @type {Record<number, ReturnType<typeof setTimeout>>} */
const _ytdlpPageTimer = {};
/** @type {Record<number, Record<string, string>>} */
const _ytdlpPageCap = {};

function netflixSegmentUrl(u) {
  if (!/(nflxvideo|nflxso)\./i.test(u)) return false;
  if (/[/.](m4s|mp4|aac|vtt|webvtt)(?:[?#]|$)/i.test(u)) return true;
  if (/\/range\/\d+-\d+/.test(u)) return true;
  return false;
}

function shouldIgnoreAsNoiseUrl(url) {
  const u = String(url).toLowerCase();
  if (u.startsWith('blob:') || u.startsWith('data:')) return true;
  if (
    u.includes('doubleclick') ||
    u.includes('googleads') ||
    u.includes('pagead2.googlesyndication') ||
    u.includes('googletagmanager') ||
    u.includes('analytics') ||
    u.includes('facebook.com/tr') ||
    (u.includes('track') && u.includes('ingest'))
  ) {
    return true;
  }
  if (/[/?#](favicon|pixel|beacon|1x1)[.?&#/]/i.test(u) || /\b(tracking|spacer)\b/i.test(u)) return true;
  if (/[/.](png|jpe?g|gif|webp|svg|ico|html|js|mjs|css|woff2?|ttf|map|json|xml|wasm)(\?|#|$)/i.test(u)) {
    if (!/type=video|mime=video|contenttype=video/i.test(u)) return true;
  }
  if (/\/(seg[-_]?\d+\.|chunk|segment-?\d+|[a-f0-9]{4,20}\.m4s|init\.(mp4|m4a))(?:\?|$)/i.test(u)) return true;
  if (hlsMediaSegmentUrl(u)) return true;
  if (netflixSegmentUrl(u)) return true;
  return false;
}

/**
 * Sites and their CDNs where the reliable way to grab a video is handing yt-dlp the
 * page URL, the same as YouTube. Their signed CDN blobs expire fast and pulling one
 * directly gives a broken clip, so we surface a single "download this video" row that
 * uses the tab URL instead. Matches the host or any subdomain of it.
 */
const SOCIAL_CDN_HOSTS = [
  'googlevideo.com', 'youtube.com', 'youtu.be', 'ytimg.com',
  'instagram.com', 'cdninstagram.com',
  'facebook.com', 'fb.watch', 'fbcdn.net', 'fbvideo.com', 'threads.net',
  'tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'musical.ly', 'muscdn.com', 'ibyteimg.com',
  'twitter.com', 'x.com', 'twimg.com',
  'reddit.com', 'redd.it', 'redditmedia.com',
  'snapchat.com', 'snap.com', 'sc-cdn.net',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net',
  'dailymotion.com', 'dm-event.net', 'dmcdn.net',
  'pinterest.com', 'pinimg.com',
  'bilibili.com', 'bilivideo.com',
  'rumble.com',
  'kick.com',
  // Apple Music: FairPlay HLS is useless — hand yt-dlp the music.apple.com song/album URL.
  'music.apple.com', 'itunes.apple.com', 'mzstatic.com',
];

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isSocialCdnHost(url) {
  const h = hostOfUrl(url);
  if (!h) return false;
  return SOCIAL_CDN_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

function isAppleMusicPage(url) {
  const h = hostOfUrl(url);
  return h === 'music.apple.com' || h.endsWith('.music.apple.com');
}

/** Song / album / playlist / music-video pages that yt-dlp can take as a URL. */
function isAppleMusicTrackPage(url) {
  if (!isAppleMusicPage(url)) return false;
  try {
    const path = new URL(url).pathname || '';
    return /\/(song|album|playlist|music-video)\//i.test(path);
  } catch {
    return false;
  }
}

function isAppleMediaCdnUrl(url) {
  const h = hostOfUrl(url);
  if (!h) return false;
  if (h === 'music.apple.com' || h.endsWith('.music.apple.com')) return true;
  if (h === 'itunes.apple.com' || h.endsWith('.itunes.apple.com')) return true;
  if (h === 'mzstatic.com' || h.endsWith('.mzstatic.com')) return true;
  return false;
}

/**
 * A social host serves plenty of images and API calls too. Only treat a request as a
 * video worth grabbing when the URL actually looks like media, so we do not offer a
 * page download on a profile page that has no video.
 */
function looksLikeMediaRequest(url) {
  const u = String(url).toLowerCase();
  if (/[/.](m3u8|m3u|mpd|mp4|m4s|m4v|webm|mov|ts|aac)(?:[?#]|$)/.test(u)) return true;
  return /(videoplayback|mime=video|itag=|[?&]dash|\bhls\b|progressive|amplify_video|ext_tw_video|\/video\/|playlist|manifest|master)/.test(
    u
  );
}

function socialPageMediaHit(url) {
  return isSocialCdnHost(url) && !shouldIgnoreAsNoiseUrl(url) && looksLikeMediaRequest(url);
}

/**
 * HLS fetches thousands of .ts (or fMP4) chunks; only playlists / progressive URLs are valid ffmpeg inputs.
 */
function hlsMediaSegmentUrl(u) {
  if (u.includes('cdninstagram.com') && /\.(ts|m2ts|mts|aac|fmp4|m4s)(?:[?#]|$)/i.test(u)) return true;
  if (u.includes('fbcdn.net') && /\/(v|t\d+)\/.+\.ts(?:[?#]|$)/i.test(u)) return true;
  if (/[/.]min\.ts(?:[?#]|$)/i.test(u) || /[._-](seg(ment)?|seq|sequence|hls-?chunk|part)[._-]?\d+[/.]/i.test(u)) {
    return true;
  }
  if (/\/(h|seg|s)[-_]?\d{2,5}\.ts(?:[?#]|$)/i.test(u) || /[/.]\d{4,8}\.ts(?:[?#]|$)/i.test(u)) return true;
  if (/[/.]ts(?:[?#]|$)/i.test(u) && /(cdninstagram|fbcdn|twimg|googlevideo|akamai|fastly|cloudfront)/i.test(u)) {
    return true;
  }
  return false;
}

/**
 * @returns {null | { kind: string, reason: string }}
 */
function classifyVideoFromUrl(url) {
  if (shouldIgnoreAsNoiseUrl(url)) return null;
  const u = String(url).toLowerCase();
  if (/[/.]vtt(?:[?#]|$)/.test(u) || /[?&](format|ext|type|mime)=([^&#]*vtt|text%2fvtt)(?:[&#]|$)/i.test(u)) {
    return { kind: 'subtitle', reason: 'vtt' };
  }

  // Social and platform CDNs first, before the generic extension checks below. A signed
  // Instagram blob ends in .mp4?token and would otherwise look like a plain direct file,
  // when what we really want is to hand yt-dlp the page URL like we do for YouTube.
  if (socialPageMediaHit(url)) {
    return { kind: 'social', reason: 'host' };
  }

  if (/[/.](m3u8|m3u)(?:[?#]|$)/.test(u)) {
    return { kind: 'hls', reason: 'path' };
  }
  if (/[/.]mpd(?:[?#]|$)/.test(u) || (u.includes('dash') && (u.includes('manifest') || u.includes('.mpd')))) {
    return { kind: 'dash', reason: 'path' };
  }
  if (/[/.](mp4|webm|mkv|mov|m4v|ogv)(?:[?#]|$)/.test(u)) {
    return { kind: 'direct', reason: 'ext' };
  }
  if (u.includes('b-cdn.net') && /(video|m3u8|mp4|mediadelivery)/.test(u)) {
    return { kind: 'direct', reason: 'b-cdn' };
  }
  if (/(ttvnw\.net|jtvnw\.net|usher\.ttvnw\.net)/.test(u) && (u.includes('m3u8') || u.includes('.mp4') || u.includes('playlist'))) {
    return { kind: 'social', reason: 'twitch' };
  }
  if (u.includes('vimeocdn.com') && /(video|m3u8|mp4|avc|dash|hls|segment)/.test(u)) {
    return { kind: 'direct', reason: 'vimeo' };
  }
  if (u.includes('m3u8') && !/segment|chunk\/\d+/.test(u)) {
    return { kind: 'hls', reason: 'query' };
  }
  if (/[?&]mime=video%2f/i.test(u) || /[?&]type=video(&|$|#)/i.test(u) || /[?&]contenttype=video/i.test(u)) {
    return { kind: 'direct', reason: 'query' };
  }
  if (/[?&]format=m3u8|manifest\.m3u8|type=hls|stream_type=hls/i.test(u)) {
    return { kind: 'hls', reason: 'query' };
  }
  if (/[?&]format=dash|type=dash|manifest\.mpd/i.test(u)) {
    return { kind: 'dash', reason: 'query' };
  }
  return null;
}

function getHeaderValue(headers, name) {
  const n = (name || '').toLowerCase();
  for (const h of headers || []) {
    if (h && h.name && h.name.toLowerCase() === n) return h.value || '';
  }
  return '';
}

/**
 * @returns {string | null}
 */
function streamKindFromContentType(contentType) {
  const c = (contentType || '').toLowerCase().split(';')[0].trim();
  if (c === 'text/vtt') {
    return 'subtitle';
  }
  if (c === 'application/vnd.apple.mpegurl' || c === 'application/x-mpegurl' || c === 'audio/mpegurl') {
    return 'hls_by_header';
  }
  if (c === 'application/dash+xml' || c === 'application/dash') {
    return 'dash';
  }
  if (c.startsWith('video/') && c !== 'video/fake') {
    return 'by_header';
  }
  if (c === 'application/octet-stream' || c === 'binary/octet-stream') {
    return null;
  }
  return null;
}

function upsertStream(tabId, url, capturedHeaders, streamKind) {
  if (!url || !tabId || tabId < 0) return;
  if (shouldIgnoreAsNoiseUrl(url)) return;
  if (!detectedStreams[tabId]) detectedStreams[tabId] = [];
  const list = detectedStreams[tabId];
  const found = list.find((e) => e.url === url);
  if (found) {
    found.capturedHeaders = { ...found.capturedHeaders, ...capturedHeaders };
    if (streamKind) found.streamKind = streamKind;
    return;
  }
  const fromUrl = streamKind ? null : classifyVideoFromUrl(url);
  const kind = streamKind || (fromUrl && fromUrl.kind);
  if (!kind) return;
  list.push({ url, streamKind: kind, capturedHeaders: { ...capturedHeaders } });
  console.log('Video stream:', kind, url);
  chrome.action.setBadgeText({ text: String(list.length), tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId });
  notifyStreamsChanged(tabId);
}

function socialPostApi() {
  return typeof self !== 'undefined' && self.HLS_SOCIAL_POSTS ? self.HLS_SOCIAL_POSTS : null;
}

/**
 * Collect yt-dlp targets: real post URLs from the tab + <a href> scan.
 * Never use bare home/feed URLs like https://www.facebook.com/
 */
async function collectYtdlpTargetUrls(tabId, pageUrl) {
  const api = socialPostApi();
  const targets = [];
  const seen = new Map(); // key -> index in targets

  const add = (raw, kindHint, urlSource) => {
    const url = String(raw || '').trim();
    if (!url) return;
    let kind = kindHint;
    let finalUrl = url;
    let cleanedUrl = '';
    if (api && typeof api.classifySocialPostUrl === 'function') {
      const hit = api.classifySocialPostUrl(url);
      if (!hit.ok) return;
      finalUrl = hit.url;
      cleanedUrl = hit.cleanedUrl || '';
      kind = hit.kind;
    } else {
      // Fallback if helper failed to load: only allow obvious watch/post paths.
      try {
        const u = new URL(url);
        const path = u.pathname || '/';
        if (path === '/' || path === '') return;
      } catch {
        return;
      }
      const lower = url.toLowerCase();
      kind =
        kind ||
        (lower.includes('youtube.com') || lower.includes('youtu.be') ? 'yt' : 'social');
    }
    const source = urlSource === 'tab' ? 'tab' : 'link';
    const key = finalUrl.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) {
      // Prefer tab (opened page) over a duplicate link hit.
      const idx = seen.get(key);
      if (source === 'tab' && targets[idx] && targets[idx].urlSource !== 'tab') {
        targets[idx].urlSource = 'tab';
      }
      if (cleanedUrl && targets[idx] && !targets[idx].cleanedUrl) {
        targets[idx].cleanedUrl = cleanedUrl;
      }
      return;
    }
    seen.set(key, targets.length);
    targets.push({
      url: finalUrl,
      cleanedUrl: cleanedUrl || finalUrl,
      streamKind: kind,
      urlSource: source,
    });
  };

  // 1) Tab URL only if it is itself a post/watch URL.
  if (api && typeof api.classifySocialPostUrl === 'function') {
    const pageHit = api.classifySocialPostUrl(pageUrl);
    if (pageHit.ok) add(pageHit.url, pageHit.kind, 'tab');
  } else {
    add(pageUrl, null, 'tab');
  }

  // 2) Scan <a href> (and canonical/og:url) in the page for post endpoints.
  //    Relative paths like /reel/123 resolve against the page origin/hostname.
  try {
    const res = await tabsSend(tabId, { type: 'LIST_SOCIAL_POST_URLS' });
    const urls = res && Array.isArray(res.urls) ? res.urls : [];
    for (const u of urls) add(u, null, 'link');
    if (res && res.pageIsPost && res.pagePostUrl) add(res.pagePostUrl, res.pageKind, 'tab');
  } catch (_) {
    // Content script may be missing on restricted pages.
  }

  return targets;
}

/**
 * Social + YouTube CDNs: yt-dlp uses post/page URLs (not raw CDN blobs).
 * Prefer concrete post links from the DOM when the tab is a feed/home root.
 */
function upsertYtdlpPagePlaceholder(tabId, capturedHeaders) {
  if (!tabId || tabId < 0) return;
  _ytdlpPageCap[tabId] = { ...(_ytdlpPageCap[tabId] || {}), ...(capturedHeaders || {}) };
  if (_ytdlpPageTimer[tabId]) {
    clearTimeout(_ytdlpPageTimer[tabId]);
  }
  _ytdlpPageTimer[tabId] = setTimeout(() => {
    delete _ytdlpPageTimer[tabId];
    const capSnap = _ytdlpPageCap[tabId];
    delete _ytdlpPageCap[tabId];
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      const pageUrl = (tab.url || '').trim();
      if (!/^https?:/i.test(pageUrl)) return;

      void (async () => {
        if (!detectedStreams[tabId]) detectedStreams[tabId] = [];
        const list = detectedStreams[tabId];
        let merged = { ...(capSnap || {}) };
        for (const e of list) {
          if ((e.streamKind === 'social' || e.streamKind === 'yt') && e.capturedHeaders) {
            merged = { ...e.capturedHeaders, ...merged };
          }
        }

        const targets = await collectYtdlpTargetUrls(tabId, pageUrl);
        // Drop raw HLS/DASH rows on Apple Music — only the song page URL is usable with yt-dlp.
        const rest = isAppleMusicPage(pageUrl)
          ? []
          : list.filter((e) => e.streamKind !== 'social' && e.streamKind !== 'yt');

        if (!targets.length) {
          // Nothing usable (e.g. facebook.com/ with no post links found yet).
          detectedStreams[tabId] = rest;
          chrome.action.setBadgeText({
            text: rest.length ? String(rest.length) : '',
            tabId,
          });
          if (rest.length) {
            chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId });
          }
          console.log('yt-dlp: no post URL on', pageUrl);
          notifyStreamsChanged(tabId);
          return;
        }

        for (const t of targets) {
          rest.push({
            url: t.url,
            cleanedUrl: t.cleanedUrl || t.url,
            streamKind: t.streamKind || 'social',
            pageDownload: true,
            urlSource: t.urlSource === 'tab' ? 'tab' : 'link',
            capturedHeaders: { ...merged },
          });
        }
        detectedStreams[tabId] = rest;
        console.log(
          'yt-dlp page placeholder(s):',
          targets.map((t) => `${t.urlSource || 'link'} ${t.streamKind} ${t.url}`).join(' | ')
        );
        chrome.action.setBadgeText({ text: String(rest.length), tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId });
        notifyStreamsChanged(tabId);
      })();
    });
  }, 140);
}

/** Prefer master / playlist URLs and progressive video in the popup list. */
function sortStreamsForUi(list) {
  if (!list || !list.length) return [];
  const score = (s) => {
    // Opened post page first, then post links from <a> tags, then network streams.
    if (s && s.pageDownload && s.urlSource === 'tab') return 170;
    if (s && s.pageDownload && s.urlSource === 'link') return 160;
    if (s && s.pageDownload) return 150;
    const u = ((s && s.url) || '').toLowerCase();
    if (hlsMediaSegmentUrl(u)) return -1000;
    if (/(^|[/._-])(main|master|index|source|highest|progressive|manifest)[^/]*\.(m3u8|m3u|mpd|mp4)(?:[?#]|$)/i.test(u)) {
      return 100;
    }
    if ((/\b(playlist|manifest)\b/i.test(u) || u.includes('master') || u.includes('main.m3u8')) && u.includes('m3u8')) {
      return 80;
    }
    if (/[/.](m3u8|m3u|mp4|mpd|webm)(?:[?#]|$)/i.test(u)) return 40;
    if (s && (s.streamKind === 'hls' || s.streamKind === 'hls_by_header' || s.streamKind === 'social')) return 20;
    return 0;
  };
  return [...list].sort((a, b) => score(b) - score(a));
}

function pickForwardHeaders(requestHeaders) {
  const allow = new Set([
    'authorization',
    'cookie',
    'referer',
    'origin',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-dest',
    'sec-fetch-user',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
  ]);
  const out = {};
  for (const h of requestHeaders || []) {
    if (!h || !h.name) continue;
    const n = h.name.toLowerCase();
    if (allow.has(n) && h.value != null && h.value !== '') {
      out[n] = h.value;
    }
  }
  return out;
}

/** Chrome-only; including this on Firefox can prevent the listener from registering. */
function isFirefoxBrowser() {
  try {
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    return /\bFirefox\//i.test(ua);
  } catch (_) {
    return false;
  }
}

const WEB_REQUEST_REQ_EXTRA = isFirefoxBrowser()
  ? ['requestHeaders']
  : ['requestHeaders', 'extraHeaders'];
const WEB_REQUEST_RES_EXTRA = isFirefoxBrowser()
  ? ['responseHeaders']
  : ['responseHeaders', 'extraHeaders'];

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const url = details.url;
    const hit = classifyVideoFromUrl(url);
    if (!hit) return;
    const tabId = details.tabId;
    if (tabId < 0) return;
    const captured = pickForwardHeaders(details.requestHeaders);
    if (hit.kind === 'social' || hit.kind === 'yt') {
      upsertYtdlpPagePlaceholder(tabId, captured);
      return;
    }
    // Apple Music FairPlay m3u8 → never list as HLS; use the tab song URL with yt-dlp.
    if (
      isAppleMediaCdnUrl(url) &&
      (hit.kind === 'hls' || hit.kind === 'dash' || hit.kind === 'direct')
    ) {
      upsertYtdlpPagePlaceholder(tabId, captured);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (
        !chrome.runtime.lastError &&
        tab &&
        isAppleMusicPage(tab.url || '') &&
        (hit.kind === 'hls' || hit.kind === 'dash')
      ) {
        upsertYtdlpPagePlaceholder(tabId, captured);
        return;
      }
      upsertStream(tabId, url, captured, hit.kind);
    });
  },
  { urls: ['<all_urls>'] },
  WEB_REQUEST_REQ_EXTRA
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;
    const url = details.url;
    if (url.startsWith('http:') === false && url.startsWith('https:') === false) return;
    if (shouldIgnoreAsNoiseUrl(url)) return;
    const lower = String(url).toLowerCase();
    if (/[/.]ts(?:[?#]|$)/i.test(lower) && /(cdninstagram|fbcdn|twimg|googlevideo|akamai|cloudfront|fastly)/i.test(lower)) {
      return;
    }
    // A social CDN media response (e.g. an Instagram video/mp4 blob) should become the
    // page download, not a raw stream row. Otherwise we would try to pull the signed blob
    // straight and end up with a broken few-hundred-byte file.
    if (socialPageMediaHit(url)) {
      upsertYtdlpPagePlaceholder(tabId, {});
      return;
    }
    if (isAppleMediaCdnUrl(url) && /[/.](m3u8|m3u|mpd|m4s|m4a|aac)(?:[?#]|$)/i.test(lower)) {
      upsertYtdlpPagePlaceholder(tabId, {});
      return;
    }
    const ct = getHeaderValue(details.responseHeaders, 'content-type');
    const k = streamKindFromContentType(ct);
    if (!k) return;
    if (k === 'by_header' && /[/.](ts|m2ts|mts|m4s)(?:[?#]|$)/i.test(lower)) return;
    if (k === 'hls_by_header' || k === 'dash') {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && isAppleMusicPage(tab.url || '')) {
          upsertYtdlpPagePlaceholder(tabId, {});
          return;
        }
        upsertStream(tabId, url, {}, k);
      });
      return;
    }
    upsertStream(tabId, url, {}, k);
  },
  { urls: ['<all_urls>'] },
  WEB_REQUEST_RES_EXTRA
);

function isSocialOrYtPageUrl(url) {
  const api = socialPostApi();
  if (api && typeof api.isSocialSiteHost === 'function') {
    try {
      return api.isSocialSiteHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Merge post URLs from DOM scans without wiping unrelated traffic streams. */
function mergeSocialPostTargets(tabId, targets, capturedHeaders) {
  if (!tabId || tabId < 0 || !targets || !targets.length) return;
  if (!detectedStreams[tabId]) detectedStreams[tabId] = [];
  const list = detectedStreams[tabId];
  const byUrl = new Map();
  for (const e of list) {
    if (e && e.url) byUrl.set(String(e.url).replace(/\/$/, '').toLowerCase(), e);
  }
  let added = 0;
  for (const t of targets) {
    const url = String((t && t.url) || '').trim();
    if (!url) continue;
    const key = url.replace(/\/$/, '').toLowerCase();
    const existing = byUrl.get(key);
    if (existing) {
      if (t.urlSource === 'tab') existing.urlSource = 'tab';
      if (t.streamKind) existing.streamKind = t.streamKind;
      existing.pageDownload = true;
      if (capturedHeaders) {
        existing.capturedHeaders = { ...(existing.capturedHeaders || {}), ...capturedHeaders };
      }
      continue;
    }
    const row = {
      url,
      cleanedUrl: (t && t.cleanedUrl) || url,
      streamKind: (t && t.streamKind) || 'social',
      pageDownload: true,
      urlSource: t.urlSource === 'tab' ? 'tab' : 'link',
      capturedHeaders: { ...(capturedHeaders || {}) },
    };
    list.push(row);
    byUrl.set(key, row);
    added += 1;
  }
  if (added || targets.length) {
    detectedStreams[tabId] = list;
    chrome.action.setBadgeText({ text: String(list.length), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId });
    notifyStreamsChanged(tabId);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    if (_ytdlpPageTimer[tabId]) {
      clearTimeout(_ytdlpPageTimer[tabId]);
      delete _ytdlpPageTimer[tabId];
    }
    delete _ytdlpPageCap[tabId];
    detectedStreams[tabId] = [];
    chrome.action.setBadgeText({ text: '', tabId });
    notifyStreamsChanged(tabId);
  }
  // Like YouTube: Apple Music song/album pages get a page-URL download for yt-dlp.
  if (
    (changeInfo.status === 'complete' || changeInfo.url) &&
    tab &&
    isAppleMusicTrackPage(tab.url || '')
  ) {
    upsertYtdlpPagePlaceholder(tabId, {});
  }
  // YouTube / Facebook / TikTok / etc.: scan for watch/shorts/reel/post links on load.
  if (
    changeInfo.status === 'complete' &&
    tab &&
    tab.url &&
    /^https?:/i.test(tab.url) &&
    isSocialOrYtPageUrl(tab.url)
  ) {
    upsertYtdlpPagePlaceholder(tabId, {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (_ytdlpPageTimer[tabId]) {
    clearTimeout(_ytdlpPageTimer[tabId]);
    delete _ytdlpPageTimer[tabId];
  }
  delete _ytdlpPageCap[tabId];
  delete detectedStreams[tabId];
});

const IMAGE_GRABBER_KEY = 'imageHoverDownloadEnabled';

/** Serialize menu rebuilds — overlapping removeAll/create causes duplicate-id errors. */
let _ctxMenusChain = Promise.resolve();

function ctxMenusRemoveAll() {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

function ctxMenusCreate(createProperties) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.create(createProperties, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

function setupImageContextMenus() {
  _ctxMenusChain = _ctxMenusChain
    .then(async () => {
      const data = await chrome.storage.local.get([IMAGE_GRABBER_KEY]);
      const enabled = data && data[IMAGE_GRABBER_KEY] === true;
      await ctxMenusRemoveAll();
      if (!enabled) return;
      await ctxMenusCreate({
        id: CTX_IMG_ROOT,
        title: 'Stuff Grabber: Download image (PNG)',
        contexts: ['image'],
      });
      for (const fmt of CTX_IMG_FMTS) {
        await ctxMenusCreate({
          id: `${CTX_IMG_FMT_PREFIX}${fmt}`,
          parentId: CTX_IMG_ROOT,
          title: `Save as ${fmt.toUpperCase()}`,
          contexts: ['image'],
        });
      }
    })
    .catch(() => {
      // never break the chain
    });
  return _ctxMenusChain;
}

chrome.runtime.onInstalled.addListener(() => {
  setupImageContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupImageContextMenus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[IMAGE_GRABBER_KEY]) {
    setupImageContextMenus();
  }
});

// Single boot setup (onInstalled also fires on reload — chain serializes both).
setupImageContextMenus();

function ctxMimeFromFormat(fmt) {
  const f = String(fmt || '').toLowerCase();
  if (f === 'png') return 'image/png';
  if (f === 'webp') return 'image/webp';
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  return 'image/png';
}

function ctxExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('jpg')) return 'jpg';
  return '';
}

function ctxSafeStemFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = (u.pathname.split('/').filter(Boolean).pop() || 'image').replace(/\.[a-z0-9]{2,5}$/i, '');
    const clean = seg.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (clean || 'image').slice(0, 80);
  } catch (_) {
    return 'image';
  }
}

async function ctxConvertImageBlob(blob, fmt) {
  const mime = ctxMimeFromFormat(fmt);
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('No drawing context');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const out = await canvas.convertToBlob({
    type: mime,
    quality: mime === 'image/jpeg' ? 0.92 : undefined,
  });
  return out;
}

async function ctxDownloadImageAs(url, fmt) {
  const stem = ctxSafeStemFromUrl(url);
  let blob = null;
  let ext = fmt === 'jpeg' ? 'jpg' : fmt;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const srcBlob = await res.blob();
    const srcExt = ctxExtFromMime(srcBlob.type);
    const want = (fmt || 'png').toLowerCase();
    if (srcExt && (want === srcExt || (want === 'jpeg' && srcExt === 'jpg'))) {
      blob = srcBlob;
      ext = srcExt;
    } else {
      blob = await ctxConvertImageBlob(srcBlob, want);
      ext = want === 'jpeg' ? 'jpg' : want;
    }
  } catch (_) {
    blob = null;
  }

  if (blob) {
    const dataUrl = await blobToDataUrl(blob);
    await downloadUrlPromise({
      url: dataUrl,
      filename: `${stem}.${ext || 'png'}`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    return;
  }

  await downloadUrlPromise({
    url,
    filename: `${stem}.${ext || 'jpg'}`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId || '');
  const srcUrl = (info.srcUrl || '').toString();
  if (!srcUrl) return;
  let fmt = 'png';
  if (id.startsWith(CTX_IMG_FMT_PREFIX)) {
    fmt = id.slice(CTX_IMG_FMT_PREFIX.length).toLowerCase();
  } else if (id !== CTX_IMG_ROOT) {
    return;
  }
  ctxDownloadImageAs(srcUrl, fmt).catch((e) => {
    console.warn('Stuff Grabber context image download failed', e);
  });
});

// Download queue: up to 4 native host processes, shared pending queue

const NATIVE = 'com.medzy.hlsgrabber';
const JOBS_KEY = 'hlsGrabJobsState';
const USER_PATH_KEY = 'userDownloadPath';
const YTDLP_MAX_HEIGHT_KEY = 'ytDlpMaxHeight';
const KEEP_ALARM = 'hlsGrabKeepAlive';
const MAX_SLOTS = 4;

/** @type {{ port: chrome.runtime.Port | null, jobId: string | null }[]} */
const slots = Array.from({ length: MAX_SLOTS }, () => ({ port: null, jobId: null }));
/** @type {{ jobId: string, payload: object }[]} */
const pendingQueue = [];

function genJobId() {
  return `j_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function defaultJobsState() {
  return { jobs: [] };
}

function respond(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (e) {
    console.error('Stuff Grabber: sendResponse failed', e);
  }
}

async function getUserDownloadPath() {
  const data = await chrome.storage.local.get(USER_PATH_KEY);
  return (data[USER_PATH_KEY] && String(data[USER_PATH_KEY]).trim()) || '';
}

async function readJobsState() {
  const data = await chrome.storage.session.get(JOBS_KEY);
  return data[JOBS_KEY] || defaultJobsState();
}

const STREAMS_REV_KEY = 'hlsGrabStreamsRev';
let _uiNotifyTimer = null;
/** @type {'jobs' | 'streams' | 'all' | null} */
let _uiNotifyKind = null;

/** Broadcast to open FAB panels + popup so lists refresh without reopen. */
function scheduleUiBroadcast(kind) {
  const next = kind === 'jobs' || kind === 'streams' ? kind : 'all';
  if (_uiNotifyKind && _uiNotifyKind !== next) _uiNotifyKind = 'all';
  else if (!_uiNotifyKind) _uiNotifyKind = next;
  if (_uiNotifyTimer) return;
  _uiNotifyTimer = setTimeout(() => {
    const k = _uiNotifyKind || 'jobs';
    _uiNotifyTimer = null;
    _uiNotifyKind = null;
    const msg = { type: 'HLS_GRABBER_LIVE_UPDATE', kind: k };
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs || []) {
        if (t.id == null) continue;
        chrome.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    });
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {
      // no open listeners (popup closed) — fine
    }
  }, 48);
}

/** @deprecated use scheduleUiBroadcast */
function scheduleFabContentBroadcast() {
  scheduleUiBroadcast('jobs');
}

function notifyStreamsChanged(tabId) {
  const list = (tabId != null && tabId >= 0 && detectedStreams[tabId]) || [];
  const count = list.length;
  const links = list.filter((s) => s && s.pageDownload && s.urlSource === 'link').length;
  chrome.storage.session
    .set({
      [STREAMS_REV_KEY]: { tabId: tabId ?? null, count, links, at: Date.now() },
    })
    .catch(() => {});
  scheduleUiBroadcast('streams');
}

function mediaIdFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const v = u.searchParams.get('v');
    if (v) return v;
    const path = u.pathname || '';
    let m = path.match(/\/(?:shorts|embed|live)\/([^/?#]+)/i);
    if (m) return m[1];
    m = path.match(/\/(?:reel|p|tv)\/([^/?#]+)/i);
    if (m) return m[1];
    m = path.match(/\/video\/(\d+)/i);
    if (m) return m[1];
    m = path.match(/\/status\/(\d+)/i);
    if (m) return m[1];
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const seg = path.replace(/^\//, '').split('/')[0];
      if (seg) return seg;
    }
  } catch (_) {
    // ignore
  }
  return '';
}

/**
 * pageUrl for yt-dlp: use each job's own download URL (page-link jobs).
 * Only fall back to the tab URL for raw CDN manifests that need the watch page.
 */
function resolveYtdlpPageUrl(downloadUrl, tabUrl, existingPageUrl) {
  const u = String(downloadUrl || '').trim();
  const tab = String(tabUrl || '').trim();
  const existing = String(existingPageUrl || '').trim();
  const looksLikeCdn =
    /\.(m3u8|mpd|m4s)(\?|$)/i.test(u) ||
    /googlevideo\.com|fbcdn\.net|cdninstagram\.com|tiktokcdn/i.test(u);
  if (looksLikeCdn && /^https?:/i.test(tab)) return tab;
  if (/^https?:/i.test(u)) return u;
  if (/^https?:/i.test(existing) && existing !== tab) return existing;
  if (/^https?:/i.test(tab)) return tab;
  return existing || u || tab;
}

function notifyTabDownloadProgress(tabId, job) {
  if (tabId == null || tabId < 0 || !job) return;
  const streamUrl = job.streamUrl || (job.downloadPayload && job.downloadPayload.url) || '';
  const pageUrl = (job.downloadPayload && job.downloadPayload.pageUrl) || '';
  const mediaId = job.mediaId || mediaIdFromUrl(streamUrl) || mediaIdFromUrl(pageUrl) || null;
  const payload = {
    type: 'JOB_DOWNLOAD_PROGRESS',
    job: {
      id: job.id,
      label: job.label || 'Download',
      status: job.status,
      detail: job.detail || '',
      percent: job.percent,
      playlistIndex: job.playlistIndex,
      playlistCount: job.playlistCount,
      mediaId,
      streamUrl: streamUrl || null,
      pageUrl: pageUrl || null,
      error: job.error || null,
    },
  };
  try {
    chrome.tabs.sendMessage(tabId, payload).catch(() => {});
  } catch (_) {
    // ignore
  }
}

function broadcastCloseFloatPanel() {
  chrome.tabs.query({}, (tabs) => {
    const msg = { type: 'HLS_GRABBER_CLOSE_FLOAT_PANEL' };
    for (const t of tabs || []) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    }
  });
}

async function writeJobsState(jobs) {
  await chrome.storage.session.set({ [JOBS_KEY]: { jobs: [...jobs] } });
  scheduleUiBroadcast('jobs');
}

async function upsertJob(job) {
  const st = await readJobsState();
  const jobs = st.jobs || [];
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i === -1) jobs.push({ ...job, updatedAt: Date.now() });
  else jobs[i] = { ...jobs[i], ...job, updatedAt: Date.now() };
  await writeJobsState(jobs);
  return jobs;
}

async function patchJob(jobId, partial) {
  const st = await readJobsState();
  const jobs = (st.jobs || []).map((j) => (j.id === jobId ? { ...j, ...partial, updatedAt: Date.now() } : j));
  await writeJobsState(jobs);
  return jobs;
}

async function removeJob(jobId) {
  const st = await readJobsState();
  const jobs = (st.jobs || []).filter((j) => j.id !== jobId);
  await writeJobsState(jobs);
}

function countActiveJobs() {
  return pendingQueue.length + slots.filter((s) => s.jobId !== null).length;
}

function syncBadgeAlarm() {
  const n = (() => {
    const running = slots.filter((s) => s.jobId !== null).length;
    return pendingQueue.length + running;
  })();
  if (n > 0) {
    chrome.alarms.create(KEEP_ALARM, { periodInMinutes: 0.1 });
    chrome.action.setBadgeText({ text: n > 9 ? '9+' : String(n) });
    chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  } else {
    chrome.alarms.clear(KEEP_ALARM);
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEP_ALARM) {
    void chrome.storage.session.get(JOBS_KEY);
  }
});

function getCookieStringPromise(streamUrl, pageUrl) {
  return new Promise((resolve) => {
    if (!streamUrl) {
      resolve('');
      return;
    }
    chrome.cookies.getAll({ url: streamUrl }, (forStream) => {
      const map = new Map();
      for (const c of forStream || []) {
        map.set(c.name, c.value);
      }
      if (!pageUrl || !/^https?:/i.test(pageUrl)) {
        resolve(
          Array.from(map.entries())
            .map(([a, b]) => `${a}=${b}`)
            .join('; ')
        );
        return;
      }
      chrome.cookies.getAll({ url: pageUrl }, (forTab) => {
        for (const c of forTab || []) {
          if (!map.has(c.name)) {
            map.set(c.name, c.value);
          }
        }
        resolve(
          Array.from(map.entries())
            .map(([a, b]) => `${a}=${b}`)
            .join('; ')
        );
      });
    });
  });
}

function registrableDomain(host) {
  const h = (host || '').toLowerCase().replace(/^\.+/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  return parts.slice(-2).join('.');
}

/**
 * Full cookie details (including httpOnly) for a site, straight from the browser in plaintext.
 * yt-dlp gets these as a cookie file, which sidesteps having to decrypt Chrome's own cookie
 * store (App-Bound Encryption / DPAPI). We are the extension the user is logged in through, so
 * this is the reliable way to reach logged-in Instagram, Facebook and the like.
 */
function getCookieJarPromise(pageUrl) {
  return new Promise((resolve) => {
    let host = '';
    try {
      host = new URL(pageUrl).hostname;
    } catch (_) {
      resolve([]);
      return;
    }
    if (!host) {
      resolve([]);
      return;
    }
    chrome.cookies.getAll({ domain: registrableDomain(host) }, (cookies) => {
      if (chrome.runtime.lastError || !cookies) {
        resolve([]);
        return;
      }
      resolve(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          hostOnly: !!c.hostOnly,
          session: !!c.session,
          expirationDate: c.expirationDate,
        }))
      );
    });
  });
}

function findSlotIndexByJobId(jobId) {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].jobId === jobId) return i;
  }
  return -1;
}

function onHostMessage(msg, slotIndex) {
  const jobId = msg && msg.jobId;
  if (!jobId) return;
  (async () => {
    if (msg.type === 'progress') {
      const patch = {
        status: 'downloading',
        detail: msg.detail || msg.phase || 'Running',
        outputPath: msg.output || null,
        ffmpegPreset: msg.ffmpegPreset || undefined,
      };
      if (msg.percent != null && Number.isFinite(Number(msg.percent))) {
        patch.percent = Math.max(0, Math.min(100, Number(msg.percent)));
      }
      if (msg.playlistIndex != null) patch.playlistIndex = Number(msg.playlistIndex) || msg.playlistIndex;
      if (msg.playlistCount != null) patch.playlistCount = Number(msg.playlistCount) || msg.playlistCount;
      if (msg.mediaId) patch.mediaId = String(msg.mediaId);
      const jobs = await patchJob(jobId, patch);
      const job = (jobs || []).find((j) => j && j.id === jobId);
      if (job && job.tabId != null) {
        notifyTabDownloadProgress(job.tabId, job);
      }
      return;
    }
    if (msg.type !== 'done') {
      return;
    }
    if (msg.idle) {
      return;
    }
    slots[slotIndex].jobId = null;
    if (msg.canceled) {
      const st = await readJobsState();
      const prev = (st.jobs || []).find((j) => j.id === jobId);
      await patchJob(jobId, {
        status: 'canceled',
        error: msg.error || 'Canceled',
        detail: '',
        outputPath: msg.output || prev?.outputPath || null,
      });
    } else if (msg.success) {
      const jobs = await patchJob(jobId, {
        status: 'completed',
        detail: (msg.detail && String(msg.detail).trim()) || 'Saved',
        error: null,
        outputPath: msg.output || null,
        percent: 100,
      });
      const job = (jobs || []).find((j) => j && j.id === jobId);
      if (job && job.tabId != null) notifyTabDownloadProgress(job.tabId, job);
    } else {
      const jobs = await patchJob(jobId, {
        status: 'error',
        error: msg.error || 'Failed',
        detail: '',
        outputPath: null,
      });
      const job = (jobs || []).find((j) => j && j.id === jobId);
      if (job && job.tabId != null) notifyTabDownloadProgress(job.tabId, job);
    }
    tryDispatch();
  })();
}

function onSlotDisconnect(slotIndex) {
  const j = slots[slotIndex].jobId;
  slots[slotIndex].port = null;
  slots[slotIndex].jobId = null;
  const err = chrome.runtime.lastError?.message;
  (async () => {
    if (j) {
      await patchJob(j, {
        status: 'error',
        error: err || 'Lost connection to the download helper',
        detail: '',
      });
    }
    tryDispatch();
  })();
  syncBadgeAlarm();
}

function ensurePort(slotIndex) {
  if (slots[slotIndex].port) return slots[slotIndex].port;
  const port = chrome.runtime.connectNative(NATIVE);
  slots[slotIndex].port = port;
  port.onMessage.addListener((msg) => onHostMessage(msg, slotIndex));
  port.onDisconnect.addListener(() => onSlotDisconnect(slotIndex));
  return port;
}

/**
 * Free slot: no jobId assigned.
 */
function firstFreeSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].jobId === null) return i;
  }
  return -1;
}

async function launchOnSlot(slotIndex, jobId, basePayload) {
  const outDir = await getUserDownloadPath();
  if (!outDir) {
    await patchJob(jobId, {
      status: 'error',
      error: 'Set a save folder in Options (right-click the extension icon).',
      detail: '',
    });
    tryDispatch();
    return;
  }
  slots[slotIndex].jobId = jobId;
  await patchJob(jobId, {
    status: 'connecting',
    detail: 'Starting',
    ffmpegPreset: basePayload.ffmpegPreset || null,
  });
  const full = { ...basePayload, jobId, outputDirectory: outDir };
  try {
    ensurePort(slotIndex).postMessage(full);
  } catch (e) {
    slots[slotIndex].jobId = null;
    await patchJob(jobId, { status: 'error', error: String(e), detail: '' });
    tryDispatch();
  }
  syncBadgeAlarm();
}

function tryDispatch() {
  (async () => {
    for (;;) {
      const i = firstFreeSlot();
      if (i === -1 || pendingQueue.length === 0) break;
      const { jobId, payload } = pendingQueue.shift();
      await launchOnSlot(i, jobId, payload);
    }
  })();
  syncBadgeAlarm();
}

/**
 * Dequeue a queued (not yet running) job by id.
 */
function removeFromPendingOnly(jobId) {
  for (let k = pendingQueue.length - 1; k >= 0; k--) {
    if (pendingQueue[k].jobId === jobId) {
      pendingQueue.splice(k, 1);
      return true;
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobInactive(jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = findSlotIndexByJobId(jobId) >= 0;
    const queued = pendingQueue.some((q) => q.jobId === jobId);
    if (!running && !queued) {
      const st = await readJobsState();
      return (st.jobs || []).find((j) => j.id === jobId) || null;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for cancel to finish');
    }
    await sleep(200);
  }
}

/** Same cancel path as the Cancel button; optional wait until the slot is free. */
async function cancelDownloadById(jobId, { wait = false } = {}) {
  if (removeFromPendingOnly(jobId)) {
    await patchJob(jobId, { status: 'canceled', error: 'Canceled before it started', detail: '' });
    tryDispatch();
    return;
  }
  const si = findSlotIndexByJobId(jobId);
  if (si >= 0 && slots[si].port) {
    try {
      slots[si].port.postMessage({ type: 'cancel', jobId });
    } catch (e) {
      await patchJob(jobId, { status: 'error', error: String(e), detail: '' });
      slots[si].jobId = null;
      tryDispatch();
    }
  } else if (si >= 0) {
    slots[si].jobId = null;
    await patchJob(jobId, { status: 'canceled', error: 'Canceled', detail: '' });
    tryDispatch();
  }
  if (wait) {
    await waitForJobInactive(jobId);
  }
}

function enqueueDownload(jobId, payload) {
  removeFromPendingOnly(jobId);
  pendingQueue.push({ jobId, payload });
}

/** Cancel (like the user Cancel btn), optional delete, then queue the same job again. */
async function restartDownloadJob(jobId, { newPreset, deleteFile, payload }) {
  const outDir = await getUserDownloadPath();
  if (!outDir) {
    throw new Error('Save folder not set');
  }
  const st = await readJobsState();
  const job = (st.jobs || []).find((j) => j.id === jobId);
  const outputPath = job && job.outputPath;

  await cancelDownloadById(jobId, { wait: true });

  if (deleteFile && outputPath) {
    const del = await deleteOutputFileViaNative(outputPath, outDir);
    if (!del.ok) {
      throw new Error(del.error || 'Could not delete file');
    }
  }

  const fullPayload = {
    ...(job?.downloadPayload || {}),
    ...payload,
    jobId,
    ffmpegPreset: newPreset,
  };
  if (deleteFile) {
    delete fullPayload.numberedOutput;
  } else {
    fullPayload.numberedOutput = true;
  }

  await patchJob(jobId, {
    status: 'queued',
    detail: 'Waiting',
    error: null,
    outputPath: null,
    ffmpegPreset: newPreset,
    downloadPayload: fullPayload,
    label: (payload.filename || job?.label || 'video').toString(),
    fileStem: (payload.filename || job?.fileStem || 'video').toString(),
  });
  enqueueDownload(jobId, fullPayload);
  tryDispatch();
}

function nativePathOp(type, resultType, outputPath, outputDirectory, timeoutError) {
  return new Promise((resolve) => {
    if (!outputPath || !outputDirectory) {
      resolve({ ok: false, error: 'Missing path or save folder' });
      return;
    }
    const requestId = genJobId();
    const timeoutMs = 30000;
    let settled = false;
    const port = chrome.runtime.connectNative(NATIVE);
    const t = setTimeout(() => finish({ ok: false, error: timeoutError }), timeoutMs);
    function finish(out) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        port.disconnect();
      } catch (_) {
        // ignore
      }
      resolve(out);
    }
    port.onMessage.addListener((msg) => {
      if (settled) return;
      if (msg && msg.type === resultType && msg.requestId === requestId) {
        finish({ ok: msg.success !== false, error: msg.error || null });
      }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      finish({ ok: false, error: chrome.runtime.lastError?.message || 'Native host disconnected' });
    });
    try {
      port.postMessage({
        type,
        requestId,
        path: outputPath,
        outputDirectory,
      });
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

function deleteOutputFileViaNative(outputPath, outputDirectory) {
  if (!outputPath || !outputDirectory) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  return nativePathOp(
    'delete_output_file',
    'delete_output_file_result',
    outputPath,
    outputDirectory,
    'Timed out deleting file'
  );
}

/** Turn a local disk path into a file:// URL the browser can open in a tab. */
function localPathToFileUrl(filePath) {
  let p = String(filePath || '').trim().replace(/\\/g, '/');
  if (!p) return '';
  if (/^[A-Za-z]:\//.test(p)) p = '/' + p;
  else if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

function openLocalFileInBrowserTab(filePath) {
  return new Promise((resolve) => {
    const fileUrl = localPathToFileUrl(filePath);
    if (!fileUrl) {
      resolve({ ok: false, error: 'Missing file path' });
      return;
    }

    const openTab = () => {
      chrome.tabs.create({ url: fileUrl }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({
            ok: false,
            error:
              err.message ||
              'Could not open file in the browser. On the extensions page, enable “Allow access to file URLs” for Stuff Grabber.',
          });
          return;
        }
        resolve({ ok: true, url: fileUrl });
      });
    };

    try {
      if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess === 'function') {
        chrome.extension.isAllowedFileSchemeAccess((allowed) => {
          if (!allowed) {
            resolve({
              ok: false,
              error:
                'Turn on “Allow access to file URLs” for Stuff Grabber on the extensions page, then try Open again.',
            });
            return;
          }
          openTab();
        });
        return;
      }
    } catch (_) {
      // fall through
    }
    openTab();
  });
}

async function cancelJobAndWait(jobId) {
  await cancelDownloadById(jobId, { wait: true });
}

function resolveActiveTabId(tabIdFromMsg, sender) {
  return new Promise((resolve) => {
    if (tabIdFromMsg != null && tabIdFromMsg >= 0) {
      resolve(tabIdFromMsg);
      return;
    }
    if (sender && sender.tab && sender.tab.id >= 0) {
      resolve(sender.tab.id);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs[0] || tabs[0].id == null) {
        resolve(null);
        return;
      }
      resolve(tabs[0].id);
    });
  });
}

function tabsSend(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message, images: [] });
        return;
      }
      resolve(res || { ok: false, error: 'No response', images: [] });
    });
  });
}

function stampForFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sanitizeZipStem(s) {
  let t = String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^\.+|\.+$/g, '');
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || 'image';
}

function extFromImageUrlOrMime(url, mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('svg')) return 'svg';
  try {
    const u = new URL(url, 'https://example.invalid');
    const path = u.pathname || '';
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    if (match) {
      const e = match[1].toLowerCase();
      if (e === 'jpeg') return 'jpg';
      if (['png', 'jpg', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(e)) return e;
    }
  } catch (_) {
    // ignore
  }
  return 'jpg';
}

async function fetchImageBytes(url) {
  if (String(url).startsWith('data:')) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), mime: res.headers.get('content-type') || '' };
  }
  const res = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime: res.headers.get('content-type') || '' };
}

/** MV3 service workers have no URL.createObjectURL — use data: URLs for chrome.downloads. */
function uint8ToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesToDataUrl(bytes, mime) {
  const type = String(mime || 'application/octet-stream').split(';')[0] || 'application/octet-stream';
  return `data:${type};base64,${uint8ToBase64(bytes)}`;
}

async function blobToDataUrl(blob) {
  if (!blob) throw new Error('No blob');
  if (typeof FileReader !== 'undefined') {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
      fr.readAsDataURL(blob);
    });
  }
  const buf = await blob.arrayBuffer();
  return bytesToDataUrl(new Uint8Array(buf), blob.type || 'application/octet-stream');
}

function downloadUrlPromise(opts) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }
      resolve(downloadId);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POPUP_OPENED') {
    broadcastCloseFloatPanel();
    respond(sendResponse, { ok: true });
    return true;
  }

  if (message.type === 'REPORT_SOCIAL_POST_URLS') {
    (async () => {
      try {
        const tabId =
          sender && sender.tab && sender.tab.id >= 0
            ? sender.tab.id
            : await resolveActiveTabId(message.tabId, sender);
        if (tabId == null) {
          respond(sendResponse, { ok: false, error: 'No tab' });
          return;
        }
        const api = socialPostApi();
        const targets = [];
        const seen = new Set();
        const push = (raw, kindHint, urlSource) => {
          const url = String(raw || '').trim();
          if (!url) return;
          let finalUrl = url;
          let cleanedUrl = '';
          let kind = kindHint;
          if (api && typeof api.classifySocialPostUrl === 'function') {
            const hit = api.classifySocialPostUrl(url);
            if (!hit.ok) return;
            finalUrl = hit.url;
            cleanedUrl = hit.cleanedUrl || '';
            kind = hit.kind;
          }
          const key = finalUrl.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          targets.push({
            url: finalUrl,
            cleanedUrl: cleanedUrl || finalUrl,
            streamKind: kind || 'social',
            urlSource: urlSource === 'tab' ? 'tab' : 'link',
          });
        };
        if (message.pageIsPost && message.pagePostUrl) {
          push(message.pagePostUrl, message.pageKind, 'tab');
        }
        const urls = Array.isArray(message.urls) ? message.urls : [];
        for (const u of urls) push(u, null, 'link');
        mergeSocialPostTargets(tabId, targets, {});
        respond(sendResponse, { ok: true, count: targets.length });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_IMAGE_URL') {
    const url = (message.url || '').toString().trim();
    const filename = (message.filename || '').toString().trim();
    if (!url) {
      respond(sendResponse, { ok: false, error: 'Missing URL' });
      return true;
    }
    const opts = {
      url,
      saveAs: false,
      conflictAction: 'uniquify',
    };
    if (filename) opts.filename = filename;
    chrome.downloads.download(opts, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        respond(sendResponse, { ok: false, error: err.message || String(err) });
        return;
      }
      respond(sendResponse, { ok: true, downloadId });
    });
    return true;
  }

  if (message.type === 'DOWNLOAD_PAGE_IMAGE') {
    (async () => {
      try {
        const tabId = await resolveActiveTabId(message.tabId, sender);
        if (tabId == null) {
          respond(sendResponse, { ok: false, error: 'No active tab' });
          return;
        }
        const res = await tabsSend(tabId, {
          type: 'DOWNLOAD_PAGE_IMAGE',
          url: message.url,
          fmt: message.fmt,
          stem: message.stem,
        });
        respond(sendResponse, res || { ok: false, error: 'No response' });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PAGE_IMAGES') {
    (async () => {
      try {
        const tabId = await resolveActiveTabId(message.tabId, sender);
        if (tabId == null) {
          respond(sendResponse, { ok: false, error: 'No active tab', images: [] });
          return;
        }
        const scope = message.scope === 'visible' ? 'visible' : 'page';
        const res = await tabsSend(tabId, { type: 'LIST_PAGE_IMAGES', scope });
        respond(sendResponse, {
          ok: !!(res && res.ok),
          images: (res && res.images) || [],
          error: (res && res.error) || null,
          scope,
        });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e), images: [] });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_IMAGES_ZIP') {
    (async () => {
      try {
        const images = Array.isArray(message.images) ? message.images : [];
        if (!images.length) {
          respond(sendResponse, { ok: false, error: 'No images to zip' });
          return;
        }
        if (
          !self.HLS_ZIP_STORE ||
          (typeof self.HLS_ZIP_STORE.buildZipStoreBytes !== 'function' &&
            typeof self.HLS_ZIP_STORE.buildZipStore !== 'function')
        ) {
          respond(sendResponse, { ok: false, error: 'Zip helper unavailable' });
          return;
        }
        const zipApi = self.HLS_ZIP_STORE;
        const used = new Set();
        const files = [];
        let failed = 0;
        const max = Math.min(images.length, 200);
        for (let i = 0; i < max; i++) {
          const item = images[i] || {};
          const url = String(item.url || '').trim();
          if (!url) {
            failed += 1;
            continue;
          }
          try {
            const data = await fetchImageBytes(url);
            const ext = extFromImageUrlOrMime(url, data.mime) || 'jpg';
            const stem = sanitizeZipStem(item.alt || item.stem || `image_${i + 1}`);
            const name = zipApi.safeZipEntryName(`${stem}.${ext}`, used);
            files.push({ name, data: data.bytes });
          } catch (_) {
            failed += 1;
          }
        }
        if (!files.length) {
          respond(sendResponse, {
            ok: false,
            error: 'Could not fetch any images (site may block downloads).',
          });
          return;
        }
        const zipBytes =
          typeof zipApi.buildZipStoreBytes === 'function'
            ? zipApi.buildZipStoreBytes(files)
            : new Uint8Array(await zipApi.buildZipStore(files).arrayBuffer());
        const zipName =
          String(message.filename || '').trim() ||
          `stuff-grabber-images-${stampForFilename()}.zip`;
        const dataUrl = bytesToDataUrl(zipBytes, 'application/zip');
        const downloadId = await downloadUrlPromise({
          url: dataUrl,
          filename: zipName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_'),
          saveAs: false,
          conflictAction: 'uniquify',
        });
        respond(sendResponse, {
          ok: true,
          downloadId,
          count: files.length,
          failed,
        });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'GET_STREAMS') {
    const tabIdFromMsg =
      message.tabId != null && message.tabId >= 0 ? message.tabId : null;
    const senderTabId = sender.tab && sender.tab.id >= 0 ? sender.tab.id : null;
    const effectiveTabId = tabIdFromMsg != null ? tabIdFromMsg : senderTabId;

    const finish = (tabId, pageTitle) => {
      Promise.all([chrome.storage.session.get(JOBS_KEY), chrome.storage.local.get(USER_PATH_KEY)])
        .then(([sess, local]) => {
          const jobsState = (sess && sess[JOBS_KEY]) || defaultJobsState();
          const userDownloadPath = (local && local[USER_PATH_KEY] && String(local[USER_PATH_KEY]).trim()) || '';
          respond(sendResponse, {
            streams: sortStreamsForUi(detectedStreams[tabId] || []),
            pageTitle: pageTitle || '',
            jobs: jobsState.jobs || [],
            userDownloadPath,
            maxParallel: MAX_SLOTS,
            queueLength: pendingQueue.length,
            running: slots.filter((s) => s.jobId).length,
          });
        })
        .catch((err) => {
          console.error('GET_STREAMS', err);
          respond(sendResponse, {
            streams: sortStreamsForUi(detectedStreams[tabId] || []),
            pageTitle: pageTitle || '',
            jobs: [],
            userDownloadPath: '',
            maxParallel: MAX_SLOTS,
            queueLength: 0,
            running: 0,
          });
        });
    };

    if (effectiveTabId != null) {
      chrome.tabs.get(effectiveTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          finish(effectiveTabId, '');
          return;
        }
        finish(tab.id, (tab.title || '').trim());
      });
      return true;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tid = tabs[0]?.id;
      const pageTitle = (tabs[0]?.title || '').trim();
      finish(tid, pageTitle);
    });
    return true;
  }

  if (message.type === 'GET_DOWNLOAD_STATE') {
    chrome.storage.session
      .get(JOBS_KEY)
      .then((data) => {
        respond(sendResponse, { jobs: (data[JOBS_KEY] && data[JOBS_KEY].jobs) || [] });
      })
      .catch((err) => {
        console.error('GET_DOWNLOAD_STATE', err);
        respond(sendResponse, { jobs: [] });
      });
    return true;
  }

  if (message.type === 'DISMISS_JOB' && message.jobId) {
    removeJob(message.jobId)
      .then(() => respond(sendResponse, { ok: true }))
      .catch((e) => respond(sendResponse, { ok: false, error: String(e) }));
    return true;
  }

  if (message.type === 'DELETE_JOB_FILE') {
    if (!message.jobId) {
      respond(sendResponse, { ok: false, error: 'Missing job' });
      return true;
    }
    (async () => {
      try {
        const jobId = message.jobId;
        const outDir = await getUserDownloadPath();
        if (!outDir) {
          respond(sendResponse, { ok: false, error: 'Save folder not set' });
          return;
        }
        const st = await readJobsState();
        const job = (st.jobs || []).find((j) => j.id === jobId);
        const outputPath = job && job.outputPath;
        if (!outputPath) {
          respond(sendResponse, { ok: false, error: 'No file to delete' });
          return;
        }
        const del = await deleteOutputFileViaNative(outputPath, outDir);
        if (!del.ok) {
          respond(sendResponse, { ok: false, error: del.error || 'Could not delete file' });
          return;
        }
        await patchJob(jobId, {
          outputPath: null,
          error: job.status === 'canceled' ? 'Canceled (file deleted)' : job.error,
        });
        respond(sendResponse, { ok: true });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_JOB_FILE') {
    if (!message.jobId) {
      respond(sendResponse, { ok: false, error: 'Missing job' });
      return true;
    }
    (async () => {
      try {
        const jobId = message.jobId;
        const st = await readJobsState();
        const job = (st.jobs || []).find((j) => j.id === jobId);
        const outputPath = job && job.outputPath;
        if (!outputPath) {
          respond(sendResponse, { ok: false, error: 'No file to open' });
          return;
        }
        const opened = await openLocalFileInBrowserTab(outputPath);
        if (!opened.ok) {
          respond(sendResponse, { ok: false, error: opened.error || 'Could not open file' });
          return;
        }
        respond(sendResponse, { ok: true });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'DISMISS_DONE') {
    (async () => {
      const st = await readJobsState();
      const jobs = (st.jobs || []).filter((j) => !['completed', 'canceled', 'error'].includes(j.status));
      await writeJobsState(jobs);
      respond(sendResponse, { ok: true });
    })();
    return true;
  }

  if (message.type === 'CANCEL_DOWNLOAD' && message.jobId) {
    (async () => {
      await cancelDownloadById(message.jobId);
      respond(sendResponse, { ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_YTDLP_FORMATS') {
    (async () => {
      const payload = message.payload || {};
      if (!payload.url) {
        respond(sendResponse, { ok: false, error: 'No stream URL', formats: [] });
        return;
      }
      const tabIdForJob = payload.tabId != null ? payload.tabId : sender.tab?.id ?? null;
      let tabUrl = '';
      if (tabIdForJob != null) {
        try {
          const t = await chrome.tabs.get(tabIdForJob);
          tabUrl = (t && t.url) || '';
        } catch (_) {
          // ignore
        }
      }
      let cookie = (payload.cookie && String(payload.cookie).trim()) || '';
      if (!cookie) {
        cookie = await getCookieStringPromise(payload.url, tabUrl);
      }
      const requestId = genJobId();
      const base = {
        type: 'ytdlp_formats',
        requestId,
        url: payload.url,
        tabId: tabIdForJob ?? undefined,
        cookie: cookie || undefined,
        userAgent: payload.userAgent,
        capturedHeaders: payload.capturedHeaders,
        authorization: payload.authorization,
        referer: payload.referer,
        pageUrl: payload.pageUrl,
        origin: payload.origin,
        ytDlpCookiesFromBrowser: payload.ytDlpCookiesFromBrowser,
      };
      if (!base.userAgent) {
        try {
          base.userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || undefined;
        } catch (_) {
          // ignore
        }
      }
      if (!base.referer && tabUrl && /^https?:/i.test(tabUrl)) {
        base.referer = tabUrl;
        try {
          base.origin = new URL(tabUrl).origin;
        } catch (_) {
          // ignore
        }
      }
      base.pageUrl = resolveYtdlpPageUrl(base.url || payload.url, tabUrl, base.pageUrl);
      try {
        const mhStore = await chrome.storage.local.get(YTDLP_MAX_HEIGHT_KEY);
        const mhRaw = mhStore[YTDLP_MAX_HEIGHT_KEY];
        if (mhRaw !== undefined && mhRaw !== null && String(mhRaw).trim() !== '') {
          const n = parseInt(String(mhRaw), 10);
          if (!Number.isNaN(n)) base.ytDlpMaxHeight = n;
        }
      } catch (_) {
        // ignore
      }
      {
        const cookiePageUrl =
          base.pageUrl && /^https?:/i.test(base.pageUrl) ? base.pageUrl : tabUrl;
        const cookieJar = await getCookieJarPromise(cookiePageUrl);
        if (cookieJar.length) base.cookieJar = cookieJar;
      }
      const timeoutMs = 125000;
      let settled = false;
      const port = chrome.runtime.connectNative(NATIVE);
      const t = setTimeout(() => {
        finish({ ok: false, error: 'Timed out listing formats', formats: [], requestId });
      }, timeoutMs);
      function finish(out) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        try {
          port.disconnect();
        } catch (_) {
          // ignore
        }
        respond(sendResponse, out);
      }
      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg && msg.type === 'ytdlp_formats_result' && msg.requestId === requestId) {
          finish({
            ok: msg.success !== false,
            requestId: msg.requestId,
            title: msg.title || '',
            formats: msg.formats || [],
            error: msg.error || null,
          });
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
        finish({ ok: false, formats: [], error: err || 'Native host disconnected', requestId });
      });
      try {
        port.postMessage(base);
      } catch (e) {
        finish({ ok: false, formats: [], error: String(e), requestId });
      }
    })();
    return true;
  }

  if (message.type === 'GET_FFMPEG_ENCODE_PRESET') {
    (async () => {
      const payload = message.payload || {};
      if (!payload.url) {
        respond(sendResponse, { ok: false, error: 'No stream URL', applies: false });
        return;
      }
      const tabIdForJob = payload.tabId != null ? payload.tabId : sender.tab?.id ?? null;
      let tabUrl = '';
      if (tabIdForJob != null) {
        try {
          const t = await chrome.tabs.get(tabIdForJob);
          tabUrl = (t && t.url) || '';
        } catch (_) {
          // ignore
        }
      }
      let cookie = (payload.cookie && String(payload.cookie).trim()) || '';
      if (!cookie) {
        cookie = await getCookieStringPromise(payload.url, tabUrl);
      }
      const requestId = genJobId();
      const base = {
        type: 'ffmpeg_encode_preset',
        requestId,
        url: payload.url,
        tabId: tabIdForJob ?? undefined,
        streamKind: payload.streamKind,
        cookie: cookie || undefined,
        userAgent: payload.userAgent,
        capturedHeaders: payload.capturedHeaders,
        authorization: payload.authorization,
        referer: payload.referer,
        pageUrl: payload.pageUrl,
        origin: payload.origin,
      };
      if (!base.userAgent) {
        try {
          base.userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || undefined;
        } catch (_) {
          // ignore
        }
      }
      if (!base.referer && tabUrl && /^https?:/i.test(tabUrl)) {
        base.referer = tabUrl;
        try {
          base.origin = new URL(tabUrl).origin;
        } catch (_) {
          // ignore
        }
      }
      base.pageUrl = resolveYtdlpPageUrl(base.url || payload.url, tabUrl, base.pageUrl);
      const timeoutMs = 90000;
      let settled = false;
      const port = chrome.runtime.connectNative(NATIVE);
      const t = setTimeout(() => {
        finish({ ok: false, error: 'Timed out probing encode preset', applies: false, requestId });
      }, timeoutMs);
      function finish(out) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        try {
          port.disconnect();
        } catch (_) {
          // ignore
        }
        respond(sendResponse, out);
      }
      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg && msg.type === 'ffmpeg_encode_preset_result' && msg.requestId === requestId) {
          finish({
            ok: msg.success !== false,
            requestId: msg.requestId,
            applies: msg.applies === true,
            recommendedPreset: msg.recommendedPreset || 'veryfast',
            alternatePreset: msg.alternatePreset || 'fast',
            allowedPresets: msg.allowedPresets || [],
            durationSec: msg.durationSec || 0,
            sizeBytes: msg.sizeBytes || 0,
            envLocked: !!msg.envLocked,
            autoReason: msg.autoReason || '',
            error: msg.error || null,
          });
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
        finish({ ok: false, applies: false, error: err || 'Native host disconnected', requestId });
      });
      try {
        port.postMessage(base);
      } catch (e) {
        finish({ ok: false, applies: false, error: String(e), requestId });
      }
    })();
    return true;
  }

  if (message.type === 'SWITCH_FFMPEG_PRESET') {
    (async () => {
      const jobId = message.jobId;
      const newPreset = (message.newPreset || '').toString().toLowerCase();
      const deleteFile = message.deleteFile === true;
      const basePayload = message.payload || {};
      if (!jobId || !newPreset) {
        respond(sendResponse, { ok: false, error: 'Missing job or preset' });
        return;
      }
      const queuedIdx = pendingQueue.findIndex((q) => q.jobId === jobId);
      if (queuedIdx >= 0) {
        pendingQueue[queuedIdx].payload = {
          ...pendingQueue[queuedIdx].payload,
          ...basePayload,
          jobId,
          ffmpegPreset: newPreset,
        };
        await patchJob(jobId, { ffmpegPreset: newPreset, detail: `Queued (${newPreset})` });
        respond(sendResponse, { ok: true, jobId });
        return;
      }
      try {
        await restartDownloadJob(jobId, {
          newPreset,
          deleteFile,
          payload: basePayload,
        });
        respond(sendResponse, { ok: true, jobId });
      } catch (e) {
        respond(sendResponse, { ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'START_DOWNLOAD') {
    (async () => {
      const payload = message.payload;
      if (!payload?.url) {
        respond(sendResponse, { ok: false, error: 'No stream URL' });
        return;
      }
      const path = await getUserDownloadPath();
      if (!path) {
        respond(sendResponse, {
          ok: false,
          error: 'Open Options and set a save folder first.',
        });
        return;
      }
      const tabIdForJob = payload.tabId != null ? payload.tabId : sender.tab?.id ?? null;
      let tabUrl = '';
      if (tabIdForJob != null) {
        try {
          const t = await chrome.tabs.get(tabIdForJob);
          tabUrl = (t && t.url) || '';
        } catch (_) {
          // ignore
        }
      }
      let cookie = (payload.cookie && String(payload.cookie).trim()) || '';
      if (!cookie) {
        cookie = await getCookieStringPromise(payload.url, tabUrl);
      }
      const ytdlpKind = payload.streamKind === 'social' || payload.streamKind === 'yt';
      const cookiePageUrl =
        payload.pageUrl && /^https?:/i.test(payload.pageUrl) ? payload.pageUrl : tabUrl;
      const cookieJar = ytdlpKind ? await getCookieJarPromise(cookiePageUrl) : [];
      const { jobId: _jid, outputDirectory: _od, ...rest } = payload;
      const base = {
        ...rest,
        tabId: tabIdForJob ?? undefined,
        cookie: cookie || undefined,
      };
      if (cookieJar.length) base.cookieJar = cookieJar;
      if (!base.userAgent) {
        try {
          base.userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || undefined;
        } catch (_) {
          // ignore
        }
      }
      if (!base.referer && tabUrl && /^https?:/i.test(tabUrl)) {
        base.referer = tabUrl;
        try {
          base.origin = new URL(tabUrl).origin;
        } catch (_) {
          // ignore
        }
      }
      base.pageUrl = resolveYtdlpPageUrl(base.url || payload.url, tabUrl, base.pageUrl);
      try {
        const mhStore = await chrome.storage.local.get(YTDLP_MAX_HEIGHT_KEY);
        const mhRaw = mhStore[YTDLP_MAX_HEIGHT_KEY];
        if (base.ytDlpMaxHeight == null && mhRaw !== undefined && mhRaw !== null && String(mhRaw).trim() !== '') {
          const n = parseInt(String(mhRaw), 10);
          if (!Number.isNaN(n)) base.ytDlpMaxHeight = n;
        }
      } catch (_) {
        // ignore
      }
      const jobId = payload.jobId || genJobId();
      const label = (payload.filename || 'video').toString() || 'video';
      const seedMediaId =
        mediaIdFromUrl(payload.url) ||
        mediaIdFromUrl(base.pageUrl) ||
        mediaIdFromUrl(tabUrl) ||
        null;
      await upsertJob({
        id: jobId,
        label,
        status: 'queued',
        detail: 'Waiting',
        error: null,
        outputPath: null,
        tabId: tabIdForJob ?? null,
        streamUrl: payload.url,
        streamKind: payload.streamKind || null,
        mediaId: seedMediaId,
        fileStem: (payload.filename || label).toString(),
        ffmpegPreset: base.ffmpegPreset || null,
        downloadPayload: base,
        lastAuthRefresh: Date.now(),
        startedAt: Date.now(),
      });
      enqueueDownload(jobId, base);
      tryDispatch();
      if (tabIdForJob != null) {
        notifyTabDownloadProgress(tabIdForJob, {
          id: jobId,
          label,
          status: 'queued',
          detail: 'Waiting',
          mediaId: seedMediaId,
          streamUrl: payload.url,
          pageUrl: base.pageUrl || tabUrl || '',
          downloadPayload: base,
        });
      }
      respond(sendResponse, { ok: true, jobId });
    })();
    return true;
  }

  return false;
});
