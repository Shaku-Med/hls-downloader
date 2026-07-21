(function () {
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Same live context already owns image hover — skip. After reload, old flag may
  // still be set while chrome.* in THAT closure is dead; take over in that case.
  try {
    const prev = window.__hlsGrabberImageHoverApi;
    if (prev && typeof prev.__hlsAlive === 'function' && prev.__hlsAlive()) {
      return;
    }
  } catch (_) {
    // take over
  }
  if (!extAlive()) return;

  window.__hlsGrabberImageHoverGen = (window.__hlsGrabberImageHoverGen || 0) + 1;
  const myGen = window.__hlsGrabberImageHoverGen;
  window.__hlsGrabberImageHoverDownload = true;

  function stillOwner() {
    return extAlive() && window.__hlsGrabberImageHoverGen === myGen;
  }

  const ENABLE_KEY = 'imageHoverDownloadEnabled';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
  const MIN_SIZE = 28;
  const HIDE_DELAY_MS = 220;
  // How long the pointer must rest on a *different* image before the popover
  // moves to it. Stops neighbouring grid thumbnails from stealing focus while
  // you're just on your way to click Download.
  const SWITCH_DELAY_MS = 220;
  const MAX_LIST_PAGE = 200;
  const MAX_LIST_VISIBLE = 120;
  const MAX_HOVER_SCAN = 320;
  const LIST_SCOPE_KEY = 'imageListScope'; // 'page' | 'visible'
  const BOX_REFRESH_MS = 450;
  // If the cursor is not exactly on an image box (overlays / pe:none stacks),
  // still pick the nearest image within this many CSS pixels.
  const PROXIMITY_PX = 36;

  const st = {
    enabled: false,
    hoveringUi: false,
    hoveringImg: false,
    activeImg: null,
    hideTimer: null,
    /** Image the user closed; ignore until the pointer leaves it. */
    dismissedImg: null,
  };

  // Same Shadow DOM path as Chromium. Styles are promoted to adoptedStyleSheets
  // so Firefox page CSP cannot blank the UI.
  const host = document.createElement('stuff-grabber-image-dl');
  host.setAttribute('data-hls-image-dl', '');
  try {
    const s = host.style;
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
  } catch (_) {
    // ignore
  }
  const shadow = host.attachShadow({ mode: 'open' });

  const setHtml =
    window.HGR_THEME && typeof window.HGR_THEME.setNodeHtml === 'function'
      ? window.HGR_THEME.setNodeHtml
      : (node, html) => {
          if (node) node.innerHTML = String(html == null ? '' : html);
        };

  setHtml(
    shadow,
    `
    <style>
      :host {
        all: initial;
        --sg-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
          "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
        --sg-bg: #000000;
        --sg-surface: #1c1c1e;
        --sg-text: #ffffff;
        --sg-muted: #8e8e93;
        --sg-line: rgba(84, 84, 88, 0.65);
        --sg-accent: #0a84ff;
        --sg-accent-2: #409cff;
        --sg-btnText: #ffffff;
        --sg-fill: rgba(120, 120, 128, 0.32);
        --sg-fill-2: rgba(120, 120, 128, 0.24);
        --font: var(--sg-font);
        --surface: var(--sg-surface);
        --text: var(--sg-text);
        --muted: var(--sg-muted);
        --line: var(--sg-line);
        --accent: var(--sg-accent);
        --fill: var(--sg-fill);
        --fill-secondary: var(--sg-fill-2);
        --radius-lg: 16px;
        --radius-ctrl: 10px;
        --shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
        --transition: 220ms cubic-bezier(0.25, 0.1, 0.25, 1);
        --spring: 320ms cubic-bezier(0.34, 1.2, 0.64, 1);
      }
      :host([data-theme="light"]) {
        --sg-bg: #f2f2f7;
        --sg-surface: #ffffff;
        --sg-text: #000000;
        --sg-muted: #8e8e93;
        --sg-line: rgba(60, 60, 67, 0.18);
        --sg-accent: #007aff;
        --sg-accent-2: #0a84ff;
        --sg-fill: rgba(120, 120, 128, 0.16);
        --sg-fill-2: rgba(120, 120, 128, 0.12);
        --shadow: 0 12px 40px rgba(0, 0, 0, 0.16);
      }
      * { box-sizing: border-box; font-family: var(--sg-font); }
      .hl {
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        border: 2px solid var(--sg-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sg-accent) 22%, transparent);
        border-radius: 12px;
        display: none;
      }
      .pop {
        position: fixed;
        z-index: 2147483647;
        pointer-events: auto !important;
        display: none;
        padding: 14px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--sg-surface) 88%, transparent);
        color: var(--sg-text);
        box-shadow: var(--shadow);
        min-width: 240px;
        max-width: 320px;
        backdrop-filter: blur(28px) saturate(180%);
        -webkit-backdrop-filter: blur(28px) saturate(180%);
        border: 0.5px solid var(--sg-line);
      }
      .pop, .pop * {
        pointer-events: auto !important;
      }
      .row1 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      .t {
        font-size: 15px;
        color: var(--sg-text);
        font-weight: 650;
        letter-spacing: -0.02em;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .x {
        border: none;
        background: var(--sg-fill);
        color: var(--sg-muted);
        width: 28px;
        height: 28px;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background var(--transition), transform 120ms ease;
      }
      .x:hover { background: var(--sg-fill-2); color: var(--sg-text); }
      .x:active { transform: scale(0.94); }
      .row2 { display: flex; gap: 8px; align-items: stretch; }
      .row2 .ios-select { flex: 1; min-width: 0; }
      button.dl {
        padding: 0 16px;
        min-height: 40px;
        border-radius: 980px;
        border: none;
        background: var(--sg-accent);
        color: var(--sg-btnText);
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
        transition: filter var(--transition), transform 120ms ease;
        white-space: nowrap;
      }
      button.dl:hover { filter: brightness(1.06); }
      button.dl:active { transform: scale(0.97); }
      button.dl:disabled { opacity: .45; cursor: default; filter: none; }
      .sub {
        margin-top: 10px;
        font-size: 12px;
        color: var(--sg-muted);
        line-height: 1.35;
        letter-spacing: -0.01em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* iOS select (inlined for shadow) */
      .ios-select { position: relative; display: block; width: 100%; min-width: 0; }
      .ios-select-native {
        position: absolute !important; width: 1px !important; height: 1px !important;
        padding: 0 !important; margin: -1px !important; overflow: hidden !important;
        clip: rect(0,0,0,0) !important; border: 0 !important; opacity: 0 !important;
        pointer-events: none !important;
      }
      .ios-select-trigger {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
        min-height: 40px; padding: 8px 12px; border: none; border-radius: 10px;
        background: var(--sg-fill); color: var(--sg-text); font: inherit; font-size: 14px;
        letter-spacing: -0.01em; text-align: left; cursor: pointer;
      }
      .ios-select-trigger:hover { background: var(--sg-fill-2); }
      .ios-select-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ios-select-chevron { width: 16px; height: 16px; color: var(--sg-muted); transition: transform var(--spring); }
      .ios-select.is-open .ios-select-chevron { transform: rotate(180deg); }
      .ios-select-menu {
        position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 2147483647;
        pointer-events: auto !important;
        max-height: 220px; overflow: auto; overscroll-behavior: contain; padding: 6px;
        border-radius: 14px; background: color-mix(in srgb, var(--sg-surface) 92%, transparent);
        backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%);
        border: 0.5px solid var(--sg-line); box-shadow: var(--shadow); box-sizing: border-box;
      }
      .ios-select-menu.ios-select-menu--fixed {
        position: fixed !important; right: auto !important; bottom: auto !important;
        margin: 0; z-index: 2147483647 !important; pointer-events: auto !important;
      }
      .ios-select-menu, .ios-select-menu * {
        pointer-events: auto !important;
      }
      .ios-select-menu[hidden] { display: none !important; }
      .ios-select-option {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        width: 100%; border: none; border-radius: 10px; background: transparent;
        color: var(--sg-text); font: inherit; font-size: 14px; text-align: left;
        padding: 10px 12px; cursor: pointer;
      }
      .ios-select-option:hover { background: var(--sg-fill); }
      .ios-select-option.is-selected { color: var(--sg-accent); font-weight: 600; }
      .ios-select-check { width: 14px; height: 14px; opacity: 0; color: var(--sg-accent); }
      .ios-select-option.is-selected .ios-select-check { opacity: 1; }
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
  `
  );

  try {
    if (window.HGR_THEME && typeof window.HGR_THEME.promoteInlineStyles === 'function') {
      window.HGR_THEME.promoteInlineStyles(shadow);
    }
  } catch (_) {
    // ignore
  }

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

  const elHL = shadow.querySelector('.hl');
  const elPop = shadow.querySelector('.pop');
  const elTitle = rootById(shadow, 't');
  const elSub = rootById(shadow, 'sub');
  const elFmt = rootById(shadow, 'fmt');
  const elDl = rootById(shadow, 'dl');
  const elClose = rootById(shadow, 'x');

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
    elHL.style.borderColor = 'var(--sg-accent, #0a84ff)';
    elHL.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--sg-accent) 24%, transparent)';
    if (mode === 'page' || resolved) {
      // keep accent ring; host CSS vars already applied by theme helper
    }
  }

  if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
    HLS_IOS_SELECT.enhance(elFmt, { compact: true });
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

  function isInViewport(r) {
    if (!r) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
    return true;
  }

  /**
   * @param {HTMLImageElement} img
   * @param {{ requireVisible?: boolean }} [opts]
   *   requireVisible true  → only images in the current scroll viewport (hover)
   *   requireVisible false → any laid-out image on the page (full-page list)
   */
  function isImgGood(img, opts) {
    if (!img) return false;
    if (!(img instanceof HTMLImageElement) && img.tagName !== 'IMG') return false;
    const requireVisible = !opts || opts.requireVisible !== false;
    const r = img.getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
    if (requireVisible && !isInViewport(r)) return false;
    // Still accept pointer-events:none / invisible hit targets — geometry only.
    return true;
  }

  function pickImgUrl(img) {
    if (!img) return '';
    const srcset = (img.currentSrc || '').trim();
    if (srcset) return srcset;
    const u = (img.src || '').trim();
    if (u) return u;
    try {
      const source = img.parentElement && img.parentElement.tagName === 'PICTURE'
        ? img.parentElement.querySelector('source[srcset], source[src]')
        : null;
      if (source) {
        const ss = (source.getAttribute('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0];
        if (ss) return new URL(ss, location.href).href;
        const s = (source.getAttribute('src') || '').trim();
        if (s) return new URL(s, location.href).href;
      }
    } catch (_) {
      // ignore
    }
    return '';
  }

  function collectPageImages(opts) {
    const requireVisible = !opts || opts.requireVisible !== false;
    const out = [];
    const seen = new Set();
    const add = (img) => {
      if (!(img instanceof HTMLImageElement)) return;
      if (seen.has(img)) return;
      seen.add(img);
      if (!isImgGood(img, { requireVisible })) return;
      out.push(img);
    };
    try {
      for (const img of Array.from(document.images || [])) add(img);
    } catch (_) {
      // ignore
    }
    try {
      document.querySelectorAll('img').forEach(add);
    } catch (_) {
      // ignore
    }
    return out;
  }

  function normalizeListScope(scope) {
    return scope === 'visible' ? 'visible' : 'page';
  }

  function pointInRect(x, y, r, pad) {
    const p = pad || 0;
    return x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
  }

  function distToRect(x, y, r) {
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    return Math.hypot(dx, dy);
  }

  function imgFromStack(x, y) {
    // elementsFromPoint skips pointer-events:none nodes, but overlays on top
    // still appear — walk them and look for contained <img> geometry.
    let stack = [];
    try {
      stack = document.elementsFromPoint(x, y) || [];
    } catch (_) {
      stack = [];
    }
    let best = null;
    let bestArea = Infinity;
    for (const el of stack) {
      if (!el || el === host || (host.contains && host.contains(el))) continue;
      if (el instanceof HTMLImageElement && isImgGood(el) && pointInRect(x, y, el.getBoundingClientRect(), 0)) {
        const r = el.getBoundingClientRect();
        const area = Math.max(1, r.width) * Math.max(1, r.height);
        if (area < bestArea) {
          bestArea = area;
          best = el;
        }
        continue;
      }
      if (!el.querySelectorAll) continue;
      let imgs;
      try {
        imgs = el.querySelectorAll('img');
      } catch (_) {
        continue;
      }
      for (const img of imgs) {
        if (!isImgGood(img)) continue;
        const r = img.getBoundingClientRect();
        if (!pointInRect(x, y, r, 2)) continue;
        const area = Math.max(1, r.width) * Math.max(1, r.height);
        if (area < bestArea) {
          bestArea = area;
          best = img;
        }
      }
    }
    return best;
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
    if (on) {
      elPop.style.setProperty('pointer-events', 'auto', 'important');
      elPop.style.setProperty('z-index', '2147483647', 'important');
    }
  }

  function popRect() {
    try {
      return elPop.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }

  /** True when pointer is on the pop, format menu, active image, or a narrow bridge between them. */
  function pointerOverActiveUi(x, y) {
    if (elPop.style.display === 'none') return false;
    const pad = 10;
    const hit = (r) =>
      !!r &&
      x >= r.left - pad &&
      x <= r.right + pad &&
      y >= r.top - pad &&
      y <= r.bottom + pad;

    const pr = popRect();
    if (hit(pr)) return true;

    try {
      const menus = shadow.querySelectorAll('.ios-select-menu:not([hidden])');
      for (const m of menus) {
        if (hit(m.getBoundingClientRect())) return true;
      }
    } catch (_) {
      // ignore
    }

    if (!(st.activeImg instanceof HTMLImageElement)) return false;
    let ir;
    try {
      ir = st.activeImg.getBoundingClientRect();
    } catch (_) {
      return false;
    }
    if (hit(ir)) return true;
    if (!pr) return false;

    // Narrow travel lane only in the gap between image and pop (not the whole bounding box).
    const left = Math.min(ir.left, pr.left) - pad;
    const right = Math.max(ir.right, pr.right) + pad;
    if (x < left || x > right) return false;

    // Pop above image
    if (pr.bottom <= ir.top + 2) {
      return y >= pr.bottom - pad && y <= ir.top + pad;
    }
    // Pop below image
    if (pr.top >= ir.bottom - 2) {
      return y >= ir.bottom - pad && y <= pr.top + pad;
    }
    // Pop to the side
    if (pr.right <= ir.left + 2) {
      return y >= Math.min(ir.top, pr.top) - pad &&
        y <= Math.max(ir.bottom, pr.bottom) + pad &&
        x >= pr.right - pad &&
        x <= ir.left + pad;
    }
    if (pr.left >= ir.right - 2) {
      return y >= Math.min(ir.top, pr.top) - pad &&
        y <= Math.max(ir.bottom, pr.bottom) + pad &&
        x >= ir.right - pad &&
        x <= pr.left + pad;
    }
    return false;
  }

  function scheduleHide() {
    if (st.hideTimer) window.clearTimeout(st.hideTimer);
    st.hideTimer = window.setTimeout(() => {
      st.hideTimer = null;
      if (st.hoveringImg || st.hoveringUi) return;
      try {
        if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.closeAll) {
          HLS_IOS_SELECT.closeAll();
        }
      } catch (_) {
        // ignore
      }
      st.activeImg = null;
      setVisible(false);
    }, HIDE_DELAY_MS);
  }

  function positionHighlight(img) {
    const r = img.getBoundingClientRect();
    const pad = 3;
    elHL.style.left = `${Math.max(0, Math.round(r.left - pad))}px`;
    elHL.style.top = `${Math.max(0, Math.round(r.top - pad))}px`;
    elHL.style.width = `${Math.max(0, Math.round(r.width + pad * 2))}px`;
    elHL.style.height = `${Math.max(0, Math.round(r.height + pad * 2))}px`;
  }

  function positionUi(img, { forcePop = false } = {}) {
    positionHighlight(img);

    // Keep the popover pinned while the same image is active so it doesn't
    // jump away from the cursor as you move toward Download.
    const popOpen = elPop.style.display !== 'none';
    if (popOpen && !forcePop && st.activeImg === img) {
      elPop.style.setProperty('pointer-events', 'auto', 'important');
      return;
    }

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
    const r = img.getBoundingClientRect();
    let left = r.left + gap;
    let top = r.top - ph - gap;
    if (top < edge) top = r.bottom + gap;
    if (left + pw > window.innerWidth - edge) left = window.innerWidth - edge - pw;
    if (left < edge) left = edge;
    if (top + ph > window.innerHeight - edge) top = window.innerHeight - edge - ph;
    if (top < edge) top = edge;
    elPop.style.left = `${Math.round(left)}px`;
    elPop.style.top = `${Math.round(top)}px`;
    elPop.style.setProperty('pointer-events', 'auto', 'important');
    elPop.style.setProperty('z-index', '2147483647', 'important');
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

  function listImages(options) {
    const scope = normalizeListScope(options && options.scope);
    const requireVisible = scope === 'visible';
    const max = requireVisible ? MAX_LIST_VISIBLE : MAX_LIST_PAGE;
    const out = [];
    const seen = new Set();
    for (const img of collectPageImages({ requireVisible })) {
      const url = pickImgUrl(img);
      if (!url || !/^https?:|^data:/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const r = img.getBoundingClientRect();
      out.push({
        url,
        alt: (img.getAttribute('alt') || '').trim(),
        w: img.naturalWidth || Math.round(r.width),
        h: img.naturalHeight || Math.round(r.height),
      });
      if (out.length >= max) break;
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
    setVisible(true);
    positionUi(img, { forcePop: true });
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
    for (const img of collectPageImages()) {
      const rect = img.getBoundingClientRect();
      next.push({
        img,
        rect,
        area: Math.max(1, rect.width) * Math.max(1, rect.height),
      });
      count++;
      if (count >= MAX_HOVER_SCAN) break;
    }
    _boxes = next;
  }

  function startBoxLoop() {
    if (_rafId) return;
    // Interval (not perpetual rAF) — refresh geometry without burning a frame loop.
    _rafId = window.setInterval(() => {
      if (!st.enabled) return;
      recomputeBoxes();
    }, BOX_REFRESH_MS);
  }

  function stopBoxLoop() {
    if (_rafId) {
      window.clearInterval(_rafId);
      _rafId = 0;
    }
  }

  function boxHit(x, y) {
    // 1) Pure geometry over all known <img> boxes — works even when the image
    //    (or a covering layer) has pointer-events: none.
    let best = null;
    let bestArea = Infinity;
    for (const b of _boxes) {
      const r = b.rect;
      if (!pointInRect(x, y, r, 0)) continue;
      const area = b.area || Math.max(1, r.width) * Math.max(1, r.height);
      if (area < bestArea) {
        bestArea = area;
        best = b.img;
      }
    }
    if (best) return best;

    // 2) Walk the element stack / overlay parents for nested images.
    const fromStack = imgFromStack(x, y);
    if (fromStack) return fromStack;

    // 3) Soft proximity — cursor near an image still counts.
    let near = null;
    let nearDist = PROXIMITY_PX;
    for (const b of _boxes) {
      const d = distToRect(x, y, b.rect);
      if (d < nearDist) {
        nearDist = d;
        near = b.img;
      }
    }
    return near;
  }

  function isOurUiNode(n) {
    if (!n || n === window || n === document || n === document.documentElement) return false;
    if (n === elPop || n === host) return true;
    if (n.nodeType === 1 && n.classList) {
      return (
        n.classList.contains('pop') ||
        n.classList.contains('ios-select') ||
        n.classList.contains('ios-select-menu') ||
        n.classList.contains('ios-select-trigger') ||
        n.classList.contains('ios-select-option')
      );
    }
    // Portaled menu lives under document; walk parents.
    try {
      let cur = n.parentNode || n.host || null;
      while (cur && cur !== document && cur !== window) {
        if (cur === elPop || cur === host) return true;
        if (cur.nodeType === 1 && cur.classList && cur.classList.contains('ios-select-menu')) {
          return true;
        }
        cur = cur.parentNode || cur.host || null;
      }
    } catch (_) {
      // ignore
    }
    return false;
  }

  function pointerOverOurUi(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    return path.some((n) => isOurUiNode(n));
  }

  /** Where the pointer is going (leave/out) — do not use composedPath (includes the element being left). */
  function pointerGoingToOurUi(ev) {
    const to = ev.relatedTarget;
    if (!to) return false;
    return isOurUiNode(to);
  }

  function dismissPopover(fromImg) {
    st.hoveringUi = false;
    st.hoveringImg = false;
    st.dismissedImg = fromImg || st.activeImg || null;
    st.activeImg = null;
    clearPendingSwitch();
    if (st.hideTimer) {
      clearTimeout(st.hideTimer);
      st.hideTimer = null;
    }
    setVisible(false);
  }

  function onPointerMove(ev) {
    if (!st.enabled) return;
    const x = ev.clientX;
    const y = ev.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const popOpen = elPop.style.display !== 'none';
    // Recompute from geometry every move — don't sticky-lock open after pointerenter.
    const overActive =
      popOpen &&
      (pointerOverOurUi(ev) || pointerOverActiveUi(x, y));

    if (overActive) {
      st.hoveringUi = true;
      st.hoveringImg = true;
      if (st.hideTimer) {
        clearTimeout(st.hideTimer);
        st.hideTimer = null;
      }
      if (st.activeImg && isImgGood(st.activeImg)) positionHighlight(st.activeImg);
      return;
    }

    st.hoveringUi = false;
    recomputeBoxes();
    const img = boxHit(x, y);

    if (!(img instanceof HTMLImageElement) || !isImgGood(img)) {
      st.hoveringImg = false;
      st.dismissedImg = null;
      clearPendingSwitch();
      if (popOpen) scheduleHide();
      return;
    }

    // User closed with X while on this image — wait until they leave it.
    if (st.dismissedImg && img === st.dismissedImg) {
      st.hoveringImg = false;
      clearPendingSwitch();
      return;
    }
    if (st.dismissedImg && img !== st.dismissedImg) {
      st.dismissedImg = null;
    }

    st.hoveringImg = true;
    if (st.hideTimer) {
      clearTimeout(st.hideTimer);
      st.hideTimer = null;
    }

    // Same image already showing: keep outline aligned; leave pop pinned.
    if (st.activeImg === img) {
      clearPendingSwitch();
      positionHighlight(img);
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
        if (st.dismissedImg && target === st.dismissedImg) return;
        _lastHoverUrl = pickImgUrl(target) || '';
        showFor(target);
      }, SWITCH_DELAY_MS);
    }
  }

  function onScrollReposition() {
    _lastBoxesAt = 0;
    if (st.enabled) recomputeBoxes();
    if (st.enabled && st.activeImg && isImgGood(st.activeImg)) {
      positionUi(st.activeImg, { forcePop: true });
    }
  }
  function onResizeReposition() {
    _lastBoxesAt = 0;
    if (st.enabled) recomputeBoxes();
    if (st.enabled && st.activeImg && isImgGood(st.activeImg)) {
      positionUi(st.activeImg, { forcePop: true });
    }
  }

  function removeOrphanImageHosts() {
    document.querySelectorAll('[data-hls-image-dl], stuff-grabber-image-dl').forEach((el) => {
      if (el === host) return;
      try {
        el.remove();
      } catch (_) {
        // ignore
      }
    });
  }

  function mount() {
    removeOrphanImageHosts();
    if (!document.documentElement.contains(host)) {
      try {
        document.documentElement.appendChild(host);
      } catch (_) {
        try {
          (document.body || document.documentElement).appendChild(host);
        } catch (e2) {
          return;
        }
      }
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
    st.dismissedImg = null;
    st.hoveringUi = false;
    st.hoveringImg = false;
    clearPendingSwitch();
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('scroll', onScrollReposition, true);
    window.removeEventListener('resize', onResizeReposition, false);
    stopBoxLoop();
    if (host.parentNode) host.parentNode.removeChild(host);
    removeOrphanImageHosts();
  }

  elPop.addEventListener('pointerenter', () => {
    st.hoveringUi = true;
    if (st.hideTimer) {
      clearTimeout(st.hideTimer);
      st.hideTimer = null;
    }
  });
  elPop.addEventListener('pointerleave', (ev) => {
    // Moving into the portaled format menu still counts as our UI.
    if (pointerGoingToOurUi(ev)) {
      st.hoveringUi = true;
      return;
    }
    st.hoveringUi = false;
    // If pointer is still on the image / bridge, onPointerMove will cancel the hide.
    scheduleHide();
  });

  elClose.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dismissPopover(st.activeImg);
  });
  elDl.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void handleDownloadClick();
  });
  elDl.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    st.hoveringUi = true;
  });
  elPop.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    st.hoveringUi = true;
  });

  function setEnabled(on) {
    st.enabled = !!on;
    if (st.enabled) mount();
    else unmount();
  }

  try {
    chrome.storage.local.get([ENABLE_KEY], (d) => {
      if (chrome.runtime.lastError) return;
      setEnabled(d[ENABLE_KEY] === true);
    });
  } catch (_) {
    // Extension context invalidated
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[ENABLE_KEY]) return;
      setEnabled(changes[ENABLE_KEY].newValue === true);
    });
  } catch (_) {
    // ignore
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!stillOwner()) return;
    if (!msg || !msg.type) return;

    if (msg.type === 'LIST_PAGE_IMAGES') {
      try {
        const scope = normalizeListScope(msg.scope);
        refreshScan();
        const images = listImages({ scope }) || [];
        sendResponse({ ok: true, images, scope });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), images: [] });
      }
      return true;
    }

    if (msg.type === 'DOWNLOAD_PAGE_IMAGE') {
      const url = String(msg.url || '').trim();
      const fmt = String(msg.fmt || 'png').toLowerCase();
      const stem = String(msg.stem || 'image');
      if (!url) {
        sendResponse({ ok: false, error: 'Missing URL' });
        return true;
      }
      Promise.resolve(downloadUrlAs(url, fmt, stem))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    if (msg.type !== 'CONTEXT_IMAGE_DOWNLOAD_AS') return;
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

  function refreshScan() {
    _lastBoxesAt = 0;
    recomputeBoxes();
  }

  window.HLS_IMAGE_DL = {
    listImages,
    downloadUrlAs,
    refreshScan,
    normalizeListScope,
    LIST_SCOPE_KEY,
  };
  window.HLS_IMAGE_DL.__hlsAlive = extAlive;
  window.__hlsGrabberImageHoverApi = window.HLS_IMAGE_DL;
})();

