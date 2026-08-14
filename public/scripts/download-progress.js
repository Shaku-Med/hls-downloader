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
        position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 2147483646;
        pointer-events: none; display: none;
        font-family: var(--font);
      }
      .bar-wrap[data-open="1"] { display: block; }
      .card {
        pointer-events: auto;
        max-width: 420px; margin: 0 auto;
        background: color-mix(in srgb, var(--surface) 94%, transparent); color: var(--text);
        border: 0.5px solid var(--line); border-radius: 14px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        padding: 12px 14px 14px;
      }
      .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
      .title { font-size: 13px; font-weight: 700; letter-spacing: -0.01em; color: var(--text); }
      .sub { font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.35; word-break: break-word; }
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
    </style>
    <div class="bar-wrap" part="wrap">
      <div class="card">
        <div class="top">
          <div>
            <div class="title"></div>
            <div class="sub"></div>
          </div>
          <button type="button" class="x" aria-label="Hide">×</button>
        </div>
        <div class="track"><div class="fill"></div></div>
        <div class="meta"></div>
        <button type="button" class="more" hidden></button>
        <div class="list"></div>
      </div>
    </div>
  `;

  const wrap = shadow.querySelector('.bar-wrap');
  const titleEl = shadow.querySelector('.title');
  const subEl = shadow.querySelector('.sub');
  const fillEl = shadow.querySelector('.fill');
  const metaEl = shadow.querySelector('.meta');
  const moreBtn = shadow.querySelector('.more');
  const listEl = shadow.querySelector('.list');
  const closeBtn = shadow.querySelector('.x');

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
  let dismissed = false;
  /** @type {Map<string, string>} jobId -> mediaId for all active downloads */
  const activeByJob = new Map();

  function mount() {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
    ensureHighlightStyle();
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
    listOpen = !listOpen;
    renderJobList();
  });

  function showProgress(job) {
    if (!job || dismissed) return;
    mount();
    const status = String(job.status || '');
    const jobId = String(job.id || '');
    const active = ['queued', 'connecting', 'downloading'].includes(status);
    const needle = needleForJob(job);

    if (!active) {
      if (jobId) {
        activeByJob.delete(jobId);
        jobProgress.delete(jobId);
      }
      renderJobList();
      highlightActiveJobs();
      wrap.setAttribute('data-open', '1');
      titleEl.textContent = job.label || 'Download';
      subEl.textContent =
        status === 'completed'
          ? 'Saved'
          : status === 'canceled'
            ? 'Canceled'
            : job.error || status || 'Done';
      fillEl.classList.remove('indeterminate');
      fillEl.style.width = status === 'completed' ? '100%' : fillEl.style.width || '0%';
      metaEl.textContent = activeByJob.size
        ? `${activeByJob.size} still downloading`
        : '';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!activeByJob.size) wrap.setAttribute('data-open', '0');
      }, 2800);
      return;
    }

    if (jobId) {
      const ids = idsForJob(job);
      if (ids.size) activeByJob.set(jobId, ids);
      jobProgress.set(jobId, {
        label: job.label || 'Download',
        percent: job.percent,
        detail: job.detail || '',
      });
    }

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    wrap.setAttribute('data-open', '1');
    titleEl.textContent = job.label || 'Downloading';

    const many = jobProgress.size > 1;

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
        metaEl.textContent = `${avg.toFixed(0)}% overall`;
      } else {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '40%';
        metaEl.textContent = `${known.length} of ${all.length} reporting progress`;
      }
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
        metaEl.textContent = `${pct.toFixed(pct >= 10 ? 0 : 1)}%${job.detail ? ` · ${job.detail}` : ''}`;
      } else {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '40%';
        metaEl.textContent = job.detail || 'Starting…';
      }
    }

    renderJobList();
    highlightActiveJobs();
  }

  closeBtn.addEventListener('click', () => {
    dismissed = true;
    wrap.setAttribute('data-open', '0');
    clearHighlights();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'JOB_DOWNLOAD_PROGRESS') return;
    dismissed = false;
    showProgress(msg.job || {});
  });
})();
