(function () {
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Living instance: just re-sync. Orphaned instance (dead chrome.*): fall through and take over.
  try {
    if (extAlive() && typeof window.__hlsGrabberFabRemount === 'function') {
      window.__hlsGrabberFabRemount();
      return;
    }
  } catch (_) {
    // take over
  }
  window.__hlsGrabberFabLoader = true;

  const FLOAT_KEY = 'floatGrabberEnabled';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
  const JOBS_KEY = 'hlsGrabJobsState';
  const STREAMS_REV_KEY = 'hlsGrabStreamsRev';
  const FAB_POS_KEY = 'hlsGrabFabPos';
  const FAB_SIZE = 52;
  const FAB_MARGIN = 14;
  const MOVE_TOLERANCE = 8;
  const HOST_TAG = 'stuff-grabber-fab';

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
    // Custom element + inline shell so page `div {…}` rules cannot hide us.
    const s = el.style;
    s.cssText = '';
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('left', '0', 'important');
    s.setProperty('top', '0', 'important');
    s.setProperty('right', '0', 'important');
    s.setProperty('bottom', '0', 'important');
    s.setProperty('width', '100vw', 'important');
    s.setProperty('height', '100vh', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('padding', '0', 'important');
    s.setProperty('border', '0', 'important');
    s.setProperty('background', 'transparent', 'important');
    s.setProperty('pointer-events', 'none', 'important');
    s.setProperty('z-index', '2147483647', 'important');
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
    if (!msg || !msg.type) return;
    if (msg.type === 'HLS_GRABBER_PING') {
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
    try {
      chrome.storage.local.get([FLOAT_KEY], (d) => {
        if (chrome.runtime.lastError) {
          // Still try to show — default is ON when unset.
          mountGrabberUi();
          return;
        }
        const on = !d || d[FLOAT_KEY] !== false;
        if (on) mountGrabberUi();
        else unmountGrabberUi();
      });
    } catch (_) {
      // Extension context invalidated
    }
  }

  window.__hlsGrabberFabRemount = syncFloatPreference;

  // Some sites rewrite <html>/<body> and strip unknown nodes — put the FAB back.
  try {
    const mo = new MutationObserver(() => {
      if (!liveFabHost) return;
      if (liveFabHost.isConnected) return;
      liveFabHost = null;
      syncFloatPreference();
    });
    mo.observe(document.documentElement, { childList: true, subtree: false });
  } catch (_) {
    // ignore
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[FLOAT_KEY]) {
        const on = changes[FLOAT_KEY].newValue !== false;
        if (on) mountGrabberUi();
        else unmountGrabberUi();
      }
      if (area === 'local' && (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY])) {
        if (liveFabHost || document.querySelector('[data-hls-grabber-fab], ' + HOST_TAG)) {
          unmountGrabberUi();
          mountGrabberUi();
        }
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
    try {
      if (liveFabHost && (liveFabHost.isConnected || document.documentElement.contains(liveFabHost))) {
        hardenFabHost(liveFabHost);
        return;
      }
      // Drop hosts left by orphaned scripts after an extension reload.
      removeOrphanFabHosts();

      const ac = new AbortController();
      const { signal } = ac;

      // Custom tag avoids hostile page rules that target bare `div`.
      const host = document.createElement(HOST_TAG);
      host.setAttribute('data-hls-grabber-fab', '');
      hardenFabHost(host);
      const shadow = host.attachShadow({ mode: 'open' });

      shadow.innerHTML = `
<style data-hls-fab-fallback>
  .fab {
    position: fixed !important;
    width: ${FAB_SIZE}px !important;
    height: ${FAB_SIZE}px !important;
    border-radius: 50% !important;
    border: none !important;
    cursor: grab !important;
    background: #ffffff !important;
    color: #111 !important;
    padding: 0 !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    visibility: visible !important;
    opacity: 1 !important;
    box-shadow: 0 12px 40px rgba(0,0,0,.22) !important;
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
    border-radius: 999px; background: #ff3b30; color: #fff; font: 700 11px/18px system-ui, sans-serif;
    pointer-events: none;
  }
  .fab-badge[hidden] { display: none !important; }
  .panel { display: none !important; }
  .panel.open {
    display: flex !important; flex-direction: column; position: fixed; z-index: 2147483646;
    pointer-events: auto; width: min(360px, calc(100vw - 24px));
    max-height: min(520px, calc(100vh - 24px));
    background: #fff; color: #111; border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0,0,0,.25); overflow: hidden;
  }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; font-weight: 700; }
  .close-p { border: 0; background: transparent; font-size: 22px; cursor: pointer; line-height: 1; }
  .panel-scroll { overflow: auto; padding: 0 14px 14px; }
</style>
<button type="button" class="fab" aria-label="Open Stuff Grabber" title="Stuff Grabber">
  <img class="fab-icon" src="" alt="" draggable="false" />
  <span class="fab-badge" hidden></span>
</button>
<div class="panel" hidden>
  <div class="panel-head">
    <span class="panel-title">Stuff Grabber</span>
    <button type="button" class="close-p" aria-label="Close">×</button>
  </div>
  <div class="panel-scroll">
    <div class="path-line" id="fab-path"></div>
    <div class="jobs-block" id="fab-jobs"></div>
    <div class="rec-section" id="fab-rec">
      <button type="button" class="rec-btn" id="fab-rec-btn">
        <span class="rec-dot"></span>
        <span id="fab-rec-label">Record videos</span>
      </button>
      <div class="rec-status" id="fab-rec-status"></div>
    </div>
    <div id="fab-streams"></div>
    <div id="fab-images"></div>
  </div>
</div>`;

      const mountRoot = document.documentElement || document.body;
      if (!mountRoot) return;
      mountRoot.appendChild(host);
      liveFabHost = host;
      host.style.setProperty('--fab-size', `${FAB_SIZE}px`);
      try {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('style/fab.css');
        // Keep fallback first so a broken/late fab.css cannot blank the button.
        shadow.appendChild(link);
      } catch (_) {
        // Stylesheet optional — inline fallback above is enough to show the button.
      }

      const fab = shadow.querySelector('.fab');
      const panel = shadow.querySelector('.panel');
      const fabPath = shadow.getElementById('fab-path');
      const fabJobs = shadow.getElementById('fab-jobs');
      const fabStreams = shadow.getElementById('fab-streams');
      const fabImages = shadow.getElementById('fab-images');
      const closeBtn = shadow.querySelector('.close-p');
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
    if (themeApi) {
      themeApi.applyThemeToHost(host, mode, accent);
      return;
    }
    host.style.setProperty('--bg', '#f4f6fb');
    host.style.setProperty('--text', '#0f172a');
  }

  let unbindFabTheme = null;
  if (window.HGR_THEME && window.HGR_THEME.bindLiveThemeHost) {
    unbindFabTheme = window.HGR_THEME.bindLiveThemeHost(host);
  } else {
    chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
      applyFabTheme(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
    });
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
    if (!panel.classList.contains('open')) return;
    const tick = () => {
      positionPanel();
      if (fab.classList.contains('snapping')) {
        snapTrackRaf = requestAnimationFrame(tick);
      } else {
        snapTrackRaf = 0;
      }
    };
    snapTrackRaf = requestAnimationFrame(tick);
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
    fab.style.setProperty('z-index', '2147483647', 'important');
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
      panel.hidden = false;
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

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fab.setPointerCapture(e.pointerId);
    const r = fab.getBoundingClientRect();
    drag = {
      pid: e.pointerId,
      ox: e.clientX - r.left,
      oy: e.clientY - r.top,
      moved: 0,
    };
    fab.classList.add('dragging');
  });

  fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
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
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const moved = drag.moved;
    try {
      fab.releasePointerCapture(e.pointerId);
    } catch (_) {
      // ignore
    }
    fab.classList.remove('dragging');
    const r = fab.getBoundingClientRect();
    const left = r.left;
    const top = r.top;
    drag = null;
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

  closeBtn.addEventListener('click', () => setPanelOpen(false));

  const panelResizeObserver = new ResizeObserver(() => {
    if (panel.classList.contains('open')) positionPanel();
  });
  panelResizeObserver.observe(panel);
  window.addEventListener(
    'resize',
    () => {
      const s = cornerCoords(corner);
      applyFabPixels(s.left, s.top, true);
      if (panel.classList.contains('open')) positionPanel();
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
          fabPath.textContent = 'No save folder. Use extension Options.';
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
          fabPath.textContent = 'No save folder. Use extension Options.';
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

  function askFabThumbnailsForAll(count, onDone) {
    if (window.HGR_THEME && typeof window.HGR_THEME.showBatchThumbnailPrompt === 'function') {
      // Page-level sheet so it matches quality / ffmpeg dialogs.
      window.HGR_THEME.showBatchThumbnailPrompt(count, onDone, document.body);
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

  function fabShortStreamUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      const path = (u.pathname || '/').replace(/\/$/, '') || '/';
      const keep = [];
      if (u.searchParams.get('v')) keep.push(`v=${u.searchParams.get('v')}`);
      if (u.searchParams.get('list')) keep.push('list=…');
      const q = keep.length ? `?${keep.join('&')}` : '';
      const s = `${u.host}${path}${q}`;
      return s.length > 56 ? s.slice(0, 54) + '…' : s;
    } catch (_) {
      return raw.length > 56 ? raw.slice(0, 54) + '…' : raw;
    }
  }

  function renderStreams(streams, pageTitle, hasPath) {
    fabStreams.textContent = '';
    if (!streams.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No streams yet</strong><br>Start playback, then open this panel.';
      fabStreams.appendChild(empty);
      return;
    }
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
          fabStreams.appendChild(sec);
          linkGrid = null;
        } else {
          const sec = document.createElement('div');
          sec.className = 'stream-source-label';
          sec.textContent = fabSourceSectionLabel(urlSource);
          fabStreams.appendChild(sec);
          linkGrid = null;
        }
      }

      const card = document.createElement('div');
      card.dataset.urlSource = urlSource;

      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultName;
      input.readOnly = !hasPath;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl';
      if (!hasPath) btn.disabled = true;
      btn.textContent = isLinkCard ? 'Download' : pageOnly ? 'Download this' : 'Download';
      btn.addEventListener('click', () => {
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
              const tel = shadow.getElementById(`fab-thumb-${i}`);
              if (tel && tel.checked) finalPayload.ytDlpWriteThumbnail = true;
            }
            return finalPayload;
          };

          const sendDownload = (finalPayload, onResult) => {
            chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: finalPayload }, (r) => {
              resetFabDlBtn();
              refreshPanelJobsOnly();
              if (chrome.runtime.lastError || !r?.ok) {
                console.warn('Stuff Grabber fab:', chrome.runtime.lastError || r?.error);
              }
              if (onResult) onResult(r);
            });
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
        card.className = 'stream-card stream-card--link';
        const main = document.createElement('div');
        main.className = 'link-card-main';
        const titleRow = document.createElement('div');
        titleRow.className = 'link-card-title-row';
        const tag = document.createElement('span');
        tag.className = 'source-tag source-tag--link';
        tag.textContent = 'page link';
        titleRow.appendChild(tag);
        titleRow.appendChild(input);
        const urlLine = document.createElement('div');
        urlLine.className = 'link-card-url';
        urlLine.textContent = fabShortStreamUrl(url);
        urlLine.title = url;
        main.appendChild(titleRow);
        main.appendChild(urlLine);
        const thumbRow = document.createElement('label');
        thumbRow.className = 'thumb-row link-card-thumb';
        const tcb = document.createElement('input');
        tcb.type = 'checkbox';
        tcb.id = `fab-thumb-${i}`;
        thumbRow.appendChild(tcb);
        const tspan = document.createElement('span');
        tspan.textContent = 'Also save thumbnail';
        thumbRow.appendChild(tspan);
        main.appendChild(thumbRow);
        card.appendChild(main);
        card.appendChild(btn);
        if (!linkGrid) {
          linkGrid = document.createElement('div');
          linkGrid.className = 'link-stream-grid';
          fabStreams.appendChild(linkGrid);
        }
        linkGrid.appendChild(card);
      } else {
        linkGrid = null;
        card.className = 'stream-card';
        const h = document.createElement('div');
        h.className = 'kind';
        h.appendChild(
          document.createTextNode(
            pageOnly
              ? isAppleMusicPage
                ? 'Download this track'
                : 'Download this video'
              : n > 1
                ? `Stream ${i + 1} of ${n}${kind ? ` (${kind})` : ''}`
                : kind || 'Stream'
          )
        );
        if (pageOnly && urlSource === 'tab') {
          const tag = document.createElement('span');
          tag.className = 'source-tag source-tag--tab';
          tag.textContent = 'this page';
          h.appendChild(tag);
        }
        const u = document.createElement('div');
        u.className = 'url';
        const link = document.createElement('div');
        link.className = 'stream-page-link';
        link.textContent = url;
        if (pageOnly) {
          const intro = document.createElement('div');
          intro.className = 'stream-page-intro';
          intro.textContent = isAppleMusicPage
            ? 'Apple Music: yt-dlp uses the song page URL below (not the FairPlay m3u8 stream).'
            : 'This tab’s post URL. Playlist params are kept — use Clean URL to strip tracking.';
          u.appendChild(intro);
          u.appendChild(link);
          // Clean URL only on the main tab item (not page links).
          if (urlSource === 'tab' && cleanedUrl && cleanedUrl !== url) {
            const cleanBtn = document.createElement('button');
            cleanBtn.type = 'button';
            cleanBtn.className = 'url-clean-btn';
            cleanBtn.textContent = 'Clean URL';
            cleanBtn.title = 'Strip tracking junk (keeps playlist list= / video id)';
            cleanBtn.addEventListener('click', () => {
              url = cleanedUrl;
              link.textContent = url;
              cleanBtn.disabled = true;
              cleanBtn.textContent = 'Cleaned';
            });
            u.appendChild(cleanBtn);
          }
        } else {
          u.appendChild(link);
        }
        const row = document.createElement('div');
        row.className = 'fn-row';
        row.appendChild(input);
        row.appendChild(btn);
        card.appendChild(h);
        card.appendChild(u);
        if (pageOnly) {
          const thumbRow = document.createElement('label');
          thumbRow.className = 'thumb-row';
          const tcb = document.createElement('input');
          tcb.type = 'checkbox';
          tcb.id = `fab-thumb-${i}`;
          thumbRow.appendChild(tcb);
          const tspan = document.createElement('span');
          tspan.textContent = 'Also save thumbnail (jpg next to the video)';
          thumbRow.appendChild(tspan);
          card.appendChild(thumbRow);
        }
        card.appendChild(row);
        fabStreams.appendChild(card);
      }
    });
  }

  function shortImgUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return 'data:image';
    try {
      const u = new URL(raw, location.href);
      const last = (u.pathname.split('/').filter(Boolean).pop() || '').slice(0, 42);
      const s = `${u.host}${last ? '/' + last : ''}`;
      return s.length > 52 ? s.slice(0, 50) + '…' : s;
    } catch (_) {
      return raw.length > 52 ? raw.slice(0, 50) + '…' : raw;
    }
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
      scopeSel.innerHTML = `
        <option value="page">Full page</option>
        <option value="visible">Visible area</option>
      `;
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
        const urlLine = document.createElement('div');
        urlLine.className = 'img-url';
        urlLine.textContent = shortImgUrl(img.url);
        urlLine.title = img.url;
        meta.appendChild(title);
        meta.appendChild(urlLine);

        const actions = document.createElement('div');
        actions.className = 'img-actions';

        const sel = document.createElement('select');
        sel.className = 'img-fmt-select';
        sel.setAttribute('aria-label', 'Format');
        sel.innerHTML = `
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WEBP</option>
        `;

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
  chrome.storage.onChanged.addListener(onFabStorageChanged);

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
    chrome.storage.onChanged.removeListener(onFabStorageChanged);
    if (typeof unbindFabTheme === 'function') unbindFabTheme();
    try {
      panelResizeObserver.disconnect();
    } catch (_) {
      // ignore
    }
  };

  /* ── Record Video Elements (FAB) ── */
  const fabRecSection = shadow.getElementById('fab-rec');
  const fabRecBtn = shadow.getElementById('fab-rec-btn');
  const fabRecLabel = shadow.getElementById('fab-rec-label');
  const fabRecStatus = shadow.getElementById('fab-rec-status');
  let fabIsRecording = false;
  let fabRecPoll = null;

  function setFabRecordUiVisible(visible) {
    if (fabRecSection) fabRecSection.hidden = !visible;
    if (!visible && fabRecStatus) fabRecStatus.textContent = '';
  }

  function fabFormatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function fabSendRecorder(action, cb) {
    // video-recorder.js shares this isolated world; call it directly.
    const api = window.HLS_VIDEO_REC;
    if (!api || typeof api[action] !== 'function') {
      cb({ ok: false, error: 'Recorder not ready' });
      return;
    }
    try {
      cb(api[action]() || { ok: false });
    } catch (e) {
      cb({ ok: false, error: String((e && e.message) || e) });
    }
  }

  function fabUpdateRecStatus() {
    fabSendRecorder('status', (res) => {
      if (!res || !res.recording) {
        if (fabIsRecording) {
          fabIsRecording = false;
          fabRecBtn.classList.remove('is-rec');
          fabRecLabel.textContent = 'Record videos';
          fabRecStatus.textContent = '';
          if (fabRecPoll) { clearInterval(fabRecPoll); fabRecPoll = null; }
        }
        return;
      }
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
        fabRecStatus.textContent = lines.join(' · ') || 'Recording…';
      }
    });
  }

  function fabRecScan() {
    fabSendRecorder('scan', (res) => {
      if (!res || !res.ok) {
        setFabRecordUiVisible(false);
        return;
      }
      if (res.recording) {
        setFabRecordUiVisible(true);
        fabIsRecording = true;
        fabRecBtn.classList.add('is-rec');
        fabRecLabel.textContent = 'Stop recording';
        if (!fabRecPoll) fabRecPoll = setInterval(fabUpdateRecStatus, 1000);
        fabUpdateRecStatus();
      } else if (res.count > 0) {
        setFabRecordUiVisible(true);
        fabRecStatus.textContent = `${res.count} video${res.count > 1 ? 's' : ''} on page`;
      } else {
        setFabRecordUiVisible(false);
      }
    });
  }

  if (fabRecBtn) {
    fabRecBtn.addEventListener('click', () => {
      if (fabIsRecording) {
        fabRecBtn.disabled = true;
        fabSendRecorder('stop', (res) => {
          fabRecBtn.disabled = false;
          fabIsRecording = false;
          fabRecBtn.classList.remove('is-rec');
          fabRecLabel.textContent = 'Record videos';
          if (fabRecPoll) { clearInterval(fabRecPoll); fabRecPoll = null; }
          if (res && res.ok && res.stopped) {
            fabRecStatus.textContent = `Saved ${res.stopped.length} recording${res.stopped.length > 1 ? 's' : ''}`;
          } else {
            fabRecStatus.textContent = res?.error || 'Stopped';
          }
        });
      } else {
        fabRecBtn.disabled = true;
        fabSendRecorder('start', (res) => {
          fabRecBtn.disabled = false;
          if (res && res.ok) {
            fabIsRecording = true;
            fabRecBtn.classList.add('is-rec');
            fabRecLabel.textContent = 'Stop recording';
            if (res.sequential && res.total > 1) {
              fabRecStatus.textContent =
                `1 of ${res.total} (one at a time` +
                (res.remaining ? `, ${res.remaining} queued` : '') +
                ')';
            } else {
              const fail = (res.details || []).filter((d) => !d.ok);
              let m = `Recording ${res.count} of ${res.total} video${res.total > 1 ? 's' : ''}`;
              if (fail.length) m += ` · ${fail.length} skipped`;
              fabRecStatus.textContent = m;
            }
            if (!fabRecPoll) fabRecPoll = setInterval(fabUpdateRecStatus, 1000);
          } else {
            fabRecStatus.textContent = res?.error || 'No videos found';
          }
        });
      }
    });
  }

  // Position immediately so the button is visible even before storage returns.
  try {
    const sc = cornerCoords('br');
    corner = 'br';
    applyFabPixels(sc.left, sc.top, false);
  } catch (_) {
    applyFabPixels(FAB_MARGIN, FAB_MARGIN, false);
  }

  loadPos(() => {
    refreshBadgeOnly();
    fabRecScan();
  });

  liveFabHost = host;
    } catch (err) {
      try {
        console.warn('Stuff Grabber: FAB mount failed', err);
      } catch (_) {
        // ignore
      }
      liveFabHost = null;
      removeOrphanFabHosts();
    }
  }

  syncFloatPreference();
})();
