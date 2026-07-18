/**
 * Lightweight iOS-style dropdown that wraps a native <select>.
 * Menus portal out of overflow parents and clamp to the visible viewport.
 */
(function (global) {
  const CHEVRON =
    '<svg class="ios-select-chevron" viewBox="0 0 20 20" aria-hidden="true">' +
    '<path fill="currentColor" d="M5.2 7.5a1 1 0 0 1 1.4 0L10 10.9l3.4-3.4a1 1 0 1 1 1.4 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L5.2 8.9a1 1 0 0 1 0-1.4z"/>' +
    '</svg>';
  const CHECK =
    '<svg class="ios-select-check" viewBox="0 0 20 20" aria-hidden="true">' +
    '<path fill="currentColor" d="M8.1 13.7 4.6 10.2a1 1 0 0 1 1.4-1.4l2.1 2.1 5.2-5.2a1 1 0 1 1 1.4 1.4l-5.9 5.9a1 1 0 0 1-1.4 0z"/>' +
    '</svg>';

  const PAD = 8;
  const GAP = 6;
  /** @type {{ wrap: HTMLElement, select: HTMLSelectElement, menu: HTMLElement, trigger: HTMLElement } | null} */
  let active = null;

  function selectedLabel(select) {
    const opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function portalRootFor(wrap) {
    const root = wrap.getRootNode();
    // FAB shadow: mount at shadow root (outside transformed/overflow panel).
    if (root && root.nodeType === 11 && root.host) return root;
    // Modals: stay inside overlay so local theme tokens still apply.
    const overlay =
      (wrap.closest && wrap.closest('.hgr-modal-overlay, .hgr-picker-overlay')) || null;
    if (overlay) return overlay;
    return document.body;
  }

  function clearMenuInlineStyles(menu) {
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.width = '';
    menu.style.minWidth = '';
    menu.style.maxWidth = '';
    menu.style.maxHeight = '';
    menu.style.zIndex = '';
    menu.style.visibility = '';
    menu.classList.remove('ios-select-menu--fixed', 'ios-select-menu--above');
  }

  function restoreMenu(menu, wrap) {
    if (!menu || !wrap) return;
    if (menu.parentNode !== wrap) wrap.appendChild(menu);
    clearMenuInlineStyles(menu);
  }

  function closeWrap(wrap) {
    if (!wrap) return;
    const menu = wrap.__iosMenu || wrap.querySelector('.ios-select-menu');
    const btn = wrap.querySelector('.ios-select-trigger');
    wrap.classList.remove('is-open', 'is-open-up');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (menu) {
      menu.hidden = true;
      restoreMenu(menu, wrap);
    }
    if (active && active.wrap === wrap) active = null;
    syncViewportListeners();
  }

  function closeAllInRoot(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.ios-select.is-open').forEach(closeWrap);
  }

  function closeAll() {
    if (active) {
      closeWrap(active.wrap);
      return;
    }
    closeAllInRoot(document);
    document.querySelectorAll('[data-hls-grabber-fab], [data-hls-image-dl]').forEach((host) => {
      if (host.shadowRoot) closeAllInRoot(host.shadowRoot);
    });
  }

  function rebuildMenu(menu, select, wrap) {
    menu.textContent = '';
    Array.from(select.options).forEach((opt, index) => {
      if (opt.disabled && opt.hidden) return;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ios-select-option' + (opt.selected ? ' is-selected' : '');
      row.dataset.index = String(index);
      const label = document.createElement('span');
      label.textContent = opt.textContent;
      row.appendChild(label);
      row.insertAdjacentHTML('beforeend', CHECK);
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (select.selectedIndex !== index) {
          select.selectedIndex = index;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncTrigger(wrap, select);
        closeWrap(wrap);
      });
      menu.appendChild(row);
    });
  }

  function syncTrigger(wrap, select) {
    const valueEl = wrap.querySelector('.ios-select-value');
    if (valueEl) valueEl.textContent = selectedLabel(select);
    const menu = wrap.__iosMenu || wrap.querySelector('.ios-select-menu');
    if (!menu) return;
    menu.querySelectorAll('.ios-select-option').forEach((row) => {
      const idx = Number(row.dataset.index);
      row.classList.toggle('is-selected', idx === select.selectedIndex);
    });
  }

  function positionMenu(wrap, menu, trigger) {
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return;

    const minW = Math.max(rect.width, 140);
    const maxW = Math.max(120, vw - PAD * 2);

    menu.classList.add('ios-select-menu--fixed');
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483647';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.minWidth = minW + 'px';
    menu.style.maxWidth = maxW + 'px';
    menu.style.width = 'auto';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = 'none';
    menu.style.visibility = 'hidden';
    menu.hidden = false;

    // Natural size first
    let menuW = Math.min(Math.max(menu.offsetWidth, minW), maxW);
    let menuH = menu.scrollHeight;

    const spaceBelow = vh - rect.bottom - PAD;
    const spaceAbove = rect.top - PAD;
    const placeAbove = menuH + GAP > spaceBelow && spaceAbove > spaceBelow;

    const available = Math.max(96, (placeAbove ? spaceAbove : spaceBelow) - GAP);
    menu.style.maxHeight = available + 'px';
    menuH = Math.min(menu.scrollHeight, available);
    menuW = Math.min(Math.max(menu.offsetWidth, minW), maxW);

    let left = rect.left;
    if (left + menuW > vw - PAD) left = vw - PAD - menuW;
    if (left < PAD) left = PAD;

    let top;
    if (placeAbove) {
      top = rect.top - GAP - menuH;
      menu.classList.add('ios-select-menu--above');
      wrap.classList.add('is-open-up');
    } else {
      top = rect.bottom + GAP;
      menu.classList.remove('ios-select-menu--above');
      wrap.classList.remove('is-open-up');
    }
    if (top < PAD) top = PAD;
    if (top + menuH > vh - PAD) top = Math.max(PAD, vh - PAD - menuH);

    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.width = Math.round(menuW) + 'px';
    menu.style.visibility = 'visible';
  }

  function repositionActive() {
    if (!active) return;
    const { wrap, menu, trigger } = active;
    if (!wrap.classList.contains('is-open')) return;
    positionMenu(wrap, menu, trigger);
  }

  function syncViewportListeners() {
    if (active) {
      if (!global.__iosSelectViewportBound) {
        global.__iosSelectViewportBound = true;
        window.addEventListener('resize', onViewportChange, true);
        window.addEventListener('scroll', onViewportChange, true);
        document.addEventListener('scroll', onViewportChange, true);
      }
    }
  }

  function onViewportChange() {
    if (!active) return;
    // Keep menu under the trigger; if trigger left the viewport, close.
    const rect = active.trigger.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const offscreen =
      rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw;
    if (offscreen) {
      closeWrap(active.wrap);
      return;
    }
    repositionActive();
  }

  function openMenu(wrap, select) {
    closeAll();
    const menu = wrap.__iosMenu || wrap.querySelector('.ios-select-menu');
    const trigger = wrap.querySelector('.ios-select-trigger');
    if (!menu || !trigger) return;

    rebuildMenu(menu, select, wrap);
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');

    const portal = portalRootFor(wrap);
    if (menu.parentNode !== portal) portal.appendChild(menu);

    active = { wrap, select, menu, trigger };
    positionMenu(wrap, menu, trigger);
    // Second pass after fonts/layout settle
    requestAnimationFrame(() => {
      if (active && active.wrap === wrap) positionMenu(wrap, menu, trigger);
    });
    syncViewportListeners();
  }

  function enhance(select, options) {
    if (!select || select.dataset.iosEnhanced === '1') return select;
    if (select.tagName !== 'SELECT') return select;
    const parent = select.parentNode;
    if (!parent) return select;

    const opts = options || {};
    select.dataset.iosEnhanced = '1';
    select.classList.add('ios-select-native');

    const wrap = document.createElement('div');
    wrap.className = 'ios-select' + (opts.compact ? ' ios-select--compact' : '');
    if (opts.className) wrap.className += ' ' + opts.className;

    parent.insertBefore(wrap, select);
    wrap.appendChild(select);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ios-select-trigger';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'ios-select-value';
    value.textContent = selectedLabel(select);
    btn.appendChild(value);
    btn.insertAdjacentHTML('beforeend', CHEVRON);

    const menu = document.createElement('div');
    menu.className = 'ios-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    wrap.__iosMenu = menu;

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wrap.classList.contains('is-open')) closeWrap(wrap);
      else openMenu(wrap, select);
    });

    select.addEventListener('change', () => syncTrigger(wrap, select));
    return select;
  }

  function enhanceAll(root, options) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    scope.querySelectorAll('select:not([data-ios-enhanced])').forEach((sel) => enhance(sel, options));
  }

  if (!global.__iosSelectOutsideBound) {
    global.__iosSelectOutsideBound = true;
    document.addEventListener(
      'click',
      (ev) => {
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
        const inside = path.some(
          (n) =>
            n &&
            n.classList &&
            (n.classList.contains('ios-select') ||
              n.classList.contains('ios-select-menu') ||
              n.classList.contains('ios-select-trigger') ||
              n.classList.contains('ios-select-option'))
        );
        if (inside) return;
        closeAll();
      },
      true
    );
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'Escape') closeAll();
      },
      true
    );
  }

  global.HLS_IOS_SELECT = { enhance, enhanceAll, closeAll };
})(typeof window !== 'undefined' ? window : globalThis);
