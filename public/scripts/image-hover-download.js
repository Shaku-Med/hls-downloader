(function () {
  if (window.__hlsGrabberImageHoverDownload) return;
  window.__hlsGrabberImageHoverDownload = true;

  const ENABLE_KEY = 'imageHoverDownloadEnabled';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
  const MIN_SIZE = 28;
  const HIDE_DELAY_MS = 180;
  // How long the pointer must rest on a *different* image before the popover
  // moves to it. Stops neighbouring grid thumbnails from stealing focus while
  // you're just on your way to click Download.
  const SWITCH_DELAY_MS = 220;
  const MAX_LIST = 80;
  const MAX_HOVER_SCAN = 220;
  const BOX_REFRESH_MS = 450;

  const st = {
    enabled: false,
    hoveringUi: false,
    hoveringImg: false,
    activeImg: null,
    hideTimer: null,
  };

  const host = document.createElement('div');
  host.setAttribute('data-hls-image-dl', '');
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .hl {
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        border: 2px solid var(--sg-accent, #2563eb);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
        border-radius: 10px;
        display: none;
      }
      .pop {
        position: fixed;
        z-index: 2147483647;
        display: none;
        padding: 12px 12px;
        border-radius: 14px;
        background: var(--sg-surface, rgba(15, 23, 42, 0.92));
        color: var(--sg-text, #fff);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 18px 48px rgba(0,0,0,.28), 0 6px 18px rgba(0,0,0,.18);
        min-width: 220px;
        max-width: 320px;
        backdrop-filter: blur(10px);
        border: 1px solid var(--sg-line, rgba(255,255,255,.16));
      }
      .row1 { display:flex; align-items:center; justify-content:space-between; gap: 10px; margin-bottom: 10px; }
      .t {
        font-size: 12px;
        color: var(--sg-text, #fff);
        font-weight: 650;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .x {
        border: none;
        background: transparent;
        color: var(--sg-muted, rgba(255,255,255,.78));
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 8px;
      }
      .x:hover { background: rgba(255,255,255,.12); color: var(--sg-text, #fff); }
      .row2 { display:flex; gap: 8px; align-items: center; }
      select {
        flex: 1;
        padding: 9px 10px;
        border-radius: 12px;
        border: 1px solid var(--sg-line, rgba(255,255,255,.16));
        background: rgba(255,255,255,.08);
        color: var(--sg-text, #fff);
        font-size: 12px;
        outline: none;
      }
      :host([data-theme-mode="page"]) select {
        background: var(--sg-accent);
        color: var(--sg-btnText);
        border-color: color-mix(in srgb, var(--sg-accent) 72%, var(--sg-line) 28%);
      }
      :host([data-theme-mode="page"]) select option {
        background: var(--sg-accent);
        color: var(--sg-btnText);
      }
      button.dl {
        padding: 9px 12px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--sg-accent) 70%, transparent 30%);
        background: linear-gradient(180deg, var(--sg-accent, #2563eb) 0%, var(--sg-accent-2, #1d4ed8) 100%);
        color: var(--sg-btnText, #fff);
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
      }
      button.dl:disabled { opacity: .6; cursor: default; }
      .sub {
        margin-top: 8px;
        font-size: 11px;
        color: var(--sg-muted, rgba(255,255,255,.72));
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      a, a:visited { color: rgba(147, 197, 253, 1); }
    </style>
    <div class="hl" part="highlight"></div>
    <div class="pop" part="popover" role="dialog" aria-label="Download image">
      <div class="row1">
        <div class="t" id="t"></div>
        <button class="x" id="x" type="button" aria-label="Close">×</button>
      </div>
      <div class="row2">
        <select id="fmt" aria-label="Format">
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WEBP</option>
        </select>
        <button class="dl" id="dl" type="button">Download</button>
      </div>
      <div class="sub" id="sub"></div>
    </div>
  `;

  const elHL = shadow.querySelector('.hl');
  const elPop = shadow.querySelector('.pop');
  const elTitle = shadow.getElementById('t');
  const elSub = shadow.getElementById('sub');
  const elFmt = shadow.getElementById('fmt');
  const elDl = shadow.getElementById('dl');
  const elClose = shadow.getElementById('x');

  function applyTheme(mode, accent) {
    const themeApi = window.HGR_THEME;
    const varMap = {
      bg: '--sg-bg',
      surface: '--sg-surface',
      text: '--sg-text',
      muted: '--sg-muted',
      line: '--sg-line',
      accent: '--sg-accent',
      accent2: '--sg-accent-2',
      btnText: '--sg-btnText',
    };
    let resolved = 'dark';
    if (themeApi) {
      resolved = themeApi.applyThemeToHost(host, mode, accent, varMap);
    }
    updateImageHoverChrome(resolved, mode);
  }

  function updateImageHoverChrome(resolved, mode) {
    elHL.style.borderColor = 'var(--sg-accent, #2563eb)';
    elHL.style.boxShadow =
      mode === 'page'
        ? '0 0 0 3px color-mix(in srgb, var(--sg-accent) 22%, transparent)'
        : resolved === 'dark'
          ? '0 0 0 3px rgba(255,255,255,.08)'
          : '0 0 0 3px rgba(37,99,235,.18)';
  }

  let unbindImageTheme = null;
  if (window.HGR_THEME && window.HGR_THEME.bindLiveThemeHost) {
    unbindImageTheme = window.HGR_THEME.bindLiveThemeHost(
      host,
      {
        bg: '--sg-bg',
        surface: '--sg-surface',
        text: '--sg-text',
        muted: '--sg-muted',
        line: '--sg-line',
        accent: '--sg-accent',
        accent2: '--sg-accent-2',
        btnText: '--sg-btnText',
      },
      (resolved, mode) => updateImageHoverChrome(resolved, mode)
    );
  } else {
    chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
      if (chrome.runtime.lastError) return;
      applyTheme(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY]) {
        chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
          if (chrome.runtime.lastError) return;
          applyTheme(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
        });
      }
    });
  }

  function isImgGood(img) {
    if (!img) return false;
    if (img.tagName !== 'IMG') return false;
    const r = img.getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
    return true;
  }

  function pickImgUrl(img) {
    const u = (img.currentSrc || img.src || '').trim();
    return u;
  }

  function sanitizeFileStem(s) {
    let t = String(s || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    t = t.replace(/^\.+|\.+$/g, '');
    if (t.length > 80) t = t.slice(0, 80).trim();
    return t || 'image';
  }

  function fileStemFromImg(img, url) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt && alt.length >= 3) return sanitizeFileStem(alt);
    try {
      const u = new URL(url, location.href);
      const p = u.pathname.split('/').filter(Boolean);
      const last = p[p.length - 1] || 'image';
      const base = last.replace(/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i, '');
      return sanitizeFileStem(base);
    } catch (_) {
      return 'image';
    }
  }

  function prettyUrl(url) {
    const raw = (url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return 'data:image';
    try {
      const u = new URL(raw, location.href);
      const hostPart = u.host;
      const path = u.pathname || '/';
      const last = path.split('/').filter(Boolean).slice(-2).join('/');
      const q = u.search ? '…' : '';
      const s = `${hostPart}/${last || ''}${q}`;
      return s.length > 90 ? s.slice(0, 88) + '…' : s;
    } catch (_) {
      return raw.length > 90 ? raw.slice(0, 88) + '…' : raw;
    }
  }

  function setVisible(on) {
    elHL.style.display = on ? 'block' : 'none';
    elPop.style.display = on ? 'block' : 'none';
  }

  function scheduleHide() {
    if (st.hideTimer) window.clearTimeout(st.hideTimer);
    st.hideTimer = window.setTimeout(() => {
      st.hideTimer = null;
      if (!st.hoveringImg && !st.hoveringUi) {
        st.activeImg = null;
        setVisible(false);
      }
    }, HIDE_DELAY_MS);
  }

  function positionUi(img) {
    const r = img.getBoundingClientRect();
    const pad = 3;
    elHL.style.left = `${Math.max(0, Math.round(r.left - pad))}px`;
    elHL.style.top = `${Math.max(0, Math.round(r.top - pad))}px`;
    elHL.style.width = `${Math.max(0, Math.round(r.width + pad * 2))}px`;
    elHL.style.height = `${Math.max(0, Math.round(r.height + pad * 2))}px`;

    const edge = 10;
    const gap = 10;
    const wasHidden = elPop.style.display === 'none';
    if (wasHidden) {
      elPop.style.display = 'block';
      elPop.style.visibility = 'hidden';
    }
    const pw = Math.min(elPop.offsetWidth || 260, Math.max(220, window.innerWidth - edge * 2));
    const ph = Math.min(elPop.offsetHeight || 110, Math.max(90, window.innerHeight - edge * 2));
    if (wasHidden) {
      elPop.style.visibility = '';
    }
    let left = r.left + gap;
    let top = r.top - ph - gap;
    if (top < edge) top = r.bottom + gap;
    if (left + pw > window.innerWidth - edge) left = window.innerWidth - edge - pw;
    if (left < edge) left = edge;
    if (top + ph > window.innerHeight - edge) top = window.innerHeight - edge - ph;
    if (top < edge) top = edge;
    elPop.style.left = `${Math.round(left)}px`;
    elPop.style.top = `${Math.round(top)}px`;
  }

  async function fetchAsBlob(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  }

  function extFromMime(mime) {
    const m = (mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('svg')) return 'svg';
    return '';
  }

  function mimeFromFormat(fmt) {
    const f = String(fmt || '').toLowerCase();
    if (f === 'png') return 'image/png';
    if (f === 'webp') return 'image/webp';
    if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
    return 'image/png';
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function extFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const p = u.pathname || '';
      const m = p.match(/\.([a-z0-9]{2,5})$/i);
      if (!m) return '';
      const e = m[1].toLowerCase();
      if (e === 'jpeg') return 'jpg';
      return e;
    } catch (_) {
      return '';
    }
  }

  function requestBackgroundUrlDownload(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_IMAGE_URL', url, filename }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error((res && res.error) || 'Download failed'));
          return;
        }
        resolve(res);
      });
    });
  }

  async function convertImageBlob(blob, fmt) {
    const mime = mimeFromFormat(fmt);
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('No canvas ctx');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const out = await new Promise((resolve, reject) => {
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        mime,
        mime === 'image/jpeg' ? 0.92 : undefined
      );
    });
    return out;
  }

  async function downloadUrlAs(url, fmt, stemHint) {
    const safeFmt = (fmt || 'png').toLowerCase();
    const stem = sanitizeFileStem(stemHint) || 'image';
    if (!url) return;
    try {
      if (url.startsWith('data:')) {
        const blob = await (await fetch(url)).blob();
        const srcExt = extFromMime(blob.type) || 'png';
        const outExt = safeFmt || srcExt;
        const outBlob = outExt === srcExt ? blob : await convertImageBlob(blob, outExt);
        downloadBlob(outBlob, `${stem}.${outExt}`);
        return;
      }
      const blob = await fetchAsBlob(url);
      const srcExt = extFromMime(blob.type);
      const outExt = safeFmt || (srcExt || 'png');
      const outBlob =
        srcExt && (outExt === srcExt || (outExt === 'jpeg' && srcExt === 'jpg')) ? blob : await convertImageBlob(blob, outExt);
      downloadBlob(outBlob, `${stem}.${outExt === 'jpeg' ? 'jpg' : outExt}`);
    } catch (e) {
      const fallbackExt = extFromUrl(url) || 'jpg';
      await requestBackgroundUrlDownload(url, `${stem}.${fallbackExt}`);
    }
  }

  async function handleDownloadClick() {
    const img = st.activeImg;
    if (!img) return;
    const fmt = elFmt.value || 'png';
    const url = pickImgUrl(img);
    if (!url) return;

    elDl.disabled = true;
    elDl.textContent = 'Working…';
    try {
      if (url.startsWith('data:')) {
        const blob = await (await fetch(url)).blob();
        const stem = fileStemFromImg(img, url);
        const srcExt = extFromMime(blob.type) || 'png';
        const outExt = fmt || srcExt;
        const outBlob = outExt === srcExt ? blob : await convertImageBlob(blob, outExt);
        downloadBlob(outBlob, `${stem}.${outExt}`);
        return;
      }

      const blob = await fetchAsBlob(url);
      const stem = fileStemFromImg(img, url);
      const srcExt = extFromMime(blob.type);
      const outExt = fmt || (srcExt || 'png');

      const outBlob = (srcExt && (outExt === srcExt || (outExt === 'jpeg' && srcExt === 'jpg'))) ? blob : await convertImageBlob(blob, outExt);
      downloadBlob(outBlob, `${stem}.${outExt === 'jpeg' ? 'jpg' : outExt}`);
    } catch (e) {
      try {
        const stem = fileStemFromImg(img, url);
        const fallbackExt = extFromUrl(url) || 'jpg';
        await requestBackgroundUrlDownload(url, `${stem}.${fallbackExt}`);
      } catch (_) {
        console.warn('Image download failed', e);
      }
    } finally {
      elDl.disabled = false;
      elDl.textContent = 'Download';
    }
  }

  function listImages() {
    const out = [];
    const seen = new Set();
    for (const img of Array.from(document.images || [])) {
      if (!(img instanceof HTMLImageElement)) continue;
      if (!isImgGood(img)) continue;
      const url = pickImgUrl(img);
      if (!url || !/^https?:|^data:/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        alt: (img.getAttribute('alt') || '').trim(),
        w: img.naturalWidth || Math.round(img.getBoundingClientRect().width),
        h: img.naturalHeight || Math.round(img.getBoundingClientRect().height),
      });
      if (out.length >= MAX_LIST) break;
    }
    return out;
  }

  function showFor(img) {
    if (!isImgGood(img)) return;
    st.activeImg = img;
    const url = pickImgUrl(img);
    const stem = fileStemFromImg(img, url);
    elTitle.textContent = stem;
    elSub.textContent = prettyUrl(url);
    positionUi(img);
    setVisible(true);
  }

  let _boxes = [];
  let _lastBoxesAt = 0;
  let _rafId = 0;
  let _lastHoverUrl = '';
  let _switchTimer = 0;
  let _pendingImg = null;

  function clearPendingSwitch() {
    if (_switchTimer) {
      window.clearTimeout(_switchTimer);
      _switchTimer = 0;
    }
    _pendingImg = null;
  }

  function recomputeBoxes() {
    const now = Date.now();
    if (now - _lastBoxesAt < BOX_REFRESH_MS) return;
    _lastBoxesAt = now;
    const next = [];
    let count = 0;
    for (const img of Array.from(document.images || [])) {
      if (!(img instanceof HTMLImageElement)) continue;
      if (!isImgGood(img)) continue;
      next.push({ img, rect: img.getBoundingClientRect() });
      count++;
      if (count >= MAX_HOVER_SCAN) break;
    }
    _boxes = next;
  }

  function startBoxLoop() {
    if (_rafId) return;
    const tick = () => {
      _rafId = 0;
      if (!st.enabled) return;
      recomputeBoxes();
      _rafId = window.requestAnimationFrame(tick);
    };
    _rafId = window.requestAnimationFrame(tick);
  }

  function stopBoxLoop() {
    if (_rafId) {
      window.cancelAnimationFrame(_rafId);
      _rafId = 0;
    }
  }

  function boxHit(x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const b of _boxes) {
      const r = b.rect;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = Math.max(1, r.width) * Math.max(1, r.height);
      if (area < bestArea) {
        bestArea = area;
        best = b.img;
      }
    }
    return best;
  }

  function onPointerMove(ev) {
    if (!st.enabled) return;
    // While the pointer sits on the popover itself, don't switch or hide — the
    // user is reaching for the Download button, so leave everything where it is.
    if (st.hoveringUi) {
      if (st.hideTimer) {
        clearTimeout(st.hideTimer);
        st.hideTimer = null;
      }
      return;
    }
    const x = ev.clientX;
    const y = ev.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    recomputeBoxes();
    const img = boxHit(x, y);
    if (!(img instanceof HTMLImageElement) || !isImgGood(img)) {
      st.hoveringImg = false;
      clearPendingSwitch();
      scheduleHide();
      return;
    }
    st.hoveringImg = true;
    if (st.hideTimer) {
      clearTimeout(st.hideTimer);
      st.hideTimer = null;
    }

    // Same image already showing: just keep the outline aligned.
    if (st.activeImg === img) {
      clearPendingSwitch();
      positionUi(img);
      return;
    }

    // Nothing showing yet: reveal straight away so it still feels instant.
    if (!st.activeImg) {
      clearPendingSwitch();
      _lastHoverUrl = pickImgUrl(img) || '';
      showFor(img);
      return;
    }

    // A popover is already up for another image. Only hand it over once the
    // pointer genuinely settles on this one — a quick pass shouldn't grab it.
    if (_pendingImg !== img) {
      clearPendingSwitch();
      _pendingImg = img;
      _switchTimer = window.setTimeout(() => {
        _switchTimer = 0;
        const target = _pendingImg;
        _pendingImg = null;
        if (!st.enabled || st.hoveringUi) return;
        if (!(target instanceof HTMLImageElement) || !isImgGood(target)) return;
        _lastHoverUrl = pickImgUrl(target) || '';
        showFor(target);
      }, SWITCH_DELAY_MS);
    }
  }

  function onScrollReposition() {
    if (st.enabled && st.activeImg && isImgGood(st.activeImg)) positionUi(st.activeImg);
  }
  function onResizeReposition() {
    if (st.enabled && st.activeImg && isImgGood(st.activeImg)) positionUi(st.activeImg);
  }

  function mount() {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    window.addEventListener('scroll', onScrollReposition, { passive: true, capture: true });
    window.addEventListener('resize', onResizeReposition, { passive: true });
    recomputeBoxes();
    startBoxLoop();
  }

  function unmount() {
    setVisible(false);
    st.activeImg = null;
    clearPendingSwitch();
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('scroll', onScrollReposition, true);
    window.removeEventListener('resize', onResizeReposition, false);
    stopBoxLoop();
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  elPop.addEventListener('pointerenter', () => {
    st.hoveringUi = true;
    if (st.hideTimer) {
      clearTimeout(st.hideTimer);
      st.hideTimer = null;
    }
  });
  elPop.addEventListener('pointerleave', () => {
    st.hoveringUi = false;
    scheduleHide();
  });

  elClose.addEventListener('click', () => {
    st.hoveringUi = false;
    st.hoveringImg = false;
    st.activeImg = null;
    clearPendingSwitch();
    setVisible(false);
  });
  elDl.addEventListener('click', () => void handleDownloadClick());

  function setEnabled(on) {
    st.enabled = !!on;
    if (st.enabled) mount();
    else unmount();
  }

  chrome.storage.local.get([ENABLE_KEY], (d) => {
    if (chrome.runtime.lastError) return;
    setEnabled(d[ENABLE_KEY] === true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ENABLE_KEY]) return;
    setEnabled(changes[ENABLE_KEY].newValue === true);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'CONTEXT_IMAGE_DOWNLOAD_AS') return;
    const p = msg.payload || {};
    const url = (p.url || '').toString().trim();
    const fmt = (p.format || 'png').toString().toLowerCase();
    if (!url) return;
    let stem = 'image';
    try {
      const u = new URL(url, location.href);
      const seg = (u.pathname.split('/').filter(Boolean).pop() || 'image').replace(/\.[a-z0-9]{2,5}$/i, '');
      stem = sanitizeFileStem(seg || 'image');
    } catch (_) {
      stem = 'image';
    }
    void downloadUrlAs(url, fmt, stem);
  });

  window.HLS_IMAGE_DL = {
    listImages,
    downloadUrlAs,
  };
})();

