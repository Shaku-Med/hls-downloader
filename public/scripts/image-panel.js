/**
 * Shared Images panel for the extension popup (and reusable helpers).
 * Fetches the active tab's image list via background ↔ content script.
 */
(function (global) {
  const SCOPE_KEY = 'imageListScope';

  function makeImgExpandableUrl(url) {
    const display = String(url || '').startsWith('data:') ? 'data:image' : url;
    const api = (typeof HGR_THEME !== 'undefined' && HGR_THEME.createExpandableUrl)
      || (global.HGR_THEME && global.HGR_THEME.createExpandableUrl);
    if (typeof api === 'function') {
      return api(display, { className: 'url-expand img-url', maxLen: 48 });
    }
    const wrap = document.createElement('div');
    wrap.className = 'url-expand img-url';
    const text = document.createElement('div');
    text.className = 'url-expand-text';
    text.textContent = String(display || '');
    wrap.appendChild(text);
    return { el: wrap };
  }

  function readScope() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SCOPE_KEY], (data) => {
        if (chrome.runtime.lastError) {
          resolve('page');
          return;
        }
        resolve(data && data[SCOPE_KEY] === 'visible' ? 'visible' : 'page');
      });
    });
  }

  function writeScope(scope) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SCOPE_KEY]: scope === 'visible' ? 'visible' : 'page' }, () =>
        resolve()
      );
    });
  }

  function getPageImages(scope) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_IMAGES', scope }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message, images: [] });
          return;
        }
        resolve(res || { ok: false, images: [] });
      });
    });
  }

  function downloadZip(images, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_IMAGES_ZIP', images, filename },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'No response' });
        }
      );
    });
  }

  function downloadOne(url, fmt, stem) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_PAGE_IMAGE', url, fmt, stem },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false });
        }
      );
    });
  }

  /**
   * @param {HTMLElement} host
   * @param {{ hasPath?: boolean, enhanceSelect?: (sel: HTMLSelectElement) => void }} [opts]
   */
  async function render(host, opts) {
    if (!host) return;
    const hasPath = !!(opts && opts.hasPath);
    const enhanceSelect = opts && typeof opts.enhanceSelect === 'function' ? opts.enhanceSelect : null;
    const preferredScope = opts && opts.scope;

    const scope =
      preferredScope === 'page' || preferredScope === 'visible'
        ? preferredScope
        : await readScope();

    host.textContent = '';
    host.hidden = false;

    const status = document.createElement('div');
    status.className = 'img-empty';
    status.textContent = 'Scanning page images…';
    host.appendChild(status);

    const res = await getPageImages(scope);
    const images = (res && res.images) || [];

    host.textContent = '';

    const head = document.createElement('div');
    head.className = 'img-section-head';

    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = images.length ? `Images · ${images.length}` : 'Images';

    const tools = document.createElement('div');
    tools.className = 'img-section-tools';

    const scopeSel = document.createElement('select');
    scopeSel.className = 'img-scope-select';
    scopeSel.setAttribute('aria-label', 'Image scan range');
    scopeSel.innerHTML = `
      <option value="page">Full page</option>
      <option value="visible">Visible area</option>
    `;
    scopeSel.value = scope;

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn-primary img-tool-btn';
    refreshBtn.textContent = 'Refresh';

    const zipBtn = document.createElement('button');
    zipBtn.type = 'button';
    zipBtn.className = 'btn-primary img-tool-btn';
    zipBtn.textContent = 'Download all';
    zipBtn.disabled = !images.length;
    zipBtn.title = images.length
      ? 'Save every listed image in one ZIP'
      : 'No images to zip yet';

    const rerender = async (nextScope) => {
      await writeScope(nextScope);
      await render(host, { hasPath, enhanceSelect, scope: nextScope });
    };

    scopeSel.addEventListener('change', () => {
      void rerender(scopeSel.value === 'visible' ? 'visible' : 'page');
    });
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Scanning…';
      void rerender(scopeSel.value === 'visible' ? 'visible' : 'page');
    });
    zipBtn.addEventListener('click', async () => {
      if (!images.length) return;
      zipBtn.disabled = true;
      zipBtn.textContent = 'Zipping…';
      const out = await downloadZip(images);
      zipBtn.disabled = false;
      zipBtn.textContent = 'Download all';
      if (!out.ok) {
        window.alert(out.error || 'Could not create ZIP');
        return;
      }
      if (out.failed) {
        window.alert(`Saved ZIP with ${out.count} image(s). ${out.failed} could not be fetched.`);
      }
    });

    tools.appendChild(scopeSel);
    tools.appendChild(refreshBtn);
    tools.appendChild(zipBtn);
    if (enhanceSelect) enhanceSelect(scopeSel);

    head.appendChild(label);
    head.appendChild(tools);
    host.appendChild(head);

    if (!images.length) {
      const empty = document.createElement('div');
      empty.className = 'img-empty';
      empty.textContent =
        (res && res.error) ||
        (scope === 'visible'
          ? 'No images in view. Scroll, or switch to Full page, then Refresh.'
          : 'No images found on this page yet. Open a normal web tab, then Refresh.');
      host.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'img-list';

    images.forEach((img, idx) => {
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
      const urlView = makeImgExpandableUrl(img.url);
      meta.appendChild(title);
      meta.appendChild(urlView.el);

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
      btn.className = 'btn-primary';
      btn.textContent = 'Save';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '…';
        const stem = (img.alt && img.alt.trim()) || `image_${idx + 1}`;
        const out = await downloadOne(img.url, sel.value, stem);
        btn.disabled = false;
        btn.textContent = 'Save';
        if (!out.ok) window.alert(out.error || 'Could not save image');
      });

      actions.appendChild(sel);
      actions.appendChild(btn);
      if (enhanceSelect) enhanceSelect(sel);

      body.appendChild(meta);
      body.appendChild(actions);
      card.appendChild(thumb);
      card.appendChild(body);
      list.appendChild(card);
    });

    host.appendChild(list);
  }

  global.HLS_IMAGE_PANEL = {
    render,
    getPageImages,
    downloadZip,
    SCOPE_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);
