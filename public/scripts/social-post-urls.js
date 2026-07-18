/**
 * Detect social/media post URLs for yt-dlp (absolute or site-relative hrefs).
 * Shared by content script (anchor scan) and background (tab URL validation).
 */
(function (global) {
  if (global.HLS_SOCIAL_POSTS) return;

  /** Soft cap so huge pages stay usable; download queue itself is unlimited. */
  const MAX_POSTS = 10000;

  /** Hosts where post-link scanning / yt-dlp page downloads apply. */
  const SOCIAL_SITE_HOSTS = [
    'youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'instagram.com',
    'facebook.com',
    'fb.watch',
    'fb.com',
    'threads.net',
    'tiktok.com',
    'vm.tiktok.com',
    'twitter.com',
    'x.com',
    'reddit.com',
    'redd.it',
    'snapchat.com',
    'twitch.tv',
    'clips.twitch.tv',
    'dailymotion.com',
    'dai.ly',
    'pinterest.com',
    'pin.it',
    'bilibili.com',
    'b23.tv',
    'rumble.com',
    'kick.com',
    'music.apple.com',
    'vimeo.com',
    'soundcloud.com',
    'bandcamp.com',
  ];

  function hostOf(urlOrHost) {
    try {
      if (!urlOrHost) return '';
      const s = String(urlOrHost);
      if (s.includes('/') || s.includes(':')) {
        return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
      }
      return s.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function isSocialSiteHost(hostname) {
    const h = hostOf(hostname);
    if (!h) return false;
    return SOCIAL_SITE_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  }

  function streamKindForHost(hostname) {
    const h = hostOf(hostname);
    if (
      h === 'youtu.be' ||
      h === 'youtube.com' ||
      h === 'youtube-nocookie.com' ||
      h.endsWith('.youtube.com') ||
      h.endsWith('.youtube-nocookie.com')
    ) {
      return 'yt';
    }
    return 'social';
  }

  function isYoutubeHost(h) {
    return (
      h === 'youtu.be' ||
      h === 'youtube.com' ||
      h === 'youtube-nocookie.com' ||
      h.endsWith('.youtube.com') ||
      h.endsWith('.youtube-nocookie.com')
    );
  }

  /** Path/query segments that are UI chrome, not a media id. */
  const RESERVED_SEG = new Set(
    [
      'tab',
      'feed',
      'home',
      'watch',
      'reel',
      'reels',
      'video',
      'videos',
      'post',
      'posts',
      'photo',
      'photos',
      'share',
      'story',
      'stories',
      'explore',
      'search',
      'login',
      'signup',
      'settings',
      'notifications',
      'marketplace',
      'gaming',
      'friends',
      'groups',
      'pages',
      'menu',
      'bookmarks',
      'saved',
      'live',
      'all',
      'about',
      'people',
      'media',
      'tagged',
      'channel',
      'user',
      'profile',
      'accounts',
      'direct',
      'inbox',
      'create',
      'trending',
      'following',
      'foryou',
      'for_you',
    ].map((s) => s.toLowerCase())
  );

  function pathSegments(pathname) {
    return String(pathname || '')
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s).trim();
        } catch {
          return String(s || '').trim();
        }
      })
      .filter(Boolean);
  }

  /** Concrete post/video id — not empty tabs like /reel/?s=tab */
  function isPostId(seg) {
    if (seg == null) return false;
    let s = String(seg).trim();
    try {
      s = decodeURIComponent(s);
    } catch (_) {
      // keep raw
    }
    if (!s || s.length < 4) return false;
    if (RESERVED_SEG.has(s.toLowerCase())) return false;
    if (/^(null|undefined|true|false)$/i.test(s)) return false;
    // Numeric media ids (Facebook videos/reels, TikTok, etc.)
    if (/^\d{5,}$/.test(s)) return true;
    // Facebook pfbid…
    if (/^pfbid[A-Za-z0-9]+$/i.test(s)) return true;
    // Shortcodes / opaque ids (Instagram, yt, etc.)
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{4,}$/.test(s)) return true;
    return false;
  }

  function queryParamId(search, keys) {
    try {
      const q = String(search || '');
      const params = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q);
      for (const key of keys) {
        const v = params.get(key);
        if (v && isPostId(v)) return v;
      }
    } catch (_) {
      // ignore
    }
    return '';
  }

  /**
   * True when path/query looks like a specific post/video/audio item yt-dlp can use.
   * Profile / home / feed / empty tab roots return false.
   */
  function pathLooksLikePost(hostname, pathname, search) {
    const h = hostOf(hostname);
    const path = pathname || '/';
    const q = search || '';
    const segs = pathSegments(path);
    const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

    // YouTube — watch, shorts, live, embed, clips, music.youtube.com, youtu.be
    if (isYoutubeHost(h)) {
      if (h === 'youtu.be') return segs.length >= 1 && isPostId(segs[0]);
      if (/^\/watch/i.test(p) && queryParamId(q, ['v'])) return true;
      // /shorts/{id}, /live/{id}, /embed/{id}, /v/{id}, /clip/{id}, /shorts/{id}/…
      if (segs[0] && /^(shorts|live|embed|v|clip|attribution_link)$/i.test(segs[0]) && isPostId(segs[1])) {
        return true;
      }
      // /youtubei / not a post
      // music.youtube.com/watch?v=
      if (h === 'music.youtube.com' || h.endsWith('.music.youtube.com')) {
        if (queryParamId(q, ['v'])) return true;
      }
      return false;
    }

    // Instagram — /p|reel|reels|tv/{code}, stories
    if (h === 'instagram.com' || h.endsWith('.instagram.com')) {
      if (segs[0] && /^(p|reel|reels|tv)$/i.test(segs[0]) && isPostId(segs[1])) return true;
      if (/^stories$/i.test(segs[0] || '') && segs[1] && isPostId(segs[2])) return true;
      return false;
    }

    // Facebook / FB watch — reel, watch, videos, posts, share, groups
    if (h === 'fb.watch') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'facebook.com' || h === 'fb.com' || h.endsWith('.facebook.com') || h.endsWith('.fb.com')) {
      if (/^(reel|reels)$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (/^watch$/i.test(segs[0] || '')) {
        if (queryParamId(q, ['v', 'story_fbid', 'fbid'])) return true;
        if (isPostId(segs[1])) return true;
        return false;
      }
      if (/^share$/i.test(segs[0] || '') && segs[1] && /^(v|r|p)$/i.test(segs[1]) && isPostId(segs[2])) {
        return true;
      }
      if (segs.length === 1 && /\.php$/i.test(segs[0])) {
        if (queryParamId(q, ['story_fbid', 'fbid', 'v', 'multi_permalinks', 'id'])) return true;
        return false;
      }
      // /photo/?fbid= /photos/…
      if (/^photo\/?$/i.test(p) && queryParamId(q, ['fbid', 'story_fbid'])) return true;
      if (/^photos$/i.test(segs[0] || '') && isPostId(segs[segs.length - 1])) return true;
      if (
        /^groups$/i.test(segs[0] || '') &&
        segs[1] &&
        /^(posts|reel|reels|videos|permalink)$/i.test(segs[2] || '') &&
        isPostId(segs[3])
      ) {
        return true;
      }
      if (/^(videos|posts)$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (
        segs[0] &&
        !RESERVED_SEG.has(String(segs[0]).toLowerCase()) &&
        /^(posts|videos|reel|reels|watch)$/i.test(segs[1] || '') &&
        isPostId(segs[2])
      ) {
        return true;
      }
      return false;
    }

    // Threads
    if (h === 'threads.net' || h.endsWith('.threads.net')) {
      return /^@/.test(segs[0] || '') && /^post$/i.test(segs[1] || '') && isPostId(segs[2]);
    }

    // TikTok (+ vm.tiktok.com short links)
    if (h === 'vm.tiktok.com' || h === 'vt.tiktok.com') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) {
      if (/^@/.test(segs[0] || '') && /^(video|photo)$/i.test(segs[1] || '') && isPostId(segs[2])) return true;
      if (/^(t|v)$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (/^video$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      return false;
    }

    // Twitter / X
    if (h === 'twitter.com' || h === 'x.com' || h.endsWith('.twitter.com') || h.endsWith('.x.com')) {
      if (/^i$/i.test(segs[0] || '') && /^status$/i.test(segs[1] || '') && isPostId(segs[2])) return true;
      if (segs[0] && /^status$/i.test(segs[1] || '') && isPostId(segs[2])) return true;
      return false;
    }

    // Reddit
    if (h === 'redd.it') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) {
      const idx = segs.findIndex((s) => /^comments$/i.test(s));
      if (idx >= 0 && isPostId(segs[idx + 1])) return true;
      return false;
    }

    // Snapchat
    if (h === 'snapchat.com' || h.endsWith('.snapchat.com')) {
      return /^(spotlight|t|add)$/i.test(segs[0] || '') && isPostId(segs[1]);
    }

    // Twitch (+ clips.twitch.tv/{slug})
    if (h === 'clips.twitch.tv') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'twitch.tv' || h.endsWith('.twitch.tv')) {
      if (/^videos$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (/^clip$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (segs[0] && /^clip$/i.test(segs[1] || '') && isPostId(segs[2])) return true;
      return false;
    }

    // Dailymotion / dai.ly
    if (h === 'dai.ly') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'dailymotion.com' || h.endsWith('.dailymotion.com')) {
      return /^video$/i.test(segs[0] || '') && isPostId(segs[1]);
    }

    // Pinterest / pin.it
    if (h === 'pin.it') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'pinterest.com' || h.endsWith('.pinterest.com')) {
      return /^pin$/i.test(segs[0] || '') && isPostId(segs[1]);
    }

    // Bilibili / b23.tv
    if (h === 'b23.tv') {
      return segs.length >= 1 && isPostId(segs[0]);
    }
    if (h === 'bilibili.com' || h.endsWith('.bilibili.com')) {
      if (/^video$/i.test(segs[0] || '') && isPostId(segs[1])) return true;
      if (/^bangumi$/i.test(segs[0] || '') && /^play$/i.test(segs[1] || '') && isPostId(segs[2])) return true;
      return false;
    }

    // Rumble
    if (h === 'rumble.com' || h.endsWith('.rumble.com')) {
      if (segs.length === 1 && /\.html$/i.test(segs[0]) && segs[0].length > 8) return true;
      if (segs[0] && /^v[A-Za-z0-9]+/i.test(segs[0]) && segs[0].length >= 6) return true;
      return false;
    }

    // Kick
    if (h === 'kick.com' || h.endsWith('.kick.com')) {
      return segs[0] && /^(videos|clips)$/i.test(segs[1] || '') && isPostId(segs[2]);
    }

    // Apple Music
    if (h === 'music.apple.com' || h.endsWith('.music.apple.com')) {
      return segs.some((s, i) => /^(song|album|playlist|music-video)$/i.test(s) && isPostId(segs[i + 1]));
    }

    // Vimeo
    if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) {
      if (segs.length >= 1 && /^\d{6,}$/.test(segs[0])) return true;
      if (/^(channels|groups)$/i.test(segs[0] || '') && segs[1] && isPostId(segs[2])) return true;
      return false;
    }

    // SoundCloud
    if (h === 'soundcloud.com' || h.endsWith('.soundcloud.com')) {
      // /artist/track-name (2+ segments, not sets-only roots)
      if (segs.length >= 2 && !RESERVED_SEG.has(String(segs[0]).toLowerCase()) && !/^sets$/i.test(segs[1] || '')) {
        if (/^(you|discover|stream|search|upload|settings|pages)$/i.test(segs[0])) return false;
        return isPostId(segs[1]) || (segs[1] && segs[1].length >= 2);
      }
      return false;
    }

    // Bandcamp
    if (h === 'bandcamp.com' || h.endsWith('.bandcamp.com')) {
      return /^(track|album)$/i.test(segs[0] || '') && !!segs[1];
    }

    return false;
  }

  /**
   * Strip tracking junk (__cft__, fbclid, s=ifu, etc.) but keep ids that live in the query
   * (YouTube ?v=, Facebook /watch?v=, …).
   */
  function cleanSocialPostUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (!/^https?:$/i.test(u.protocol)) return String(url || '').trim();
      const host = hostOf(u.hostname);
      const path = u.pathname || '/';
      const segs = pathSegments(path);

      /** Query keys that identify the media (keep these). */
      const keepKeys = new Set();
      if (isYoutubeHost(host)) {
        // Keep watch + playlist context so "download whole playlist" still works.
        keepKeys.add('v');
        keepKeys.add('list');
        keepKeys.add('index');
        keepKeys.add('t');
        keepKeys.add('start');
      } else if (
        host === 'facebook.com' ||
        host === 'fb.com' ||
        host.endsWith('.facebook.com') ||
        host.endsWith('.fb.com')
      ) {
        // Path already has /reel/{id} → drop all query. /watch?v= needs v.
        const pathHasId =
          (/^(reel|reels|videos|posts)$/i.test(segs[0] || '') && isPostId(segs[1])) ||
          (segs[0] &&
            /^(posts|videos|reel|reels)$/i.test(segs[1] || '') &&
            isPostId(segs[2])) ||
          (/^share$/i.test(segs[0] || '') && isPostId(segs[2]));
        if (!pathHasId) {
          keepKeys.add('v');
          keepKeys.add('story_fbid');
          keepKeys.add('fbid');
          keepKeys.add('id');
          keepKeys.add('multi_permalinks');
        }
      } else if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
        // comments id is in the path
      } else if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
        keepKeys.add('h'); // some unlisted hashes
      }

      const kept = new URLSearchParams();
      if (keepKeys.size) {
        u.searchParams.forEach((value, key) => {
          if (keepKeys.has(key.toLowerCase()) && value) kept.set(key, value);
        });
      }
      // Rebuild search from kept only (drops __cft__, s, fbclid, mibextid, …).
      const qs = kept.toString();
      u.search = qs ? `?${qs}` : '';
      u.hash = '';

      // Normalize trailing slash on path-id posts (optional nicety).
      if (!u.search && u.pathname.length > 1 && !u.pathname.endsWith('/')) {
        // keep as-is — yt-dlp accepts both
      }
      return u.toString();
    } catch {
      return String(url || '').trim();
    }
  }

  /**
   * @param {string} url
   * @returns {{ ok: true, url: string, cleanedUrl: string, kind: 'social'|'yt', host: string } | { ok: false }}
   */
  function classifySocialPostUrl(url) {
    try {
      const raw = String(url || '').trim();
      const u = new URL(raw);
      if (!/^https?:$/i.test(u.protocol)) return { ok: false };
      const host = hostOf(u.hostname);
      if (!isSocialSiteHost(host)) return { ok: false };
      // Validate against the original (ids may only appear in the query).
      if (!pathLooksLikePost(host, u.pathname || '/', u.search || '')) return { ok: false };
      // Keep original query (playlist list=, tracking, …). Cleaning is opt-in in the UI.
      u.hash = '';
      const kept = u.toString();
      const cleaned = cleanSocialPostUrl(raw);
      // Ensure a cleaned form would still be a real post (not /reel/?s=tab alone).
      try {
        const c = new URL(cleaned);
        if (!pathLooksLikePost(hostOf(c.hostname), c.pathname || '/', c.search || '')) {
          // Original is valid (e.g. watch?v= + list=); still accept kept URL.
          if (!pathLooksLikePost(host, u.pathname || '/', u.search || '')) return { ok: false };
        }
      } catch {
        return { ok: false };
      }
      return {
        ok: true,
        url: kept,
        cleanedUrl: cleaned,
        kind: streamKindForHost(host),
        host,
      };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Resolve href against page base; relative paths use the page hostname/origin.
   * @param {string} href
   * @param {string} [baseUrl]
   */
  function resolveHref(href, baseUrl) {
    const raw = String(href || '').trim();
    if (!raw || raw.startsWith('#') || raw.toLowerCase().startsWith('javascript:')) return '';
    try {
      const base = baseUrl || (typeof location !== 'undefined' ? location.href : undefined);
      if (!base) {
        if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
        return '';
      }
      return new URL(raw, base).toString();
    } catch {
      return '';
    }
  }

  /** Regex scrape for post URLs embedded in SPA HTML / JSON (YouTube shorts, FB reels, …). */
  const EMBEDDED_URL_RES = [
    /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/|clip\/)[A-Za-z0-9_-]{6,}/gi,
    /https?:\/\/youtu\.be\/[A-Za-z0-9_-]{6,}/gi,
    /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?:reel|reels|watch|videos|share\/[vrp]|[^"'\\\s]+\/(?:posts|videos|reel|reels))\/[A-Za-z0-9_.-]+/gi,
    /https?:\/\/(?:www\.|m\.)?facebook\.com\/watch\/?\?v=\d+/gi,
    /https?:\/\/fb\.watch\/[A-Za-z0-9_-]+/gi,
    /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/gi,
    /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/(?:@[^/\s"'\\]+\/(?:video|photo)\/\d+|t\/[A-Za-z0-9]+|video\/\d+)/gi,
    /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/\s"'\\]+\/status\/\d+/gi,
    /https?:\/\/(?:www\.)?reddit\.com\/r\/[^/\s"'\\]+\/comments\/[A-Za-z0-9]+/gi,
    /https?:\/\/(?:www\.)?twitch\.tv\/videos\/\d+/gi,
    /https?:\/\/clips\.twitch\.tv\/[A-Za-z0-9_-]+/gi,
    /https?:\/\/(?:www\.)?dailymotion\.com\/video\/[A-Za-z0-9]+/gi,
    /https?:\/\/(?:www\.)?vimeo\.com\/\d{6,}/gi,
    /https?:\/\/(?:www\.)?rumble\.com\/v[A-Za-z0-9][^"'\\\s]*/gi,
    /https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+/gi,
  ];

  /**
   * Collect unique post URLs from anchors, data-* attrs, meta, and embedded page text.
   * @param {Document} [doc]
   * @param {string} [baseUrl]
   * @returns {string[]}
   */
  function collectSocialPostUrlsFromDocument(doc, baseUrl) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return [];
    const base =
      baseUrl ||
      (typeof location !== 'undefined' ? location.href : '') ||
      (documentRef.baseURI || '');
    const pageHost = hostOf(base);
    const out = [];
    const seen = new Set();

    const consider = (href) => {
      if (out.length >= MAX_POSTS) return;
      const abs = resolveHref(href, base);
      if (!abs) return;
      const hit = classifySocialPostUrl(abs);
      if (!hit.ok) return;
      const key = hit.url.replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(hit.url);
    };

    // 1) Classic anchors + image maps
    try {
      const anchors = documentRef.querySelectorAll('a[href], area[href]');
      const limit = Math.min(anchors.length, 2000);
      for (let i = 0; i < limit; i++) {
        const a = anchors[i];
        if (!a || a.closest('[data-hls-grabber-fab],[data-hls-image-dl]')) continue;
        consider(a.getAttribute('href'));
      }
    } catch (_) {
      // ignore
    }

    // 2) SPA / Facebook lynx / generic data link attrs
    if (out.length < MAX_POSTS) {
      try {
        const nodes = documentRef.querySelectorAll(
          '[data-href], [data-lynx-uri], [data-uri], [data-url], [href]'
        );
        const limit = Math.min(nodes.length, 1500);
        for (let i = 0; i < limit; i++) {
          const el = nodes[i];
          if (!el || el.closest('[data-hls-grabber-fab],[data-hls-image-dl]')) continue;
          consider(el.getAttribute('data-href'));
          consider(el.getAttribute('data-lynx-uri'));
          consider(el.getAttribute('data-uri'));
          consider(el.getAttribute('data-url'));
          if (el.tagName !== 'A' && el.tagName !== 'AREA') {
            consider(el.getAttribute('href'));
          }
        }
      } catch (_) {
        // ignore
      }
    }

    // 3) Canonical / Open Graph
    if (out.length < MAX_POSTS) {
      try {
        const canon = documentRef.querySelector('link[rel="canonical"]');
        if (canon) consider(canon.getAttribute('href'));
        const og = documentRef.querySelector('meta[property="og:url"]');
        if (og) consider(og.getAttribute('content'));
        const alt = documentRef.querySelector('meta[property="al:web:url"]');
        if (alt) consider(alt.getAttribute('content'));
      } catch (_) {
        // ignore
      }
    }

    // 4) Regex scrape of HTML for embedded watch/shorts/reel URLs
    if (out.length < MAX_POSTS) {
      try {
        const html = String(documentRef.documentElement && documentRef.documentElement.innerHTML) || '';
        // Cap scan size for huge pages
        const slice = html.length > 2_500_000 ? html.slice(0, 2_500_000) : html;
        for (const re of EMBEDDED_URL_RES) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(slice)) && out.length < MAX_POSTS) {
            consider(m[0]);
          }
        }
      } catch (_) {
        // ignore
      }
    }

    // Prefer posts on the current host first.
    if (pageHost) {
      out.sort((a, b) => {
        const ah = hostOf(a) === pageHost || hostOf(a).endsWith('.' + pageHost) ? 0 : 1;
        const bh = hostOf(b) === pageHost || hostOf(b).endsWith('.' + pageHost) ? 0 : 1;
        return ah - bh;
      });
    }

    return out.slice(0, MAX_POSTS);
  }

  function buildListResponse() {
    const base = (typeof location !== 'undefined' ? location.href : '') || '';
    const urls = collectSocialPostUrlsFromDocument(document, base);
    const pageHit = classifySocialPostUrl(base);
    return {
      ok: true,
      urls,
      pageUrl: base,
      pageIsPost: !!(pageHit && pageHit.ok),
      pagePostUrl: pageHit && pageHit.ok ? pageHit.url : null,
      pageKind: pageHit && pageHit.ok ? pageHit.kind : null,
    };
  }

  function reportPostsToBackground(force) {
    try {
      if (!isSocialSiteHost(typeof location !== 'undefined' ? location.hostname : '')) return;
      const payload = buildListResponse();
      if (!payload.urls.length && !payload.pageIsPost && !force) return;
      chrome.runtime.sendMessage({
        type: 'REPORT_SOCIAL_POST_URLS',
        urls: payload.urls,
        pageUrl: payload.pageUrl,
        pageIsPost: payload.pageIsPost,
        pagePostUrl: payload.pagePostUrl,
        pageKind: payload.pageKind,
      });
    } catch (_) {
      // ignore
    }
  }

  function initContentScript() {
    if (global.__hlsSocialPostUrlsCs) return;
    global.__hlsSocialPostUrlsCs = true;

    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'LIST_SOCIAL_POST_URLS') return;
        try {
          sendResponse(buildListResponse());
        } catch (e) {
          sendResponse({ ok: false, error: String(e), urls: [] });
        }
        return true;
      });
    } catch (_) {
      // ignore outside extension pages
    }

    // Proactive: scan on load + as the feed mutates (YouTube shorts row, FB reels, …).
    let reportTimer = 0;
    const scheduleReport = () => {
      if (reportTimer) clearTimeout(reportTimer);
      reportTimer = setTimeout(() => {
        reportTimer = 0;
        reportPostsToBackground(false);
      }, 450);
    };

    try {
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        scheduleReport();
      } else {
        document.addEventListener('DOMContentLoaded', scheduleReport, { once: true });
      }
      window.addEventListener('load', () => scheduleReport(), { once: true });
      document.addEventListener('yt-navigate-finish', scheduleReport, true);
      document.addEventListener('pjax:end', scheduleReport, true);
    } catch (_) {
      // ignore
    }

    try {
      const obs = new MutationObserver(() => scheduleReport());
      const startObs = () => {
        if (document.documentElement) {
          obs.observe(document.documentElement, { childList: true, subtree: true });
        }
      };
      if (document.documentElement) startObs();
      else document.addEventListener('DOMContentLoaded', startObs, { once: true });
    } catch (_) {
      // ignore
    }

    try {
      setInterval(() => reportPostsToBackground(false), 4000);
    } catch (_) {
      // ignore
    }
  }

  try {
    if (typeof location !== 'undefined' && /^https?:$/i.test(String(location.protocol))) {
      initContentScript();
    }
  } catch (_) {
    // ignore
  }

  global.HLS_SOCIAL_POSTS = {
    MAX_POSTS,
    SOCIAL_SITE_HOSTS,
    hostOf,
    isSocialSiteHost,
    streamKindForHost,
    pathLooksLikePost,
    cleanSocialPostUrl,
    classifySocialPostUrl,
    resolveHref,
    collectSocialPostUrlsFromDocument,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
