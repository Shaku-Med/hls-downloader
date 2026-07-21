/**
 * Shared: YouTube page URL handling and playlist prompt for popup + fab.
 * Exposes window.HLS_YT
 */
(function () {
  if (window.HLS_YT) return;

  /** @param {string} u */
  function isYoutubePage(u) {
    try {
      const raw = new URL(u).hostname.toLowerCase();
      const h = raw.replace(/^www\./i, '');
      if (h === 'youtu.be') return true;
      return h === 'youtube.com' || h.endsWith('.youtube.com');
    } catch {
      return false;
    }
  }

  /** @param {string} url @returns {{ shouldAskPlaylist: boolean, isPlaylistPage: boolean, watchHasList: boolean }} */
  function playlistHints(url) {
    try {
      if (!isYoutubePage(url)) {
        return { shouldAskPlaylist: false, isPlaylistPage: false, watchHasList: false };
      }
      const u = new URL(url);
      const path = (u.pathname || '').toLowerCase();
      const hasListParam = !!u.searchParams.get('list');
      const isPlaylistPage =
        path.includes('/playlist') || /^\/playlist\/?$/i.test(u.pathname);
      const watchHasList = hasListParam && !isPlaylistPage;
      return {
        shouldAskPlaylist: isPlaylistPage || watchHasList,
        isPlaylistPage,
        watchHasList,
      };
    } catch {
      return { shouldAskPlaylist: false, isPlaylistPage: false, watchHasList: false };
    }
  }

  /** Remove playlist context for single-video yt-dlp (--no-playlist). */
  function urlForSingleVideoOnly(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('list');
      u.searchParams.delete('index');
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * @param {string} pageUrl
   * @param {{ shouldAskPlaylist: boolean, isPlaylistPage: boolean, watchHasList: boolean }} hints
   * @param {(choice: 'single' | 'playlist' | null) => void} onPick null = canceled
   */
  function showPlaylistPrompt(pageUrl, hints, onPick) {
    if (!hints.shouldAskPlaylist) {
      onPick('single');
      return;
    }

    const subtitle = hints.isPlaylistPage
      ? 'This page is a playlist. Download all videos? (yt-dlp will create multiple files in your save folder.)'
      : 'This watch URL includes a playlist. Download only this video, or the full playlist? (Full playlist creates multiple files.)';

    const choices = hints.isPlaylistPage
      ? [{ id: 'playlist', label: 'Download full playlist', primary: true }]
      : [
          { id: 'single', label: 'This video only', primary: true },
          { id: 'playlist', label: 'Full playlist' },
        ];

    const finish = (id) => {
      if (id === 'single' || id === 'playlist') onPick(id);
      else onPick(null);
    };

    if (window.HGR_THEME && typeof window.HGR_THEME.showChoicePicker === 'function') {
      window.HGR_THEME.showChoicePicker(
        {
          title: 'YouTube playlist',
          subtitle,
          detail: pageUrl || '',
          choices,
          cancelLabel: 'Cancel',
          mount: document.documentElement || document.body,
        },
        finish
      );
      return;
    }

    // Fallback if theme helpers didn't load — still use shared modal classes.
    const overlay = document.createElement('div');
    overlay.className = 'hgr-modal-overlay';
    if (window.HGR_THEME && typeof window.HGR_THEME.hardenModalOverlay === 'function') {
      window.HGR_THEME.hardenModalOverlay(overlay);
    }
    overlay.setAttribute('data-theme', 'dark');
    const box = document.createElement('div');
    box.className = 'hgr-modal-box';
    if (window.HGR_THEME && typeof window.HGR_THEME.hardenModalBox === 'function') {
      window.HGR_THEME.hardenModalBox(box);
    }
    const title = document.createElement('div');
    title.className = 'hgr-modal-title';
    title.textContent = 'YouTube playlist';
    const sub = document.createElement('div');
    sub.className = 'hgr-modal-sub';
    sub.textContent = subtitle;
    const detail = document.createElement('div');
    detail.className = 'hgr-modal-detail';
    detail.textContent = pageUrl || '';
    const form = document.createElement('div');
    form.className = 'hgr-modal-actions';
    let settled = false;
    const done = (id) => {
      if (settled) return;
      settled = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      finish(id);
    };
    choices.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = c.primary ? 'hgr-modal-btn-primary' : 'hgr-modal-btn-secondary';
      b.textContent = c.label;
      b.addEventListener('click', () => done(c.id));
      form.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'hgr-modal-btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => done(null));
    form.appendChild(cancel);
    box.appendChild(title);
    box.appendChild(sub);
    if (pageUrl) box.appendChild(detail);
    box.appendChild(form);
    overlay.appendChild(box);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) done(null);
    });
    // Mount on <html>: the floater host follows <body>, so a body-mounted
    // overlay would stack behind the floating panel.
    (document.documentElement || document.body).appendChild(overlay);
  }

  /**
   * @param {string} tabUrl
   * @param {'single' | 'playlist'} choice
   */
  function applyYoutubeChoice(tabUrl, choice) {
    if (!isYoutubePage(tabUrl)) {
      return {
        targetUrl: tabUrl,
        pageUrl: tabUrl,
        referer: tabUrl,
        origin: (() => {
          try {
            return new URL(tabUrl).origin;
          } catch {
            return '';
          }
        })(),
        ytDlpDownloadPlaylist: false,
      };
    }
    if (choice === 'playlist') {
      let origin = '';
      try {
        origin = new URL(tabUrl).origin;
      } catch (_) {}
      return {
        targetUrl: tabUrl,
        pageUrl: tabUrl,
        referer: tabUrl,
        origin,
        ytDlpDownloadPlaylist: true,
      };
    }
    const stripped = urlForSingleVideoOnly(tabUrl);
    let origin = '';
    try {
      origin = new URL(stripped).origin;
    } catch (_) {}
    return {
      targetUrl: stripped,
      pageUrl: stripped,
      referer: stripped,
      origin,
      ytDlpDownloadPlaylist: false,
    };
  }

  window.HLS_YT = {
    isYoutubePage,
    playlistHints,
    urlForSingleVideoOnly,
    showPlaylistPrompt,
    applyYoutubeChoice,
  };
})();
