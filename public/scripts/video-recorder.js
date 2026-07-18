(function () {
  if (window.__hlsGrabberVideoRecorder) return;
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

  /** idx -> entry (at most one active when queuing) */
  const recordings = new Map();
  /** @type {{ video: HTMLVideoElement, idx: number, label: string }[]} */
  let recordQueue = [];
  let queueTotal = 0;
  let queueFinished = 0;
  let recording = false;
  let nextIdx = 0;
  let rafId = 0;
  let lastBadgeTick = 0;
  let resizing = false;
  let resizeTimer = 0;
  let resizeToastShown = false;
  let seekModalEntry = null;
  let queueAdvanceTimer = 0;

  /* ───────────────────────── overlay host (shadow DOM, isolated) ───────────────────────── */
  const overlayHost = document.createElement('div');
  overlayHost.setAttribute('data-hls-rec-overlay', '');
  const overlayShadow = overlayHost.attachShadow({ mode: 'open' });
  overlayShadow.innerHTML = `
    <style>
      :host { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483647; }
      .layer { position: absolute; inset: 0; pointer-events: none; }
      .box {
        position: fixed; border: 3px solid #ef4444; border-radius: 8px; box-sizing: border-box;
        box-shadow: 0 0 0 2px rgba(239,68,68,.25), 0 0 22px rgba(239,68,68,.35);
        pointer-events: none; transition: border-color 200ms ease, box-shadow 200ms ease;
      }
      .box.buffer, .box.seek { border-color: #f59e0b; box-shadow: 0 0 0 2px rgba(245,158,11,.25), 0 0 22px rgba(245,158,11,.35); }
      .box.pause { border-color: #94a3b8; box-shadow: 0 0 0 2px rgba(148,163,184,.25); }
      .badge {
        position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px;
        background: rgba(15,23,42,.92); color: #fff;
        font: 600 11px/1.3 Inter, system-ui, "Segoe UI", sans-serif;
        padding: 4px 9px; border-radius: 7px; box-shadow: 0 2px 10px rgba(0,0,0,.35);
        max-width: calc(100% - 16px); white-space: nowrap; overflow: hidden;
      }
      .badge .d { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex: 0 0 auto; animation: recblink 1s infinite; }
      .badge.buffer .d, .badge.seek .d { background: #f59e0b; animation: none; }
      .badge.pause .d { background: #94a3b8; animation: none; }
      .badge .txt { overflow: hidden; text-overflow: ellipsis; }
      @keyframes recblink { 0%,100% { opacity: 1; } 50% { opacity: .2; } }
      .toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        background: rgba(15,23,42,.96); color: #fff;
        font: 500 12px/1.45 Inter, system-ui, "Segoe UI", sans-serif;
        padding: 11px 15px; border-radius: 11px; box-shadow: 0 10px 32px rgba(0,0,0,.4);
        max-width: 380px; border: 1px solid rgba(255,255,255,.12); pointer-events: none;
      }
      .toast[hidden] { display: none; }

      /* Centered, top-most decision modal */
      .modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: auto; }
      .modal[data-open="1"] { display: flex; }
      .modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.6); }
      .sheet {
        position: relative; max-width: 400px; width: calc(100% - 48px);
        background: #161b27; color: #e6e9ef; border: 1px solid #2b3344; border-radius: 16px;
        padding: 22px; box-shadow: 0 28px 70px rgba(0,0,0,.55);
        font: 400 13px/1.5 Inter, system-ui, "Segoe UI", sans-serif;
      }
      .m-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; }
      .m-body { font-size: 13px; color: #aab4c8; line-height: 1.55; margin-bottom: 20px; }
      .m-body b { color: #e6e9ef; }
      .m-actions { display: flex; flex-direction: column; gap: 9px; }
      .m-btn {
        padding: 12px 14px; border-radius: 11px; font: 700 13px Inter, system-ui, sans-serif;
        cursor: pointer; border: 1px solid transparent; text-align: center; transition: filter 140ms ease;
      }
      .m-btn.back { background: linear-gradient(180deg,#4f8cff,#3574f0); color: #fff; }
      .m-btn.override { background: #1c2433; color: #e6e9ef; border-color: #2b3344; }
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
    mTitle.textContent = 'You skipped while recording';
    mBody.innerHTML =
      'Recording is <b>paused</b>. Jumping the playhead would leave a gap in the saved file. ' +
      'Want to go back to where you were, or record from this new spot?';
    mBackBtn.textContent = '↩ Go back & keep recording';
    mOverrideBtn.textContent = 'Record from here (override)';
    modalEl.setAttribute('data-open', '1');
  }
  function closeSeekModal() {
    modalEl.removeAttribute('data-open');
  }
  function resolveSeek(entry, choice) {
    closeSeekModal();
    if (seekModalEntry === entry) seekModalEntry = null;
    if (!recordings.has(entry.idx)) return;
    if (choice === 'back') {
      // Return to the last position before the skip, then continue.
      entry.internalSeek = true;
      try {
        if (typeof entry.lastTime === 'number' && isFinite(entry.lastTime)) {
          entry.video.currentTime = entry.lastTime;
        }
      } catch (_) {}
    }
    entry.seekHold = false;
    try {
      const p = entry.video.play && entry.video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
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
      'Looks like you resized the window. Recording pauses while you do that so the frozen ' +
      'frame stays out of the file, then it picks back up. For the cleanest capture, try not to resize mid-recording.'
    );
  }

  /* ───────────────────────── start / stop one ───────────────────────── */
  function startOne(video, idx) {
    const label = labelForVideo(video, idx);

    // Same path for every site: kick playback, then capture the element's stream.
    try { const p0 = video.play && video.play(); if (p0 && p0.catch) p0.catch(() => {}); } catch (_) {}

    let stream;
    try {
      stream = video.captureStream
        ? video.captureStream()
        : (video.mozCaptureStream ? video.mozCaptureStream() : null);
    } catch (e) {
      return { idx, label, error: 'this video could not be recorded' };
    }
    if (!stream) return { idx, label, error: 'this video could not be recorded' };

    let mime = '';
    for (const m of MIMES) {
      if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    if (!mime) return { idx, label, error: 'no supported recording codec' };

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE });
    } catch (e) {
      return { idx, label, error: String((e && e.message) || e) };
    }

    const ov = createOverlayBox(label);
    const entry = {
      idx, label, video, recorder, mime,
      chunks: [], startedAt: Date.now(), gate: null, reason: 'rec',
      ov, listeners: [],
      buffering: false, seekHold: false, internalSeek: false,
      lastTime: (typeof video.currentTime === 'number' ? video.currentTime : 0),
    };

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) entry.chunks.push(e.data); };
    recorder.onstop = () => finalizeDownload(entry);
    recorder.onerror = () => {};

    const on = (ev, fn) => { video.addEventListener(ev, fn); entry.listeners.push([ev, fn]); };
    const gate = () => applyGate(entry);

    on('waiting', () => { entry.buffering = true; gate(); });
    on('stalled', () => { entry.buffering = true; gate(); });
    on('playing', () => { entry.buffering = false; gate(); });
    on('canplay', () => { entry.buffering = false; gate(); });
    on('canplaythrough', () => { entry.buffering = false; gate(); });
    on('play', gate);
    on('pause', gate);
    on('ratechange', gate);
    on('timeupdate', () => {
      if (!video.seeking && !entry.seekHold) entry.lastTime = video.currentTime;
    });
    on('seeking', () => {
      if (entry.internalSeek) { gate(); return; }      // our own go-back seek
      if (entry.seekHold || seekModalEntry) { gate(); return; } // a decision is already pending
      entry.seekHold = true;
      seekModalEntry = entry;
      gate();                                          // pause immediately
      openSeekModal(entry);
    });
    on('seeked', () => {
      if (entry.internalSeek) entry.internalSeek = false;
      gate();
    });
    on('ended', () => stopOne(idx));

    try {
      recorder.start(1000);
    } catch (e) {
      try { if (ov.box.parentNode) ov.box.parentNode.removeChild(ov.box); } catch (_) {}
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
            `Recording ${pos.current} of ${pos.total}: ${r.label}. Next starts when this one finishes.`,
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
    return null;
  }

  function finalizeDownload(entry) {
    if (!recordings.has(entry.idx)) return;
    recordings.delete(entry.idx);
    queueFinished += 1;
    if (seekModalEntry === entry) { seekModalEntry = null; closeSeekModal(); }
    for (const [ev, fn] of entry.listeners) {
      try { entry.video.removeEventListener(ev, fn); } catch (_) {}
    }
    try { if (entry.ov.box.parentNode) entry.ov.box.parentNode.removeChild(entry.ov.box); } catch (_) {}

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
            showToast(`Finished the queue (${queueFinished} of ${queueTotal}).`, 5000);
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
          showToast(`Finished all recordings (${finished} of ${total}).`, 5000);
        }
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

  /* ───────────────────────── public actions ───────────────────────── */
  function startRecording() {
    if (recording) return { ok: false, error: 'Already recording' };
    const videos = findVideoElements();
    if (!videos.length) return { ok: false, error: 'No video elements found on this page' };

    // Queue every video; record one at a time so captureStream stays reliable.
    recordQueue = [];
    queueTotal = videos.length;
    queueFinished = 0;
    clearQueueAdvanceTimer();
    for (const v of videos) {
      const idx = nextIdx++;
      recordQueue.push({ video: v, idx, label: labelForVideo(v, idx) });
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
      return { ok: false, error: 'Could not start recording on any video', details };
    }

    const pos = queuePosition();
    showToast(
      queueTotal > 1
        ? `Queued ${queueTotal} videos — recording one at a time (${pos.current} of ${queueTotal} now).`
        : 'Recording started. Avoid resizing the window or switching tabs for the cleanest capture.',
      6000
    );
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
    return { ok: true, stopped, cancelled };
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

  // Popup / options (separate contexts) reach us via chrome.tabs.sendMessage.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'VIDEO_RECORDER') return false;
    if (msg.action === 'scan') {
      sendResponse({ ok: true, count: findVideoElements().length, recording });
      return true;
    }
    if (msg.action === 'start') { sendResponse(startRecording()); return true; }
    if (msg.action === 'stop') { sendResponse(stopRecording()); return true; }
    if (msg.action === 'status') { sendResponse(getStatus()); return true; }
    return false;
  });

  // The floating button (fab.js) is a content script in the same isolated world,
  // so it calls these directly — content scripts have no chrome.tabs API.
  window.HLS_VIDEO_REC = {
    scan: () => ({ ok: true, count: findVideoElements().length, recording }),
    start: startRecording,
    stop: stopRecording,
    status: getStatus,
  };

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
    }
  });
})();
