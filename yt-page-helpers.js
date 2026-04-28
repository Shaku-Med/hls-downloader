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

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;';
    const box = document.createElement('div');
    box.style.cssText =
      'background:#fff;border-radius:12px;padding:16px 18px;max-width:400px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:system-ui,Segoe UI,sans-serif;font-size:13px;color:#1c1917;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:8px;';
    title.textContent = 'YouTube playlist';

    const body = document.createElement('div');
    body.style.cssText = 'font-size:12px;color:#44403c;line-height:1.45;margin-bottom:14px;';
    if (hints.isPlaylistPage) {
      body.textContent =
        'This page is a playlist. Download all videos? (yt-dlp will create multiple files in your save folder.)';
    } else {
      body.textContent =
        'This watch URL includes a playlist. Download only this video, or the full playlist? (Full playlist creates multiple files.)';
    }

    const urlLine = document.createElement('div');
    urlLine.style.cssText =
      'font-size:10px;color:#78716c;word-break:break-all;margin-bottom:14px;font-family:ui-monospace,Consolas,monospace;';
    urlLine.textContent = pageUrl;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const mkBtn = (label, primary, choice) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = [
        'padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;',
        primary
          ? 'background:#c2410c;color:#fff;border:none;'
          : 'background:#fafaf9;color:#44403c;border:1px solid #d6d3d1;',
      ].join('');
      b.addEventListener('click', () => {
        document.body.removeChild(overlay);
        onPick(choice);
      });
      return b;
    };

    if (hints.isPlaylistPage) {
      row.appendChild(mkBtn('Download full playlist', true, 'playlist'));
      row.appendChild(
        mkBtn('Cancel', false, null)
      );
    } else {
      row.appendChild(mkBtn('This video only', true, 'single'));
      row.appendChild(mkBtn('Full playlist', false, 'playlist'));
      row.appendChild(
        mkBtn('Cancel', false, null)
      );
    }

    const close = () => {
      if (overlay.parentNode) document.body.removeChild(overlay);
      onPick(null);
    };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });

    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(urlLine);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
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
