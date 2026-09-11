/**
 * MAIN world: copy HLS playlist bodies from the player's own fetch/XHR.
 * A second GET of a signed m3u8 often fails; this does not make one.
 * Only touches playlist-looking URLs so normal page traffic is left alone.
 */
(function () {
  const MSG = '__SG_HLS_PLAYLIST__';
  const MAX = 500000;
  if (window.__sgHlsPlaylistHook) return;
  window.__sgHlsPlaylistHook = true;

  function urlLooksLikePlaylist(url) {
    const u = String(url || '');
    if (/\.m3u8(?:[?#]|$)/i.test(u) || /\.m3u(?:[?#]|$)/i.test(u)) return true;
    // gzip-token LMS paths sometimes omit a .m3u8 suffix in the request URL.
    if (/H4sIAAAA/i.test(u) && /\/pl\//i.test(u)) return true;
    return false;
  }

  function typeLooksLikePlaylist(type) {
    const t = String(type || '').toLowerCase();
    return (
      t.indexOf('mpegurl') !== -1 ||
      t.indexOf('x-mpegurl') !== -1 ||
      t.indexOf('vnd.apple.mpegurl') !== -1
    );
  }

  function looksHls(url, text) {
    if (!text || text.length > MAX) return false;
    if (!/#EXTM3U/i.test(text)) return false;
    return (
      urlLooksLikePlaylist(url) ||
      /#EXTINF|#EXT-X-STREAM-INF|#EXT-X-TARGETDURATION|#EXT-X-MAP/i.test(text)
    );
  }

  function emit(url, text) {
    if (!looksHls(url, text)) return;
    try {
      window.postMessage({ source: MSG, url: String(url || ''), text: String(text) }, '*');
    } catch (_) {
      // ignore
    }
  }

  const MEDIA_MSG = '__SG_PAGE_MEDIA__';
  const closedRoots = [];
  try {
    const origAttach = Element.prototype.attachShadow;
    if (typeof origAttach === 'function' && !Element.prototype.__sgAttachShadow) {
      Element.prototype.attachShadow = function sgAttachShadow(init) {
        const root = origAttach.apply(this, arguments);
        try {
          if (root) closedRoots.push(root);
        } catch (_) {
          // ignore
        }
        return root;
      };
      Element.prototype.__sgAttachShadow = true;
    }
  } catch (_) {
    // ignore
  }

  function emitPageMedia() {
    const urls = [];
    const seen = new Set();
    const add = (raw) => {
      if (!raw || urls.length >= 12) return;
      const s = String(raw);
      if (!/^https?:/i.test(s)) return;
      try {
        const abs = new URL(s, location.href).href;
        if (seen.has(abs)) return;
        seen.add(abs);
        urls.push(abs);
      } catch (_) {
        // ignore
      }
    };
    const walk = (root) => {
      if (!root) return;
      try {
        root.querySelectorAll('video, audio, source').forEach((el) => {
          add(el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src'));
        });
      } catch (_) {
        // ignore
      }
    };
    walk(document);
    for (const root of closedRoots) walk(root);
    if (!urls.length) return;
    try {
      window.postMessage({ source: MEDIA_MSG, urls }, '*');
    } catch (_) {
      // ignore
    }
  }
  try {
    setTimeout(emitPageMedia, 400);
    setTimeout(emitPageMedia, 2000);
  } catch (_) {
    // ignore
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function sgHlsFetch(...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const peek = urlLooksLikePlaylist(url);
      return origFetch.apply(this, args).then((res) => {
        const finalUrl = res.url || url;
        const shouldPeek =
          peek || urlLooksLikePlaylist(finalUrl) || typeLooksLikePlaylist(res.headers && res.headers.get('content-type'));
        if (shouldPeek) {
          try {
            const clone = res.clone();
            clone
              .text()
              .then((t) => emit(finalUrl, t))
              .catch(() => {});
          } catch (_) {
            // ignore
          }
        }
        return res;
      });
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function sgHlsXhrOpen(method, url, ...rest) {
    this.__sgHlsUrl = url;
    this.__sgHlsPeek = urlLooksLikePlaylist(url);
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function sgHlsXhrSend(...args) {
    if (this.__sgHlsPeek) {
      this.addEventListener('load', function () {
        const url = this.responseURL || this.__sgHlsUrl;
        try {
          if (typeof this.responseText === 'string' && this.responseText) {
            emit(url, this.responseText);
            return;
          }
        } catch (_) {
          // responseText throws when responseType is arraybuffer/blob
        }
        try {
          const r = this.response;
          if (r instanceof ArrayBuffer) {
            emit(url, new TextDecoder('utf-8').decode(new Uint8Array(r)));
          } else if (typeof Blob !== 'undefined' && r instanceof Blob) {
            r.text().then((t) => emit(url, t)).catch(() => {});
          }
        } catch (_) {
          // ignore
        }
      });
    }
    return xhrSend.apply(this, args);
  };
})();
