/**
 * Spot pages whose video is protected, so the UI can offer screen recording
 * instead of a download that was never going to work.
 *
 * The reliable signal is the page asking for a media key system: every DRM
 * player has to call requestMediaKeySystemAccess before it can play. That call
 * lives in the page's own world, so the hook is injected there and reports
 * back. Where a page's CSP blocks that, a list of known hosts still catches the
 * usual suspects.
 */
(function () {
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  if (!extAlive()) return;
  if (window.__hlsGrabberDrmWatch) return;
  window.__hlsGrabberDrmWatch = true;

  /** Shared with the background so both agree on which sites are protected. */
  function drmHosts() {
    return (typeof self !== 'undefined' && self.HLS_DRM_HOSTS) || window.HLS_DRM_HOSTS || null;
  }

  let reported = '';

  /** "video" where screen recording is the way out, "audio" where it is not. */
  function mediaKindForHost() {
    const api = drmHosts();
    if (!api) return '';
    try {
      return api.kindFor(location.hostname) || '';
    } catch (_) {
      return '';
    }
  }

  function report(reason, keySystem) {
    // One report per page is enough; the panel only needs to know that it applies.
    const key = reason + '|' + (keySystem || '');
    if (reported === key || !extAlive()) return;
    reported = key;
    // A page caught only by the EME hook is assumed to be video, which is the
    // overwhelmingly common case and the one worth offering a recorder for.
    const kind = mediaKindForHost() || 'video';
    try {
      chrome.runtime.sendMessage(
        {
          type: 'DRM_DETECTED',
          reason,
          mediaKind: kind,
          host: (drmHosts() && drmHosts().matchedHost(location.hostname)) || '',
          keySystem: String(keySystem || ''),
          pageUrl: String(location.href || '').slice(0, 500),
        },
        () => void chrome.runtime.lastError
      );
    } catch (_) {
      // Extension reloaded; nothing to do.
    }
  }

  /** Patch the page's own EME entry point and post back when it is used. */
  function installPageHook() {
    const source = `(function () {
      if (navigator.__sgDrmHooked) return;
      navigator.__sgDrmHooked = true;
      var orig = navigator.requestMediaKeySystemAccess;
      if (typeof orig !== 'function') return;
      navigator.requestMediaKeySystemAccess = function (keySystem) {
        try {
          window.postMessage({ __sgDrm: true, keySystem: String(keySystem || '') }, '*');
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    })();`;
    try {
      const el = document.createElement('script');
      el.textContent = source;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return true;
    } catch (_) {
      // Trusted Types or a strict CSP refused the injection.
      return false;
    }
  }

  window.addEventListener(
    'message',
    (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (d && d.__sgDrm) report('eme', d.keySystem);
    },
    false
  );

  installPageHook();

  // Known sites are reported straight away, so the panel is right before the
  // user ever presses play.
  if (mediaKindForHost()) report('known-host', '');

  // Players often set up DRM only once the user hits play.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'DRM_CHECK') return false;
    sendResponse({ ok: true, drm: !!reported, reason: reported.split('|')[0] || '' });
    return true;
  });
})();
