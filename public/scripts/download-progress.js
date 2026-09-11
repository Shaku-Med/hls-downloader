/**
 * On-page download progress bar + highlight <a href> that contains the media id.
 */
(function () {
  try {
    if (window.__hlsGrabberDownloadProgressUi && chrome.runtime && chrome.runtime.id) return;
  } catch (_) {
    // invalidated context — take over from orphaned script
  }
  window.__hlsGrabberDownloadProgressUi = true;

  const HIGHLIGHT_CLASS = 'hls-grabber-dl-current';
  const STYLE_ID = 'hls-grabber-dl-highlight-css';

  const host = document.createElement('div');
  host.setAttribute('data-hls-dl-progress', '');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        --bg: #000000;
        --surface: #1c1c1e;
        --text: #ffffff;
        --muted: #8e8e93;
        --line: rgba(84, 84, 88, 0.65);
        --accent: #0a84ff;
        --accent-2: #409cff;
        --fill: rgba(120, 120, 128, 0.32);
        --shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        --dl-spring: cubic-bezier(0.32, 0.72, 0, 1);
        --dl-spring-in: cubic-bezier(0.34, 1.25, 0.64, 1);
      }
      :host([data-theme="light"]) {
        --bg: #f2f2f7;
        --surface: #ffffff;
        --text: #000000;
        --muted: #8e8e93;
        --line: rgba(60, 60, 67, 0.18);
        --accent: #007aff;
        --accent-2: #0a84ff;
        --fill: rgba(120, 120, 128, 0.16);
        --shadow: 0 12px 40px rgba(0, 0, 0, 0.16);
      }
      .bar-wrap {
        position: fixed; left: 16px; right: 16px; bottom: 16px; top: auto;
        z-index: 2147483646;
        pointer-events: none; display: none;
        font-family: var(--font);
        width: auto;
        transform-origin: top left;
      }
      .bar-wrap[data-open="1"],
      .bar-wrap.is-leaving { display: block; }
      .bar-wrap[data-morph="1"].is-appearing,
      .bar-wrap[data-morph="1"].is-leaving {
        transform-origin: center center;
      }
      .bar-wrap[data-morph="1"].is-appearing {
        animation: dl-island-in 520ms var(--dl-spring-in) both;
      }
      .bar-wrap[data-morph="1"].is-leaving {
        animation: dl-island-out 340ms var(--dl-spring) both;
        pointer-events: none;
      }
      .bar-wrap.is-morphing {
        will-change: transform, filter;
        z-index: 2147483647;
      }
      .bar-wrap.is-morphing .card { overflow: hidden; }
      .bar-wrap[data-morph="1"] .body,
      .bar-wrap[data-morph="1"] .circle-face {
        transition: opacity 260ms var(--dl-spring);
      }
      .bar-wrap.is-morphing .body,
      .bar-wrap.is-morphing .circle-face { opacity: 0.18; }
      @keyframes dl-island-in {
        0% { opacity: 0; transform: scale(0.62); filter: blur(10px); }
        62% { opacity: 1; filter: blur(0); }
        100% { opacity: 1; transform: scale(1); filter: none; }
      }
      @keyframes dl-island-out {
        0% { opacity: 1; transform: scale(1); filter: none; }
        100% { opacity: 0; transform: scale(0.7); filter: blur(8px); }
      }
      .bar-wrap[data-placed="1"] {
        left: var(--dl-left, 16px);
        top: var(--dl-top, 16px);
        right: auto;
        bottom: auto;
        width: max-content;
        max-width: calc(100vw - 16px);
      }
      .bar-wrap[data-placed="1"][data-layout="bar"] .card {
        width: min(420px, calc(100vw - 16px));
        max-width: min(420px, calc(100vw - 16px));
        margin: 0;
      }
      .bar-wrap[data-placed="1"][data-layout="pill"] .card {
        width: min(360px, calc(100vw - 16px));
        max-width: min(360px, calc(100vw - 16px));
        margin: 0;
      }
      .bar-wrap[data-layout="circle"]:not([data-placed="1"]) {
        left: 16px; right: auto; bottom: 16px; top: auto; width: auto;
      }
      .bar-wrap[data-layout="pill"]:not([data-placed="1"]) {
        left: 16px; right: 16px; top: 16px; bottom: auto;
      }
      .card {
        pointer-events: auto;
        max-width: 420px; margin: 0 auto;
        background: color-mix(in srgb, var(--surface) 94%, transparent); color: var(--text);
        border: 0.5px solid var(--line); border-radius: 14px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        padding: 12px 14px 14px;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
      }
      .bar-wrap[data-morph="1"] .card {
        transition: border-radius 520ms var(--dl-spring), box-shadow 520ms var(--dl-spring);
      }
      .bar-wrap[data-morph="1"] .card.dragging { transition: none; }
      .card.dragging { cursor: grabbing; }
      .card button { cursor: pointer; touch-action: manipulation; }
      .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
      .title { font-size: 13px; font-weight: 700; letter-spacing: -0.01em; color: var(--text); }
      .sub { font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.35; word-break: break-word; }
      .top-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      .cancel {
        flex: 0 0 auto; border: 0; background: transparent; color: #ff453a;
        font: 650 12px/1 var(--font); cursor: pointer; padding: 4px 2px;
      }
      .cancel[hidden] { display: none; }
      .x {
        flex: 0 0 auto; border: 0; background: transparent; color: var(--muted);
        font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px;
      }
      .track {
        height: 8px; border-radius: 980px; background: var(--fill); overflow: hidden;
      }
      .fill {
        height: 100%; width: 0%; border-radius: 980px;
        background: linear-gradient(90deg, var(--accent), var(--accent-2));
        transition: width 220ms ease;
      }
      .fill.indeterminate {
        width: 40% !important;
        animation: slide 1.1s ease-in-out infinite;
      }
      @keyframes slide {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(280%); }
      }
      .meta { margin-top: 7px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
      /* Several downloads at once get a row each rather than sharing one bar. */
      .more {
        margin-top: 8px; width: 100%; border: 0; background: transparent;
        color: var(--accent); font: 600 11px/1 var(--font); cursor: pointer;
        padding: 6px 0; text-align: left;
      }
      .more[hidden] { display: none; }
      .list { margin-top: 6px; display: none; }
      .list[data-open="1"] { display: block; }
      .row + .row { margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--line); }
      .row-top {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 8px; margin-bottom: 4px;
      }
      .row-name {
        font-size: 11px; color: var(--text); font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
      }
      .row-pct {
        flex: 0 0 auto; font-size: 11px; color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .row-track { height: 4px; border-radius: 980px; background: var(--fill); overflow: hidden; }
      .row-fill {
        height: 100%; width: 0%; border-radius: 980px; background: var(--accent);
        transition: width 220ms ease;
      }
      .row-fill.indeterminate { width: 38% !important; animation: slide 1.1s ease-in-out infinite; }
      .circle-face { display: none; position: relative; width: 72px; height: 72px; place-items: center; }
      .circle-ring {
        position: absolute; inset: 0;
        border-radius: 50%;
        background: conic-gradient(var(--accent) calc(var(--pct, 0) * 1%), var(--fill) 0);
      }
      .circle-ring::after {
        content: "";
        position: absolute; inset: 7px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--surface) 96%, transparent);
      }
      .circle-ring.indeterminate {
        background: conic-gradient(var(--accent) 28%, var(--fill) 0);
        animation: spin 1.1s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .circle-pct {
        position: relative; z-index: 1;
        font-size: 13px; font-weight: 750; letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums; color: var(--text);
      }
      .circle-count {
        display: none; position: absolute; top: -2px; right: -2px; z-index: 2;
        min-width: 18px; height: 18px; padding: 0 5px;
        border-radius: 980px; background: var(--accent); color: #fff;
        font: 700 10px/18px var(--font); text-align: center;
      }
      .circle-count[data-on="1"] { display: block; }
      .bar-wrap[data-layout="circle"]:not([data-expanded="1"]) .body { display: none; }
      .bar-wrap[data-layout="circle"]:not([data-expanded="1"]) .circle-face { display: grid; }
      .bar-wrap[data-layout="circle"]:not([data-expanded="1"]) .card {
        width: 72px; height: 72px; max-width: 72px; padding: 0; margin: 0;
        border-radius: 50%; display: grid; place-items: center;
      }
      .bar-wrap[data-layout="circle"][data-expanded="1"] .card {
        width: min(360px, 92vw); max-width: 360px;
      }
      .bar-wrap[data-layout="pill"] .card {
        max-width: min(380px, 92vw);
        border-radius: 980px;
        padding: 8px 12px 10px;
      }
      .bar-wrap[data-layout="pill"]:not([data-expanded="1"]) .sub,
      .bar-wrap[data-layout="pill"]:not([data-expanded="1"]) .more,
      .bar-wrap[data-layout="pill"]:not([data-expanded="1"]) .list { display: none; }
      .bar-wrap[data-layout="pill"] .track { height: 4px; }
      .bar-wrap[data-layout="pill"] .title { font-size: 12px; }
      .bar-wrap[data-layout="pill"] .meta { margin-top: 4px; }
    </style>
    <div class="bar-wrap" part="wrap" data-layout="bar" data-morph="1">
      <div class="card">
        <div class="circle-face" aria-hidden="true">
          <div class="circle-ring"></div>
          <div class="circle-pct">0%</div>
          <div class="circle-count">1</div>
        </div>
        <div class="body">
          <div class="top">
            <div>
              <div class="title"></div>
              <div class="sub"></div>
            </div>
            <div class="top-actions">
              <button type="button" class="cancel" hidden>Cancel</button>
              <button type="button" class="x" aria-label="Hide">×</button>
            </div>
          </div>
          <div class="track"><div class="fill"></div></div>
          <div class="meta"></div>
          <button type="button" class="more" hidden></button>
          <div class="list"></div>
        </div>
      </div>
    </div>
  `;

  const wrap = shadow.querySelector('.bar-wrap');
  const card = shadow.querySelector('.card');
  const titleEl = shadow.querySelector('.title');
  const subEl = shadow.querySelector('.sub');
  const fillEl = shadow.querySelector('.fill');
  const metaEl = shadow.querySelector('.meta');
  const moreBtn = shadow.querySelector('.more');
  const listEl = shadow.querySelector('.list');
  const closeBtn = shadow.querySelector('.x');
  const cancelBtn = shadow.querySelector('.cancel');
  const circleRing = shadow.querySelector('.circle-ring');
  const circlePct = shadow.querySelector('.circle-pct');
  const circleCount = shadow.querySelector('.circle-count');

  const LAYOUT_KEY = 'dlProgressLayout';
  const POS_KEY = 'dlProgressPos';
  const MORPH_KEY = (window.HGR_THEME && window.HGR_THEME.MORPH_KEY) || 'uiMorphMotion';
  const MORPH_KEY_LEGACY = (window.HGR_THEME && window.HGR_THEME.MORPH_KEY_LEGACY) || 'dlProgressMorph';
  const LAYOUTS = ['bar', 'circle', 'pill'];
  const EDGE = 8;
  const MOVE_TOLERANCE = 6;
  const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const MORPH_MS = 540;
  let layout = 'bar';
  let morphOn = true;
  let morphTimer = 0;
  let leaveTimer = 0;
  /** @type {{ bar?: {left:number, top:number}, circle?: {left:number, top:number}, pill?: {left:number, top:number} }} */
  let savedPos = {};
  let expanded = false;
  /** @type {null | { pid: number, ox: number, oy: number, startX: number, startY: number, moved: number }} */
  let drag = null;
  let suppressClickUntil = 0;

  let unbindProgressTheme = null;
  try {
    if (window.HGR_THEME && window.HGR_THEME.bindLiveThemeHost) {
      unbindProgressTheme = window.HGR_THEME.bindLiveThemeHost(host);
    } else if (window.HGR_THEME && window.HGR_THEME.applyStoredThemeToElement) {
      window.HGR_THEME.applyStoredThemeToElement(host);
    }
  } catch (_) {
    // ignore
  }

  /** @type {HTMLElement[]} */
  let highlighted = [];
  let hideTimer = 0;
  let timeTimer = 0;
  let dismissed = false;
  /** Jobs the user hid or canceled — do not bring the card back on leftover ticks. */
  const dismissedIds = new Set();
  /** @type {Map<string, string>} jobId -> mediaId for all active downloads */
  const activeByJob = new Map();

  function formatJobTime(job) {
    if (window.HGR_THEME && typeof window.HGR_THEME.formatJobTime === 'function') {
      return window.HGR_THEME.formatJobTime(job);
    }
    return '';
  }

  function stopTimeTick() {
    if (timeTimer) {
      clearInterval(timeTimer);
      timeTimer = 0;
    }
  }

  function startTimeTick() {
    if (timeTimer) return;
    timeTimer = setInterval(() => {
      if (!jobProgress.size || wrap.getAttribute('data-open') !== '1') {
        stopTimeTick();
        return;
      }
      const first = [...jobProgress.values()][0];
      const clock = formatJobTime(first);
      if (jobProgress.size === 1) {
        const base = metaEl.dataset.base || '';
        metaEl.textContent = [base, clock].filter(Boolean).join(' · ');
      }
    }, 1000);
  }

  function mount() {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
    ensureHighlightStyle();
  }

  function vw() {
    return window.visualViewport ? window.visualViewport.width : window.innerWidth;
  }
  function vh() {
    return window.visualViewport ? window.visualViewport.height : window.innerHeight;
  }
  function vx() {
    return window.visualViewport ? window.visualViewport.offsetLeft : 0;
  }
  function vy() {
    return window.visualViewport ? window.visualViewport.offsetTop : 0;
  }

  function cardSize() {
    const r = card.getBoundingClientRect();
    return {
      w: Math.max(r.width || 0, layout === 'circle' && !expanded ? 72 : 160),
      h: Math.max(r.height || 0, layout === 'circle' && !expanded ? 72 : 48),
    };
  }

  function clampPos(left, top) {
    const { w, h } = cardSize();
    const minL = vx() + EDGE;
    const minT = vy() + EDGE;
    const maxL = vx() + vw() - w - EDGE;
    const maxT = vy() + vh() - h - EDGE;
    return {
      left: Math.round(Math.min(Math.max(minL, left), Math.max(minL, maxL))),
      top: Math.round(Math.min(Math.max(minT, top), Math.max(minT, maxT))),
    };
  }

  function placeAt(left, top, persist) {
    const p = clampPos(left, top);
    wrap.style.setProperty('--dl-left', `${p.left}px`);
    wrap.style.setProperty('--dl-top', `${p.top}px`);
    wrap.setAttribute('data-placed', '1');
    if (persist) {
      savedPos = { ...savedPos, [layout]: { left: p.left, top: p.top } };
      try {
        chrome.storage.local.set({ [POS_KEY]: savedPos });
      } catch (_) {
        // ignore
      }
    }
    return p;
  }

  function applySavedPlace() {
    const p = savedPos[layout];
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      placeAt(p.left, p.top, false);
      return;
    }
    wrap.removeAttribute('data-placed');
    wrap.style.removeProperty('--dl-left');
    wrap.style.removeProperty('--dl-top');
  }

  function reclampPlaced() {
    if (wrap.getAttribute('data-placed') !== '1') return;
    const r = card.getBoundingClientRect();
    if (!r.width && !r.height) return;
    placeAt(r.left, r.top, false);
  }

  function setMorphEnabled(on) {
    morphOn = on !== false;
    wrap.setAttribute('data-morph', morphOn ? '1' : '0');
    if (!morphOn) {
      wrap.classList.remove('is-appearing', 'is-leaving', 'is-morphing');
      wrap.style.transition = '';
      wrap.style.transform = '';
      wrap.style.filter = '';
    }
  }

  function morphEnabled() {
    return (
      morphOn &&
      wrap.getAttribute('data-open') === '1' &&
      !wrap.classList.contains('is-leaving') &&
      !wrap.classList.contains('is-appearing') &&
      !drag
    );
  }

  function clearMorphStyles() {
    wrap.classList.remove('is-morphing');
    wrap.style.transition = '';
    wrap.style.transform = '';
    wrap.style.filter = '';
    wrap.style.transformOrigin = '';
  }

  function runMorph(mutate) {
    if (!morphEnabled()) {
      mutate();
      return;
    }
    const first = wrap.getBoundingClientRect();
    if (!first.width || !first.height) {
      mutate();
      return;
    }
    if (morphTimer) {
      clearTimeout(morphTimer);
      morphTimer = 0;
    }
    wrap.classList.add('is-morphing');
    mutate();
    const last = wrap.getBoundingClientRect();
    if (!last.width || !last.height) {
      clearMorphStyles();
      return;
    }
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) {
      clearMorphStyles();
      return;
    }
    wrap.style.transition = 'none';
    wrap.style.transformOrigin = 'top left';
    wrap.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    wrap.style.filter = 'blur(6px)';
    void wrap.offsetWidth;
    wrap.style.transition = `transform ${MORPH_MS}ms ${SPRING}, filter 380ms ${SPRING}`;
    wrap.style.transform = 'none';
    wrap.style.filter = 'none';
    morphTimer = setTimeout(() => {
      morphTimer = 0;
      clearMorphStyles();
    }, MORPH_MS + 40);
  }

  function setChipOpen(open) {
    const isOpen = wrap.getAttribute('data-open') === '1';
    if (open) {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = 0;
      }
      wrap.classList.remove('is-leaving');
      if (isOpen) return;
      wrap.setAttribute('data-open', '1');
      if (!morphOn) return;
      wrap.classList.remove('is-appearing');
      void wrap.offsetWidth;
      wrap.classList.add('is-appearing');
      const done = () => wrap.classList.remove('is-appearing');
      wrap.addEventListener(
        'animationend',
        (ev) => {
          if (ev.animationName === 'dl-island-in') done();
        },
        { once: true }
      );
      setTimeout(done, 560);
      return;
    }
    if (!isOpen && !wrap.classList.contains('is-leaving')) return;
    wrap.classList.remove('is-appearing');
    if (!morphOn) {
      wrap.classList.remove('is-leaving');
      wrap.setAttribute('data-open', '0');
      return;
    }
    wrap.classList.add('is-leaving');
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      leaveTimer = 0;
      wrap.classList.remove('is-leaving');
      wrap.setAttribute('data-open', '0');
    }, 360);
  }

  function setExpanded(on) {
    const next = !!on;
    const mutate = () => {
      expanded = next;
      if (expanded) wrap.setAttribute('data-expanded', '1');
      else wrap.removeAttribute('data-expanded');
      reclampPlaced();
    };
    if (expanded === next) return;
    runMorph(mutate);
  }

  function applyLayout(next, opts) {
    const id = LAYOUTS.includes(next) ? next : 'bar';
    const mutate = () => {
      layout = id;
      wrap.setAttribute('data-layout', id);
      if (id === 'bar') {
        expanded = false;
        wrap.removeAttribute('data-expanded');
      }
      applySavedPlace();
      reclampPlaced();
    };
    if (opts && opts.instant) {
      mutate();
      return;
    }
    runMorph(mutate);
  }

  function updateCircleFace(job) {
    if (!circleRing || !circlePct) return;
    const many = jobProgress.size > 1;
    const pct = job && job.percent != null ? Number(job.percent) : NaN;
    let shown = pct;
    if (many) {
      const known = [...jobProgress.values()]
        .map((p) => Number(p.percent))
        .filter((n) => Number.isFinite(n));
      shown = known.length ? known.reduce((a, b) => a + b, 0) / known.length : NaN;
    }
    if (Number.isFinite(shown)) {
      circleRing.classList.remove('indeterminate');
      wrap.style.setProperty('--pct', String(Math.max(0, Math.min(100, shown))));
      circlePct.textContent = `${Math.round(shown)}%`;
    } else {
      circleRing.classList.add('indeterminate');
      wrap.style.setProperty('--pct', '28');
      circlePct.textContent = many ? String(jobProgress.size) : '…';
    }
    if (circleCount) {
      const n = Math.max(jobProgress.size, activeByJob.size);
      circleCount.textContent = String(n);
      circleCount.setAttribute('data-on', n > 1 ? '1' : '0');
    }
  }

  function loadLayoutPrefs() {
    try {
      chrome.storage.local.get([LAYOUT_KEY, POS_KEY, MORPH_KEY, MORPH_KEY_LEGACY], (data) => {
        if (chrome.runtime.lastError) return;
        savedPos = data && data[POS_KEY] && typeof data[POS_KEY] === 'object' ? data[POS_KEY] : {};
        const morph =
          data && data[MORPH_KEY] != null
            ? data[MORPH_KEY] !== false
            : !data || data[MORPH_KEY_LEGACY] !== false;
        setMorphEnabled(morph);
        applyLayout((data && data[LAYOUT_KEY]) || 'bar', { instant: true });
      });
    } catch (_) {
      setMorphEnabled(true);
      applyLayout('bar', { instant: true });
    }
  }

  function isDragIgnoreTarget(el) {
    return !!(el && el.closest && el.closest('button, a, input, textarea, select'));
  }

  function ensureHighlightStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    const accent =
      (host && getComputedStyle(host).getPropertyValue('--accent').trim()) || '#0a84ff';
    st.textContent = `
      a.${HIGHLIGHT_CLASS},
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid ${accent} !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 4px color-mix(in srgb, ${accent} 35%, transparent) !important;
        border-radius: 8px !important;
        position: relative !important;
        z-index: 2147483000 !important;
      }
      a.${HIGHLIGHT_CLASS}::after,
      .${HIGHLIGHT_CLASS}::after {
        content: "Downloading";
        position: absolute;
        left: 6px;
        top: 6px;
        z-index: 2147483001;
        padding: 2px 8px;
        border-radius: 980px;
        font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: ${accent};
        color: #fff;
      }
    `;
    document.documentElement.appendChild(st);
  }

  function clearHighlights() {
    for (const el of highlighted) {
      try {
        el.classList.remove(HIGHLIGHT_CLASS);
        el.removeAttribute('data-hls-dl-highlight');
        el.removeAttribute('title');
      } catch (_) {
        // ignore
      }
    }
    highlighted = [];
  }

  /** Pull short media ids from a URL (youtube v=, reel/, etc.). */
  function idsFromAnything(raw) {
    const out = [];
    const s = String(raw || '').trim();
    if (!s) return out;
    out.push(s);
    try {
      const u = new URL(s, location.href);
      const v = u.searchParams.get('v');
      if (v) out.push(v);
      const path = u.pathname || '';
      const pats = [
        /\/(?:shorts|embed|live)\/([^/?#]+)/i,
        /\/(?:reel|p|tv)\/([^/?#]+)/i,
        /\/video\/(\d+)/i,
        /\/status\/(\d+)/i,
        /\/clip\/([^/?#]+)/i,
      ];
      for (const re of pats) {
        const m = path.match(re);
        if (m && m[1]) out.push(m[1]);
      }
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      if (host === 'youtu.be') {
        const seg = path.replace(/^\//, '').split('/')[0];
        if (seg) out.push(seg);
      }
    } catch (_) {
      // not a URL — keep raw string
    }
    return out;
  }

  /**
   * Ids that identify one specific video, for matching against links on the
   * page. Only pattern-extracted ids and whole URLs are used. Picking the
   * shortest string (as this used to) meant a bare number like 12345 became
   * the needle and every link containing those digits lit up.
   */
  function idsForJob(job) {
    const ids = new Set();
    const add = (x) => {
      const t = String(x || '').trim().toLowerCase();
      if (t.length < 6) return; // too short to identify anything on its own
      if (/^(downloading|extracting|playlist|webpage|starting)$/i.test(t)) return;
      ids.add(t);
    };
    add(job && job.mediaId);
    for (const id of idsFromAnything(job && job.streamUrl)) add(id);
    for (const id of idsFromAnything(job && job.pageUrl)) add(id);
    return ids;
  }

  /** Short label for the progress bar, not used for matching. */
  function needleForJob(job) {
    const first = [...idsForJob(job)].sort((a, b) => a.length - b.length)[0];
    return first || '';
  }

  /**
   * A link points at the same video only when it carries the same id, not
   * merely the same characters somewhere in the href.
   */
  function anchorMatches(href, ids) {
    const lc = href.toLowerCase();
    let maybe = false;
    for (const id of ids) {
      if (lc.includes(id)) {
        maybe = true;
        break;
      }
    }
    if (!maybe) return false;
    for (const cand of idsFromAnything(href)) {
      if (ids.has(String(cand).trim().toLowerCase())) return true;
    }
    return false;
  }

  /** Marking more links than this means the id was not specific enough. */
  const MAX_HIGHLIGHTS = 12;
  let lastScanKey = '';

  /**
   * Mark links that point at a video being downloaded right now.
   *
   * Scanning every anchor is expensive, and progress messages arrive many times
   * a second, so this only re-scans when the set of active ids actually
   * changes. A percent tick alone never touches the DOM.
   */
  function highlightActiveJobs(force) {
    const needles = new Set();
    for (const ids of activeByJob.values()) {
      for (const id of ids) needles.add(id);
    }
    const key = [...needles].sort().join('|');
    if (!force && key === lastScanKey) return;
    lastScanKey = key;

    ensureHighlightStyle();
    clearHighlights();
    if (!needles.size) return;

    const anchors = document.querySelectorAll('a[href]');
    const limit = Math.min(anchors.length, 8000);
    const hits = [];
    for (let i = 0; i < limit; i++) {
      const a = anchors[i];
      if (!a || a.closest('[data-hls-grabber-fab],[data-hls-dl-progress],[data-hls-image-dl]')) {
        continue;
      }
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) continue;
      if (!anchorMatches(href, needles)) continue;
      hits.push(a);
      if (hits.length > MAX_HIGHLIGHTS) break;
    }

    // Matching this many links means the id was not specific enough. Marking
    // half the page is worse than marking nothing, so mark nothing.
    if (hits.length > MAX_HIGHLIGHTS) return;

    let scrolled = false;
    for (const a of hits) {
      a.classList.add(HIGHLIGHT_CLASS);
      a.setAttribute('data-hls-dl-highlight', '1');
      a.setAttribute('title', 'Currently downloading this one');
      highlighted.push(a);
      if (!scrolled) {
        scrolled = true;
        try {
          a.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } catch (_) {
          // ignore
        }
      }
    }
  }

  /** jobId -> live numbers, so several downloads each get their own bar. */
  const jobProgress = new Map();
  const rowEls = new Map();
  let listOpen = false;

  function setRowProgress(els, p) {
    const pct = Number(p.percent);
    if (Number.isFinite(pct)) {
      els.fill.classList.remove('indeterminate');
      els.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      els.pct.textContent = `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
    } else {
      els.fill.classList.add('indeterminate');
      els.pct.textContent = p.detail || '…';
    }
    els.name.textContent = p.label || 'Download';
    els.name.title = p.label || '';
  }

  /**
   * One shared bar cannot represent several downloads at once, so past the
   * first job the card grows a collapsible list with a row each.
   */
  function renderJobList() {
    const entries = [...jobProgress.entries()];
    if (entries.length < 2) {
      moreBtn.hidden = true;
      listEl.setAttribute('data-open', '0');
      listEl.textContent = '';
      rowEls.clear();
      return;
    }

    moreBtn.hidden = false;
    moreBtn.textContent = listOpen
      ? 'Hide the other downloads'
      : `Show all ${entries.length} downloads`;
    listEl.setAttribute('data-open', listOpen ? '1' : '0');

    for (const [id, els] of [...rowEls]) {
      if (!jobProgress.has(id)) {
        try {
          els.root.remove();
        } catch (_) {
          // ignore
        }
        rowEls.delete(id);
      }
    }

    for (const [id, p] of entries) {
      let els = rowEls.get(id);
      if (!els) {
        const root = document.createElement('div');
        root.className = 'row';
        const top = document.createElement('div');
        top.className = 'row-top';
        const name = document.createElement('div');
        name.className = 'row-name';
        const pct = document.createElement('div');
        pct.className = 'row-pct';
        top.appendChild(name);
        top.appendChild(pct);
        const track = document.createElement('div');
        track.className = 'row-track';
        const fill = document.createElement('div');
        fill.className = 'row-fill';
        track.appendChild(fill);
        root.appendChild(top);
        root.appendChild(track);
        els = { root, name, pct, fill };
        rowEls.set(id, els);
        listEl.appendChild(root);
      }
      setRowProgress(els, p);
    }
  }

  moreBtn.addEventListener('click', () => {
    runMorph(() => {
      listOpen = !listOpen;
      renderJobList();
      reclampPlaced();
    });
  });

  function showProgress(job) {
    if (!job || dismissed) return;
    mount();
    const status = String(job.status || '');
    const jobId = String(job.id || '');
    const active = ['queued', 'connecting', 'downloading'].includes(status);
    const needle = needleForJob(job);
    if (cancelBtn) cancelBtn.hidden = !active && !jobProgress.size;

    if (!active) {
      if (jobId) {
        activeByJob.delete(jobId);
        jobProgress.delete(jobId);
        dismissedIds.add(jobId);
      }
      renderJobList();
      highlightActiveJobs();
      setChipOpen(true);
      titleEl.textContent = job.label || 'Download';
      subEl.textContent =
        status === 'completed'
          ? 'Saved'
          : status === 'canceled'
            ? 'Canceled'
            : job.error || status || 'Done';
      fillEl.classList.remove('indeterminate');
      fillEl.style.width = status === 'completed' ? '100%' : fillEl.style.width || '0%';
      const clock = formatJobTime(job);
      metaEl.dataset.base = '';
      metaEl.textContent = activeByJob.size
        ? `${activeByJob.size} still downloading`
        : clock;
      if (cancelBtn) cancelBtn.hidden = activeByJob.size === 0;
      updateCircleFace(job);
      if (hideTimer) clearTimeout(hideTimer);
      const hideMs = status === 'canceled' ? 700 : 2800;
      hideTimer = setTimeout(() => {
        if (!activeByJob.size) {
          setChipOpen(false);
          stopTimeTick();
        }
      }, hideMs);
      if (!activeByJob.size) stopTimeTick();
      return;
    }

    if (jobId) {
      const ids = idsForJob(job);
      if (ids.size) activeByJob.set(jobId, ids);
      jobProgress.set(jobId, {
        label: job.label || 'Download',
        percent: job.percent,
        detail: job.detail || '',
        startedAt: job.startedAt,
        playlistIndex: job.playlistIndex,
        playlistCount: job.playlistCount,
      });
    }

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    setChipOpen(true);
    titleEl.textContent = job.label || 'Downloading';
    if (cancelBtn) cancelBtn.hidden = false;

    const many = jobProgress.size > 1;
    const clock = formatJobTime(job);

    if (many) {
      // One bar cannot stand for several downloads, and showing whichever
      // reported last just makes it jump about. Summarise here, details below.
      const all = [...jobProgress.values()];
      const known = all.map((p) => Number(p.percent)).filter((n) => Number.isFinite(n));
      titleEl.textContent = `${all.length} downloads running`;
      subEl.textContent = 'Open the list to see each one';
      if (known.length === all.length) {
        const avg = known.reduce((a, b) => a + b, 0) / known.length;
        fillEl.classList.remove('indeterminate');
        fillEl.style.width = `${Math.max(0, Math.min(100, avg))}%`;
        metaEl.dataset.base = `${avg.toFixed(0)}% overall`;
      } else {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '40%';
        metaEl.dataset.base = `${known.length} of ${all.length} reporting progress`;
      }
      metaEl.textContent = [metaEl.dataset.base, clock].filter(Boolean).join(' · ');
    } else {
      const bits = [];
      if (job.playlistIndex != null && job.playlistCount != null) {
        bits.push(`Playlist item ${job.playlistIndex} of ${job.playlistCount}`);
      }
      if (needle) bits.push(String(needle));
      subEl.textContent = bits.join(' · ') || job.detail || 'Working…';

      const pct = job.percent != null ? Number(job.percent) : NaN;
      if (Number.isFinite(pct)) {
        fillEl.classList.remove('indeterminate');
        fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        metaEl.dataset.base = `${pct.toFixed(pct >= 10 ? 0 : 1)}%${job.detail ? ` · ${job.detail}` : ''}`;
      } else {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '40%';
        metaEl.dataset.base = job.detail || 'Starting…';
      }
      metaEl.textContent = [metaEl.dataset.base, clock].filter(Boolean).join(' · ');
    }

    startTimeTick();
    renderJobList();
    highlightActiveJobs();
    updateCircleFace(job);
    requestAnimationFrame(reclampPlaced);
  }

  closeBtn.addEventListener('click', () => {
    dismissed = true;
    for (const id of jobProgress.keys()) dismissedIds.add(id);
    setChipOpen(false);
    stopTimeTick();
    clearHighlights();
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const entries = [...jobProgress.entries()];
      for (const [id, p] of entries) {
        dismissedIds.add(id);
        try {
          chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', jobId: id });
        } catch (_) {
          // ignore
        }
        showProgress({
          id,
          status: 'canceled',
          label: (p && p.label) || titleEl.textContent,
          startedAt: p && p.startedAt,
        });
      }
    });
  }

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (isDragIgnoreTarget(e.target)) return;
    try {
      card.setPointerCapture(e.pointerId);
    } catch (_) {
      // Firefox / hostile pages may reject capture
    }
    const r = card.getBoundingClientRect();
    drag = {
      pid: e.pointerId,
      ox: e.clientX - r.left,
      oy: e.clientY - r.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: 0,
    };
    card.classList.add('dragging');
  });

  card.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    drag.moved = Math.max(drag.moved, dist);
    if (dist < MOVE_TOLERANCE) return;
    placeAt(e.clientX - drag.ox, e.clientY - drag.oy, false);
  });

  function endDrag(e) {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.pid)) return;
    const moved = drag.moved;
    if (e && e.pointerId != null) {
      try {
        card.releasePointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
    }
    card.classList.remove('dragging');
    const r = card.getBoundingClientRect();
    drag = null;
    if (moved >= MOVE_TOLERANCE) {
      suppressClickUntil = Date.now() + 400;
      placeAt(r.left, r.top, true);
    }
  }

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);

  card.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isDragIgnoreTarget(e.target)) return;
    if (layout === 'circle' || layout === 'pill') {
      setExpanded(!expanded);
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[POS_KEY] && changes[POS_KEY].newValue && typeof changes[POS_KEY].newValue === 'object') {
        savedPos = changes[POS_KEY].newValue;
      }
      if (changes[MORPH_KEY] || changes[MORPH_KEY_LEGACY]) {
        const next = changes[MORPH_KEY]
          ? changes[MORPH_KEY].newValue !== false
          : changes[MORPH_KEY_LEGACY].newValue !== false;
        setMorphEnabled(next);
      }
      if (changes[LAYOUT_KEY]) {
        applyLayout(changes[LAYOUT_KEY].newValue || 'bar');
      } else if (changes[POS_KEY]) {
        applySavedPlace();
      }
    });
  } catch (_) {
    // ignore
  }

  window.addEventListener('resize', () => requestAnimationFrame(reclampPlaced), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => requestAnimationFrame(reclampPlaced), {
      passive: true,
    });
    window.visualViewport.addEventListener('scroll', () => requestAnimationFrame(reclampPlaced), {
      passive: true,
    });
  }

  loadLayoutPrefs();

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'JOB_DOWNLOAD_PROGRESS') return;
    const job = msg.job || {};
    const id = String(job.id || '');
    const status = String(job.status || '');
    if (id && dismissedIds.has(id)) {
      if (['queued', 'connecting', 'downloading'].includes(status)) return;
      if (wrap.getAttribute('data-open') !== '1') return;
    }
    if (id && ['canceled', 'completed', 'error'].includes(status)) {
      dismissedIds.add(id);
    }
    dismissed = false;
    showProgress(job);
  });
})();
