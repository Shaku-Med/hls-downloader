/**
 * MAIN world. Keeps a copy of playlist, init, and segment responses the player
 * already received. Playback is unchanged. Used only if a later download fails.
 */
(function () {
  if (window.__sgPlayerCopy) return;
  window.__sgPlayerCopy = true;

  const ASK = '__SG_PLAYER_COPY_ASK__';
  const REPLY = '__SG_PLAYER_COPY__';
  const MAX_TOTAL = 160 * 1024 * 1024;
  const MAX_PART = 24 * 1024 * 1024;

  const mapUrls = new Set();
  const segUrls = new Set();
  const seen = new Set();
  const inits = [];
  const segments = [];
  let total = 0;

  function absUrl(url) {
    try {
      return new URL(String(url || ''), location.href).href.split('#')[0];
    } catch (_) {
      return '';
    }
  }

  function sniff(buf) {
    if (!buf || buf.length < 8) return '';
    if (buf[0] === 0x23 && buf[1] === 0x45 && buf[2] === 0x58 && buf[3] === 0x54) return 'playlist';
    if (buf[0] === 0x47) return 'segment';
    const box = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    if (box === 'ftyp' || box === 'styp') return 'init';
    if (box === 'moof' || box === 'mdat') return 'segment';
    return '';
  }

  function rememberPlaylist(text, base) {
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      if (/^#EXT-X-MAP:/i.test(s)) {
        const m = s.match(/URI\s*=\s*"([^"]+)"/i) || s.match(/URI\s*=\s*([^,\s]+)/i);
        if (m) {
          const u = absUrl(new URL(m[1].trim(), base || location.href).href);
          if (u) mapUrls.add(u);
        }
        continue;
      }
      if (s.charAt(0) === '#') continue;
      try {
        const u = absUrl(new URL(s, base || location.href).href);
        if (u) segUrls.add(u);
      } catch (_) {
        // ignore
      }
    }
  }

  function keep(url, buf) {
    if (!buf || buf.length < 8 || buf.length > MAX_PART) return;
    if (total + buf.length > MAX_TOTAL) return;
    const key = absUrl(url);
    if (!key || seen.has(key)) return;
    const kind = sniff(buf);
    if (kind === 'playlist') {
      try {
        const text = new TextDecoder('utf-8').decode(buf.subarray(0, Math.min(buf.length, 500000)));
        rememberPlaylist(text, key);
        window.postMessage({ source: '__SG_HLS_PLAYLIST__', url: key, text: text }, '*');
      } catch (_) {
        // ignore
      }
      return;
    }
    const knownInit = mapUrls.has(key);
    const knownSeg = segUrls.has(key);
    if (!knownInit && !knownSeg && kind !== 'init' && kind !== 'segment') return;
    if (kind === 'init' || (knownInit && kind !== 'segment')) {
      seen.add(key);
      inits.push({ url: key, buf });
      total += buf.length;
      return;
    }
    if (kind === 'segment' || knownSeg) {
      seen.add(key);
      segments.push({ url: key, buf });
      total += buf.length;
    }
  }

  function shouldPeek(url, contentType) {
    const u = String(url || '');
    const key = absUrl(u);
    if (key && (mapUrls.has(key) || segUrls.has(key))) return true;
    if (/\.m3u8?(?:[?#]|$)/i.test(u)) return true;
    if (/\.(?:m4s|cmfv|cmfa|cmft|ts|mp4)(?:[?#]|$)/i.test(u)) return true;
    const ct = String(contentType || '').toLowerCase();
    if (!ct) return false;
    return ct.indexOf('mpegurl') !== -1 || ct.indexOf('mp2t') !== -1 || ct.indexOf('mp4') !== -1 || ct.indexOf('video/') === 0 || ct.indexOf('audio/') === 0;
  }

  function toB64(u8) {
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function findPart(url) {
    const key = absUrl(url);
    for (let i = 0; i < inits.length; i++) if (inits[i].url === key) return inits[i];
    for (let i = 0; i < segments.length; i++) if (segments[i].url === key) return segments[i];
    return null;
  }

  function reply(id, extra) {
    try {
      window.postMessage(Object.assign({ source: REPLY, id: id }, extra || {}), '*');
    } catch (_) {
      // ignore
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== ASK) return;
    if (data.op === 'inventory') {
      reply(data.id, {
        ok: true,
        inits: inits.map((p) => ({ url: p.url, size: p.buf.length })),
        segments: segments.map((p) => ({ url: p.url, size: p.buf.length })),
      });
      return;
    }
    if (data.op === 'chunk') {
      const part = findPart(data.url);
      if (!part) {
        reply(data.id, { ok: false });
        return;
      }
      const start = Math.max(0, Number(data.offset) || 0);
      const len = Math.max(0, Number(data.length) || 0);
      const slice = part.buf.subarray(start, Math.min(part.buf.length, start + len));
      reply(data.id, {
        ok: true,
        base64: toB64(slice),
        size: part.buf.length,
      });
    }
  });

  /**
   * A copy of the body, read without ever holding more than one part.
   *
   * Reading a cloned response to the end makes the browser keep the whole
   * body, so a large progressive video fetched this way was held in full only
   * to be dropped for being over the size limit. Stop as soon as it is.
   */
  function readCopy(res) {
    const declared = Number((res.headers && res.headers.get('content-length')) || 0);
    if (declared > MAX_PART || total + declared > MAX_TOTAL) return Promise.resolve(null);
    let body;
    try {
      body = res.clone().body;
    } catch (_) {
      return Promise.resolve(null);
    }
    if (!body || typeof body.getReader !== 'function') return Promise.resolve(null);
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) {
          const out = new Uint8Array(size);
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.length;
          }
          return out;
        }
        size += value.length;
        if (size > MAX_PART) {
          reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
        return pump();
      });
    return pump().catch(() => null);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function sgPlayerCopyFetch(...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      return Promise.resolve(origFetch.apply(this, args)).then((res) => {
        try {
          if (res && res.ok && shouldPeek(res.url || url, res.headers && res.headers.get('content-type'))) {
            readCopy(res).then((buf) => {
              if (buf) keep(res.url || url, buf);
            });
          }
        } catch (_) {
          // ignore
        }
        return res;
      });
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function sgPlayerCopyOpen(method, url, ...rest) {
    try {
      this.__sgCopyUrl = url;
    } catch (_) {
      // ignore
    }
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function sgPlayerCopySend(...args) {
    this.addEventListener('load', function () {
      const url = this.responseURL || this.__sgCopyUrl || '';
      let ct = '';
      try {
        ct = this.getResponseHeader('content-type') || '';
      } catch (_) {
        ct = '';
      }
      if (!shouldPeek(url, ct)) return;
      try {
        const r = this.response;
        if (r instanceof ArrayBuffer) {
          keep(url, new Uint8Array(r));
          return;
        }
        if (typeof Blob !== 'undefined' && r instanceof Blob) {
          r.arrayBuffer().then((buf) => keep(url, new Uint8Array(buf))).catch(() => {});
          return;
        }
        if (typeof this.responseText === 'string' && this.responseText.indexOf('#EXTM3U') !== -1) {
          keep(url, new TextEncoder().encode(this.responseText));
        }
      } catch (_) {
        // ignore
      }
    });
    return xhrSend.apply(this, args);
  };

  // Workers are left alone. Rebuilding a site's worker from a blob URL broke
  // every one that loads a sibling script, a wasm file or a relative API path,
  // since nothing resolves against a blob address, and this runs on every
  // site, video or not. Their requests still reach the network level capture
  // in the background.
})();
