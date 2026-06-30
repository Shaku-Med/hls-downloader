(function () {
  if (window.__hlsGrabberFabLoader) return;
  window.__hlsGrabberFabLoader = true;

  const FLOAT_KEY = 'floatGrabberEnabled';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
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
    if (area === 'local' && (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY])) {
      const host = document.querySelector('[data-hls-grabber-fab]');
      if (host) {
        unmountGrabberUi();
        mountGrabberUi();
      }
    }
  });

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
    if (document.querySelector('[data-hls-grabber-fab]')) return;

    const ac = new AbortController();
    const { signal } = ac;

    const host = document.createElement('div');
  host.setAttribute('data-hls-grabber-fab', '');
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
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

  document.documentElement.appendChild(host);
  host.style.setProperty('--fab-size', `${FAB_SIZE}px`);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('style/fab.css');
  shadow.prepend(link);

  const fab = shadow.querySelector('.fab');
  const panel = shadow.querySelector('.panel');
  const fabPath = shadow.getElementById('fab-path');
  const fabJobs = shadow.getElementById('fab-jobs');
  const fabStreams = shadow.getElementById('fab-streams');
  const fabImages = shadow.getElementById('fab-images');
  const closeBtn = shadow.querySelector('.close-p');

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
          fabPath.textContent = 'No save folder. Use extension Options.';
          fabPath.classList.add('bad');
        }
      }
      renderJobs(response.jobs || [], response);
      renderStreams(response.streams || [], response.pageTitle || '', hasPath);
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
        let detail = job.detail || job.error || '';
        if (job.ffmpegPreset && ['queued', 'connecting', 'downloading'].includes(job.status)) {
          detail = detail ? `${detail} · preset ${job.ffmpegPreset}` : `preset ${job.ffmpegPreset}`;
        }
        d.textContent = detail;
      }
      card.appendChild(t);
      card.appendChild(d);
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
      const pageOnly = stream.pageDownload === true;
      const defaultName = defaultFileName(i, n, pageTitle, url);

      const card = document.createElement('div');
      card.className = 'stream-card';
      const h = document.createElement('div');
      h.className = 'kind';
      h.textContent = pageOnly
        ? 'Download this video'
        : n > 1
          ? `Stream ${i + 1} of ${n}${kind ? ` (${kind})` : ''}`
          : kind || 'Stream';
      const u = document.createElement('div');
      u.className = 'url';
      if (pageOnly) {
        const intro = document.createElement('div');
        intro.className = 'stream-page-intro';
        intro.textContent =
          'Social media: yt-dlp uses the page URL below (not a separate stream link).';
        const link = document.createElement('div');
        link.className = 'stream-page-link';
        link.textContent = url;
        u.appendChild(intro);
        u.appendChild(link);
      } else {
        u.textContent = url;
      }
      const row = document.createElement('div');
      row.className = 'fn-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultName;
      input.readOnly = !hasPath;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl';
      if (!hasPath) btn.disabled = true;
      btn.textContent = pageOnly ? 'Download this' : 'Download';
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
          btn.textContent = pageOnly ? 'Download this' : 'Download';
        };

        const startCookieAndDl = (plPick) => {
          let effUrl = url;
          let effPage = '';
          let effRef = '';
          let effOrigin = '';
          let plDl = false;
          if (isHttpUrl(tabUrl)) {
            effPage = tabUrl;
            effRef = tabUrl;
            try {
              effOrigin = new URL(tabUrl).origin;
            } catch (_) {}
          }
          if (pageOnly && kind === 'yt' && YT && YT.isYoutubePage(tabUrl)) {
            const yChoice = plPick === 'playlist' ? 'playlist' : 'single';
            const a = YT.applyYoutubeChoice(tabUrl, yChoice);
            effUrl = a.targetUrl;
            effPage = a.pageUrl;
            effRef = a.referer;
            effOrigin = a.origin || effOrigin;
            plDl = !!a.ytDlpDownloadPlaylist;
          } else if (!isHttpUrl(tabUrl)) {
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
    });
  }

  function renderImages(hasPath) {
    if (!fabImages) return;
    fabImages.textContent = '';
    const api = typeof window !== 'undefined' ? window.HLS_IMAGE_DL : null;
    if (!api || typeof api.listImages !== 'function' || typeof api.downloadUrlAs !== 'function') return;

    const imgs = api.listImages() || [];
    if (!imgs.length) return;

    const head = document.createElement('div');
    head.className = 'kind';
    head.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:6px 0 8px;';
    head.textContent = `Images on page (${imgs.length})`;
    fabImages.appendChild(head);

    const mkRow = (img, idx) => {
      const card = document.createElement('div');
      card.className = 'stream-card';

      const title = document.createElement('div');
      title.className = 'kind';
      const dim = img.w && img.h ? ` · ${img.w}×${img.h}` : '';
      title.textContent = `Image ${idx + 1}${dim}`;

      const line = document.createElement('div');
      line.className = 'url';
      line.textContent = img.url;

      const preview = document.createElement('img');
      preview.src = img.url;
      preview.alt = img.alt || '';
      preview.referrerPolicy = 'no-referrer';
      preview.style.cssText =
        'width:100%;max-height:140px;object-fit:contain;border-radius:8px;margin-top:8px;border:1px solid var(--line);background:var(--bg);';

      const row = document.createElement('div');
      row.className = 'fn-row';

      const sel = document.createElement('select');
      sel.className = 'img-fmt-select';
      sel.innerHTML = `
        <option value="png">PNG</option>
        <option value="jpg">JPG</option>
        <option value="jpeg">JPEG</option>
        <option value="webp">WEBP</option>
      `;

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
        btn.disabled = true;
        btn.textContent = '…';
        const stem = (img.alt && img.alt.trim()) || `image_${idx + 1}`;
        Promise.resolve(api.downloadUrlAs(img.url, sel.value, stem))
          .catch(() => {})
          .finally(() => {
            btn.disabled = false;
            btn.textContent = 'Download';
          });
      });

      row.appendChild(sel);
      row.appendChild(btn);

      card.appendChild(title);
      card.appendChild(line);
      card.appendChild(preview);
      card.appendChild(row);
      return card;
    };

    imgs.forEach((img, i) => fabImages.appendChild(mkRow(img, i)));
  }

  function onFabStorageChanged(changes, area) {
    if (area === 'local' && changes.userDownloadPath) {
      if (panel.classList.contains('open')) refreshAll();
      else refreshBadgeOnly();
      return;
    }
    if (area === 'session' && changes[JOBS_KEY]) {
      if (panel.classList.contains('open')) refreshPanelJobsOnly();
      else refreshBadgeOnly();
    }
  }
  chrome.storage.onChanged.addListener(onFabStorageChanged);

  fabCtl.closePanel = () => setPanelOpen(false);
  fabCtl.liveRefresh = () => {
    refreshBadgeOnly();
    if (panel.classList.contains('open')) refreshPanelJobsOnly();
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
      const lines = (res.active || []).map((a) => `${a.label}: ${fabFormatElapsed(a.elapsed)}`);
      fabRecStatus.textContent = lines.join(' · ') || 'Recording…';
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
            const fail = (res.details || []).filter((d) => !d.ok);
            let m = `Recording ${res.count} of ${res.total} video${res.total > 1 ? 's' : ''}`;
            if (fail.length) m += ` · ${fail.length} skipped`;
            fabRecStatus.textContent = m;
            if (!fabRecPoll) fabRecPoll = setInterval(fabUpdateRecStatus, 1000);
          } else {
            fabRecStatus.textContent = res?.error || 'No videos found';
          }
        });
      }
    });
  }

  loadPos(() => {
    refreshBadgeOnly();
    fabRecScan();
  });
  }

  syncFloatPreference();
})();
