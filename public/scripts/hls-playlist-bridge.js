/**
 * Isolated world: forward MAIN-world playlist copies to the service worker,
 * and scan HTML shells for hidden .m3u8 URLs (LMS / hashed content pages).
 */
(function () {
  const MSG = '__SG_HLS_PLAYLIST__';
  const MEDIA_MSG = '__SG_PAGE_MEDIA__';
  const MAX_URLS = 20;
  let lastSent = '';
  let lastMediaSent = '';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === MEDIA_MSG && Array.isArray(data.urls) && data.urls.length) {
      const sig = data.urls.join('\n');
      if (sig === lastMediaSent) return;
      lastMediaSent = sig;
      try {
        chrome.runtime.sendMessage({ type: 'PAGE_MEDIA_URLS', urls: data.urls });
      } catch (_) {
        // ignore
      }
      return;
    }
    if (!data || data.source !== MSG || !data.text) return;
    try {
      chrome.runtime.sendMessage({
        type: 'HLS_PLAYLIST_CAPTURE',
        url: data.url || '',
        text: data.text,
      });
    } catch (_) {
      // ignore
    }
  });

  function collectHlsUrls() {
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      if (!raw || out.length >= MAX_URLS) return;
      let url = String(raw).trim();
      if (!url) return;
      try {
        url = new URL(url, location.href).href;
      } catch (_) {
        return;
      }
      if (!/^https?:/i.test(url)) return;
      if (!/\.m3u8(?:[?#]|$)/i.test(url)) return;
      const key = url.split('#')[0];
      if (seen.has(key)) return;
      seen.add(key);
      out.push(url);
    };

    try {
      document.querySelectorAll('video, audio, source').forEach((el) => {
        add(el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src'));
      });
    } catch (_) {
      // ignore
    }
    try {
      document.querySelectorAll('[data-hls], [data-m3u8], [data-src], [data-playlist]').forEach((el) => {
        add(el.getAttribute('data-hls') || el.getAttribute('data-m3u8') || el.getAttribute('data-src') || el.getAttribute('data-playlist'));
      });
    } catch (_) {
      // ignore
    }

    let html = '';
    try {
      html = (document.documentElement && document.documentElement.innerHTML) || '';
    } catch (_) {
      html = '';
    }
    if (html && html.length < 2500000) {
      const re = /https?:\/\/[^"'\\\s<>]+?\.m3u8(?:\?[^"'\\\s<>]*)?/gi;
      let m;
      while ((m = re.exec(html)) && out.length < MAX_URLS) {
        add(m[0].replace(/&amp;/g, '&'));
      }
    }
    return out;
  }

  function reportEmbeds() {
    const urls = collectHlsUrls();
    if (!urls.length) return;
    const sig = urls.join('\n');
    if (sig === lastSent) return;
    lastSent = sig;
    try {
      chrome.runtime.sendMessage({ type: 'HLS_EMBED_URLS', urls });
    } catch (_) {
      // ignore
    }
  }

  function schedule() {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(reportEmbeds, 200), { once: true });
      } else {
        setTimeout(reportEmbeds, 200);
      }
      setTimeout(reportEmbeds, 1500);
    } catch (_) {
      // ignore
    }
  }

  schedule();
})();
