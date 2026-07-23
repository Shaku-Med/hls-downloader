(function () {
  try {
    if (window.__hlsGrabberVideoRecorder && chrome.runtime && chrome.runtime.id) return;
  } catch (_) {
    // invalidated context — take over from orphaned script
  }
  window.__hlsGrabberVideoRecorder = true;

  const MIMES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const VIDEO_BITRATE = 6_000_000;
  const GATE_SAFETY_MS = 500; // low-frequency safety net (no per-frame thrash)
  const DETACH_KEY = 'recordDetachVideoEnabled';

  /** idx -> entry (at most one active when queuing) */
  const recordings = new Map();
  /** @type {{ video: HTMLVideoElement, idx: number, label: string }[]} */
  let recordQueue = [];
  let queueTotal = 0;
  let queueFinished = 0;
  let recording = false;
  /** Page-order index of the video the user wants to record first. */
  let preferredStartIndex = 0;
  let highlightTimer = 0;
  let highlightVideo = null;
  let highlightPrev = null;
  let nextIdx = 0;
  let rafId = 0;
  let lastBadgeTick = 0;
  let resizing = false;
  let resizeTimer = 0;
  let resizeToastShown = false;
  let seekModalEntry = null;
  let queueAdvanceTimer = 0;
  /** Cached setting — default ON (unset === true). */
  let detachVideoEnabled = true;

  function refreshDetachSetting() {
    try {
      chrome.storage.local.get([DETACH_KEY], (d) => {
        if (chrome.runtime.lastError) return;
        detachVideoEnabled = !(d && d[DETACH_KEY] === false);
      });
    } catch (_) {
      // ignore
    }
  }
  refreshDetachSetting();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[DETACH_KEY]) return;
      detachVideoEnabled = changes[DETACH_KEY].newValue !== false;
    });
  } catch (_) {
    // ignore
  }

  function snapMediaTime(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return 0;
    // Millisecond precision — accurate enough for seek restore without float noise.
    return Math.round(n * 1000) / 1000;
  }

  function fmtMediaClock(t) {
    const s = Math.max(0, snapMediaTime(t));
    const m = Math.floor(s / 60);
    const whole = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    if (ms > 0) return `${m}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    return `${m}:${String(whole).padStart(2, '0')}`;
  }

  /* ───────────────────────── detach video for max-quality capture ───────────────────────── */
  function detachVideoForRecord(video) {
    if (!video || video.getAttribute('data-hls-rec-detached') === '1') return null;
    const placeholder = document.createComment('stuff-grabber-rec-placeholder');
    const parent = video.parentNode;
    if (parent) {
      try {
        parent.insertBefore(placeholder, video);
      } catch (_) {
        // ignore
      }
    }
    const saved = {
      placeholder,
      styleAttr: video.getAttribute('style'),
      controls: !!video.controls,
      playsInline: !!video.playsInline,
    };
    video.setAttribute('data-hls-rec-detached', '1');
    // Fixed fullscreen on top of page chrome; overlay UI stays one layer above.
    video.style.cssText = [
      'position:fixed!important',
      'inset:0!important',
      'left:0!important',
      'top:0!important',
      'right:0!important',
      'bottom:0!important',
      'width:100vw!important',
      'height:100vh!important',
      'max-width:none!important',
      'max-height:none!important',
      'min-width:0!important',
      'min-height:0!important',
      'margin:0!important',
      'padding:0!important',
      'border:none!important',
      'outline:none!important',
      'transform:none!important',
      'filter:none!important',
      'clip:auto!important',
      'clip-path:none!important',
      'object-fit:contain!important',
      'background:#000!important',
      'z-index:2147483645!important',
      'pointer-events:auto!important',
      'visibility:visible!important',
      'opacity:1!important',
      'display:block!important',
    ].join(';');
    try {
      video.controls = true;
    } catch (_) {
      // ignore
    }
    try {
      video.playsInline = true;
    } catch (_) {
      // ignore
    }
    try {
      document.documentElement.appendChild(video);
    } catch (_) {
      try {
        (document.body || document.documentElement).appendChild(video);
      } catch (e2) {
        // leave in place if move fails
      }
    }
    return saved;
  }

  function restoreVideoAfterRecord(video, saved) {
    if (!video || !saved) return;
    try {
      video.removeAttribute('data-hls-rec-detached');
    } catch (_) {
      // ignore
    }
    try {
      if (saved.styleAttr == null || saved.styleAttr === '') video.removeAttribute('style');
      else video.setAttribute('style', saved.styleAttr);
    } catch (_) {
      // ignore
    }
    try {
      video.controls = saved.controls;
    } catch (_) {
      // ignore
    }
    try {
      video.playsInline = saved.playsInline;
    } catch (_) {
      // ignore
    }
    try {
      if (saved.placeholder && saved.placeholder.parentNode) {
        saved.placeholder.parentNode.insertBefore(video, saved.placeholder);
        saved.placeholder.parentNode.removeChild(saved.placeholder);
      }
    } catch (_) {
      // ignore
    }
  }

  /* ───────────────────────── overlay host (shadow DOM, isolated) ───────────────────────── */
  const overlayHost = document.createElement('div');
  overlayHost.setAttribute('data-hls-rec-overlay', '');
  const overlayShadow = overlayHost.attachShadow({ mode: 'open' });
  overlayShadow.innerHTML = `
    <style>
      :host {
        position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483647;
        --bg: #000000;
        --surface: #1c1c1e;
        --surface-2: #2c2c2e;
        --text: #ffffff;
        --muted: #8e8e93;
        --line: rgba(84, 84, 88, 0.65);
        --accent: #0a84ff;
        --accent-2: #409cff;
        --fill: rgba(120, 120, 128, 0.32);
        --danger: #ff453a;
        --shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        --overlay-bg: rgba(0, 0, 0, 0.48);
        --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      }
      :host([data-theme="light"]) {
        --bg: #f2f2f7;
        --surface: #ffffff;
        --surface-2: #f2f2f7;
        --text: #000000;
        --muted: #8e8e93;
        --line: rgba(60, 60, 67, 0.18);
        --accent: #007aff;
        --accent-2: #0a84ff;
        --fill: rgba(120, 120, 128, 0.16);
        --danger: #ff3b30;
        --shadow: 0 12px 40px rgba(0, 0, 0, 0.16);
        --overlay-bg: rgba(0, 0, 0, 0.28);
      }
      .layer { position: absolute; inset: 0; pointer-events: none; }
      .box {
        position: fixed; border: 3px solid var(--danger); border-radius: 8px; box-sizing: border-box;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 25%, transparent), 0 0 22px color-mix(in srgb, var(--danger) 35%, transparent);
        pointer-events: none; transition: border-color 200ms ease, box-shadow 200ms ease;
      }
      .box.buffer, .box.seek { border-color: #ff9f0a; box-shadow: 0 0 0 2px rgba(255,159,10,.25), 0 0 22px rgba(255,159,10,.35); }
      .box.pause { border-color: var(--muted); box-shadow: 0 0 0 2px color-mix(in srgb, var(--muted) 25%, transparent); }
      .badge {
        position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px;
        background: color-mix(in srgb, var(--surface) 92%, transparent); color: var(--text);
        font: 600 11px/1.3 var(--font);
        padding: 4px 9px; border-radius: 7px; box-shadow: var(--shadow);
        max-width: calc(100% - 16px); white-space: nowrap; overflow: hidden;
        border: 0.5px solid var(--line);
      }
      .badge .d { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); flex: 0 0 auto; animation: recblink 1s infinite; }
      .badge.buffer .d, .badge.seek .d { background: #ff9f0a; animation: none; }
      .badge.pause .d { background: var(--muted); animation: none; }
      .badge .txt { overflow: hidden; text-overflow: ellipsis; }
      @keyframes recblink { 0%,100% { opacity: 1; } 50% { opacity: .2; } }
      .toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        background: color-mix(in srgb, var(--surface) 96%, transparent); color: var(--text);
        font: 500 12px/1.45 var(--font);
        padding: 11px 15px; border-radius: 11px; box-shadow: var(--shadow);
        max-width: 380px; border: 0.5px solid var(--line); pointer-events: none;
      }
      .toast[hidden] { display: none; }

      .modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: auto; }
      .modal[data-open="1"] { display: flex; }
      .modal-backdrop { position: absolute; inset: 0; background: var(--overlay-bg); }
      .sheet {
        position: relative; max-width: 400px; width: calc(100% - 48px);
        background: var(--surface); color: var(--text); border: 0.5px solid var(--line); border-radius: 16px;
        padding: 22px; box-shadow: var(--shadow);
        font: 400 13px/1.5 var(--font);
      }
      .m-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; color: var(--text); }
      .m-body { font-size: 13px; color: var(--muted); line-height: 1.55; margin-bottom: 20px; }
      .m-body b { color: var(--text); }
      .m-actions { display: flex; flex-direction: column; gap: 9px; }
      .m-btn {
        padding: 12px 14px; border-radius: 11px; font: 700 13px var(--font);
        cursor: pointer; border: 1px solid transparent; text-align: center; transition: filter 140ms ease;
      }
      .m-btn.back { background: linear-gradient(180deg, var(--accent), var(--accent-2)); color: #fff; }
      .m-btn.override { background: var(--fill); color: var(--text); border-color: var(--line); }
      .m-btn:hover { filter: brightness(1.1); }
    </style>
    <div class="layer"></div>
    <div class="toast" hidden></div>
    <div class="modal">
      <div class="modal-backdrop"></div>
      <div class="sheet">
        <div class="m-title"></div>
        <div class="m-body"></div>
        <div class="m-actions">
          <button class="m-btn back" type="button"></button>
          <button class="m-btn override" type="button"></button>
        </div>
      </div>
    </div>
  `;
  const layer = overlayShadow.querySelector('.layer');
  const toastEl = overlayShadow.querySelector('.toast');
  const modalEl = overlayShadow.querySelector('.modal');
  const mTitle = overlayShadow.querySelector('.m-title');
  const mBody = overlayShadow.querySelector('.m-body');
  const mBackBtn = overlayShadow.querySelector('.m-btn.back');
  const mOverrideBtn = overlayShadow.querySelector('.m-btn.override');
  let toastTimer = 0;

  try {
    if (window.HGR_THEME && window.HGR_THEME.bindLiveThemeHost) {
      window.HGR_THEME.bindLiveThemeHost(overlayHost);
    } else if (window.HGR_THEME && window.HGR_THEME.applyStoredThemeToElement) {
      window.HGR_THEME.applyStoredThemeToElement(overlayHost);
    }
  } catch (_) {
    // ignore
  }

  function mountOverlay() {
    if (!overlayHost.parentNode) document.documentElement.appendChild(overlayHost);
  }
  function unmountOverlay() {
    if (overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
  }
  function showToast(text, ms = 4500) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  /* ───────────────────────── seek decision modal ───────────────────────── */
  function openSeekModal(entry) {
    const from = snapMediaTime(entry.seekResumeTime);
    const to = snapMediaTime(entry.video && entry.video.currentTime);
    mTitle.textContent = 'You skipped ahead';
    mBody.innerHTML =
      'I paused recording and the video so we don’t leave a gap in your file.<br><br>' +
      `You were at <b>${fmtMediaClock(from)}</b>, now you’re at <b>${fmtMediaClock(to)}</b>.<br><br>` +
      'Want to jump back to where you were, or keep going from here?';
    mBackBtn.textContent = 'Go back and keep recording';
    mOverrideBtn.textContent = 'Keep going from here';
    modalEl.setAttribute('data-open', '1');
  }
  function closeSeekModal() {
    modalEl.removeAttribute('data-open');
  }
  function resolveSeek(entry, choice) {
    closeSeekModal();
    if (seekModalEntry === entry) seekModalEntry = null;
    if (!recordings.has(entry.idx)) return;
    const video = entry.video;

    if (choice === 'back') {
      // Restore exact pre-seek media time, then resume only after seeked fires.
      const target = snapMediaTime(entry.seekResumeTime);
      entry.internalSeek = true;
      entry.seekHold = true; // stay gated until seeked + play
      let done = false;
      const finishBack = () => {
        if (done) return;
        done = true;
        try {
          video.removeEventListener('seeked', onSeeked);
        } catch (_) {
          // ignore
        }
        if (entry._seekBackTimer) {
          clearTimeout(entry._seekBackTimer);
          entry._seekBackTimer = 0;
        }
        entry.internalSeek = false;
        entry.seekHold = false;
        entry.lastTime = snapMediaTime(video.currentTime);
        entry.seekResumeTime = entry.lastTime;
        try {
          const p = video.play && video.play();
          if (p && p.catch) p.catch(() => {});
        } catch (_) {
          // ignore
        }
        applyGate(entry);
      };
      const onSeeked = () => {
        const cur = snapMediaTime(video.currentTime);
        if (Math.abs(cur - target) > 0.35 && entry.internalSeek) {
          // Keep waiting briefly — some players settle in two steps.
          return;
        }
        finishBack();
      };
      try {
        video.addEventListener('seeked', onSeeked);
      } catch (_) {
        // ignore
      }
      // Safety timeout if seeked never fires.
      entry._seekBackTimer = setTimeout(finishBack, 2500);
      try {
        video.pause();
      } catch (_) {
        // ignore
      }
      try {
        video.currentTime = target;
      } catch (_) {
        finishBack();
        return;
      }
      // If already at target (no seek needed), seeked may not fire.
      try {
        if (Math.abs(snapMediaTime(video.currentTime) - target) < 0.05 && !video.seeking) {
          finishBack();
        }
      } catch (_) {
        // ignore
      }
      return;
    }

    // Override: accept the new position as the baseline and keep recording.
    entry.seekHold = false;
    entry.internalSeek = false;
    entry.lastTime = snapMediaTime(video.currentTime);
    entry.seekResumeTime = entry.lastTime;
    try {
      const p = video.play && video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      // ignore
    }
    applyGate(entry);
  }
  mBackBtn.addEventListener('click', () => { if (seekModalEntry) resolveSeek(seekModalEntry, 'back'); });
  mOverrideBtn.addEventListener('click', () => { if (seekModalEntry) resolveSeek(seekModalEntry, 'override'); });

  /* ───────────────────────── geometry (handles same-origin iframes) ───────────────────────── */
  function getViewportRect(video) {
    const rect = video.getBoundingClientRect();
    let top = rect.top;
    let left = rect.left;
    let win;
    try { win = video.ownerDocument.defaultView; } catch (_) { win = null; }
    while (win && win !== window) {
      let fe;
      try { fe = win.frameElement; } catch (_) { break; } // cross-origin: stop
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      top += fr.top;
      left += fr.left;
      try { win = win.parent; } catch (_) { break; }
    }
    return { top, left, width: rect.width, height: rect.height };
  }

  /* ───────────────────────── discovery ───────────────────────── */
  function findVideoElements() {
    const videos = [];
    const seen = new Set();
    const collect = (root) => {
      let list;
      try { list = root.querySelectorAll('video'); } catch (_) { return; }
      for (const v of list) {
        if (seen.has(v)) continue;
        seen.add(v);
        videos.push(v);
      }
    };
    collect(document);
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (doc) collect(doc);
      } catch (_) { /* cross-origin */ }
    }
    return videos;
  }

  function labelForVideo(video, idx) {
    const title = document.title || '';
    const src = video.currentSrc || video.src || '';
    let name = title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 2) {
      try {
        const u = new URL(src, location.href);
        name = (u.pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.[^.]+$/, '');
      } catch (_) {
        name = 'video';
      }
    }
    if (name.length > 80) name = name.slice(0, 80);
    return idx > 0 ? `${name} (${idx + 1})` : name;
  }

  function clearVideoHighlight() {
    if (highlightTimer) {
      clearTimeout(highlightTimer);
      highlightTimer = 0;
    }
    const video = highlightVideo;
    const prev = highlightPrev;
    highlightVideo = null;
    highlightPrev = null;
    if (!video || !prev) return;
    try {
      if (prev.outline == null) video.style.removeProperty('outline');
      else video.style.outline = prev.outline;
      if (prev.outlineOffset == null) video.style.removeProperty('outline-offset');
      else video.style.outlineOffset = prev.outlineOffset;
      if (prev.boxShadow == null) video.style.removeProperty('box-shadow');
      else video.style.boxShadow = prev.boxShadow;
      if (prev.transition == null) video.style.removeProperty('transition');
      else video.style.transition = prev.transition;
    } catch (_) {
      // ignore
    }
  }

  function listVideos() {
    const videos = findVideoElements();
    return {
      ok: true,
      count: videos.length,
      // >0 means a cross-origin player is on the page that this frame cannot read.
      blockedFrames: blockedFrameCount(),
      embeddedPlayers: embeddedPlayerUrls(),
      preferredStartIndex,
      recording: recording || recordings.size > 0,
      videos: videos.map((video, index) => {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        const dur = Number.isFinite(video.duration) ? video.duration : 0;
        let meta = `Video ${index + 1}`;
        if (w && h) meta += ` · ${w}×${h}`;
        if (dur > 0) meta += ` · ${fmtClock(Math.round(dur))}`;
        else if (video.paused === false) meta += ' · playing';
        return {
          index,
          label: labelForVideo(video, index),
          meta,
          width: w,
          height: h,
          duration: dur,
          paused: !!video.paused,
        };
      }),
    };
  }

  function frameIsReachable(iframe) {
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      return !!doc;
    } catch (_) {
      return false;
    }
  }

  /** Players embedded from another domain are unreachable from this frame. */
  function blockedFrameCount() {
    let n = 0;
    for (const iframe of document.querySelectorAll('iframe')) {
      if (!frameIsReachable(iframe)) n += 1;
    }
    return n;
  }

  /**
   * Cross-origin iframes we cannot read into, but whose src attribute the parent
   * can still read. Opening one as a top-level tab makes its video reachable.
   * Small frames are skipped so ad/tracking iframes do not show up.
   */
  function embeddedPlayerUrls() {
    const found = [];
    const seen = new Set();
    for (const iframe of document.querySelectorAll('iframe')) {
      if (frameIsReachable(iframe)) continue;
      let rect;
      try {
        rect = iframe.getBoundingClientRect();
      } catch (_) {
        continue;
      }
      // Skip ad/tracker frames, but stay loose enough not to miss a real player.
      if (!rect || rect.width < 120 || rect.height < 80) continue;
      let raw = '';
      try {
        raw = iframe.src || iframe.getAttribute('src') || '';
      } catch (_) {
        continue;
      }
      if (!raw) continue;
      let abs;
      try {
        abs = new URL(raw, location.href);
      } catch (_) {
        continue;
      }
      // Only ever hand back real web pages, never javascript:/data:/blob:.
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      if (seen.has(abs.href)) continue;
      seen.add(abs.href);
      found.push({
        url: abs.href,
        host: abs.hostname.replace(/^www\./, ''),
        area: Math.round(rect.width * rect.height),
      });
    }
    // Biggest frame first: the player is almost always the largest one.
    found.sort((a, b) => b.area - a.area);
    return found.slice(0, 4);
  }

  function noVideoReason() {
    // Only blame an embedded player when we actually found one to point at.
    if (embeddedPlayerUrls().length > 0) {
      return 'This player is embedded from another site, so the page cannot reach it. Open it in its own tab, or use a stream row from the list.';
    }
    if (blockedFrameCount() > 0) {
      return 'No video element is reachable on this page. Use a stream row from the list instead.';
    }
    return 'That video disappeared. Open the list again.';
  }

  function focusVideo(index) {
    const videos = findVideoElements();
    const i = Math.max(0, Math.min(videos.length - 1, Number(index) | 0));
    const video = videos[i];
    if (!video) {
      return { ok: false, error: noVideoReason(), embeddedPlayers: embeddedPlayerUrls() };
    }
    preferredStartIndex = i;
    try {
      video.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_) {
      try { video.scrollIntoView(true); } catch (e2) { /* ignore */ }
    }
    clearVideoHighlight();
    highlightPrev = {
      outline: video.style.outline || null,
      outlineOffset: video.style.outlineOffset || null,
      boxShadow: video.style.boxShadow || null,
      transition: video.style.transition || null,
    };
    highlightVideo = video;
    try {
      video.style.setProperty('transition', 'outline 160ms ease, box-shadow 160ms ease', 'important');
      video.style.setProperty('outline', '3px solid #ff3b30', 'important');
      video.style.setProperty('outline-offset', '4px', 'important');
      video.style.setProperty('box-shadow', '0 0 0 8px rgba(255, 59, 48, 0.28)', 'important');
    } catch (_) {
      // ignore
    }
    highlightTimer = setTimeout(() => clearVideoHighlight(), 3800);
    return {
      ok: true,
      index: i,
      label: labelForVideo(video, i),
      preferredStartIndex,
    };
  }

  function fmtClock(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  /* ───────────────────────── per-recording overlay ───────────────────────── */
  function createOverlayBox(label) {
    const box = document.createElement('div');
    box.className = 'box';
    const badge = document.createElement('div');
    badge.className = 'badge';
    const dot = document.createElement('span');
    dot.className = 'd';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = label;
    badge.appendChild(dot);
    badge.appendChild(txt);
    box.appendChild(badge);
    layer.appendChild(box);
    return { box, badge, txt };
  }

  function setEntryState(entry, gate) {
    if (entry.gate === gate) return; // avoid needless DOM writes (smoother, no flicker)
    entry.gate = gate;
    const cls = gate === 'rec' ? '' : gate;
    entry.ov.box.className = 'box' + (cls ? ' ' + cls : '');
    entry.ov.badge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  function badgeText(entry) {
    const time = fmtClock(Math.round((Date.now() - entry.startedAt) / 1000));
    const r = entry.reason;
    const suffix =
      r === 'buffer' ? ' · buffering' :
      r === 'seek' ? ' · paused (skip)' :
      r === 'resize' ? ' · resizing' :
      r === 'hidden' ? ' · tab hidden' :
      r === 'pause' ? ' · paused' : '';
    return `${entry.label} ${time}${suffix}`;
  }

  function positionOverlay(entry) {
    const r = getViewportRect(entry.video);
    const visible =
      r.width > 0 && r.height > 0 &&
      r.top < window.innerHeight && r.left < window.innerWidth &&
      r.top + r.height > 0 && r.left + r.width > 0;
    const s = entry.ov.box.style;
    if (!visible) { s.display = 'none'; return; }
    s.display = 'block';
    s.left = Math.round(r.left) + 'px';
    s.top = Math.round(r.top) + 'px';
    s.width = Math.round(r.width) + 'px';
    s.height = Math.round(r.height) + 'px';
  }

  function loop() {
    rafId = 0;
    if (recordings.size === 0) return;
    const now = Date.now();
    const tick = now - lastBadgeTick > GATE_SAFETY_MS;
    if (tick) lastBadgeTick = now;
    for (const entry of recordings.values()) {
      positionOverlay(entry); // every frame: smooth border tracking
      // High-frequency playhead stamp so "go back" restores accurate media time.
      if (
        entry.reason === 'rec' &&
        !entry.seekHold &&
        !entry.internalSeek &&
        entry.video &&
        !entry.video.seeking &&
        !entry.video.paused
      ) {
        try {
          entry.lastTime = snapMediaTime(entry.video.currentTime);
          entry.seekResumeTime = entry.lastTime;
        } catch (_) {
          // ignore
        }
      }
      if (tick) {
        applyGate(entry); // low-frequency safety net only — events drive the real transitions
        entry.ov.txt.textContent = badgeText(entry);
      }
    }
    rafId = requestAnimationFrame(loop);
  }
  function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  /* ───────────────────────── recorder gating ─────────────────────────
   * Event-driven. The recorder runs only while playback is genuinely
   * progressing. Buffering, user pause, seek, window resize, and tab-hidden
   * each pause it cleanly so no freeze is baked into the file. Flags (set by
   * media events) drive it — NOT per-frame polling — so it doesn't flicker.
   */
  function gateReasonFor(entry) {
    const v = entry.video;
    if (entry.seekHold) return 'seek';     // waiting for the user's go-back/override choice
    if (document.hidden) return 'hidden';
    if (resizing) return 'resize';
    if (v.seeking) return 'seek';
    if (v.ended) return 'ended';
    if (v.paused) return 'pause';
    if (entry.buffering) return 'buffer';
    return 'rec';
  }
  function visualFor(reason) {
    if (reason === 'rec') return 'rec';
    if (reason === 'buffer') return 'buffer';
    if (reason === 'seek' || reason === 'resize') return 'seek'; // amber
    return 'pause'; // pause | hidden | ended → grey
  }
  function applyGate(entry) {
    const reason = gateReasonFor(entry);
    entry.reason = reason;
    if (reason === 'rec') {
      if (entry.recorder.state === 'paused') { try { entry.recorder.resume(); } catch (_) {} }
    } else if (entry.recorder.state === 'recording') {
      try { entry.recorder.pause(); } catch (_) {}
    }
    setEntryState(entry, visualFor(reason));
  }
  function maybeResizeToast() {
    if (resizeToastShown) return;
    resizeToastShown = true;
    showToast(
      'Looks like you resized the window. I paused so that frozen stretch doesn’t land in your file. ' +
      'It’ll pick back up when you stop. For the cleanest take, try not to resize while recording.'
    );
  }

  /* ───────────────────────── start / stop one ───────────────────────── */
  function startOne(video, idx) {
    const label = labelForVideo(video, idx);

    // Optional: pin the element fullscreen for the cleanest captureStream quality.
    let detachSaved = null;
    if (detachVideoEnabled) {
      try {
        detachSaved = detachVideoForRecord(video);
      } catch (_) {
        detachSaved = null;
      }
    }

    // Same path for every site: kick playback, then capture the element's stream.
    try { const p0 = video.play && video.play(); if (p0 && p0.catch) p0.catch(() => {}); } catch (_) {}

    let stream;
    try {
      stream = video.captureStream
        ? video.captureStream()
        : (video.mozCaptureStream ? video.mozCaptureStream() : null);
    } catch (e) {
      restoreVideoAfterRecord(video, detachSaved);
      return { idx, label, error: 'this video could not be recorded' };
    }
    if (!stream) {
      restoreVideoAfterRecord(video, detachSaved);
      return { idx, label, error: 'this video could not be recorded' };
    }

    let mime = '';
    for (const m of MIMES) {
      if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    if (!mime) {
      restoreVideoAfterRecord(video, detachSaved);
      return { idx, label, error: 'no supported recording codec' };
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE });
    } catch (e) {
      restoreVideoAfterRecord(video, detachSaved);
      return { idx, label, error: String((e && e.message) || e) };
    }

    const ov = createOverlayBox(label);
    const t0 = snapMediaTime(video.currentTime);
    const entry = {
      idx, label, video, recorder, mime,
      chunks: [], startedAt: Date.now(), gate: null, reason: 'rec',
      ov, listeners: [],
      buffering: false, seekHold: false, internalSeek: false,
      lastTime: t0,
      seekResumeTime: t0,
      detachSaved,
      _seekBackTimer: 0,
    };

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) entry.chunks.push(e.data); };
    recorder.onstop = () => finalizeDownload(entry);
    recorder.onerror = () => {};

    const on = (ev, fn) => { video.addEventListener(ev, fn); entry.listeners.push([ev, fn]); };
    const gate = () => applyGate(entry);
    const stampTime = () => {
      if (video.seeking || entry.seekHold || entry.internalSeek) return;
      entry.lastTime = snapMediaTime(video.currentTime);
      entry.seekResumeTime = entry.lastTime;
    };

    on('waiting', () => { entry.buffering = true; gate(); });
    on('stalled', () => { entry.buffering = true; gate(); });
    on('playing', () => { entry.buffering = false; gate(); });
    on('canplay', () => { entry.buffering = false; gate(); });
    on('canplaythrough', () => { entry.buffering = false; gate(); });
    on('play', gate);
    on('pause', gate);
    on('ratechange', gate);
    on('timeupdate', stampTime);
    on('seeking', () => {
      if (entry.internalSeek) { gate(); return; }      // our own go-back seek
      if (entry.seekHold || seekModalEntry) { gate(); return; } // a decision is already pending
      // Ignore tiny scrub jitter — only prompt on real jumps.
      const from = snapMediaTime(entry.lastTime);
      const to = snapMediaTime(video.currentTime);
      if (Math.abs(to - from) < 0.25) {
        gate();
        return;
      }
      // Freeze the last good media time BEFORE the skip lands for an accurate restore.
      entry.seekResumeTime = from;
      entry.seekHold = true;
      seekModalEntry = entry;
      try {
        video.pause(); // pause playback + recording (via gate) while the user decides
      } catch (_) {
        // ignore
      }
      gate();                                          // pause MediaRecorder immediately
      openSeekModal(entry);
    });
    on('seeked', () => {
      if (entry.internalSeek) return; // resolveSeek finishBack owns this path
      gate();
    });
    on('ended', () => stopOne(idx));

    try {
      recorder.start(1000);
    } catch (e) {
      try { if (ov.box.parentNode) ov.box.parentNode.removeChild(ov.box); } catch (_) {}
      restoreVideoAfterRecord(video, detachSaved);
      return { idx, label, error: 'could not start (no active media track yet)' };
    }
    recordings.set(idx, entry);

    // Best-effort: let the app play it through. If autoplay is blocked (no page
    // gesture), the recorder simply waits paused until the user hits play.
    try {
      const p = video.play && video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
    applyGate(entry); // set correct initial recording/paused state

    return { idx, label, ok: true };
  }

  function clearQueueAdvanceTimer() {
    if (queueAdvanceTimer) {
      clearTimeout(queueAdvanceTimer);
      queueAdvanceTimer = 0;
    }
  }

  function queuePosition() {
    // 1-based index of the video currently recording (or just finished slot).
    const current = Math.min(queueTotal, queueFinished + (recordings.size > 0 ? 1 : 0));
    return { current, total: queueTotal, remaining: recordQueue.length };
  }

  /**
   * Start the next queued video only (never multiple at once).
   * Skips videos that fail to start.
   */
  function startNextFromQueue() {
    clearQueueAdvanceTimer();
    while (recordQueue.length) {
      const item = recordQueue.shift();
      if (!item || !item.video || !document.contains(item.video)) continue;
      const r = startOne(item.video, item.idx);
      if (r && r.ok) {
        mountOverlay();
        startLoop();
        const pos = queuePosition();
        if (queueTotal > 1) {
          showToast(
            `Recording ${pos.current} of ${pos.total}: ${r.label}. The next one starts when this finishes.`,
            5000
          );
        }
        return r;
      }
      queueFinished += 1; // count skipped as done for progress
    }
    // Nothing left to record.
    recording = false;
    stopLoop();
    unmountOverlay();
    emitRecState({ reason: 'queue-empty' });
    return null;
  }

  function finalizeDownload(entry) {
    if (!recordings.has(entry.idx)) return;
    recordings.delete(entry.idx);
    queueFinished += 1;
    if (seekModalEntry === entry) { seekModalEntry = null; closeSeekModal(); }
    if (entry._seekBackTimer) {
      clearTimeout(entry._seekBackTimer);
      entry._seekBackTimer = 0;
    }
    for (const [ev, fn] of entry.listeners) {
      try { entry.video.removeEventListener(ev, fn); } catch (_) {}
    }
    try { if (entry.ov.box.parentNode) entry.ov.box.parentNode.removeChild(entry.ov.box); } catch (_) {}
    try {
      restoreVideoAfterRecord(entry.video, entry.detachSaved);
    } catch (_) {
      // ignore
    }

    if (entry.chunks.length) {
      const blob = new Blob(entry.chunks, { type: entry.mime });
      const ext = entry.mime.includes('webm') ? 'webm' : 'mp4';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${entry.label}.${ext}`;
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }

    if (recordings.size === 0) {
      if (recording && recordQueue.length > 0) {
        // Brief gap so the download save can settle before the next capture.
        clearQueueAdvanceTimer();
        queueAdvanceTimer = setTimeout(() => {
          queueAdvanceTimer = 0;
          if (!recording) return;
          if (recordings.size > 0) return;
          const next = startNextFromQueue();
          if (!next && queueTotal > 1) {
            showToast(`All done with the queue (${queueFinished} of ${queueTotal}).`, 5000);
          }
        }, 500);
      } else {
        const total = queueTotal;
        const finished = queueFinished;
        recording = false;
        recordQueue = [];
        stopLoop();
        unmountOverlay();
        if (total > 1 && finished > 0) {
          showToast(`All done. Saved ${finished} of ${total} recordings.`, 5000);
        }
        emitRecState({
          reason: 'finished',
          message: total > 1 && finished > 0
            ? `All done. Saved ${finished} of ${total} recordings.`
            : 'Recording saved.',
        });
      }
    }
  }

  function stopOne(idx) {
    const entry = recordings.get(idx);
    if (!entry) return;
    if (entry.recorder.state !== 'inactive') {
      try { entry.recorder.stop(); } catch (_) { finalizeDownload(entry); }
    } else {
      finalizeDownload(entry);
    }
  }

  /** Tell FAB / other same-world listeners that recording state changed. */
  function emitRecState(extra) {
    const status = getStatus();
    const detail = Object.assign({}, status, extra || {});
    try {
      window.dispatchEvent(new CustomEvent('hls-video-rec', { detail }));
    } catch (_) {
      // ignore
    }
    return detail;
  }

  /* ───────────────────────── public actions ───────────────────────── */
  function startRecording(opts) {
    if (recording) return { ok: false, error: 'Already recording' };
    const videos = findVideoElements();
    if (!videos.length) {
      return {
        ok: false,
        error: noVideoReason(),
        embeddedPlayers: embeddedPlayerUrls(),
      };
    }

    const rawStart = opts && Number.isFinite(Number(opts.startIndex))
      ? Number(opts.startIndex)
      : preferredStartIndex;
    const startIndex = Math.max(0, Math.min(videos.length - 1, rawStart | 0));
    preferredStartIndex = startIndex;

    // Selected video first, then the rest in page order.
    const ordered = [videos[startIndex]];
    for (let i = 0; i < videos.length; i++) {
      if (i !== startIndex) ordered.push(videos[i]);
    }

    // Queue every video; record one at a time so captureStream stays reliable.
    recordQueue = [];
    queueTotal = ordered.length;
    queueFinished = 0;
    clearQueueAdvanceTimer();
    clearVideoHighlight();
    for (let oi = 0; oi < ordered.length; oi++) {
      const v = ordered[oi];
      const pageIdx = videos.indexOf(v);
      const idx = nextIdx++;
      recordQueue.push({
        video: v,
        idx,
        label: labelForVideo(v, pageIdx >= 0 ? pageIdx : oi),
      });
    }

    recording = true;
    resizing = false;
    resizeToastShown = false;
    mountOverlay();
    startLoop();

    const details = [];
    const first = startNextFromQueue();
    if (first) details.push(first);

    if (!first || !first.ok) {
      recording = false;
      recordQueue = [];
      stopLoop();
      unmountOverlay();
      return { ok: false, error: 'Couldn’t get a recording going on any of these videos', details };
    }

    const pos = queuePosition();
    showToast(
      queueTotal > 1
        ? `Got ${queueTotal} videos lined up. Recording them one by one (${pos.current} of ${queueTotal} now).`
        : 'Recording started. Leave the window alone and stay on this tab for the cleanest take.',
      6000
    );
    emitRecState({ reason: 'start' });
    return {
      ok: true,
      count: 1,
      total: queueTotal,
      queued: true,
      sequential: true,
      position: pos.current,
      remaining: recordQueue.length,
      details,
    };
  }

  function stopRecording() {
    if (!recording && recordings.size === 0 && !recordQueue.length) {
      return { ok: false, error: 'Not recording' };
    }
    // Cancel anything still waiting, then stop the active capture.
    const cancelled = recordQueue.length;
    recordQueue = [];
    clearQueueAdvanceTimer();
    const stopped = [];
    for (const entry of Array.from(recordings.values())) {
      stopped.push({
        idx: entry.idx,
        label: entry.label,
        duration: Math.round((Date.now() - entry.startedAt) / 1000),
      });
      stopOne(entry.idx);
    }
    recording = false;
    const result = { ok: true, stopped, cancelled };
    // Force recording:false — MediaRecorder.onstop may still be clearing the Map.
    emitRecState({
      reason: 'stop',
      recording: false,
      message: stopped.length
        ? `Saved ${stopped.length} recording${stopped.length > 1 ? 's' : ''}`
        : 'Stopped',
    });
    return result;
  }

  function getStatus() {
    const active = [];
    for (const entry of recordings.values()) {
      active.push({
        idx: entry.idx,
        label: entry.label,
        elapsed: Math.round((Date.now() - entry.startedAt) / 1000),
        state: entry.recorder.state,
        gate: entry.gate,
        reason: entry.reason,
      });
    }
    const pos = queuePosition();
    return {
      recording: recording || recordings.size > 0,
      videoCount: findVideoElements().length,
      active,
      sequential: queueTotal > 1,
      queueTotal,
      queueFinished,
      queueRemaining: recordQueue.length,
      position: pos.current,
      total: pos.total || findVideoElements().length,
    };
  }

  function scanVideos() {
    const st = getStatus();
    const listed = listVideos();
    return {
      ok: true,
      count: st.videoCount,
      recording: st.recording,
      sequential: st.sequential,
      total: st.total,
      position: st.position,
      remaining: st.queueRemaining,
      preferredStartIndex: listed.preferredStartIndex,
      videos: listed.videos,
      blockedFrames: listed.blockedFrames,
      embeddedPlayers: listed.embeddedPlayers,
    };
  }

  // Popup / options (separate contexts) reach us via chrome.tabs.sendMessage.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'VIDEO_RECORDER') return false;
    if (msg.action === 'scan') {
      sendResponse(scanVideos());
      return true;
    }
    if (msg.action === 'list') { sendResponse(listVideos()); return true; }
    if (msg.action === 'focus') {
      sendResponse(focusVideo(msg.index));
      return true;
    }
    if (msg.action === 'start') {
      sendResponse(startRecording({ startIndex: msg.startIndex }));
      return true;
    }
    if (msg.action === 'stop') { sendResponse(stopRecording()); return true; }
    if (msg.action === 'status') { sendResponse(getStatus()); return true; }
    return false;
  });

  // The floating button (fab.js) is a content script in the same isolated world,
  // so it calls these directly — content scripts have no chrome.tabs API.
  window.HLS_VIDEO_REC = {
    scan: scanVideos,
    list: listVideos,
    focus: focusVideo,
    start: (opts) => startRecording(opts || {}),
    stop: stopRecording,
    status: getStatus,
  };

  const isTopFrame = (() => {
    try {
      return window.top === window.self;
    } catch (_) {
      return false;
    }
  })();

  /**
   * This runs in every frame. Sub-frames announce themselves so the background
   * learns their frameId and can reach an embedded player directly, which the
   * top frame cannot do across origins.
   */
  function announceFrame() {
    if (isTopFrame) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'RECORDER_FRAME_READY',
          url: String(location.href || '').slice(0, 500),
          videoCount: findVideoElements().length,
        },
        () => void chrome.runtime.lastError
      );
    } catch (_) {
      // Extension reloaded; the next scan re-announces.
    }
  }

  announceFrame();
  // Players often attach their <video> well after document_idle.
  setTimeout(announceFrame, 1500);
  setTimeout(announceFrame, 5000);

  // Window resize: pause all active recordings during the resize burst, resume
  // once it settles (debounced). Avoids freeze-on-resize getting into the file.
  function onWindowResize() {
    if (recordings.size === 0) return;
    resizing = true;
    maybeResizeToast();
    for (const e of recordings.values()) applyGate(e);
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizing = false;
      for (const e of recordings.values()) applyGate(e);
    }, 600);
  }
  function onVisibilityChange() {
    for (const e of recordings.values()) applyGate(e);
  }
  window.addEventListener('resize', onWindowResize, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  window.addEventListener('pagehide', () => {
    if (recording || recordings.size || recordQueue.length) {
      recordQueue = [];
      clearQueueAdvanceTimer();
      recording = false;
      for (const entry of Array.from(recordings.values())) stopOne(entry.idx);
      emitRecState({ reason: 'pagehide', recording: false });
    }
  });
})();
