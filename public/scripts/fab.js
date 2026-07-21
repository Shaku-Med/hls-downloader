(function () {
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function isInvalidatedError(err) {
    const msg = err && (err.message || String(err));
    return typeof msg === 'string' && /extension context invalidated/i.test(msg);
  }

  if (!extAlive()) {
    // Injected into a dead world — do nothing.
    return;
  }

  // Living instance from THIS extension context: remount only.
  // After reload, a previous remount may still sit on window but its chrome.* is dead —
  // detect that via the alive probe closed over the previous instance.
  try {
    const prev = window.__hlsGrabberFabRemount;
    if (typeof prev === 'function' && typeof prev.__hlsAlive === 'function' && prev.__hlsAlive()) {
      prev();
      return;
    }
  } catch (e) {
    if (!isInvalidatedError(e)) {
      // unexpected — still take over below
    }
  }

  window.__hlsGrabberFabGen = (window.__hlsGrabberFabGen || 0) + 1;
  const myGen = window.__hlsGrabberFabGen;
  window.__hlsGrabberFabLoader = true;

  function stillOwner() {
    return extAlive() && window.__hlsGrabberFabGen === myGen;
  }

  const FLOAT_KEY = 'floatGrabberEnabled';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
  const JOBS_KEY = 'hlsGrabJobsState';
  const STREAMS_REV_KEY = 'hlsGrabStreamsRev';
  const FAB_POS_KEY = 'hlsGrabFabPos';
  const FAB_SIZE = 52;
  const FAB_MARGIN = 14;
  const MOVE_TOLERANCE = 12;
  const HOST_TAG = 'stuff-grabber-fab';
  // Firefox YouTube: Polymer/ShadyDOM can throw when walking composedPath into
  // extension ShadowRoots. Keep Shadow DOM (same as Chromium) so styles work,
  // and seal host bubble events on Firefox to reduce page interference.
  const IS_FIREFOX =
    typeof navigator !== 'undefined' && /Firefox\//.test(String(navigator.userAgent || ''));

  try {
    if (typeof customElements !== 'undefined' && !customElements.get(HOST_TAG)) {
      customElements.define(HOST_TAG, class extends HTMLElement {});
    }
  } catch (_) {
    // Unknown elements still work for shadow hosts if define is blocked.
  }

  /** ShadowRoot has getElementById; Element fallback uses querySelector. */
  function rootById(root, id) {
    if (!root || id == null || id === '') return null;
    if (typeof root.getElementById === 'function') {
      try {
        return root.getElementById(String(id));
      } catch (_) {
        // fall through
      }
    }
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return root.querySelector('#' + CSS.escape(String(id)));
      }
    } catch (_) {
      // fall through
    }
    try {
      return root.querySelector('[id="' + String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
    } catch (_) {
      return null;
    }
  }

  /** Keep FAB pointer events from bubbling into YouTube Polymer gesture code. */
  function sealFabHostEvents(host) {
    if (!IS_FIREFOX || !host || host._hlsFabSealed) return;
    host._hlsFabSealed = true;
    const seal = (e) => {
      try {
        e.stopPropagation();
      } catch (_) {
        // ignore
      }
    };
    [
      'click',
      'pointerdown',
      'pointerup',
      'pointermove',
      'mousedown',
      'mouseup',
      'mousemove',
      'touchstart',
      'touchend',
      'touchmove',
    ].forEach((type) => {
      try {
        host.addEventListener(type, seal, false);
      } catch (_) {
        // ignore
      }
    });
  }

  function setNodeHtml(node, html) {
    if (window.HGR_THEME && typeof window.HGR_THEME.setNodeHtml === 'function') {
      return window.HGR_THEME.setNodeHtml(node, html);
    }
    if (!node) return false;
    try {
      node.innerHTML = String(html == null ? '' : html);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Last-resort FAB shell with zero innerHTML (Trusted Types / hostile pages). */
  function buildFabShellDom(shadow, fabSize) {
    const style = document.createElement('style');
    style.setAttribute('data-hls-fab-fallback', '');
    style.textContent = `
:host {
  --fab-size: ${fabSize}px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --bg: #f2f2f7; --surface: #fff; --text: #000; --muted: #8e8e93;
  --line: rgba(60,60,67,.18); --accent: #007aff; --fill: rgba(120,120,128,.16);
  --fill-secondary: rgba(120,120,128,.12); --danger: #ff3b30;
  --shadow: 0 12px 40px rgba(0,0,0,.18);
}
:host([data-theme="dark"]) {
  --bg: #000; --surface: #1c1c1e; --text: #fff; --line: rgba(84,84,88,.65);
  --accent: #0a84ff; --fill: rgba(120,120,128,.32); --danger: #ff453a;
  --shadow: 0 16px 48px rgba(0,0,0,.5);
}
.fab {
  position: fixed !important; width: ${fabSize}px !important; height: ${fabSize}px !important;
  border-radius: 50% !important; border: none !important; cursor: grab !important;
  background: var(--surface) !important; color: var(--text) !important; z-index: 2147483647 !important;
  pointer-events: auto !important; display: flex !important; align-items: center !important;
  justify-content: center !important; visibility: visible !important; opacity: 1 !important;
  box-shadow: var(--shadow), 0 0 0 0.5px var(--line) !important;
  left: var(--fab-left, 14px) !important; top: var(--fab-top, 14px) !important;
  right: auto !important; bottom: auto !important; margin: 0 !important;
}
.fab-icon { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; pointer-events: none; display: block; }
.fab-badge {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 999px; background: var(--danger); color: #fff; font: 700 11px/18px system-ui, sans-serif;
  pointer-events: none;
}
.fab-badge[hidden] { display: none !important; }
.panel { display: none !important; }
.panel.open {
  display: flex !important; flex-direction: column; position: fixed; z-index: 2147483646;
  pointer-events: auto; width: min(360px, calc(100vw - 24px));
  max-height: min(520px, calc(100vh - 24px)); background: var(--bg); color: var(--text);
  border: 0.5px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); overflow: hidden;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; font-weight: 700; }
.close-p { border: 0; background: transparent; font-size: 22px; cursor: pointer; color: var(--muted); }
.panel-scroll { overflow: auto; padding: 0 14px 14px; }
.path-line { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.path-line.bad { color: var(--danger); }
.fab-rec-stop {
  position: fixed !important; z-index: 2147483647 !important; pointer-events: auto !important;
  display: inline-flex !important; align-items: center !important; justify-content: center !important;
  gap: 7px !important; height: 34px !important; padding: 0 12px 0 10px !important;
  border: none !important; border-radius: 999px !important; cursor: pointer !important;
  font: 650 13px/1 system-ui, sans-serif !important; color: #fff !important;
  background: var(--danger, #ff3b30) !important;
  box-shadow: var(--shadow), 0 0 0 0.5px rgba(0,0,0,.18) !important;
}
.fab-rec-stop[hidden] { display: none !important; }
.fab-rec-stop-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #fff; flex-shrink: 0;
  animation: rec-blink 1s ease-in-out infinite;
}
@keyframes rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
`;
    shadow.appendChild(style);

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'fab';
    fab.setAttribute('aria-label', 'Open Stuff Grabber');
    fab.title = 'Stuff Grabber';
    const icon = document.createElement('img');
    icon.className = 'fab-icon';
    icon.alt = '';
    icon.draggable = false;
    const badge = document.createElement('span');
    badge.className = 'fab-badge';
    badge.hidden = true;
    fab.appendChild(icon);
    fab.appendChild(badge);
    shadow.appendChild(fab);

    const recStop = document.createElement('button');
    recStop.type = 'button';
    recStop.className = 'fab-rec-stop';
    recStop.id = 'fab-rec-stop';
    recStop.hidden = true;
    recStop.setAttribute('aria-label', 'Stop recording');
    recStop.title = 'Stop recording';
    const recStopDot = document.createElement('span');
    recStopDot.className = 'fab-rec-stop-dot';
    recStopDot.setAttribute('aria-hidden', 'true');
    const recStopLabel = document.createElement('span');
    recStopLabel.className = 'fab-rec-stop-label';
    recStopLabel.textContent = 'Stop';
    recStop.appendChild(recStopDot);
    recStop.appendChild(recStopLabel);
    shadow.appendChild(recStop);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    const head = document.createElement('div');
    head.className = 'panel-head';
    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = 'Stuff Grabber';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'close-p';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    head.appendChild(title);
    head.appendChild(closeBtn);
    const top = document.createElement('div');
    top.className = 'panel-top';
    const path = document.createElement('div');
    path.className = 'path-line';
    path.id = 'fab-path';
    const rec = document.createElement('div');
    rec.className = 'rec-section';
    rec.id = 'fab-rec';
    rec.hidden = true;
    const recRow = document.createElement('div');
    recRow.className = 'rec-row';
    const selWrap = document.createElement('div');
    selWrap.className = 'rec-select-wrap';
    const recSelect = document.createElement('select');
    recSelect.id = 'fab-rec-select';
    recSelect.className = 'rec-video-select';
    recSelect.setAttribute('aria-label', 'Choose which video to record first');
    selWrap.appendChild(recSelect);
    const recBtn = document.createElement('button');
    recBtn.type = 'button';
    recBtn.className = 'rec-btn';
    recBtn.id = 'fab-rec-btn';
    recBtn.title = 'Record videos on this page';
    const recDot = document.createElement('span');
    recDot.className = 'rec-dot';
    const recLabel = document.createElement('span');
    recLabel.id = 'fab-rec-label';
    recLabel.textContent = 'Rec';
    recBtn.appendChild(recDot);
    recBtn.appendChild(recLabel);
    recRow.appendChild(selWrap);
    recRow.appendChild(recBtn);
    const recStatus = document.createElement('div');
    recStatus.className = 'rec-status';
    recStatus.id = 'fab-rec-status';
    rec.appendChild(recRow);
    rec.appendChild(recStatus);
    top.appendChild(path);
    top.appendChild(rec);

    const scroll = document.createElement('div');
    scroll.className = 'panel-scroll';
    const jobs = document.createElement('div');
    jobs.className = 'jobs-block';
    jobs.id = 'fab-jobs';
    const streams = document.createElement('div');
    streams.id = 'fab-streams';
    const images = document.createElement('div');
    images.id = 'fab-images';
    scroll.appendChild(jobs);
    scroll.appendChild(streams);
    scroll.appendChild(images);
    const foot = document.createElement('div');
    foot.className = 'panel-foot';
    foot.textContent = 'Up to 4 downloads at once. The rest wait their turn across your tabs.';
    panel.appendChild(head);
    panel.appendChild(top);
    panel.appendChild(scroll);
    panel.appendChild(foot);
    shadow.appendChild(panel);
  }

  const fabCtl = {
    closePanel: () => {},
    openPanel: () => {},
    liveRefresh: () => {},
    showBatchThumbPrompt: null,
    runGetAllPageLinks: null,
  };

  /** Host owned by this live content-script instance (null after unmount / orphan cleanup). */
  let liveFabHost = null;

  function hardenFabHost(el) {
    if (!el || !el.style) return;
    // Tight 0×0 host (not a full-viewport sheet). Fixed children still paint
    // on the page; Firefox hit-tests full-viewport pointer-events:none hosts
    // less reliably than Chromium.
    const s = el.style;
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('left', '0', 'important');
    s.setProperty('top', '0', 'important');
    s.setProperty('right', 'auto', 'important');
    s.setProperty('bottom', 'auto', 'important');
    s.setProperty('width', '0', 'important');
    s.setProperty('height', '0', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('padding', '0', 'important');
    s.setProperty('border', '0', 'important');
    s.setProperty('background', 'transparent', 'important');
    s.setProperty('pointer-events', 'none', 'important');
    s.setProperty('z-index', '2147483646', 'important');
    s.setProperty('overflow', 'visible', 'important');
    s.setProperty('display', 'block', 'important');
    s.setProperty('visibility', 'visible', 'important');
    s.setProperty('opacity', '1', 'important');
    s.setProperty('transform', 'none', 'important');
    s.setProperty('filter', 'none', 'important');
    s.setProperty('clip', 'auto', 'important');
    s.setProperty('clip-path', 'none', 'important');
    s.setProperty('max-width', 'none', 'important');
    s.setProperty('max-height', 'none', 'important');
  }

  /** Kill leftover choice sheets that sit above the floater and steal clicks. */
  function dismissStaleOverlays() {
    try {
      document.querySelectorAll('.hgr-modal-overlay, .hgr-picker-overlay').forEach((el) => {
        try {
          el.remove();
        } catch (_) {
          // ignore
        }
      });
    } catch (_) {
      // ignore
    }
  }

  function refreshFabTheme(hostEl) {
    const el = hostEl || liveFabHost;
    if (!el) return;
    try {
      chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
        if (chrome.runtime.lastError) return;
        let mode = (cfg && cfg[THEME_MODE_KEY]) || 'system';
        const accent = (cfg && cfg[THEME_ACCENT_KEY]) || 'blue';
        // Keep floater on app chrome colors (same as popup), not scraped page paint.
        if (mode === 'page') mode = 'system';
        applyFabTheme(mode, accent);
      });
    } catch (_) {
      applyFabTheme('system', 'blue');
    }
  }

  function removeOrphanFabHosts() {
    document.querySelectorAll('[data-hls-grabber-fab], ' + HOST_TAG).forEach((h) => {
      if (liveFabHost && h === liveFabHost) return;
      try {
        if (typeof h._hlsFabCleanup === 'function') h._hlsFabCleanup();
      } catch (_) {
        // ignore
      }
      try {
        h.remove();
      } catch (_) {
        // ignore
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!stillOwner()) return;
    if (!msg || !msg.type) return;
    if (msg.type === 'HLS_GRABBER_PING') {
      sendResponse({
        ok: true,
        fab: !!(liveFabHost && (liveFabHost.isConnected || document.documentElement.contains(liveFabHost))),
      });
      return true;
    }
    if (msg.type === 'HLS_GRABBER_REMOUNT') {
      syncFloatPreference();
      sendResponse({
        ok: true,
        fab: !!(liveFabHost && (liveFabHost.isConnected || document.documentElement.contains(liveFabHost))),
      });
      return true;
    }
    if (msg.type === 'HLS_GRABBER_CLOSE_FLOAT_PANEL') {
      fabCtl.closePanel();
      return;
    }
    if (msg.type === 'HLS_GRABBER_LIVE_UPDATE') {
      fabCtl.liveRefresh(msg.kind || 'jobs');
      return;
    }
    if (msg.type === 'HLS_SHOW_BATCH_THUMB_PROMPT') {
      const run =
        typeof fabCtl.showBatchThumbPrompt === 'function'
          ? fabCtl.showBatchThumbPrompt
          : null;
      if (!run) {
        sendResponse({ choice: null, error: 'Grabber UI not ready' });
        return true;
      }
      fabCtl.openPanel();
      run(msg.count || 0, (choice) => {
        sendResponse({ choice });
      });
      return true;
    }
    if (msg.type === 'HLS_GET_ALL_PAGE_LINKS') {
      const run =
        typeof fabCtl.runGetAllPageLinks === 'function' ? fabCtl.runGetAllPageLinks : null;
      if (!run) {
        sendResponse({ ok: false, error: 'Grabber UI not ready' });
        return true;
      }
      // Ack immediately so the popup can close and reveal this page sheet.
      sendResponse({ ok: true, opened: true });
      setTimeout(() => {
        run(msg.items || [], msg.count || (msg.items || []).length, (result) => {
          try {
            chrome.runtime.sendMessage({
              type: 'HLS_GET_ALL_RESULT',
              ...(result || { canceled: true, choice: null }),
            });
          } catch (_) {
            // ignore
          }
        });
      }, 60);
      return true;
    }
  });

  function unmountGrabberUi() {
    if (!stillOwner()) return;
    const h = liveFabHost || document.querySelector('[data-hls-grabber-fab]');
    liveFabHost = null;
    if (!h) {
      removeOrphanFabHosts();
      return;
    }
    if (typeof h._hlsFabCleanup === 'function') {
      try {
        h._hlsFabCleanup();
      } catch (_) {
        // ignore
      }
    }
    fabCtl.closePanel = () => {};
    fabCtl.openPanel = () => {};
    fabCtl.liveRefresh = () => {};
    fabCtl.showBatchThumbPrompt = null;
    fabCtl.runGetAllPageLinks = null;
    try {
      h.remove();
    } catch (_) {
      // ignore
    }
    removeOrphanFabHosts();
  }

  function syncFloatPreference() {
    if (!stillOwner()) return;
    // Default is ON — mount right away so the button doesn't wait on storage /
    // service-worker wake (that only happened after opening the popup before).
    try {
      mountGrabberUi();
    } catch (e) {
      if (isInvalidatedError(e)) return;
    }
    if (!stillOwner()) return;
    try {
      chrome.storage.local.get([FLOAT_KEY], (d) => {
        if (!stillOwner()) return;
        if (chrome.runtime.lastError) return;
        if (d && d[FLOAT_KEY] === false) {
          unmountGrabberUi();
          return;
        }
        if (!liveFabHost || !liveFabHost.isConnected) mountGrabberUi();
      });
    } catch (e) {
      // Extension context invalidated
      if (isInvalidatedError(e)) return;
    }
  }

  syncFloatPreference.__hlsAlive = extAlive;
  window.__hlsGrabberFabRemount = syncFloatPreference;

  // Some sites rewrite <html>/<body> and strip unknown nodes — put the FAB back.
  let remountTimer = 0;
  let fabDomObserver = null;
  try {
    fabDomObserver = new MutationObserver(() => {
      if (!stillOwner()) {
        try {
          fabDomObserver.disconnect();
        } catch (_) {
          // ignore
        }
        return;
      }
      if (!liveFabHost) return;
      if (liveFabHost.isConnected) return;
      liveFabHost = null;
      if (remountTimer) clearTimeout(remountTimer);
      remountTimer = setTimeout(() => {
        remountTimer = 0;
        if (!stillOwner()) return;
        syncFloatPreference();
      }, 50);
    });
    fabDomObserver.observe(document.documentElement, { childList: true, subtree: false });
  } catch (_) {
    fabDomObserver = null;
  }

  try {
    window.addEventListener('pageshow', () => {
      if (!stillOwner()) return;
      syncFloatPreference();
    });
  } catch (_) {
    // ignore
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!stillOwner()) return;
      if (area === 'local' && changes[FLOAT_KEY]) {
        const on = changes[FLOAT_KEY].newValue !== false;
        if (on) mountGrabberUi();
        else unmountGrabberUi();
      }
      if (area === 'local' && (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY])) {
        // Live binder already updates CSS vars; just refresh if host exists.
        if (liveFabHost) refreshFabTheme(liveFabHost);
      }
    });
  } catch (_) {
    // ignore
  }

  function genJobId() {
    return `j_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  function ytdlpFormatSelection(row) {
    if (!row) return '';
    if (row.has_video && row.has_audio) return String(row.format_id);
    if (row.has_video) return `${row.format_id}+bestaudio/best`;
    return '';
  }

  /** @param {(row: object | null | undefined) => void} callback */
  function showYtdlpFormatPicker(title, rows, callback) {
    if (window.HGR_THEME && window.HGR_THEME.showYtdlpFormatPicker) {
      window.HGR_THEME.showYtdlpFormatPicker(title, rows, callback);
      return;
    }
    callback(null);
  }

  function maybeAskYtdlpFormat(kind, probePayload, onPick, onCancel) {
    // A reloaded extension orphans this script: fall back to default quality
    // instead of throwing out of the click handler and doing nothing visible.
    if (!extAlive()) {
      onPick(null);
      return;
    }
    try {
      chrome.storage.local.get(['ytDlpQualityMode'], (opt) => {
        if (chrome.runtime.lastError) {
          onPick(null);
          return;
        }
        const ask = opt && opt.ytDlpQualityMode === 'ask';
        const ytdlp = kind === 'social' || kind === 'yt';
        if (!ask || !ytdlp) {
          onPick(null);
          return;
        }
        chrome.runtime.sendMessage({ type: 'GET_YTDLP_FORMATS', payload: probePayload }, (res) => {
          if (chrome.runtime.lastError) {
            onPick(null);
            return;
          }
          const formats = (res && res.formats) || [];
          const videoRows = formats.filter((f) => f.has_video);
          const pickable = videoRows.length ? videoRows : formats;
          if (!res || !res.ok || pickable.length < 2) {
            onPick(null);
            return;
          }
          showYtdlpFormatPicker((res.title || '').trim(), pickable, (sel) => {
            if (sel === undefined) {
              onCancel();
              return;
            }
            if (sel === null) {
              onPick(null);
              return;
            }
            onPick(ytdlpFormatSelection(sel));
          });
        });
      });
    } catch (_) {
      onPick(null);
    }
  }

  function slugify(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      let raw = parts[parts.length - 2] || parts[parts.length - 1] || 'stream';
      raw = raw.replace(/\.m3u8$/i, '');
      let s = raw.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      if (s.length > 64) {
        let h = 2166136261;
        for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 16777619);
        s = `stream_${(h >>> 0).toString(16)}`;
      }
      return s || 'stream';
    } catch {
      return 'stream';
    }
  }

  function sanitizePageTitleForFile(title) {
    let t = String(title || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    t = t.replace(/^\.+|\.+$/g, '');
    if (t.length > 100) t = t.slice(0, 100).trim();
    if (/^(new tab|untitled|loading)$/i.test(t) || t.length < 1) return '';
    return t;
  }

  function defaultFileName(streamIndex, streamCount, pageTitle, url) {
    const base = sanitizePageTitleForFile(pageTitle);
    if (base) {
      if (streamCount > 1) {
        return streamIndex === 0 ? base : `${base} (${streamIndex + 1})`;
      }
      return base;
    }
    return slugify(url);
  }

  function mountGrabberUi() {
    let coreReady = false;
    if (!stillOwner()) return;
    try {
      if (liveFabHost && (liveFabHost.isConnected || document.documentElement.contains(liveFabHost))) {
        hardenFabHost(liveFabHost);
        refreshFabTheme(liveFabHost);
        return;
      }
      // Drop hosts left by orphaned scripts after an extension reload.
      removeOrphanFabHosts();

      const ac = new AbortController();
      const { signal } = ac;

      // Custom tag avoids hostile page rules that target bare `div`.
      // Same Shadow DOM path as Chromium (styles via adoptExtensionCss for Firefox CSP).
      let host = document.createElement(HOST_TAG);
      host.setAttribute('data-hls-grabber-fab', '');
      hardenFabHost(host);
      let shadow;
      try {
        shadow = host.attachShadow({ mode: 'open' });
      } catch (attachErr) {
        shadow = host.shadowRoot;
        if (!shadow) {
          // Fall back to a plain div host if the custom tag is blocked.
          host = document.createElement('div');
          host.setAttribute('data-hls-grabber-fab', '');
          hardenFabHost(host);
          shadow = host.attachShadow({ mode: 'open' });
        } else {
          setNodeHtml(shadow, '');
        }
      }

      setNodeHtml(
        shadow,
        `
<style data-hls-fab-fallback>
  :host {
    --fab-size: ${FAB_SIZE}px;
    --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
      "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    --bg: #f2f2f7;
    --surface: #ffffff;
    --surface-2: #ffffff;
    --text: #000000;
    --muted: #8e8e93;
    --line: rgba(60, 60, 67, 0.18);
    --accent: #007aff;
    --btnText: #ffffff;
    --fill: rgba(120, 120, 128, 0.16);
    --fill-secondary: rgba(120, 120, 128, 0.12);
    --danger: #ff3b30;
    --danger-bg: rgba(255, 59, 48, 0.12);
    --shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  }
  :host([data-theme="dark"]) {
    --bg: #000000;
    --surface: #1c1c1e;
    --surface-2: #2c2c2e;
    --text: #ffffff;
    --muted: #8e8e93;
    --line: rgba(84, 84, 88, 0.65);
    --accent: #0a84ff;
    --fill: rgba(120, 120, 128, 0.32);
    --fill-secondary: rgba(120, 120, 128, 0.24);
    --danger: #ff453a;
    --danger-bg: rgba(255, 69, 58, 0.16);
    --shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .fab {
    position: fixed !important;
    width: ${FAB_SIZE}px !important;
    height: ${FAB_SIZE}px !important;
    border-radius: 50% !important;
    border: none !important;
    cursor: grab !important;
    background: var(--surface) !important;
    color: var(--text) !important;
    padding: 0 !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    visibility: visible !important;
    opacity: 1 !important;
    box-shadow: var(--shadow), 0 0 0 0.5px var(--line) !important;
    left: var(--fab-left, 14px) !important;
    top: var(--fab-top, 14px) !important;
    right: auto !important;
    bottom: auto !important;
    transform: var(--fab-transform, none);
    margin: 0 !important;
  }
  .fab-icon { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; pointer-events: none; display: block; }
  .fab-badge {
    position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px;
    border-radius: 999px; background: var(--danger, #ff3b30); color: #fff; font: 700 11px/18px system-ui, sans-serif;
    pointer-events: none;
  }
  .fab-badge[hidden] { display: none !important; }
  .panel { display: none !important; }
  .panel.open {
    display: flex !important; flex-direction: column; position: fixed; z-index: 2147483646;
    pointer-events: auto; width: min(360px, calc(100vw - 24px));
    max-height: min(520px, calc(100vh - 24px));
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    color: var(--text);
    border: 0.5px solid var(--line);
    border-radius: 16px;
    box-shadow: var(--shadow); overflow: hidden;
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
  }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; font-weight: 700; color: var(--text);
  }
  .panel-title { color: var(--text); }
  .close-p {
    border: 0; background: transparent; font-size: 22px; cursor: pointer; line-height: 1;
    color: var(--muted);
  }
  .close-p:hover { background: var(--fill-secondary); color: var(--text); }
  .panel-scroll { overflow: auto; padding: 0 14px 14px; color: var(--text); }
  .path-line { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .path-line.bad { color: var(--danger); }
  .fab-rec-stop {
    position: fixed; z-index: 2147483647; pointer-events: auto;
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    height: 34px; padding: 0 12px 0 10px; border: none; border-radius: 999px;
    cursor: pointer; font: 650 13px/1 system-ui, sans-serif; color: #fff;
    background: var(--danger, #ff3b30);
    box-shadow: var(--shadow), 0 0 0 0.5px rgba(0,0,0,0.18);
  }
  .fab-rec-stop[hidden] { display: none !important; }
  .fab-rec-stop-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #fff; flex-shrink: 0;
    animation: rec-blink 1s ease-in-out infinite;
  }
  @keyframes rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
<button type="button" class="fab" aria-label="Open Stuff Grabber" title="Stuff Grabber">
  <img class="fab-icon" src="" alt="" draggable="false" />
  <span class="fab-badge" hidden></span>
</button>
<button type="button" class="fab-rec-stop" id="fab-rec-stop" hidden aria-label="Stop recording" title="Stop recording">
  <span class="fab-rec-stop-dot" aria-hidden="true"></span>
  <span class="fab-rec-stop-label">Stop</span>
</button>
<div class="panel" hidden>
  <div class="panel-head">
    <span class="panel-title">Stuff Grabber</span>
    <button type="button" class="close-p" aria-label="Close">×</button>
  </div>
  <div class="panel-top">
    <div class="path-line" id="fab-path"></div>
    <div class="rec-section" id="fab-rec" hidden>
      <div class="rec-row">
        <div class="rec-select-wrap">
          <select id="fab-rec-select" class="rec-video-select" aria-label="Choose which video to record first"></select>
        </div>
        <button type="button" class="rec-btn" id="fab-rec-btn" title="Record videos on this page">
          <span class="rec-dot"></span>
          <span id="fab-rec-label">Rec</span>
        </button>
      </div>
      <div class="rec-status" id="fab-rec-status"></div>
    </div>
  </div>
  <div class="panel-scroll">
    <div class="jobs-block" id="fab-jobs"></div>
    <div id="fab-streams"></div>
    <div id="fab-images"></div>
  </div>
  <div class="panel-foot">Up to 4 downloads at once. The rest wait their turn across your tabs.</div>
</div>`
      );

      const mountRoot = document.documentElement || document.body;
      if (!mountRoot) return;
      mountRoot.appendChild(host);
      liveFabHost = host;
      sealFabHostEvents(host);
      host.style.setProperty('--fab-size', `${FAB_SIZE}px`);
      try {
        const styleUrls = [
          'style/app-theme-base.css',
          'style/shared-ui.css',
          'style/fab.css',
          'style/ios-select.css',
        ];
        const themeApi = window.HGR_THEME;
        // Firefox CSP blocks <link>/<style> into the page; adoptedStyleSheets
        // (and promoteInlineStyles) apply the same CSS Chromium gets via <link>.
        if (themeApi && typeof themeApi.promoteInlineStyles === 'function') {
          themeApi.promoteInlineStyles(shadow);
        }
        if (themeApi && typeof themeApi.adoptExtensionCss === 'function') {
          themeApi.adoptExtensionCss(shadow, styleUrls);
        } else {
          styleUrls.forEach((href) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL(href);
            shadow.appendChild(link);
          });
        }
      } catch (_) {
        // Stylesheet optional — inline fallback above is enough to show the button.
      }

      let fab = shadow.querySelector('.fab');
      let panel = shadow.querySelector('.panel');
      let fabRecStop = rootById(shadow, 'fab-rec-stop');
      let fabPath = rootById(shadow, 'fab-path');
      let fabJobs = rootById(shadow, 'fab-jobs');
      let fabStreams = rootById(shadow, 'fab-streams');
      let fabImages = rootById(shadow, 'fab-images');
      let closeBtn = shadow.querySelector('.close-p');
      if (!fab || !panel || !closeBtn) {
        // HTML inject was blocked or stripped — build with createElement only.
        setNodeHtml(shadow, '');
        buildFabShellDom(shadow, FAB_SIZE);
        fab = shadow.querySelector('.fab');
        panel = shadow.querySelector('.panel');
        fabRecStop = rootById(shadow, 'fab-rec-stop');
        fabPath = rootById(shadow, 'fab-path');
        fabJobs = rootById(shadow, 'fab-jobs');
        fabStreams = rootById(shadow, 'fab-streams');
        fabImages = rootById(shadow, 'fab-images');
        closeBtn = shadow.querySelector('.close-p');
      }
      if (!fab || !panel || !closeBtn) {
        try {
          host.remove();
        } catch (_) {
          // ignore
        }
        liveFabHost = null;
        return;
      }

  let _fabStreamsSig = '';
  function fabStreamsSignature(streams) {
    return (streams || [])
      .map((s) => {
        if (typeof s === 'string') return s;
        return `${s.urlSource || ''}|${s.cleanedUrl || s.url || ''}|${s.streamKind || ''}`;
      })
      .join('\n');
  }

  function applyFabTheme(mode, accent) {
    const themeApi = window.HGR_THEME;
    if (themeApi && typeof themeApi.applyThemeToHost === 'function') {
      themeApi.applyThemeToHost(host, mode, accent);
      return;
    }
    const dark =
      mode === 'dark' ||
      (mode !== 'light' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    host.setAttribute('data-theme-mode', mode || 'system');
    if (mode === 'page') host.removeAttribute('data-accent');
    else host.setAttribute('data-accent', accent || 'blue');
  }

  // Match the popup chrome: use Settings theme tokens, not live page colors
  // (page sampling on YouTube etc. makes the floater look washed out / mismatched).
  let unbindFabTheme = null;
  function syncFabStoredTheme() {
    try {
      chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
        if (chrome.runtime.lastError) return;
        let mode = (cfg && cfg[THEME_MODE_KEY]) || 'system';
        const accent = (cfg && cfg[THEME_ACCENT_KEY]) || 'blue';
        if (mode === 'page') mode = 'system';
        applyFabTheme(mode, accent);
      });
    } catch (_) {
      applyFabTheme('system', 'blue');
    }
  }
  syncFabStoredTheme();
  try {
    const onThemeStorage = (changes, area) => {
      if (area !== 'local') return;
      if (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY]) syncFabStoredTheme();
    };
    chrome.storage.onChanged.addListener(onThemeStorage);
    unbindFabTheme = () => {
      try {
        chrome.storage.onChanged.removeListener(onThemeStorage);
      } catch (_) {
        // ignore
      }
    };
  } catch (_) {
    // ignore
  }

  try {
    const iconEl = shadow.querySelector('.fab-icon');
    if (iconEl) iconEl.src = chrome.runtime.getURL('asset/icon-48.png');
  } catch (_) {
    // ignore
  }

  let corner = 'br';
  let drag = null;

  function vw() {
    return window.innerWidth;
  }
  function vh() {
    return window.innerHeight;
  }

  function cornerCoords(c) {
    const w = vw();
    const h = vh();
    const m = FAB_MARGIN;
    const s = FAB_SIZE;
    switch (c) {
      case 'tl':
        return { left: m, top: m };
      case 'tr':
        return { left: w - s - m, top: m };
      case 'bl':
        return { left: m, top: h - s - m };
      case 'br':
      default:
        return { left: w - s - m, top: h - s - m };
    }
  }

  let snapTrackRaf = 0;

  function stopSnapTracking() {
    if (snapTrackRaf) {
      cancelAnimationFrame(snapTrackRaf);
      snapTrackRaf = 0;
    }
  }

  function trackPanelDuringSnap() {
    stopSnapTracking();
    const needPanel = panel.classList.contains('open');
    const needStop = !!(fabRecStop && !fabRecStop.hidden);
    if (!needPanel && !needStop) return;
    const tick = () => {
      if (needPanel) positionPanel();
      positionRecStop();
      if (fab.classList.contains('snapping')) {
        snapTrackRaf = requestAnimationFrame(tick);
      } else {
        snapTrackRaf = 0;
      }
    };
    snapTrackRaf = requestAnimationFrame(tick);
  }

  /** Keep the recording Stop chip glued to the FAB wherever it moves. */
  function positionRecStop() {
    if (!fabRecStop || fabRecStop.hidden) return;
    const r = fab.getBoundingClientRect();
    const gap = 8;
    const edge = 8;
    const pw = fabRecStop.offsetWidth || 78;
    const ph = fabRecStop.offsetHeight || 34;
    let left = r.left + (r.width - pw) / 2;
    let top = r.top - ph - gap;
    // Prefer above the FAB; flip below / sideways if near viewport edges.
    if (top < edge) top = r.bottom + gap;
    if (top + ph > vh() - edge) {
      top = Math.max(edge, r.top + (r.height - ph) / 2);
      // Place inward from the FAB (away from the nearest side edge).
      const preferLeft = r.left + r.width / 2 > vw() / 2;
      left = preferLeft ? r.left - pw - gap : r.right + gap;
    }
    left = Math.min(Math.max(edge, left), vw() - pw - edge);
    top = Math.min(Math.max(edge, top), vh() - ph - edge);
    fabRecStop.style.setProperty('position', 'fixed', 'important');
    fabRecStop.style.setProperty('left', `${Math.round(left)}px`, 'important');
    fabRecStop.style.setProperty('top', `${Math.round(top)}px`, 'important');
    fabRecStop.style.setProperty('right', 'auto', 'important');
    fabRecStop.style.setProperty('bottom', 'auto', 'important');
    fabRecStop.style.setProperty('z-index', '2147483647', 'important');
    fabRecStop.style.setProperty('pointer-events', 'auto', 'important');
  }

  function applyFabPixels(left, top, mode) {
    // mode: false/'drag' = no transition, true/'snap' = spring snap, 'soft' = gentle move
    const isDrag = mode === false || mode === 'drag';
    const isSnap = mode === true || mode === 'snap';
    fab.classList.toggle('dragging', isDrag);
    if (!isSnap) fab.classList.remove('snapping');
    const l = Math.round(Number(left) || 0);
    const t = Math.round(Number(top) || 0);
    // Direct inline position (not only CSS vars) so the button stays visible
    // even when fab.css fails to load or var() resolution breaks.
    fab.style.setProperty('position', 'fixed', 'important');
    fab.style.setProperty('left', `${l}px`, 'important');
    fab.style.setProperty('top', `${t}px`, 'important');
    fab.style.setProperty('right', 'auto', 'important');
    fab.style.setProperty('bottom', 'auto', 'important');
    fab.style.setProperty('width', `${FAB_SIZE}px`, 'important');
    fab.style.setProperty('height', `${FAB_SIZE}px`, 'important');
    fab.style.setProperty('display', 'flex', 'important');
    fab.style.setProperty('visibility', 'visible', 'important');
    fab.style.setProperty('opacity', '1', 'important');
    fab.style.setProperty('pointer-events', 'auto', 'important');
    fab.style.setProperty('z-index', '2147483646', 'important');
    fab.style.setProperty('--fab-left', `${l}px`);
    fab.style.setProperty('--fab-top', `${t}px`);
    fab.style.setProperty('--fab-right', 'auto');
    fab.style.setProperty('--fab-bottom', 'auto');
    if (isDrag) {
      fab.style.setProperty('--fab-transform', 'scale(1.08)');
      fab.style.setProperty('transform', 'scale(1.08)');
    } else if (!isSnap) {
      fab.style.setProperty('--fab-transform', 'none');
      fab.style.setProperty('transform', 'none');
    }
    positionRecStop();
  }

  function animateSnapTo(left, top) {
    const from = fab.getBoundingClientRect();
    const dx = left - from.left;
    const dy = top - from.top;
    const dist = Math.hypot(dx, dy);

    fab.classList.remove('dragging');
    fab.classList.add('snapping');

    // Stretch slightly along the travel direction, then settle.
    if (dist > 12) {
      const nx = dx / dist;
      const ny = dy / dist;
      const stretchX = 1 + Math.min(0.14, Math.abs(nx) * 0.14);
      const stretchY = 1 + Math.min(0.14, Math.abs(ny) * 0.14);
      fab.style.setProperty(
        '--fab-transform',
        `scale(${stretchX.toFixed(3)}, ${stretchY.toFixed(3)})`
      );
    } else {
      fab.style.setProperty('--fab-transform', 'scale(1.06)');
    }

    // Force style flush so the next left/top change animates from here.
    void fab.offsetWidth;

    const l = Math.round(left);
    const t = Math.round(top);
    fab.style.setProperty('left', `${l}px`, 'important');
    fab.style.setProperty('top', `${t}px`, 'important');
    fab.style.setProperty('--fab-left', `${l}px`);
    fab.style.setProperty('--fab-top', `${t}px`);
    fab.style.setProperty('--fab-right', 'auto');
    fab.style.setProperty('--fab-bottom', 'auto');

    requestAnimationFrame(() => {
      fab.style.setProperty('--fab-transform', 'scale(1)');
      fab.style.setProperty('transform', 'scale(1)');
    });

    trackPanelDuringSnap();

    const finish = (ev) => {
      if (ev && ev.target !== fab) return;
      if (ev && ev.propertyName !== 'left' && ev.propertyName !== 'top') return;
      fab.removeEventListener('transitionend', finish);
      window.clearTimeout(fallbackTimer);
      fab.classList.remove('snapping');
      fab.style.setProperty('--fab-transform', 'none');
      stopSnapTracking();
      if (panel.classList.contains('open')) positionPanel();
      positionRecStop();
    };
    fab.addEventListener('transitionend', finish);
    const fallbackTimer = window.setTimeout(() => finish(null), 700);
  }

  function snapCornerFromPosition(left, top) {
    const w = vw();
    const h = vh();
    const cx = left + FAB_SIZE / 2;
    const cy = top + FAB_SIZE / 2;
    const pts = [
      { c: 'tl', x: FAB_MARGIN + FAB_SIZE / 2, y: FAB_MARGIN + FAB_SIZE / 2 },
      { c: 'tr', x: w - FAB_MARGIN - FAB_SIZE / 2, y: FAB_MARGIN + FAB_SIZE / 2 },
      { c: 'bl', x: FAB_MARGIN + FAB_SIZE / 2, y: h - FAB_MARGIN - FAB_SIZE / 2 },
      { c: 'br', x: w - FAB_MARGIN - FAB_SIZE / 2, y: h - FAB_MARGIN - FAB_SIZE / 2 },
    ];
    let best = pts[0];
    let d0 = (cx - pts[0].x) ** 2 + (cy - pts[0].y) ** 2;
    for (let i = 1; i < pts.length; i++) {
      const d = (cx - pts[i].x) ** 2 + (cy - pts[i].y) ** 2;
      if (d < d0) {
        d0 = d;
        best = pts[i];
      }
    }
    corner = best.c;
    return cornerCoords(corner);
  }

  function updateQueueBadge(response) {
    const badge = shadow.querySelector('.fab-badge');
    if (!badge) return;
    const n = (response?.running ?? 0) + (response?.queueLength ?? 0);
    if (n <= 0) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    badge.hidden = false;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.setAttribute('aria-label', `${n} active downloads`);
  }

  function refreshBadgeOnly() {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      updateQueueBadge(response);
    });
  }

  function setPanelTransformOrigin() {
    const origin =
      corner === 'tl' ? 'top left' : corner === 'tr' ? 'top right' : corner === 'bl' ? 'bottom left' : 'bottom right';
    panel.style.setProperty('--panel-origin', origin);
  }

  function positionPanel() {
    if (panel.hidden || !panel.classList.contains('open')) return;
    const rect = fab.getBoundingClientRect();
    const edge = 12;
    const gap = 10;
    const pw = Math.min(360, vw() - 2 * edge);
    panel.style.width = `${pw}px`;
    const maxPh = Math.min(520, vh() - 2 * edge);
    panel.style.maxHeight = `${maxPh}px`;

    const ph = Math.min(panel.offsetHeight || panel.scrollHeight, maxPh);

    let left;
    let top;
    if (corner === 'tr' || corner === 'br') {
      left = rect.left - gap - pw;
    } else {
      left = rect.right + gap;
    }
    if (corner === 'bl' || corner === 'br') {
      top = rect.top - gap - ph;
    } else {
      top = rect.bottom + gap;
    }

    const fr = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    function clamp(l, t) {
      const nl = Math.min(Math.max(edge, l), vw() - edge - pw);
      const nt = Math.min(Math.max(edge, t), vh() - edge - ph);
      return { l: nl, t: nt };
    }
    function overlap(l, t) {
      const r = { left: l, top: t, right: l + pw, bottom: t + ph };
      return !(
        r.right <= fr.left - 2 ||
        r.left >= fr.right + 2 ||
        r.bottom <= fr.top - 2 ||
        r.top >= fr.bottom + 2
      );
    }

    let c = clamp(left, top);
    left = c.l;
    top = c.t;
    if (overlap(left, top)) {
      if (corner === 'br' || corner === 'bl') {
        top = rect.bottom + gap;
      } else {
        top = rect.top - gap - ph;
      }
      c = clamp(left, top);
      left = c.l;
      top = c.t;
    }
    if (overlap(left, top)) {
      if (corner === 'tr' || corner === 'br') {
        left = rect.right + gap;
      } else {
        left = rect.left - gap - pw;
      }
      c = clamp(left, top);
      left = c.l;
      top = c.t;
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }
  function setPanelOpen(open) {
    if (open) {
      dismissStaleOverlays();
      panel.hidden = false;
      // Inline layout so the panel is visible even if fab.css is CSP-blocked.
      panel.style.setProperty('position', 'fixed', 'important');
      panel.style.setProperty('display', 'flex', 'important');
      panel.style.setProperty('flex-direction', 'column', 'important');
      panel.style.setProperty('z-index', '2147483646', 'important');
      panel.style.setProperty('pointer-events', 'auto', 'important');
      panel.style.setProperty('visibility', 'visible', 'important');
      panel.style.setProperty('opacity', '1', 'important');
      panel.style.setProperty('overflow', 'hidden', 'important');
      panel.style.setProperty('box-sizing', 'border-box', 'important');
      setPanelTransformOrigin();
      panel.classList.add('open');
      requestAnimationFrame(() => {
        positionPanel();
        requestAnimationFrame(() => positionPanel());
      });
      fabRecScan();
    } else {
      panel.classList.remove('open');
      setTimeout(() => {
        if (!panel.classList.contains('open')) {
          panel.hidden = true;
          panel.style.setProperty('display', 'none', 'important');
        }
      }, 220);
    }
  }
  function persistPos(left, top) {
    chrome.storage.local.set({
      [FAB_POS_KEY]: { corner, left: Math.round(left), top: Math.round(top) },
    });
  }

  function loadPos(cb) {
    chrome.storage.local.get(FAB_POS_KEY, (data) => {
      const p = data[FAB_POS_KEY];
      if (p && typeof p.left === 'number' && typeof p.top === 'number') {
        corner = p.corner || 'br';
        const snapped = snapCornerFromPosition(p.left, p.top);
        applyFabPixels(snapped.left, snapped.top, true);
        cb();
        return;
      }
      const sc = cornerCoords('br');
      corner = 'br';
      applyFabPixels(sc.left, sc.top, true);
      cb();
    });
  }

  // Paint the button as soon as helpers exist — later wiring failures must not tear it down.
  try {
    const sc = cornerCoords('br');
    corner = 'br';
    applyFabPixels(sc.left, sc.top, false);
  } catch (_) {
    try {
      applyFabPixels(FAB_MARGIN, FAB_MARGIN, false);
    } catch (_) {
      // ignore
    }
  }
  coreReady = true;

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dismissStaleOverlays();
    try {
      fab.setPointerCapture(e.pointerId);
    } catch (_) {
      // Firefox / hostile pages may reject capture — drag still works via move.
    }
    const r = fab.getBoundingClientRect();
    drag = {
      pid: e.pointerId,
      ox: e.clientX - r.left,
      oy: e.clientY - r.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: 0,
    };
    fab.classList.add('dragging');
  });

  fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    // Prefer distance from start (Firefox movementX/Y is often noisy / zero).
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    drag.moved = Math.max(drag.moved, dist);
    if (dist < MOVE_TOLERANCE) return;
    const left = e.clientX - drag.ox;
    const top = e.clientY - drag.oy;
    const maxL = vw() - FAB_SIZE - FAB_MARGIN;
    const maxT = vh() - FAB_SIZE - FAB_MARGIN;
    applyFabPixels(
      Math.min(Math.max(FAB_MARGIN, left), maxL),
      Math.min(Math.max(FAB_MARGIN, top), maxT),
      false
    );
    if (panel.classList.contains('open')) positionPanel();
    positionRecStop();
  });

  let suppressFabClickUntil = 0;
  function endDrag(e) {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.pid)) return;
    const moved = drag.moved;
    if (e && e.pointerId != null) {
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
    }
    fab.classList.remove('dragging');
    const r = fab.getBoundingClientRect();
    const left = r.left;
    const top = r.top;
    drag = null;
    suppressFabClickUntil = Date.now() + 450;
    if (moved >= MOVE_TOLERANCE) {
      const s = snapCornerFromPosition(left, top);
      animateSnapTo(s.left, s.top);
      persistPos(s.left, s.top);
      setPanelTransformOrigin();
    } else {
      fab.style.setProperty('--fab-transform', 'none');
      const wasOpen = panel.classList.contains('open');
      setPanelOpen(!wasOpen);
      if (!wasOpen) refreshAll();
    }
  }

  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  // Fallback when pointer capture / pointerup is swallowed (seen on some Firefox builds).
  fab.addEventListener('click', (e) => {
    if (Date.now() < suppressFabClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    dismissStaleOverlays();
    const wasOpen = panel.classList.contains('open');
    setPanelOpen(!wasOpen);
    if (!wasOpen) refreshAll();
  });

  closeBtn.addEventListener('click', () => setPanelOpen(false));

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') dismissStaleOverlays();
    },
    { capture: true, signal }
  );

  let panelResizeObserver = null;
  try {
    panelResizeObserver = new ResizeObserver(() => {
      if (panel.classList.contains('open')) positionPanel();
    });
    panelResizeObserver.observe(panel);
  } catch (_) {
    panelResizeObserver = null;
  }
  window.addEventListener(
    'resize',
    () => {
      const s = cornerCoords(corner);
      applyFabPixels(s.left, s.top, true);
      if (panel.classList.contains('open')) positionPanel();
      positionRecStop();
    },
    { passive: true, signal }
  );

  function refreshAll() {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const hasPath = !!(response.userDownloadPath || '').trim();
      if (fabPath) {
        if (response.userDownloadPath) {
          const short =
            response.userDownloadPath.length > 40
              ? response.userDownloadPath.slice(0, 38) + '…'
              : response.userDownloadPath;
          fabPath.textContent = `Saves to: ${short}`;
          fabPath.classList.remove('bad');
        } else {
          fabPath.textContent = 'No save folder yet. Pick one in Settings.';
          fabPath.classList.add('bad');
        }
      }
      const streams = response.streams || [];
      _fabStreamsSig = fabStreamsSignature(streams);
      renderJobs(response.jobs || [], response);
      renderStreams(streams, response.pageTitle || '', hasPath);
      renderImages(hasPath);
      updateQueueBadge(response);
      if (panel.classList.contains('open')) positionPanel();
    });
  }

  function refreshStreamsIfChanged() {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const streams = response.streams || [];
      const sig = fabStreamsSignature(streams);
      if (sig === _fabStreamsSig) {
        renderJobs(response.jobs || [], response);
        updateQueueBadge(response);
        return;
      }
      _fabStreamsSig = sig;
      const hasPath = !!(response.userDownloadPath || '').trim();
      if (fabPath) {
        if (response.userDownloadPath) {
          const short =
            response.userDownloadPath.length > 40
              ? response.userDownloadPath.slice(0, 38) + '…'
              : response.userDownloadPath;
          fabPath.textContent = `Saves to: ${short}`;
          fabPath.classList.remove('bad');
        } else {
          fabPath.textContent = 'No save folder yet. Pick one in Settings.';
          fabPath.classList.add('bad');
        }
      }
      renderJobs(response.jobs || [], response);
      renderStreams(streams, response.pageTitle || '', hasPath);
      renderImages(hasPath);
      updateQueueBadge(response);
      if (panel.classList.contains('open')) positionPanel();
    });
  }

  /** Frequent job progress writes; avoid re-building stream inputs (focus + edited titles). */
  function refreshPanelJobsOnly() {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      renderJobs(response.jobs || [], response);
      updateQueueBadge(response);
      if (panel.classList.contains('open')) positionPanel();
    });
  }
  function renderJobs(jobs, meta) {
    fabJobs.textContent = '';
    const list = jobs.filter((j) => j && j.id);
    if (list.length === 0) return;

    const metaEl = document.createElement('div');
    metaEl.className = 'queue-line';
    const r = meta?.running ?? 0;
    const q = meta?.queueLength ?? 0;
    const m = meta?.maxParallel ?? 4;
    let line = `${r} of ${m} downloading`;
    if (q > 0) line += ` · ${q} queued`;
    metaEl.textContent = line;
    fabJobs.appendChild(metaEl);

    for (const job of list) {
      const card = document.createElement('div');
      card.className = 'job-mini';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = `${job.label || 'video'} (${job.status || ''})`;
      const d = document.createElement('div');
      d.className = 'd';
      if (job.status === 'error') {
        d.classList.add('err');
        d.textContent = job.error || '';
      } else if (job.status === 'canceled') {
        d.textContent = job.error || 'Canceled';
      } else {
        let detail = job.detail || job.error || '';
        if (job.mediaId && !String(detail).includes(String(job.mediaId))) {
          detail = detail ? `${detail} · ${job.mediaId}` : String(job.mediaId);
        }
        if (job.ffmpegPreset && ['queued', 'connecting', 'downloading'].includes(job.status)) {
          detail = detail ? `${detail} · preset ${job.ffmpegPreset}` : `preset ${job.ffmpegPreset}`;
        }
        d.textContent = detail;
      }
      card.appendChild(t);
      card.appendChild(d);
      if (['queued', 'connecting', 'downloading'].includes(job.status)) {
        const track = document.createElement('div');
        track.className = 'job-progress';
        const fill = document.createElement('div');
        fill.className = 'job-progress-fill';
        const pct = job.percent != null ? Number(job.percent) : NaN;
        if (Number.isFinite(pct)) {
          fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        } else {
          fill.classList.add('is-indeterminate');
        }
        track.appendChild(fill);
        card.appendChild(track);
        if (job.playlistIndex != null && job.playlistCount != null) {
          const pl = document.createElement('div');
          pl.className = 'job-playlist';
          pl.textContent = `Item ${job.playlistIndex}/${job.playlistCount}${
            job.mediaId ? ` · ${job.mediaId}` : ''
          }`;
          card.appendChild(pl);
        }
      }
      if (typeof HLS_FFMPEG !== 'undefined' && HLS_FFMPEG.enhanceJobCard) {
        HLS_FFMPEG.enhanceJobCard(job, card, { onRefresh: refreshPanelJobsOnly });
      }
      const row = document.createElement('div');
      row.className = 'row-btns';
      if (['queued', 'connecting', 'downloading'].includes(job.status)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-dan';
        b.textContent = 'Cancel';
        b.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', jobId: job.id }, refreshPanelJobsOnly)
        );
        row.appendChild(b);
      } else if (['completed', 'canceled', 'error'].includes(job.status)) {
        if (job.status === 'completed' && job.outputPath) {
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'btn btn-pri';
          openBtn.textContent = 'Open';
          openBtn.title = 'Open this file in a new browser tab';
          openBtn.addEventListener('click', () => {
            openBtn.disabled = true;
            chrome.runtime.sendMessage({ type: 'OPEN_JOB_FILE', jobId: job.id }, (r) => {
              openBtn.disabled = false;
              if (chrome.runtime.lastError || !r?.ok) {
                window.alert(
                  chrome.runtime.lastError?.message || r?.error || 'Could not open file'
                );
              }
            });
          });
          row.appendChild(openBtn);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost';
        b.textContent = 'Dismiss';
        b.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'DISMISS_JOB', jobId: job.id }, refreshPanelJobsOnly)
        );
        row.appendChild(b);
      }
      if (row.childElementCount) card.appendChild(row);
      fabJobs.appendChild(card);
    }

    const clr = document.createElement('div');
    clr.className = 'row-btns';
    const cbtn = document.createElement('button');
    cbtn.type = 'button';
    cbtn.className = 'btn btn-ghost';
    cbtn.textContent = 'Clear finished';
    cbtn.addEventListener('click', () =>
      chrome.runtime.sendMessage({ type: 'DISMISS_DONE' }, refreshPanelJobsOnly)
    );
    clr.appendChild(cbtn);
    fabJobs.appendChild(clr);
  }

  function fabStreamUrlSource(stream) {
    if (!stream) return 'traffic';
    if (stream.pageDownload === true) {
      return stream.urlSource === 'tab' ? 'tab' : 'link';
    }
    return 'traffic';
  }

  function fabSourceSectionLabel(src, count) {
    if (src === 'tab') return 'This page';
    if (src === 'link') {
      const n = typeof count === 'number' ? count : null;
      return n != null ? `From page links (${n})` : 'From page links';
    }
    return 'From network';
  }

  function fabStreamSourceBadge(stream, kind) {
    const src = fabStreamUrlSource(stream);
    if (src === 'link') return { text: 'page link', mod: 'link' };
    if (src === 'tab') return { text: kind === 'yt' ? 'yt page' : 'this page', mod: 'tab' };
    return { text: kind || 'stream', mod: 'traffic' };
  }

  function askFabThumbnailsForAll(count, onDone) {
    if (window.HGR_THEME && typeof window.HGR_THEME.showBatchThumbnailPrompt === 'function') {
      // Page-level sheet so it matches quality / ffmpeg dialogs. Mount on
      // <html>: the floater host follows <body>, so a body-mounted sheet
      // would stack behind the floating panel.
      window.HGR_THEME.showBatchThumbnailPrompt(
        count,
        onDone,
        document.documentElement || document.body
      );
      return;
    }
    onDone(null);
  }

  function queueFabPageLinkBatch(items, opts, onDone) {
    const writeThumbnail = !!(opts && opts.writeThumbnail);
    const tabUrl = window.location.href || '';
    const isHttpUrl = (x) => x && (x.startsWith('http:') || x.startsWith('https:'));
    let left = items.length;
    let queued = 0;
    let failed = 0;
    if (!items.length) {
      if (onDone) onDone(0, 0);
      return;
    }
    const doneOne = () => {
      left -= 1;
      if (left <= 0 && onDone) onDone(queued, failed);
    };
    items.forEach((item) => {
      const url = item.url;
      const kind = item.kind || 'social';
      const filename = item.filename || 'video';
      const jobId = genJobId();
      // Each link is its own download target. Tab URL is only the referer.
      let effUrl = url;
      let effPage = url;
      let effRef = isHttpUrl(tabUrl) ? tabUrl : url;
      let effOrigin = '';
      try {
        effOrigin = new URL(effUrl || url).origin;
      } catch (_) {}
      if (/music\.apple\.com/i.test(url)) {
        effUrl = url;
        effPage = url;
        effRef = url;
        try {
          effOrigin = new URL(url).origin;
        } catch (_) {}
      }
      const payload = {
        jobId,
        url: effUrl,
        filename,
        streamKind: kind || undefined,
        capturedHeaders: item.capturedHeaders || {},
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      };
      if (effPage && isHttpUrl(effPage)) {
        payload.pageUrl = effPage;
        payload.referer = effRef || effPage;
        if (effOrigin) payload.origin = effOrigin;
      }
      if (/music\.apple\.com/i.test(effUrl || '')) {
        payload.ytDlpAudioOnly = true;
        payload.streamKind = 'social';
      }
      if (writeThumbnail) payload.ytDlpWriteThumbnail = true;
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload }, (r) => {
        if (chrome.runtime.lastError || !r?.ok) failed += 1;
        else queued += 1;
        doneOne();
      });
    });
  }

  function fabMakeExpandableUrl(url, className, maxLen) {
    const api = (typeof HGR_THEME !== 'undefined' && HGR_THEME.createExpandableUrl)
      || (window.HGR_THEME && window.HGR_THEME.createExpandableUrl);
    if (typeof api === 'function') {
      return api(url, { className: className || 'url-expand', maxLen: maxLen || 72 });
    }
    const wrap = document.createElement('div');
    wrap.className = className || 'url-expand';
    const text = document.createElement('div');
    text.className = 'url-expand-text';
    text.textContent = String(url || '');
    wrap.appendChild(text);
    return {
      el: wrap,
      textEl: text,
      getUrl: () => String(url || ''),
      setUrl(next) {
        text.textContent = String(next || '');
      },
    };
  }

  /** Reloading the extension orphans this script until the page reloads. */
  function fabShowStaleNotice() {
    const scroll = shadow.querySelector('.panel-scroll');
    if (!scroll || rootById(shadow, 'fab-stale')) return;
    const box = document.createElement('div');
    box.id = 'fab-stale';
    box.className = 'status err';
    box.textContent = 'Stuff Grabber was updated. Reload this page to keep using the floater.';
    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'btn btn-pri';
    reloadBtn.textContent = 'Reload page';
    reloadBtn.style.marginTop = '8px';
    reloadBtn.addEventListener('click', () => location.reload());
    box.appendChild(document.createElement('br'));
    box.appendChild(reloadBtn);
    scroll.insertBefore(box, scroll.firstChild);
  }

  function renderStreams(streams, pageTitle, hasPath) {
    fabStreams.textContent = '';
    if (!streams.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const strong = document.createElement('strong');
      strong.textContent = 'No streams yet';
      empty.appendChild(strong);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(document.createTextNode('Start playback, then open this panel.'));
      fabStreams.appendChild(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'stream-list';
    fabStreams.appendChild(list);
    const n = streams.length;
    const sourceTypes = new Set(streams.map((s) => fabStreamUrlSource(typeof s === 'string' ? { url: s } : s)));
    const linkStreamEntries = streams
      .map((raw, i) => {
        const stream = typeof raw === 'string' ? { url: raw } : raw;
        return { stream, i };
      })
      .filter(({ stream }) => stream.pageDownload === true && fabStreamUrlSource(stream) === 'link');
    const linkCount = linkStreamEntries.length;
    const showSourceSections = sourceTypes.size > 1 || linkCount > 0;
    let lastSource = '';
    /** @type {HTMLElement | null} */
    let linkGrid = null;
    /** @type {HTMLButtonElement | null} */
    let getAllBtn = null;

    streams.forEach((raw, i) => {
      const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
      const cleanedUrl = stream.cleanedUrl || '';
      const kind = stream.streamKind ? String(stream.streamKind) : '';
      const pageOnly = stream.pageDownload === true;
      const urlSource = fabStreamUrlSource(stream);
      // Page links: always cleaned. Only the main tab item can opt into cleaning.
      let url =
        urlSource === 'link' && cleanedUrl
          ? cleanedUrl
          : stream.url || '';
      const defaultName = defaultFileName(i, n, pageTitle, url);
      const isAppleMusicPage = /music\.apple\.com/i.test(String(url || ''));
      const isLinkCard = pageOnly && urlSource === 'link';

      if (showSourceSections && urlSource !== lastSource) {
        lastSource = urlSource;
        if (urlSource === 'link') {
          const sec = document.createElement('div');
          sec.className = 'stream-source-row';
          const lab = document.createElement('div');
          lab.className = 'stream-source-label';
          lab.textContent = fabSourceSectionLabel('link', linkCount);
          getAllBtn = document.createElement('button');
          getAllBtn.type = 'button';
          getAllBtn.className = 'get-all-links-btn';
          getAllBtn.textContent = 'Get all';
          if (!hasPath) {
            getAllBtn.disabled = true;
            getAllBtn.title = 'Add a save folder in Options first';
          } else {
            getAllBtn.title = `Queue all ${linkCount} page links (up to 4 download at once)`;
          }
          getAllBtn.addEventListener('click', () => {
            if (!hasPath) {
              chrome.runtime.openOptionsPage();
              return;
            }
            if (!linkCount || !getAllBtn) return;
            askFabThumbnailsForAll(linkCount, (choice) => {
              if (choice === null) {
                getAllBtn.disabled = false;
                getAllBtn.textContent = 'Get all';
                return;
              }
              getAllBtn.disabled = true;
              getAllBtn.textContent = 'Queueing…';
              const items = linkStreamEntries.map(({ stream: s, i: idx }) => {
                const cleaned = s.cleanedUrl || '';
                const u = cleaned || s.url || '';
                return {
                  url: u,
                  kind: s.streamKind ? String(s.streamKind) : 'social',
                  filename: defaultFileName(idx, n, pageTitle, u),
                  capturedHeaders: s.capturedHeaders || {},
                };
              });
              queueFabPageLinkBatch(items, { writeThumbnail: choice === true }, (queued, failed) => {
                getAllBtn.disabled = false;
                getAllBtn.textContent =
                  failed > 0 ? `Queued ${queued} (${failed} failed)` : `Queued ${queued}`;
                setTimeout(() => {
                  if (getAllBtn) getAllBtn.textContent = 'Get all';
                }, 2400);
                refreshPanelJobsOnly();
              });
            });
          });
          sec.appendChild(lab);
          sec.appendChild(getAllBtn);
          list.appendChild(sec);
          linkGrid = null;
        } else {
          const sec = document.createElement('div');
          sec.className = 'stream-source-label';
          sec.textContent = fabSourceSectionLabel(urlSource);
          list.appendChild(sec);
          linkGrid = null;
        }
      }

      const card = document.createElement('div');
      card.dataset.urlSource = urlSource;

      const input = document.createElement('input');
      input.className = 'filename-input';
      input.type = 'text';
      input.id = `fab-name-${i}`;
      input.value = defaultName;
      input.setAttribute('placeholder', 'e.g. My video');
      if (!hasPath) input.readOnly = true;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-btn';
      btn.id = `fab-btn-${i}`;
      if (!hasPath) {
        btn.disabled = true;
        btn.title = 'Add a save folder in Options first';
      }
      btn.textContent = isLinkCard ? 'Download' : pageOnly ? 'Download this' : 'Download';
      btn.addEventListener('click', () => {
        if (!extAlive()) {
          fabShowStaleNotice();
          return;
        }
        if (!hasPath) {
          chrome.runtime.openOptionsPage();
          return;
        }
        const filename = input.value.trim() || defaultName;
        const jobId = genJobId();
        btn.disabled = true;
        const YT = typeof window !== 'undefined' ? window.HLS_YT : null;
        const tabUrl = window.location.href || '';
        const isHttpUrl = (x) => x && (x.startsWith('http:') || x.startsWith('https:'));

        const resetFabDlBtn = () => {
          btn.disabled = false;
          btn.textContent = isLinkCard ? 'Download' : pageOnly ? 'Download this' : 'Download';
        };

        const startCookieAndDl = (plPick) => {
          let effUrl = url;
          let effPage = '';
          let effRef = '';
          let effOrigin = '';
          let plDl = false;
          if (isLinkCard) {
            // Page-link row: download THIS link, not the tab feed/playlist page.
            effUrl = url;
            effPage = url;
            effRef = isHttpUrl(tabUrl) ? tabUrl : url;
            try {
              effOrigin = new URL(effUrl).origin;
            } catch (_) {}
          } else if (isHttpUrl(tabUrl)) {
            effPage = tabUrl;
            effRef = tabUrl;
            try {
              effOrigin = new URL(tabUrl).origin;
            } catch (_) {}
          }
          if (!isLinkCard && pageOnly && kind === 'yt' && YT && YT.isYoutubePage(tabUrl)) {
            const yChoice = plPick === 'playlist' ? 'playlist' : 'single';
            const a = YT.applyYoutubeChoice(tabUrl, yChoice);
            effUrl = a.targetUrl;
            effPage = a.pageUrl;
            effRef = a.referer;
            effOrigin = a.origin || effOrigin;
            plDl = !!a.ytDlpDownloadPlaylist;
          } else if (!isLinkCard && pageOnly && /music\.apple\.com/i.test(tabUrl || url || '')) {
            // Always send the Apple Music song page URL — never a CDN m3u8.
            const appleUrl = /music\.apple\.com/i.test(tabUrl || '') ? tabUrl : url;
            effUrl = appleUrl;
            effPage = appleUrl;
            effRef = appleUrl;
            try {
              effOrigin = new URL(appleUrl).origin;
            } catch (_) {}
          } else if (!isLinkCard && !isHttpUrl(tabUrl)) {
            effPage = effUrl;
            effRef = effUrl;
            try {
              effOrigin = new URL(effUrl).origin;
            } catch (_) {}
          }

          const payload = {
            jobId,
            url: effUrl,
            filename,
            streamKind: kind || undefined,
            capturedHeaders: stream.capturedHeaders || {},
          };
          if (typeof navigator !== 'undefined' && navigator.userAgent) {
            payload.userAgent = navigator.userAgent;
          }
          if (effPage && isHttpUrl(effPage)) {
            payload.pageUrl = effPage;
            payload.referer = effRef || effPage;
            if (effOrigin) payload.origin = effOrigin;
          }
          if (plDl) payload.ytDlpDownloadPlaylist = true;
          if (pageOnly && /music\.apple\.com/i.test(effUrl || '')) {
            payload.ytDlpAudioOnly = true;
            payload.streamKind = 'social';
          }

          const probePayload = {
            url: payload.url,
            cookie: payload.cookie,
            userAgent: payload.userAgent,
            capturedHeaders: payload.capturedHeaders,
            pageUrl: payload.pageUrl,
            referer: payload.referer,
            origin: payload.origin,
          };

          const buildFinalPayload = (ytFmt, ffmpegPreset, extra = {}) => {
            const finalPayload = { ...payload, ...extra };
            if (ytFmt) finalPayload.ytDlpFormat = ytFmt;
            if (ffmpegPreset) finalPayload.ffmpegPreset = ffmpegPreset;
            if (pageOnly) {
              const tel = rootById(shadow, `fab-thumb-${i}`);
              if (tel && tel.checked) finalPayload.ytDlpWriteThumbnail = true;
            }
            return finalPayload;
          };

          const sendDownload = (finalPayload, onResult) => {
            let settled = false;
            const done = (r) => {
              if (settled) return;
              settled = true;
              resetFabDlBtn();
              refreshPanelJobsOnly();
              if (chrome.runtime.lastError || !r?.ok) {
                console.warn('Stuff Grabber fab:', chrome.runtime.lastError || r?.error);
              }
              if (onResult) onResult(r);
            };
            // Firefox sometimes never invokes the callback — don't leave the button stuck.
            const safety = setTimeout(() => done({ ok: false, error: 'timeout' }), 20000);
            try {
              chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: finalPayload }, (r) => {
                clearTimeout(safety);
                done(r || { ok: false });
              });
            } catch (err) {
              clearTimeout(safety);
              done({ ok: false, error: String(err && err.message ? err.message : err) });
            }
          };

          const finishDl = (ytFmt, ffmpegPreset, extra) => {
            sendDownload(buildFinalPayload(ytFmt, ffmpegPreset, extra));
          };

          maybeAskYtdlpFormat(kind, probePayload, (ytFmt) => {
            const ffProbe = { ...probePayload, streamKind: kind };
            const ffCtx = {
              filename,
              ext: '.mp4',
              onStart: (preset, cb) => {
                if (preset == null) {
                  finishDl(ytFmt, null);
                  if (cb) cb(null, null);
                  return;
                }
                sendDownload(buildFinalPayload(ytFmt, preset), (r) => {
                  if (!r?.ok) {
                    if (cb) cb(r?.error || 'Could not start', null);
                    return;
                  }
                  if (cb) cb(null, r.jobId);
                });
              },
              onSwitch: ({ jobId, preset, deleteFile }, cb) => {
                chrome.runtime.sendMessage(
                  {
                    type: 'SWITCH_FFMPEG_PRESET',
                    jobId,
                    newPreset: preset,
                    deleteFile,
                    payload: buildFinalPayload(ytFmt, preset),
                  },
                  (r) => {
                    if (chrome.runtime.lastError || !r?.ok) {
                      if (cb) cb(chrome.runtime.lastError?.message || r?.error || 'Switch failed', null);
                      return;
                    }
                    refreshPanelJobsOnly();
                    if (cb) cb(null, r.jobId);
                  }
                );
              },
              getJobOutputPath: () => '',
            };
            const askFf =
              typeof HLS_FFMPEG !== 'undefined' && HLS_FFMPEG.maybeAskFfmpegPreset
                ? HLS_FFMPEG.maybeAskFfmpegPreset.bind(HLS_FFMPEG)
                : (_k, _p, ctx) => ctx.onStart(null, () => {});
            askFf(kind, ffProbe, ffCtx, () => {
              resetFabDlBtn();
              refreshPanelJobsOnly();
            });
          }, () => {
            resetFabDlBtn();
            refreshPanelJobsOnly();
          });
        };

        if (pageOnly && kind === 'yt' && YT && YT.isYoutubePage(tabUrl)) {
          const hints = YT.playlistHints(tabUrl);
          if (hints.shouldAskPlaylist) {
            YT.showPlaylistPrompt(tabUrl, hints, (pick) => {
              if (pick === null) {
                resetFabDlBtn();
                return;
              }
              startCookieAndDl(pick);
            });
            return;
          }
        }
        startCookieAndDl('single');
      });

      if (isLinkCard) {
        card.className = 'stream-item stream-item--link';
        const main = document.createElement('div');
        main.className = 'link-card-main';
        const titleRow = document.createElement('div');
        titleRow.className = 'link-card-title-row';
        const badge = document.createElement('span');
        badge.className = 'stream-kind-badge stream-kind-badge--link';
        badge.textContent = 'page link';
        titleRow.appendChild(badge);
        titleRow.appendChild(input);
        const urlView = fabMakeExpandableUrl(url, 'url-expand link-card-url', 56);
        main.appendChild(titleRow);
        main.appendChild(urlView.el);
        const thumbLab = document.createElement('label');
        thumbLab.className = 'stream-thumb-label link-card-thumb';
        const tcb = document.createElement('input');
        tcb.type = 'checkbox';
        tcb.id = `fab-thumb-${i}`;
        thumbLab.appendChild(tcb);
        const tsp = document.createElement('span');
        tsp.textContent = 'Also save thumbnail';
        thumbLab.appendChild(tsp);
        main.appendChild(thumbLab);
        card.appendChild(main);
        card.appendChild(btn);
        if (!linkGrid) {
          linkGrid = document.createElement('div');
          linkGrid.className = 'link-stream-grid';
          list.appendChild(linkGrid);
        }
        linkGrid.appendChild(card);
      } else {
        linkGrid = null;
        card.className = 'stream-item';
        const top = document.createElement('div');
        top.className = 'stream-top';
        const h = document.createElement('div');
        h.className = 'stream-label';
        h.textContent = pageOnly
          ? isAppleMusicPage
            ? 'Download this track'
            : 'Download this video'
          : n > 1
            ? `Stream ${i + 1} of ${n}` + (kind ? ` (${kind})` : '')
            : kind
              ? `Stream (${kind})`
              : 'Stream';
        const badgeInfo = fabStreamSourceBadge(stream, kind);
        const badge = document.createElement('span');
        badge.className = `stream-kind-badge stream-kind-badge--${badgeInfo.mod}`;
        badge.textContent = badgeInfo.text;
        top.appendChild(h);
        top.appendChild(badge);

        const urlEl = document.createElement('div');
        urlEl.className = 'stream-url';
        const urlView = fabMakeExpandableUrl(url, 'url-expand stream-page-link', 80);
        if (pageOnly) {
          const intro = document.createElement('div');
          intro.className = 'stream-page-intro';
          intro.textContent = isAppleMusicPage
            ? 'Apple Music: yt-dlp uses the song page URL below (not the FairPlay m3u8 stream).'
            : 'This tab’s post URL. Playlist bits stay on. Tap Clean URL if you want tracking junk removed.';
          urlEl.appendChild(intro);
          urlEl.appendChild(urlView.el);
          if (urlSource === 'tab' && cleanedUrl && cleanedUrl !== url) {
            const cleanBtn = document.createElement('button');
            cleanBtn.type = 'button';
            cleanBtn.className = 'url-clean-btn';
            cleanBtn.textContent = 'Clean URL';
            cleanBtn.title = 'Strip tracking junk (keeps playlist list= / video id)';
            cleanBtn.addEventListener('click', () => {
              url = cleanedUrl;
              urlView.setUrl(url);
              cleanBtn.disabled = true;
              cleanBtn.textContent = 'Cleaned';
            });
            urlEl.appendChild(cleanBtn);
          }
        } else {
          urlEl.appendChild(urlView.el);
        }

        const field = document.createElement('div');
        field.className = 'field';
        const lab = document.createElement('label');
        lab.setAttribute('for', `fab-name-${i}`);
        lab.textContent = kind === 'subtitle' ? 'File name (no .vtt)' : 'File name (no .mp4)';
        const row = document.createElement('div');
        row.className = 'row';
        row.appendChild(input);
        row.appendChild(btn);
        field.appendChild(lab);
        field.appendChild(row);
        if (pageOnly) {
          const thumbLab = document.createElement('label');
          thumbLab.className = 'stream-thumb-label';
          const tcb = document.createElement('input');
          tcb.type = 'checkbox';
          tcb.id = `fab-thumb-${i}`;
          thumbLab.appendChild(tcb);
          const tsp = document.createElement('span');
          tsp.textContent = 'Also save thumbnail (jpg next to the video)';
          thumbLab.appendChild(tsp);
          field.appendChild(thumbLab);
        }
        card.appendChild(top);
        card.appendChild(urlEl);
        card.appendChild(field);
        list.appendChild(card);
      }
    });
  }

  function fabMakeImgExpandableUrl(url) {
    const display = String(url || '').startsWith('data:') ? 'data:image' : url;
    return fabMakeExpandableUrl(display, 'url-expand img-url', 48);
  }

  const IMAGE_SCOPE_KEY = 'imageListScope';
  const IMAGE_GRABBER_KEY = 'imageHoverDownloadEnabled';

  function clearFabImages() {
    if (!fabImages) return;
    fabImages.textContent = '';
  }

  function readImageListScope(cb) {
    chrome.storage.local.get([IMAGE_SCOPE_KEY], (data) => {
      if (chrome.runtime.lastError) {
        cb('page');
        return;
      }
      const scope = data && data[IMAGE_SCOPE_KEY] === 'visible' ? 'visible' : 'page';
      cb(scope);
    });
  }

  function renderImages(hasPath, preferredScope) {
    if (!fabImages) return;
    chrome.storage.local.get([IMAGE_GRABBER_KEY], (cfg) => {
      if (chrome.runtime.lastError || cfg[IMAGE_GRABBER_KEY] !== true) {
        clearFabImages();
        return;
      }
      renderImagesEnabled(hasPath, preferredScope);
    });
  }

  function renderImagesEnabled(hasPath, preferredScope) {
    if (!fabImages) return;
    const api = typeof window !== 'undefined' ? window.HLS_IMAGE_DL : null;
    if (!api || typeof api.listImages !== 'function' || typeof api.downloadUrlAs !== 'function') {
      clearFabImages();
      return;
    }

    const finish = (scope) => {
      const listScope = scope === 'visible' ? 'visible' : 'page';
      fabImages.textContent = '';

      let imgs = [];
      try {
        if (typeof api.refreshScan === 'function') api.refreshScan();
        imgs = api.listImages({ scope: listScope }) || [];
      } catch (_) {
        imgs = [];
      }

      const head = document.createElement('div');
      head.className = 'img-section-head';

      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = imgs.length ? `Images · ${imgs.length}` : 'Images';

      const tools = document.createElement('div');
      tools.className = 'img-section-tools';

      const scopeSel = document.createElement('select');
      scopeSel.className = 'img-scope-select';
      scopeSel.setAttribute('aria-label', 'Image scan range');
      [
        ['page', 'Full page'],
        ['visible', 'Visible area'],
      ].forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        scopeSel.appendChild(opt);
      });
      scopeSel.value = listScope;

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'btn btn-pri img-refresh-btn';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.title = 'Scan again using the selected range';

      const zipBtn = document.createElement('button');
      zipBtn.type = 'button';
      zipBtn.className = 'btn btn-pri img-zip-btn';
      zipBtn.textContent = 'Download all';
      zipBtn.disabled = !imgs.length;
      zipBtn.title = imgs.length
        ? 'Save every listed image in one ZIP'
        : 'No images to zip yet';

      const runRefresh = (nextScope) => {
        const useScope = nextScope === 'visible' ? 'visible' : 'page';
        chrome.storage.local.set({ [IMAGE_SCOPE_KEY]: useScope }, () => {
          refreshBtn.disabled = true;
          refreshBtn.textContent = 'Scanning…';
          try {
            if (typeof api.refreshScan === 'function') api.refreshScan();
          } catch (_) {
            // ignore
          }
          window.requestAnimationFrame(() => {
            renderImages(hasPath, useScope);
            if (panel.classList.contains('open')) positionPanel();
          });
        });
      };

      scopeSel.addEventListener('change', () => {
        runRefresh(scopeSel.value);
      });
      refreshBtn.addEventListener('click', () => {
        runRefresh(scopeSel.value);
      });
      zipBtn.addEventListener('click', () => {
        if (!imgs.length) return;
        zipBtn.disabled = true;
        zipBtn.textContent = 'Zipping…';
        chrome.runtime.sendMessage(
          { type: 'DOWNLOAD_IMAGES_ZIP', images: imgs },
          (res) => {
            zipBtn.disabled = false;
            zipBtn.textContent = 'Download all';
            if (chrome.runtime.lastError || !res?.ok) {
              window.alert(
                chrome.runtime.lastError?.message || res?.error || 'Could not create ZIP'
              );
              return;
            }
            if (res.failed) {
              window.alert(
                `Saved ZIP with ${res.count} image(s). ${res.failed} could not be fetched.`
              );
            }
          }
        );
      });

      tools.appendChild(scopeSel);
      tools.appendChild(refreshBtn);
      tools.appendChild(zipBtn);
      if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
        HLS_IOS_SELECT.enhance(scopeSel, { compact: true });
      }

      head.appendChild(label);
      head.appendChild(tools);
      fabImages.appendChild(head);

      if (!imgs.length) {
        const empty = document.createElement('div');
        empty.className = 'img-empty';
        empty.textContent =
          listScope === 'visible'
            ? 'No images in view. Scroll, or switch to Full page, then Refresh.'
            : 'No images found on this page yet. Tap Refresh after more load in.';
        fabImages.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'img-list';

      imgs.forEach((img, idx) => {
        const card = document.createElement('div');
        card.className = 'img-card';

        const thumb = document.createElement('img');
        thumb.className = 'img-thumb';
        thumb.src = img.url;
        thumb.alt = img.alt || '';
        thumb.referrerPolicy = 'no-referrer';
        thumb.loading = 'lazy';

        const body = document.createElement('div');
        body.className = 'img-body';

        const meta = document.createElement('div');
        meta.className = 'img-meta';
        const title = document.createElement('div');
        title.className = 'img-title';
        const dim = img.w && img.h ? `${img.w}×${img.h}` : '';
        const name = (img.alt && img.alt.trim()) || `Image ${idx + 1}`;
        title.textContent = dim ? `${name} · ${dim}` : name;
        title.title = name;
        const urlView = fabMakeImgExpandableUrl(img.url);
        meta.appendChild(title);
        meta.appendChild(urlView.el);

        const actions = document.createElement('div');
        actions.className = 'img-actions';

        const sel = document.createElement('select');
        sel.className = 'img-fmt-select';
        sel.setAttribute('aria-label', 'Format');
        [
          ['png', 'PNG'],
          ['jpg', 'JPG'],
          ['jpeg', 'JPEG'],
          ['webp', 'WEBP'],
        ].forEach(([value, text]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          sel.appendChild(opt);
        });

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-pri';
        btn.textContent = 'Save';
        // Image saves use the browser Downloads API — no helper folder required.
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = '…';
          const stem = (img.alt && img.alt.trim()) || `image_${idx + 1}`;
          Promise.resolve(api.downloadUrlAs(img.url, sel.value, stem))
            .catch(() => {})
            .finally(() => {
              btn.disabled = false;
              btn.textContent = 'Save';
            });
        });

        actions.appendChild(sel);
        actions.appendChild(btn);
        if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
          HLS_IOS_SELECT.enhance(sel, { compact: true });
        }

        body.appendChild(meta);
        body.appendChild(actions);
        card.appendChild(thumb);
        card.appendChild(body);
        list.appendChild(card);
      });

      fabImages.appendChild(list);
    };

    if (preferredScope === 'page' || preferredScope === 'visible') {
      finish(preferredScope);
      return;
    }
    readImageListScope(finish);
  }

  function onFabStorageChanged(changes, area) {
    if (area === 'local' && changes[IMAGE_GRABBER_KEY]) {
      if (changes[IMAGE_GRABBER_KEY].newValue === true) {
        if (panel.classList.contains('open')) refreshAll();
      } else {
        clearFabImages();
      }
      return;
    }
    if (area === 'local' && changes.userDownloadPath) {
      if (panel.classList.contains('open')) refreshAll();
      else refreshBadgeOnly();
      return;
    }
    if (area === 'session' && changes[STREAMS_REV_KEY]) {
      refreshBadgeOnly();
      if (panel.classList.contains('open')) refreshStreamsIfChanged();
      return;
    }
    if (area === 'session' && changes[JOBS_KEY]) {
      if (panel.classList.contains('open')) refreshPanelJobsOnly();
      else refreshBadgeOnly();
    }
  }
  try {
    chrome.storage.onChanged.addListener(onFabStorageChanged);
  } catch (_) {
    // Extension context invalidated
  }

  fabCtl.closePanel = () => setPanelOpen(false);
  fabCtl.openPanel = () => setPanelOpen(true);
  fabCtl.showBatchThumbPrompt = askFabThumbnailsForAll;
  fabCtl.runGetAllPageLinks = (items, count, onDone) => {
    const list = Array.isArray(items) ? items : [];
    const n = count || list.length;
    const finish = (result) => {
      if (typeof onDone === 'function') onDone(result);
    };
    if (!list.length) {
      finish({ ok: false, canceled: true, choice: null });
      return;
    }
    setPanelOpen(true);
    refreshAll();
    askFabThumbnailsForAll(n, (choice) => {
      if (choice === null) {
        // User canceled — close the float panel and tell the popup to stop.
        setPanelOpen(false);
        finish({ ok: false, canceled: true, choice: null });
        return;
      }
      queueFabPageLinkBatch(list, { writeThumbnail: choice === true }, (queued, failed) => {
        refreshPanelJobsOnly();
        finish({ ok: true, choice, queued, failed });
      });
    });
  };
  fabCtl.liveRefresh = (kind) => {
    refreshBadgeOnly();
    if (!panel.classList.contains('open')) return;
    if (kind === 'streams' || kind === 'all') refreshStreamsIfChanged();
    else refreshPanelJobsOnly();
  };

  host._hlsFabCleanup = () => {
    ac.abort();
    try {
      chrome.storage.onChanged.removeListener(onFabStorageChanged);
    } catch (_) {
      // ignore
    }
    if (typeof unbindFabTheme === 'function') unbindFabTheme();
    try {
      if (panelResizeObserver) panelResizeObserver.disconnect();
    } catch (_) {
      // ignore
    }
  };

  /* ── Record Video Elements (FAB) — uses HLS_IOS_SELECT like the rest of the app ── */
  const fabRecSection = rootById(shadow, 'fab-rec');
  const fabRecBtn = rootById(shadow, 'fab-rec-btn');
  const fabRecLabel = rootById(shadow, 'fab-rec-label');
  const fabRecStatus = rootById(shadow, 'fab-rec-status');
  const fabRecSelect = rootById(shadow, 'fab-rec-select');
  if (!fabRecStop) fabRecStop = rootById(shadow, 'fab-rec-stop');
  let fabIsRecording = false;
  let fabRecPoll = null;
  let fabVideos = [];
  let fabSelectedIndex = 0;
  let fabSelectEnhanced = false;

  function setFabRecordUiVisible(visible) {
    if (fabRecSection) fabRecSection.hidden = !visible;
    if (!visible) {
      if (fabRecStatus) fabRecStatus.textContent = '';
      fabVideos = [];
    }
  }

  function setFabRecStopVisible(visible) {
    if (!fabRecStop) return;
    fabRecStop.hidden = !visible;
    if (visible) {
      requestAnimationFrame(() => positionRecStop());
    }
  }

  function fabShortLabel(text, max) {
    const t = String(text || 'Video').trim();
    const n = max || 36;
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function ensureFabRecSelectEnhanced() {
    if (!fabRecSelect || fabSelectEnhanced) return;
    if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
      HLS_IOS_SELECT.enhance(fabRecSelect, { compact: true, className: 'rec-ios-select' });
      fabSelectEnhanced = true;
    }
  }

  function fillFabRecSelect() {
    if (!fabRecSelect) return;
    const prev = String(fabSelectedIndex);
    fabRecSelect.textContent = '';
    if (!fabVideos.length) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = 'No videos right now';
      fabRecSelect.appendChild(opt);
      fabRecSelect.disabled = true;
    } else {
      fabRecSelect.disabled = fabIsRecording;
      fabVideos.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = String(v.index);
        const n = fabVideos.length;
        if (n === 1) opt.textContent = '1 video on this page';
        else opt.textContent = `${v.index + 1}. ${fabShortLabel(v.label, 42)}`;
        fabRecSelect.appendChild(opt);
      });
      fabRecSelect.value = prev;
      if (fabRecSelect.selectedIndex < 0) fabRecSelect.selectedIndex = 0;
      fabSelectedIndex = Number(fabRecSelect.value) || 0;
    }
    ensureFabRecSelectEnhanced();
    try {
      fabRecSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      // ignore
    }
  }

  function applyFabVideoList(res) {
    fabVideos = Array.isArray(res && res.videos) ? res.videos : [];
    const pref = Number.isFinite(Number(res && res.preferredStartIndex))
      ? Number(res.preferredStartIndex)
      : fabSelectedIndex;
    fabSelectedIndex = fabVideos.length
      ? Math.max(0, Math.min(fabVideos.length - 1, pref | 0))
      : 0;
    fillFabRecSelect();
  }

  function setFabRecordingState(on, statusText) {
    fabIsRecording = !!on;
    if (fabRecBtn) fabRecBtn.classList.toggle('is-rec', fabIsRecording);
    if (fabRecLabel) fabRecLabel.textContent = fabIsRecording ? 'Stop' : 'Rec';
    if (fabRecSelect) fabRecSelect.disabled = fabIsRecording || !fabVideos.length;
    if (fabIsRecording && typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.closeAll) {
      try { HLS_IOS_SELECT.closeAll(); } catch (_) { /* ignore */ }
    }
    setFabRecStopVisible(fabIsRecording);
    if (typeof statusText === 'string' && fabRecStatus) fabRecStatus.textContent = statusText;
    if (fabIsRecording) {
      if (!fabRecPoll) fabRecPoll = setInterval(fabUpdateRecStatus, 1000);
    } else if (fabRecPoll) {
      clearInterval(fabRecPoll);
      fabRecPoll = null;
    }
  }

  function fabFormatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function fabSendRecorder(action, cb, arg) {
    // video-recorder.js shares this isolated world; call it directly.
    const api = window.HLS_VIDEO_REC;
    if (!api || typeof api[action] !== 'function') {
      cb({ ok: false, error: 'Recorder not ready' });
      return;
    }
    try {
      const res = arg !== undefined ? api[action](arg) : api[action]();
      cb(res || { ok: false });
    } catch (e) {
      cb({ ok: false, error: String((e && e.message) || e) });
    }
  }

  function fabStopRecording() {
    if (fabRecBtn) fabRecBtn.disabled = true;
    if (fabRecStop) fabRecStop.disabled = true;
    fabSendRecorder('stop', (res) => {
      if (fabRecBtn) fabRecBtn.disabled = false;
      if (fabRecStop) fabRecStop.disabled = false;
      const msg =
        res && res.ok && res.stopped
          ? `Saved ${res.stopped.length} recording${res.stopped.length > 1 ? 's' : ''}`
          : (res?.error || 'Stopped');
      setFabRecordingState(false, msg);
    });
  }

  function fabUpdateRecStatus() {
    fabSendRecorder('status', (res) => {
      if (!res || !res.recording) {
        if (fabIsRecording) setFabRecordingState(false, '');
        return;
      }
      if (!fabIsRecording) setFabRecordingState(true);
      const act = res.active || [];
      const total = res.total || res.queueTotal || act.length;
      const pos = res.position || 1;
      if (res.sequential && total > 1) {
        const a = act[0];
        const elapsed = a ? fabFormatElapsed(a.elapsed) : '';
        const label = a ? a.label : 'video';
        fabRecStatus.textContent = `${pos} of ${total}${elapsed ? ` · ${elapsed}` : ''} · ${label}`;
      } else {
        const lines = act.map((a) => `${a.label}: ${fabFormatElapsed(a.elapsed)}`);
        fabRecStatus.textContent = lines.join(', ') || 'Recording…';
      }
    });
  }

  function fabRecScan() {
    fabSendRecorder('scan', (res) => {
      if (!res || !res.ok) {
        setFabRecordUiVisible(false);
        setFabRecStopVisible(false);
        return;
      }
      applyFabVideoList(res);
      if (res.recording) {
        setFabRecordUiVisible(true);
        setFabRecordingState(true);
        fabUpdateRecStatus();
      } else if (res.count > 0) {
        setFabRecordUiVisible(true);
        setFabRecordingState(
          false,
          res.count === 1
            ? 'Found 1 video. Hit Rec when you’re ready, or open the list to peek at it.'
            : `Found ${res.count} videos. Pick which one to start with, then hit Rec.`
        );
      } else {
        setFabRecordUiVisible(false);
        setFabRecordingState(false);
      }
    });
  }

  if (fabRecSelect) {
    fabRecSelect.addEventListener('change', () => {
      const idx = Number(fabRecSelect.value);
      if (!Number.isFinite(idx)) return;
      fabSelectedIndex = idx;
      if (fabIsRecording) return;
      fabSendRecorder('focus', (res) => {
        if (!res || !res.ok) {
          if (fabRecStatus) {
            fabRecStatus.textContent = res?.error || 'Couldn’t find that video. Try again.';
          }
          return;
        }
        if (fabRecStatus) {
          fabRecStatus.textContent = `Got it. Brought you to “${fabShortLabel(res.label, 40)}”.`;
        }
      }, idx);
    });
  }

  if (fabRecBtn) {
    fabRecBtn.addEventListener('click', () => {
      if (fabIsRecording) {
        fabStopRecording();
      } else {
        fabRecBtn.disabled = true;
        if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.closeAll) {
          try { HLS_IOS_SELECT.closeAll(); } catch (_) { /* ignore */ }
        }
        fabSendRecorder('start', (res) => {
          fabRecBtn.disabled = false;
          if (res && res.ok) {
            let m;
            if (res.sequential && res.total > 1) {
              m =
                `Recording 1 of ${res.total}` +
                (res.remaining ? ` (${res.remaining} waiting in line)` : '');
            } else {
              const fail = (res.details || []).filter((d) => !d.ok);
              m = `Recording ${res.count} of ${res.total} video${res.total > 1 ? 's' : ''}`;
              if (fail.length) m += ` (${fail.length} skipped)`;
            }
            setFabRecordingState(true, m);
          } else {
            fabRecStatus.textContent = res?.error || 'No videos on this page right now.';
          }
        }, { startIndex: fabSelectedIndex });
      }
    });
  }

  if (fabRecStop) {
    fabRecStop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!fabIsRecording || fabRecStop.disabled) return;
      fabStopRecording();
    });
    fabRecStop.addEventListener('pointerdown', (e) => {
      // Don't let the FAB drag / open handlers steal this press.
      e.stopPropagation();
    });
  }

  // Recorder notifies us instantly (popup start, FAB start, auto-finish).
  function onHlsVideoRec(ev) {
    const d = (ev && ev.detail) || {};
    if (d.recording) {
      setFabRecordUiVisible(true);
      setFabRecordingState(true);
      fabUpdateRecStatus();
      return;
    }
    if (fabIsRecording) {
      setFabRecordingState(false, typeof d.message === 'string' ? d.message : '');
    }
  }
  window.addEventListener('hls-video-rec', onHlsVideoRec, { signal });

  function waitForRecorderThenScan(tries) {
    const left = typeof tries === 'number' ? tries : 40;
    if (window.HLS_VIDEO_REC && typeof window.HLS_VIDEO_REC.scan === 'function') {
      fabRecScan();
      return;
    }
    if (left <= 0) return;
    setTimeout(() => waitForRecorderThenScan(left - 1), 50);
  }

  // Light watchdog: catch recording started while FAB missed the event (rare).
  let fabRecWatch = setInterval(() => {
    if (!extAlive()) {
      clearInterval(fabRecWatch);
      fabRecWatch = null;
      return;
    }
    const api = window.HLS_VIDEO_REC;
    if (!api || typeof api.status !== 'function') return;
    let st;
    try {
      st = api.status();
    } catch (_) {
      return;
    }
    if (!st) return;
    if (st.recording && !fabIsRecording) {
      setFabRecordUiVisible(true);
      setFabRecordingState(true);
      fabUpdateRecStatus();
    } else if (!st.recording && fabIsRecording) {
      setFabRecordingState(false, '');
    }
  }, 1500);
  try {
    signal.addEventListener('abort', () => {
      if (fabRecWatch) {
        clearInterval(fabRecWatch);
        fabRecWatch = null;
      }
    });
  } catch (_) {
    // ignore
  }

  // Refresh position from storage (core button already painted above).
  loadPos(() => {
    refreshBadgeOnly();
    waitForRecorderThenScan();
  });

  liveFabHost = host;
    } catch (err) {
      // Normal after extension reload — orphaned script tried to remount with dead chrome.*.
      if (isInvalidatedError(err) || !extAlive()) {
        try {
          if (fabDomObserver) fabDomObserver.disconnect();
        } catch (_) {
          // ignore
        }
        liveFabHost = null;
        return;
      }
      try {
        const detail =
          err && typeof err === 'object'
            ? `${err.name || 'Error'}: ${err.message || err}`
            : String(err);
        console.warn('Stuff Grabber: FAB mount failed', detail, err);
        try {
          window.__hlsFabMountError = detail;
        } catch (_) {
          // ignore
        }
      } catch (_) {
        // ignore
      }
      // If the button shell already painted, keep it — only tear down total failures.
      if (!coreReady) {
        liveFabHost = null;
        removeOrphanFabHosts();
      }
    }
  }

  syncFloatPreference();
})();
