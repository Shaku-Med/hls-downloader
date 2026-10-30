/**
 * Isolated world. Hands the page's saved player copy to the service worker
 * when a download needs the fallback.
 */
(function () {
  const ASK = '__SG_PLAYER_COPY_ASK__';
  const REPLY = '__SG_PLAYER_COPY__';

  function askPage(op, extra) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 8000);
      function onMsg(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== REPLY || data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(data);
      }
      window.addEventListener('message', onMsg);
      try {
        window.postMessage(Object.assign({ source: ASK, op: op, id: id }, extra || {}), '*');
      } catch (_) {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(null);
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || (msg.type !== 'PLAYER_COPY_INVENTORY' && msg.type !== 'PLAYER_COPY_CHUNK')) return;
    const op = msg.type === 'PLAYER_COPY_INVENTORY' ? 'inventory' : 'chunk';
    askPage(op, { url: msg.url || '', offset: msg.offset || 0, length: msg.length || 0 })
      .then((data) => {
        try {
          sendResponse(data || { ok: false });
        } catch (_) {
          // ignore
        }
      })
      .catch(() => {
        try {
          sendResponse({ ok: false });
        } catch (_) {
          // ignore
        }
      });
    return true;
  });
})();
