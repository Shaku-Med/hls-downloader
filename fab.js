(function () {
  if (window.__hlsGrabberFabLoader) return;
  window.__hlsGrabberFabLoader = true;

  const FLOAT_KEY = 'floatGrabberEnabled';
  const JOBS_KEY = 'hlsGrabJobsState';
  const FAB_POS_KEY = 'hlsGrabFabPos';
  const FAB_SIZE = 52;
  const FAB_MARGIN = 14;
  const MOVE_TOLERANCE = 8;

  const fabCtl = {
    closePanel: () => {},
    liveRefresh: () => {},
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'HLS_GRABBER_CLOSE_FLOAT_PANEL') {
      fabCtl.closePanel();
      return;
    }
    if (msg && msg.type === 'HLS_GRABBER_LIVE_UPDATE') {
      fabCtl.liveRefresh();
    }
  });

  function unmountGrabberUi() {
    const h = document.querySelector('[data-hls-grabber-fab]');
    if (!h) return;
    if (typeof h._hlsFabCleanup === 'function') {
      try {
        h._hlsFabCleanup();
      } catch (_) {
        // ignore
      }
    }
    fabCtl.closePanel = () => {};
    fabCtl.liveRefresh = () => {};
    h.remove();
  }

  function syncFloatPreference() {
    chrome.storage.local.get([FLOAT_KEY], (d) => {
      if (chrome.runtime.lastError) return;
      const on = d[FLOAT_KEY] !== false;
      if (on) mountGrabberUi();
      else unmountGrabberUi();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[FLOAT_KEY]) {
      const on = changes[FLOAT_KEY].newValue !== false;
      if (on) mountGrabberUi();
      else unmountGrabberUi();
    }
  });

  function genJobId() {
    return `j_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
    if (document.querySelector('[data-hls-grabber-fab]')) return;

    const ac = new AbortController();
    const { signal } = ac;

    const host = document.createElement('div');
  host.setAttribute('data-hls-grabber-fab', '');
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  :host {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 2147483647;
    overflow: visible;
    isolation: isolate;
  }
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
  .fab {
    position: fixed;
    width: ${FAB_SIZE}px;
    height: ${FAB_SIZE}px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.92);
    cursor: grab;
    background: linear-gradient(145deg, #fff5f0, #ffedd5);
    padding: 0;
    box-shadow: 0 4px 18px rgba(194, 65, 12, 0.45), 0 2px 4px rgba(0,0,0,.2);
    z-index: 3;
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    touch-action: none;
    overflow: visible;
    left: var(--fab-left, auto);
    top: var(--fab-top, auto);
    right: var(--fab-right, auto);
    bottom: var(--fab-bottom, auto);
    transform: var(--fab-transform, none);
    transition: left 0.52s cubic-bezier(0.34, 1.55, 0.56, 1),
                top 0.52s cubic-bezier(0.34, 1.55, 0.56, 1),
                right 0.52s cubic-bezier(0.34, 1.55, 0.56, 1),
                bottom 0.52s cubic-bezier(0.34, 1.55, 0.56, 1),
                transform 0.52s cubic-bezier(0.34, 1.55, 0.56, 1),
                box-shadow 0.25s ease;
  }
  .fab-icon {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
    pointer-events: none;
    display: block;
  }
  .fab-badge {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 9px;
    background: #c2410c;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    border: 2px solid #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.3);
    pointer-events: none;
    z-index: 4;
  }
  .fab-badge[hidden] { display: none !important; }
  .fab:active { cursor: grabbing; }
  .fab:hover {
    box-shadow: 0 6px 22px rgba(194, 65, 12, 0.55), 0 2px 6px rgba(0,0,0,.22);
    transform: var(--fab-transform, none) scale(1.04);
  }
  .fab.dragging {
    transition: none !important;
    cursor: grabbing;
    transform: var(--fab-transform, none) scale(1.08);
    box-shadow: 0 8px 28px rgba(194, 65, 12, 0.5);
  }
  .panel {
    position: fixed;
    width: min(360px, calc(100vw - 24px));
    max-height: min(72vh, 520px);
    background: #faf8f5;
    color: #1c1917;
    border-radius: 14px;
    border: 1px solid #e7e2dc;
    box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 4px 12px rgba(0,0,0,.08);
    z-index: 2;
    pointer-events: auto;
    flex-direction: column;
    overflow: hidden;
    display: none;
    opacity: 0;
    transform: scale(0.94);
    transform-origin: var(--panel-origin, center center);
    transition: opacity 0.22s ease, transform 0.32s cubic-bezier(0.34, 1.35, 0.64, 1);
  }
  .panel.open {
    display: flex;
    opacity: 1;
    transform: scale(1);
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: linear-gradient(180deg, #fff 0%, #faf8f5 100%);
    border-bottom: 1px solid #e7e2dc;
  }
  .panel-title { font-size: 14px; font-weight: 600; }
  .close-p {
    border: none;
    background: transparent;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    color: #78716c;
    padding: 0 4px;
    border-radius: 6px;
  }
  .close-p:hover { background: #f5f5f4; color: #1c1917; }
  .panel-scroll {
    overflow-y: auto;
    padding: 10px 12px 12px;
    flex: 1;
    min-height: 0;
  }
  .path-line {
    font-size: 11px;
    color: #78716c;
    margin-bottom: 10px;
    word-break: break-all;
    line-height: 1.35;
  }
  .path-line.bad { color: #b91c1c; }
  .jobs-block { margin-bottom: 12px; }
  .queue-line { font-size: 10px; color: #a8a29e; margin-bottom: 8px; }
  .job-mini {
    background: #fff;
    border: 1px solid #e7e2dc;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 8px;
    font-size: 11px;
  }
  .job-mini .t { font-weight: 600; color: #44403c; }
  .job-mini .d { margin-top: 4px; color: #57534e; line-height: 1.35; }
  .job-mini .d.err { color: #b91c1c; }
  .row-btns { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    border-radius: 8px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .btn-ghost {
    background: #fff;
    border: 1px solid #d6d3d1;
    color: #44403c;
  }
  .btn-ghost:hover { background: #fafaf9; }
  .btn-dan {
    background: #fff;
    border: 1px solid #f87171;
    color: #b91c1c;
  }
  .stream-card {
    background: #fff;
    border: 1px solid #e7e2dc;
    border-radius: 10px;
    padding: 10px;
    margin-bottom: 10px;
  }
  .stream-card .kind { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #a8a29e; font-weight: 600; margin-bottom: 6px; }
  .stream-card .url { font-size: 10px; color: #57534e; word-break: break-all; line-height: 1.4; font-family: ui-monospace, monospace; }
  .stream-card .fn-row { display: flex; gap: 6px; margin-top: 8px; }
  .stream-card input {
    flex: 1;
    min-width: 0;
    border: 1px solid #d6d3d1;
    border-radius: 8px;
    padding: 6px 8px;
    font-size: 12px;
    background: #faf8f5;
  }
  .stream-card .dl {
    background: #c2410c;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .stream-card .dl:disabled { background: #d6d3d1; cursor: not-allowed; }
  .empty { text-align: center; padding: 20px 8px; font-size: 12px; color: #78716c; line-height: 1.5; }
</style>
<button type="button" class="fab" aria-label="Open HLS Grabber" title="HLS Grabber">
  <img class="fab-icon" src="" alt="" draggable="false" />
  <span class="fab-badge" hidden></span>
</button>
<div class="panel" hidden>
  <div class="panel-head">
    <span class="panel-title">HLS Grabber</span>
    <button type="button" class="close-p" aria-label="Close">×</button>
  </div>
  <div class="panel-scroll">
    <div class="path-line" id="fab-path"></div>
    <div class="jobs-block" id="fab-jobs"></div>
    <div id="fab-streams"></div>
  </div>
</div>`;

  document.documentElement.appendChild(host);

  const fab = shadow.querySelector('.fab');
  const panel = shadow.querySelector('.panel');
  const fabPath = shadow.getElementById('fab-path');
  const fabJobs = shadow.getElementById('fab-jobs');
  const fabStreams = shadow.getElementById('fab-streams');
  const closeBtn = shadow.querySelector('.close-p');

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

  function applyFabPixels(left, top, withTransition) {
    fab.classList.toggle('dragging', !withTransition);
    fab.style.setProperty('--fab-left', `${Math.round(left)}px`);
    fab.style.setProperty('--fab-top', `${Math.round(top)}px`);
    fab.style.setProperty('--fab-right', 'auto');
    fab.style.setProperty('--fab-bottom', 'auto');
    fab.style.setProperty('--fab-transform', 'none');
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
      applyFabPixels(s.left, s.top, true);
      persistPos(s.left, s.top);
      setPanelTransformOrigin();
      if (panel.classList.contains('open')) positionPanel();
    } else {
      const wasOpen = panel.classList.contains('open');
      setPanelOpen(!wasOpen);
      if (!wasOpen) refreshAll();
    }
  }

  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);

  fab.addEventListener('transitionend', (ev) => {
    if (ev.target !== fab) return;
    if (ev.propertyName !== 'left' && ev.propertyName !== 'top') return;
    if (panel.classList.contains('open')) positionPanel();
  });

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
          fabPath.textContent = 'No save folder — use extension Options.';
          fabPath.classList.add('bad');
        }
      }
      renderJobs(response.jobs || [], response);
      renderStreams(response.streams || [], response.pageTitle || '', hasPath);
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
    let line = `${r} of ${m} busy`;
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
        d.textContent = job.detail || job.error || '';
      }
      card.appendChild(t);
      card.appendChild(d);
      const row = document.createElement('div');
      row.className = 'row-btns';
      if (['queued', 'connecting', 'downloading'].includes(job.status)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-dan';
        b.textContent = 'Cancel';
        b.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', jobId: job.id }, refreshAll)
        );
        row.appendChild(b);
      } else if (['completed', 'canceled', 'error'].includes(job.status)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost';
        b.textContent = 'Dismiss';
        b.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'DISMISS_JOB', jobId: job.id }, refreshAll)
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
    cbtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'DISMISS_DONE' }, refreshAll));
    clr.appendChild(cbtn);
    fabJobs.appendChild(clr);
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
    streams.forEach((raw, i) => {
      const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
      const url = stream.url || '';
      const kind = stream.streamKind ? String(stream.streamKind) : '';
      const defaultName = defaultFileName(i, n, pageTitle, url);

      const card = document.createElement('div');
      card.className = 'stream-card';
      const h = document.createElement('div');
      h.className = 'kind';
      h.textContent = n > 1 ? `Stream ${i + 1} of ${n}${kind ? ` · ${kind}` : ''}` : kind || 'Stream';
      const u = document.createElement('div');
      u.className = 'url';
      u.textContent = url;
      const row = document.createElement('div');
      row.className = 'fn-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultName;
      input.readOnly = !hasPath;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl';
      btn.textContent = 'Download';
      if (!hasPath) btn.disabled = true;
      btn.addEventListener('click', () => {
        if (!hasPath) {
          chrome.runtime.openOptionsPage();
          return;
        }
        const filename = input.value.trim() || defaultName;
        const jobId = genJobId();
        btn.disabled = true;
        const payload = {
          jobId,
          url,
          filename,
          streamKind: kind || undefined,
          capturedHeaders: stream.capturedHeaders || {},
        };
        if (typeof navigator !== 'undefined' && navigator.userAgent) {
          payload.userAgent = navigator.userAgent;
        }
        const tabUrl = window.location.href || '';
        if (/^https?:/i.test(tabUrl)) {
          payload.referer = tabUrl;
          try {
            payload.origin = new URL(tabUrl).origin;
          } catch (_) {}
        }
        chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload }, (r) => {
          btn.disabled = false;
          refreshAll();
          if (chrome.runtime.lastError || !r?.ok) {
            console.warn('HLS Grabber fab:', chrome.runtime.lastError || r?.error);
          }
        });
      });
      row.appendChild(input);
      row.appendChild(btn);
      card.appendChild(h);
      card.appendChild(u);
      card.appendChild(row);
      fabStreams.appendChild(card);
    });
  }

  function onFabStorageChanged(changes, area) {
    if (area === 'local' && changes.userDownloadPath) {
      if (panel.classList.contains('open')) refreshAll();
      else refreshBadgeOnly();
      return;
    }
    if (area === 'session' && changes[JOBS_KEY]) {
      if (panel.classList.contains('open')) refreshAll();
      else refreshBadgeOnly();
    }
  }
  chrome.storage.onChanged.addListener(onFabStorageChanged);

  fabCtl.closePanel = () => setPanelOpen(false);
  fabCtl.liveRefresh = () => {
    refreshBadgeOnly();
    if (panel.classList.contains('open')) refreshAll();
  };

  host._hlsFabCleanup = () => {
    ac.abort();
    chrome.storage.onChanged.removeListener(onFabStorageChanged);
    try {
      panelResizeObserver.disconnect();
    } catch (_) {
      // ignore
    }
  };

  loadPos(() => {
    refreshBadgeOnly();
  });
  }

  syncFloatPreference();
})();
