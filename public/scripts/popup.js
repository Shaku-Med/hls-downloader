const JOBS_KEY = 'hlsGrabJobsState';
const STREAMS_REV_KEY = 'hlsGrabStreamsRev';

/** Signature of stream list so live refresh can skip no-op re-renders. */
let _lastStreamsSig = '';

function streamsSignature(streams) {
  return (streams || [])
    .map((s) => {
      if (typeof s === 'string') return s;
      return `${s.urlSource || ''}|${s.cleanedUrl || s.url || ''}|${s.streamKind || ''}`;
    })
    .join('\n');
}

/**
 * Ask once before Get all: include thumbnails for every link?
 * Prefers the on-page extension sheet; falls back to the same themed UI in the popup.
 * @param {number} count
 * @param {(choice: boolean | null) => void} onDone — true=with thumbs, false=without, null=cancel
 */
function askThumbnailsForAllLocal(count, onDone) {
  if (window.HGR_THEME && typeof window.HGR_THEME.showBatchThumbnailPrompt === 'function') {
    window.HGR_THEME.showBatchThumbnailPrompt(count, onDone, document.body);
    return;
  }
  // Last-resort fallback if theme helpers failed to load
  const pick = window.confirm(
    `Queue ${count} page links?\n\nOK = with thumbnails for all\nCancel = cancel\n\n(Use Cancel then Get all again… or reload if this looks wrong.)`
  );
  onDone(pick ? true : null);
}

function askThumbnailsForAll(count, onDone) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs && tabs[0] ? tabs[0].id : null;
    if (tabId == null) {
      askThumbnailsForAllLocal(count, onDone);
      return;
    }
    chrome.tabs.sendMessage(
      tabId,
      { type: 'HLS_SHOW_BATCH_THUMB_PROMPT', count },
      (res) => {
        if (chrome.runtime.lastError || !res || typeof res.choice === 'undefined') {
          askThumbnailsForAllLocal(count, onDone);
          return;
        }
        onDone(res.choice);
      }
    );
  });
}

/**
 * Queue page-link downloads with defaults (no per-item format/ffmpeg prompts).
 * @param {Array<{url:string, kind:string, filename:string, capturedHeaders:object}>} items
 * @param {{ writeThumbnail: boolean }} opts
 * @param {(queued: number, failed: number) => void} [onDone]
 */
function queuePageLinkBatch(items, opts, onDone) {
  const writeThumbnail = !!(opts && opts.writeThumbnail);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const tabUrl = tab?.url || '';
    const tabId = tab?.id;
    let left = items.length;
    let queued = 0;
    let failed = 0;
    if (!items.length) {
      if (onDone) onDone(0, 0);
      return;
    }
    const doneOne = () => {
      left -= 1;
      if (left <= 0 && onDone) onDone(queued, failed);
    };
    items.forEach((item) => {
      const url = item.url;
      const kind = item.kind || 'social';
      const filename = item.filename || 'video';
      const capturedHeaders = item.capturedHeaders || {};
      const jobId = genJobId();
      // Each link is its own download target. Tab URL is only the referer.
      let effUrl = url;
      let effPage = url;
      let effRef = isHttpUrl(tabUrl) ? tabUrl : url;
      let effOrigin = '';
      try {
        effOrigin = new URL(effUrl || url).origin;
      } catch (_) {}
      if (/music\.apple\.com/i.test(url)) {
        effUrl = url;
        effPage = url;
        effRef = url;
        try {
          effOrigin = new URL(url).origin;
        } catch (_) {}
      }
      buildCookieHeader(effUrl, effRef || tabUrl, (cookie) => {
        const payload = {
          jobId,
          url: effUrl,
          filename,
          tabId: tabId != null ? tabId : undefined,
          streamKind: kind || undefined,
          cookie: cookie || undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          capturedHeaders,
        };
        if (effPage && isHttpUrl(effPage)) {
          payload.pageUrl = effPage;
          payload.referer = effRef || effPage;
          if (effOrigin) payload.origin = effOrigin;
        }
        if (/music\.apple\.com/i.test(effUrl || '')) {
          payload.ytDlpAudioOnly = true;
          payload.streamKind = 'social';
        }
        const cookieBrowser = cookieBrowserFromUa();
        if (cookieBrowser) payload.ytDlpCookiesFromBrowser = cookieBrowser;
        if (writeThumbnail) payload.ytDlpWriteThumbnail = true;
        chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload }, (r) => {
          if (chrome.runtime.lastError || !r?.ok) failed += 1;
          else queued += 1;
          doneOne();
        });
      });
    });
  });
}

function isHttpUrl(u) {
  return u && (u.startsWith('http:') || u.startsWith('https:'));
}

function buildCookieHeader(streamUrl, tabUrl, callback) {
  chrome.cookies.getAll({ url: streamUrl }, (forStream) => {
    const map = new Map();
    for (const c of ofArray(forStream)) {
      map.set(c.name, c.value);
    }
    if (!isHttpUrl(tabUrl)) {
      callback(
        Array.from(map.entries())
          .map(([name, value]) => `${name}=${value}`)
          .join('; ')
      );
      return;
    }
    chrome.cookies.getAll({ url: tabUrl }, (forTab) => {
      for (const c of ofArray(forTab)) {
        if (!map.has(c.name)) map.set(c.name, c.value);
      }
      callback(
        Array.from(map.entries())
          .map(([name, value]) => `${name}=${value}`)
          .join('; ')
      );
    });
  });
}

function ofArray(x) {
  return x || [];
}

function genJobId() {
  return `j_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Which browser yt-dlp should read cookies from. We are running inside it, so the user agent
 * tells us. Lets logged-in Instagram/Facebook grabs work without the user setting anything up.
 * Brave reports itself as Chrome, so those users get the chrome default.
 */
function cookieBrowserFromUa() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  return '';
}

function ytdlpFormatSelection(row) {
  if (!row) return '';
  if (row.has_video && row.has_audio) return String(row.format_id);
  if (row.has_video) return `${row.format_id}+bestaudio/best`;
  return '';
}

/** @param {(row: object | null | undefined) => void} callback - null = best auto, undefined = canceled */
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

/* ── Ready status dot ── */
const ready = { hasPath: false, active: 0, helper: null };

function updateReadyDot() {
  const dot = document.getElementById('status-dot');
  const title = document.getElementById('status-pop-title');
  const body = document.getElementById('status-pop-body');
  if (!dot) return;
  dot.classList.remove('is-setup', 'is-busy', 'is-error');
  const helper = ready.helper;
  const helperBad =
    helper &&
    (helper.status === 'missing' ||
      helper.status === 'error' ||
      helper.status === 'degraded' ||
      helper.ok === false);

  if (helperBad) {
    dot.classList.add(helper.status === 'degraded' ? 'is-setup' : 'is-error');
    if (title) {
      title.textContent =
        helper.status === 'missing'
          ? 'Helper missing'
          : helper.status === 'degraded'
            ? 'Helper needs attention'
            : 'Helper error';
    }
    if (body) {
      let msg =
        helper.error ||
        (helper.status === 'missing'
          ? 'Install the download helper, then fully restart the browser.'
          : 'Open Helper on this PC for ffmpeg / yt-dlp / install steps.');
      if (!ready.hasPath) msg += ' Also pick a save folder in Settings.';
      body.textContent = msg;
    }
    return;
  }
  if (!ready.hasPath) {
    dot.classList.add('is-setup');
    if (title) title.textContent = 'One quick thing first';
    if (body) body.textContent = "Pick a folder to save into and you're all set. Click the gear to choose one.";
    return;
  }
  if (ready.active > 0) {
    dot.classList.add('is-busy');
    if (title) title.textContent = `${ready.active} download${ready.active > 1 ? 's' : ''} on the way`;
    if (body) body.textContent = "Working on it. Feel free to close this window, I'll keep going in the background.";
    return;
  }
  if (title) title.textContent = 'Ready to go';
  if (body) body.textContent = "Everything's set. Open a page with video, audio, or images and I'll grab it for you.";
}

function setReadyActive(active) {
  ready.active = active || 0;
  updateReadyDot();
}

function setPathBar(userDownloadPath) {
  ready.hasPath = !!userDownloadPath;
  updateReadyDot();
  const el = document.getElementById('path-line');
  if (!el) return;
  if (userDownloadPath) {
    const short = userDownloadPath.length > 42 ? userDownloadPath.slice(0, 40) + '…' : userDownloadPath;
    el.textContent = `Saving to ${short}`;
    el.classList.remove('path-missing');
  } else {
    el.textContent = 'No save folder yet. Pick one in Settings.';
    el.classList.add('path-missing');
  }
}

function refreshHelperHealthForPopup() {
  chrome.runtime.sendMessage({ type: 'GET_HELPER_HEALTH' }, (res) => {
    if (chrome.runtime.lastError) {
      ready.helper = {
        ok: false,
        status: 'error',
        error: chrome.runtime.lastError.message,
      };
      updateReadyDot();
      return;
    }
    ready.helper = res || { ok: false, status: 'error', error: 'No response' };
    updateReadyDot();
  });
}

function renderJobsBanner(jobs, meta) {
  const host = document.getElementById('download-banner');
  if (!host) return;
  const list = (jobs || []).filter((j) => j && j.id);
  if (list.length === 0) {
    host.hidden = true;
    host.textContent = '';
    setReadyActive(0);
    return;
  }
  host.hidden = false;
  host.textContent = '';
  const sub = document.createElement('div');
  const section = document.createElement('div');
  section.className = 'section-label';
  section.textContent = 'Downloads';
  host.appendChild(section);
  sub.className = 'queue-meta';
  const r = meta?.running ?? 0;
  const q = meta?.queueLength ?? 0;
  const m = meta?.max ?? 4;
  setReadyActive(r + q);
  let line = `${r} of ${m} downloading`;
  if (q > 0) line += `. ${q} queued`;
  sub.textContent = line;
  host.appendChild(sub);
  for (const job of list) {
    const card = document.createElement('div');
    card.className = 'job-card';
    const t = document.createElement('div');
    t.className = 'job-title';
    t.textContent = (job.label || 'video') + ' (' + (job.status || '') + ')';
    const d = document.createElement('div');
    d.className = 'job-detail';
    const spotifyBlocked =
      typeof job.error === 'string' &&
      /spotify/i.test(job.error) &&
      /(drm|unsupported|protected)/i.test(job.error);
    if (job.status === 'error') {
      d.textContent = spotifyBlocked
        ? 'Spotify source protected (DRM/unsupported). Try another source URL.'
        : job.error || '';
    } else if (job.status === 'canceled') {
      d.textContent = job.error || 'Canceled';
    } else {
      let detail = job.detail || job.error || '';
      if (job.mediaId && !String(detail).includes(String(job.mediaId))) {
        detail = detail ? `${detail} · ${job.mediaId}` : String(job.mediaId);
      }
      if (job.ffmpegPreset && ['queued', 'connecting', 'downloading'].includes(job.status)) {
        detail = detail ? `${detail} · preset ${job.ffmpegPreset}` : `preset ${job.ffmpegPreset}`;
      }
      d.textContent = detail;
    }
    card.appendChild(t);
    card.appendChild(d);
    if (['queued', 'connecting', 'downloading'].includes(job.status)) {
      const track = document.createElement('div');
      track.className = 'job-progress';
      const fill = document.createElement('div');
      fill.className = 'job-progress-fill';
      const pct = job.percent != null ? Number(job.percent) : NaN;
      if (Number.isFinite(pct)) {
        fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      } else {
        fill.classList.add('is-indeterminate');
      }
      track.appendChild(fill);
      card.appendChild(track);
      if (job.playlistIndex != null && job.playlistCount != null) {
        const pl = document.createElement('div');
        pl.className = 'job-playlist';
        pl.textContent = `Playlist item ${job.playlistIndex} of ${job.playlistCount}${
          job.mediaId ? ` · ${job.mediaId}` : ''
        }`;
        card.appendChild(pl);
      }
    }
    if (typeof HLS_FFMPEG !== 'undefined' && HLS_FFMPEG.enhanceJobCard) {
      HLS_FFMPEG.enhanceJobCard(job, card, {
        onRefresh: () => {
          chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
            renderJobsBanner(response?.jobs || [], {
              running: response?.running,
              queueLength: response?.queueLength,
              max: response?.max,
            });
          });
        },
      });
    }
    if (job.outputPath && job.status === 'completed') {
      const p = document.createElement('div');
      p.className = 'job-path';
      p.textContent = job.outputPath;
      card.appendChild(p);
    }
    const row = document.createElement('div');
    row.className = 'banner-row';
    if (['queued', 'connecting', 'downloading'].includes(job.status)) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-danger';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', jobId: job.id });
      });
      row.appendChild(cancel);
    } else if (['completed', 'canceled', 'error'].includes(job.status)) {
      if (job.status === 'completed' && job.outputPath) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn-primary';
        openBtn.textContent = 'Open';
        openBtn.title = 'Open this file in a new browser tab';
        openBtn.addEventListener('click', () => {
          openBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'OPEN_JOB_FILE', jobId: job.id }, (r) => {
            openBtn.disabled = false;
            if (chrome.runtime.lastError || !r?.ok) {
              window.alert(
                chrome.runtime.lastError?.message || r?.error || 'Could not open file'
              );
            }
          });
        });
        row.appendChild(openBtn);
      }
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'btn-ghost';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'DISMISS_JOB', jobId: job.id });
      });
      row.appendChild(dismiss);
    }
    if (row.childElementCount) card.appendChild(row);
    host.appendChild(card);
  }
  const clear = document.createElement('div');
  clear.className = 'queue-meta';
  const cbtn = document.createElement('button');
  cbtn.type = 'button';
  cbtn.className = 'btn-ghost';
  cbtn.textContent = 'Clear finished';
  cbtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISMISS_DONE' });
  });
  clear.appendChild(cbtn);
  host.appendChild(clear);
}

function setStatusRunInBackground(statusEl) {
  statusEl.style.display = 'block';
  statusEl.className = 'status pending';
  statusEl.setAttribute('data-bg-run', '1');
  statusEl.textContent = "Queued up. You can close this window if you like; I run 4 at a time and the rest wait their turn.";
}

function isSpotifyLike(url, kind) {
  const u = String(url || '').toLowerCase();
  return kind === 'spotify' || u.includes('open.spotify.com') || u.includes('spotify.com/');
}

function spotifyContextFromTabUrl(tabUrl) {
  const u = String(tabUrl || '').trim();
  const low = u.toLowerCase();
  const isSpotify = low.includes('open.spotify.com') || low.includes('spotify.com/');
  const autoTrack = /open\.spotify\.com\/(track|episode)\//i.test(u) ? u : '';
  return { isSpotify, autoTrack, tabUrl: u };
}

function defaultSpotifyFileName(spotifyUrl) {
  try {
    const u = new URL(spotifyUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `spotify ${parts[0]} ${parts[1].slice(0, 8)}`;
  } catch (_) {}
  return 'spotify audio';
}

function buildSpotifyPromptCard(ctx, hasPath) {
  const item = document.createElement('div');
  item.className = 'stream-item';
  const top = document.createElement('div');
  top.className = 'stream-top';
  const h = document.createElement('div');
  h.className = 'stream-label';
  h.textContent = 'Spotify URL';
  const badge = document.createElement('span');
  badge.className = 'stream-kind-badge';
  badge.textContent = 'spotify';
  top.appendChild(h);
  top.appendChild(badge);
  const info = document.createElement('div');
  info.className = 'stream-url';
  info.textContent = 'Paste a Spotify track URL, or use the current page URL if you are already on a track.';
  const field = document.createElement('div');
  field.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = 'Spotify track URL';
  const row = document.createElement('div');
  row.className = 'row';
  const input = document.createElement('input');
  input.className = 'filename-input';
  input.type = 'text';
  input.value = ctx.autoTrack || '';
  input.placeholder = 'https://open.spotify.com/track/...';
  if (!hasPath) input.readOnly = true;
  const btn = document.createElement('button');
  btn.className = 'dl-btn';
  btn.type = 'button';
  btn.textContent = 'Download';
  if (!hasPath) btn.disabled = true;
  const status = document.createElement('div');
  status.className = 'status';
  status.style.display = 'none';
  row.appendChild(input);
  row.appendChild(btn);
  field.appendChild(lab);
  field.appendChild(row);
  item.appendChild(top);
  item.appendChild(info);
  item.appendChild(field);
  item.appendChild(status);

  btn.addEventListener('click', () => {
    const spotifyUrl = input.value.trim();
    if (!/^https?:\/\/(open\.)?spotify\.com\//i.test(spotifyUrl)) {
      status.style.display = 'block';
      status.className = 'status err';
      status.textContent = 'Enter a valid Spotify URL.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Queueing…';
    status.style.display = 'block';
    status.className = 'status pending';
    status.textContent = 'Attempting Spotify extraction…';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const tabUrl = tab?.url || ctx.tabUrl || spotifyUrl;
      const tabId = tab?.id;
      buildCookieHeader(spotifyUrl, tabUrl, (cookie) => {
        const payload = {
          jobId: genJobId(),
          url: spotifyUrl,
          filename: defaultSpotifyFileName(spotifyUrl),
          tabId: tabId != null ? tabId : undefined,
          streamKind: 'social',
          cookie: cookie || undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          pageUrl: tabUrl,
          referer: tabUrl,
        };
        chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload }, (r) => {
          btn.disabled = false;
          btn.textContent = 'Download';
          if (chrome.runtime.lastError || !r?.ok) {
            status.className = 'status err';
            status.textContent = chrome.runtime.lastError?.message || r?.error || 'Could not start';
            return;
          }
          status.className = 'status ok';
          status.textContent = 'Download queued';
        });
      });
    });
  });
  return item;
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
  if (/^(new tab|untitled|loading)$/i.test(t) || t.length < 1) {
    return '';
  }
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

function setContextLine(pageTitle) {
  const el = document.getElementById('context-line');
  if (!el) return;
  if (pageTitle) {
    const short =
      pageTitle.length > 52 ? pageTitle.slice(0, 50).trim() + '…' : pageTitle;
    el.textContent = `You're on: ${short}`;
  } else {
    el.textContent = "Give it a name, or I'll guess one from the link.";
  }
}

function enhanceIosSelect(sel) {
  if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
    HLS_IOS_SELECT.enhance(sel, { compact: true });
  }
}

const IMAGE_GRABBER_KEY = 'imageHoverDownloadEnabled';

function clearPageImages() {
  const host = document.getElementById('images-root');
  if (!host) return;
  host.textContent = '';
  host.hidden = true;
}

function renderPageImages(hasPath) {
  const host = document.getElementById('images-root');
  if (!host || !window.HLS_IMAGE_PANEL) return;
  chrome.storage.local.get([IMAGE_GRABBER_KEY], (data) => {
    if (chrome.runtime.lastError) {
      clearPageImages();
      return;
    }
    if (data[IMAGE_GRABBER_KEY] !== true) {
      clearPageImages();
      return;
    }
    host.hidden = false;
    void HLS_IMAGE_PANEL.render(host, {
      hasPath: !!hasPath,
      enhanceSelect: enhanceIosSelect,
    });
  });
}

function streamUrlSource(stream) {
  if (!stream) return 'traffic';
  if (stream.pageDownload === true) {
    return stream.urlSource === 'tab' ? 'tab' : 'link';
  }
  return 'traffic';
}

function streamSourceSectionLabel(src, count) {
  if (src === 'tab') return 'This page';
  if (src === 'link') {
    const n = typeof count === 'number' ? count : null;
    return n != null ? `From page links (${n})` : 'From page links';
  }
  return 'From network';
}

function streamSourceBadge(stream, kind) {
  const src = streamUrlSource(stream);
  if (src === 'link') return { text: 'page link', mod: 'link' };
  if (src === 'tab') return { text: kind === 'yt' ? 'yt page' : 'this page', mod: 'tab' };
  return { text: kind || 'stream', mod: 'traffic' };
}

function makeExpandableUrl(url, className, maxLen) {
  const api = (typeof HGR_THEME !== 'undefined' && HGR_THEME.createExpandableUrl)
    || (typeof globalThis !== 'undefined' && globalThis.HGR_THEME && globalThis.HGR_THEME.createExpandableUrl);
  if (typeof api === 'function') {
    return api(url, { className: className || 'url-expand', maxLen: maxLen || 72 });
  }
  // Fallback if theme helpers failed to load.
  const wrap = document.createElement('div');
  wrap.className = className || 'url-expand';
  const text = document.createElement('div');
  text.className = 'url-expand-text';
  text.textContent = String(url || '');
  wrap.appendChild(text);
  return {
    el: wrap,
    textEl: text,
    getUrl: () => String(url || ''),
    setUrl(next) {
      text.textContent = String(next || '');
    },
  };
}

function renderStreams(streams, pageTitle, hasPath, spotifyCtx) {
  setContextLine(pageTitle);
  const content = document.getElementById('streams-root') || document.getElementById('content');

  const visibleStreams = (streams || []).map((raw) => (typeof raw === 'string' ? { url: raw } : raw)).filter(Boolean);

  if (!visibleStreams || visibleStreams.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = "<strong>Nothing to grab yet</strong><br>Play the video for a second, then open me again.";
    content.textContent = '';
    content.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'stream-list';
  const n = visibleStreams.length;
  if (spotifyCtx && spotifyCtx.isSpotify) {
    list.appendChild(buildSpotifyPromptCard(spotifyCtx, hasPath));
  }

  const sourceTypes = new Set(visibleStreams.map((s) => streamUrlSource(typeof s === 'string' ? { url: s } : s)));
  const linkStreamEntries = visibleStreams
    .map((raw, i) => {
      const stream = typeof raw === 'string' ? { url: raw } : raw;
      return { stream, i };
    })
    .filter(({ stream }) => stream.pageDownload === true && streamUrlSource(stream) === 'link');
  const linkCount = linkStreamEntries.length;
  // Always label page-links (shows count + Get all). Other sections when mixed.
  const showSourceSections = sourceTypes.size > 1 || linkCount > 0;
  let lastSource = '';
  /** @type {HTMLElement | null} */
  let linkGrid = null;
  /** @type {HTMLButtonElement | null} */
  let getAllBtn = null;

  visibleStreams.forEach((raw, i) => {
    const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
    const cleanedUrl = stream.cleanedUrl || '';
    const urlSource = streamUrlSource(stream);
    // Page links: always use cleaned URL. Only the main tab item can opt into cleaning.
    let url =
      urlSource === 'link' && cleanedUrl
        ? cleanedUrl
        : stream.url || '';
    const defaultName = defaultFileName(i, n, pageTitle, url);
    const kind = stream.streamKind ? String(stream.streamKind) : '';
    const pageOnly = stream.pageDownload === true;
    const isAppleMusicPage = /music\.apple\.com/i.test(String(url || ''));
    const isLinkCard = pageOnly && urlSource === 'link';

    if (showSourceSections && urlSource !== lastSource) {
      lastSource = urlSource;
      if (urlSource === 'link') {
        const sec = document.createElement('div');
        sec.className = 'stream-source-row';
        const lab = document.createElement('div');
        lab.className = 'stream-source-label';
        lab.textContent = streamSourceSectionLabel('link', linkCount);
        getAllBtn = document.createElement('button');
        getAllBtn.type = 'button';
        getAllBtn.className = 'get-all-links-btn';
        getAllBtn.textContent = 'Get all';
        if (!hasPath) {
          getAllBtn.disabled = true;
          getAllBtn.title = 'Add a save folder in Options first';
        } else {
          getAllBtn.title = `Queue all ${linkCount} page links (up to 4 download at once)`;
        }
        getAllBtn.addEventListener('click', () => {
          if (!hasPath) {
            chrome.runtime.openOptionsPage();
            return;
          }
          if (!linkCount || !getAllBtn) return;
          const items = linkStreamEntries.map(({ stream: s, i: idx }) => {
            const cleaned = s.cleanedUrl || '';
            const u = cleaned || s.url || '';
            return {
              url: u,
              kind: s.streamKind ? String(s.streamKind) : 'social',
              filename: defaultFileName(idx, n, pageTitle, u),
              capturedHeaders: s.capturedHeaders || {},
            };
          });
          // Hand off to the page so the themed sheet + float panel are visible.
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs && tabs[0] ? tabs[0].id : null;
            if (tabId == null) {
              askThumbnailsForAllLocal(linkCount, (choice) => {
                if (choice === null) return;
                queuePageLinkBatch(items, { writeThumbnail: choice === true }, () =>
                  refreshJobsBannerOnly()
                );
              });
              return;
            }
            getAllBtn.disabled = true;
            getAllBtn.textContent = 'Opening…';
            chrome.tabs.sendMessage(
              tabId,
              { type: 'HLS_GET_ALL_PAGE_LINKS', items, count: linkCount },
              (res) => {
                if (chrome.runtime.lastError || !res?.ok) {
                  getAllBtn.disabled = false;
                  getAllBtn.textContent = 'Get all';
                  askThumbnailsForAllLocal(linkCount, (choice) => {
                    if (choice === null) {
                      getAllBtn.disabled = false;
                      getAllBtn.textContent = 'Get all';
                      return;
                    }
                    queuePageLinkBatch(items, { writeThumbnail: choice === true }, () =>
                      refreshJobsBannerOnly()
                    );
                  });
                  return;
                }
                // Page sheet is up — close popup so the dialog is visible.
                try {
                  window.close();
                } catch (_) {
                  getAllBtn.disabled = false;
                  getAllBtn.textContent = 'Get all';
                }
              }
            );
          });
        });
        sec.appendChild(lab);
        sec.appendChild(getAllBtn);
        list.appendChild(sec);
        linkGrid = null;
      } else {
        const sec = document.createElement('div');
        sec.className = 'stream-source-label';
        sec.textContent = streamSourceSectionLabel(urlSource);
        list.appendChild(sec);
        linkGrid = null;
      }
    }

    const item = document.createElement('div');
    item.dataset.urlSource = urlSource;

    const input = document.createElement('input');
    input.className = 'filename-input';
    input.type = 'text';
    input.id = `name-${i}`;
    input.value = defaultName;
    input.setAttribute('placeholder', 'e.g. My video');
    if (!hasPath) input.readOnly = true;

    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.type = 'button';
    btn.id = `btn-${i}`;
    if (!hasPath) {
      btn.disabled = true;
      btn.title = 'Add a save folder in Options first';
    }
    btn.textContent = isLinkCard ? 'Download' : pageOnly ? 'Download this' : 'Download';

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.id = `status-${i}`;
    statusEl.style.display = 'none';

    if (isLinkCard) {
      item.className = 'stream-item stream-item--link';
      const main = document.createElement('div');
      main.className = 'link-card-main';
      const titleRow = document.createElement('div');
      titleRow.className = 'link-card-title-row';
      const badge = document.createElement('span');
      badge.className = 'stream-kind-badge stream-kind-badge--link';
      badge.textContent = 'page link';
      titleRow.appendChild(badge);
      titleRow.appendChild(input);
      const urlView = makeExpandableUrl(url, 'url-expand link-card-url', 56);
      main.appendChild(titleRow);
      main.appendChild(urlView.el);
      const thumbLab = document.createElement('label');
      thumbLab.className = 'stream-thumb-label link-card-thumb';
      const tcb = document.createElement('input');
      tcb.type = 'checkbox';
      tcb.id = `thumb-${i}`;
      thumbLab.appendChild(tcb);
      const tsp = document.createElement('span');
      tsp.textContent = 'Also save thumbnail';
      thumbLab.appendChild(tsp);
      main.appendChild(thumbLab);
      item.appendChild(main);
      item.appendChild(btn);
      item.appendChild(statusEl);
      if (!linkGrid) {
        linkGrid = document.createElement('div');
        linkGrid.className = 'link-stream-grid';
        list.appendChild(linkGrid);
      }
      linkGrid.appendChild(item);
    } else {
      linkGrid = null;
      item.className = 'stream-item';
      const top = document.createElement('div');
      top.className = 'stream-top';
      const h = document.createElement('div');
      h.className = 'stream-label';
      h.textContent = pageOnly
        ? isAppleMusicPage
          ? 'Download this track'
          : 'Download this video'
        : n > 1
          ? `Stream ${i + 1} of ${n}` + (kind ? ` (${kind})` : '')
          : kind
            ? `Stream (${kind})`
            : 'Stream';
      const badgeInfo = streamSourceBadge(stream, kind);
      const badge = document.createElement('span');
      badge.className = `stream-kind-badge stream-kind-badge--${badgeInfo.mod}`;
      badge.textContent = badgeInfo.text;
      top.appendChild(h);
      top.appendChild(badge);

      const urlEl = document.createElement('div');
      urlEl.className = 'stream-url';
      const urlView = makeExpandableUrl(url, 'url-expand stream-page-link', 80);
      if (pageOnly) {
        const intro = document.createElement('div');
        intro.className = 'stream-page-intro';
        intro.textContent = isAppleMusicPage
          ? 'Apple Music: yt-dlp uses the song page URL below (not the FairPlay m3u8 stream).'
          : 'This tab’s post URL. Playlist bits stay on. Tap Clean URL if you want tracking junk removed.';
        urlEl.appendChild(intro);
        urlEl.appendChild(urlView.el);
        // Clean URL only on the main tab item (not page links).
        if (urlSource === 'tab' && cleanedUrl && cleanedUrl !== url) {
          const cleanBtn = document.createElement('button');
          cleanBtn.type = 'button';
          cleanBtn.className = 'url-clean-btn';
          cleanBtn.textContent = 'Clean URL';
          cleanBtn.title = 'Strip tracking junk (keeps playlist list= / video id)';
          cleanBtn.addEventListener('click', () => {
            url = cleanedUrl;
            urlView.setUrl(url);
            cleanBtn.disabled = true;
            cleanBtn.textContent = 'Cleaned';
          });
          urlEl.appendChild(cleanBtn);
        }
      } else {
        urlEl.appendChild(urlView.el);
      }

      const field = document.createElement('div');
      field.className = 'field';
      const isSubtitle = kind === 'subtitle';
      const lab = document.createElement('label');
      lab.setAttribute('for', `name-${i}`);
      lab.textContent = isSubtitle ? 'File name (no .vtt)' : 'File name (no .mp4)';
      const row = document.createElement('div');
      row.className = 'row';
      row.appendChild(input);
      row.appendChild(btn);
      field.appendChild(lab);
      field.appendChild(row);
      if (pageOnly) {
        const thumbLab = document.createElement('label');
        thumbLab.className = 'stream-thumb-label';
        const tcb = document.createElement('input');
        tcb.type = 'checkbox';
        tcb.id = `thumb-${i}`;
        thumbLab.appendChild(tcb);
        const tsp = document.createElement('span');
        tsp.textContent = 'Also save thumbnail (jpg next to the video)';
        thumbLab.appendChild(tsp);
        field.appendChild(thumbLab);
      }

      item.appendChild(top);
      item.appendChild(urlEl);
      item.appendChild(field);
      item.appendChild(statusEl);
      list.appendChild(item);
    }

    btn.addEventListener('click', () => {
      if (!hasPath) {
        chrome.runtime.openOptionsPage();
        return;
      }
      const filename = document.getElementById(`name-${i}`).value.trim() || defaultName;
      const jobId = genJobId();
      btn.disabled = true;
      btn.textContent = 'Queueing…';
      if (isSpotifyLike(url, kind)) {
        statusEl.style.display = 'block';
        statusEl.className = 'status pending';
        statusEl.textContent = 'Attempting Spotify extraction…';
      } else {
        setStatusRunInBackground(statusEl);
      }

      const YT = typeof window !== 'undefined' ? window.HLS_YT : null;

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const tabUrl = tab?.url || '';
        const tabId = tab?.id;
        const capturedHeaders = stream.capturedHeaders || {};

        const resetDlUi = () => {
          btn.disabled = false;
          btn.textContent = isLinkCard ? 'Download' : pageOnly ? 'Download this' : 'Download';
          statusEl.removeAttribute('data-bg-run');
        };

        const startCookieAndDl = (plPick) => {
          let effUrl = url;
          let effPage = '';
          let effRef = '';
          let effOrigin = '';
          let plDl = false;
          if (isLinkCard) {
            // Page-link row: download THIS link, not the tab feed/playlist page.
            effUrl = url;
            effPage = url;
            effRef = isHttpUrl(tabUrl) ? tabUrl : url;
            try {
              effOrigin = new URL(effUrl).origin;
            } catch (_) {}
          } else if (isHttpUrl(tabUrl)) {
            effPage = tabUrl;
            effRef = tabUrl;
            try {
              effOrigin = new URL(tabUrl).origin;
            } catch (_) {}
          }
          if (!isLinkCard && pageOnly && kind === 'yt' && YT && YT.isYoutubePage(tabUrl)) {
            const yChoice = plPick === 'playlist' ? 'playlist' : 'single';
            const a = YT.applyYoutubeChoice(tabUrl, yChoice);
            effUrl = a.targetUrl;
            effPage = a.pageUrl;
            effRef = a.referer;
            effOrigin = a.origin || effOrigin;
            plDl = !!a.ytDlpDownloadPlaylist;
          } else if (!isLinkCard && pageOnly && /music\.apple\.com/i.test(tabUrl || url || '')) {
            const appleUrl = /music\.apple\.com/i.test(tabUrl || '') ? tabUrl : url;
            effUrl = appleUrl;
            effPage = appleUrl;
            effRef = appleUrl;
            try {
              effOrigin = new URL(appleUrl).origin;
            } catch (_) {}
          } else if (!isLinkCard && !isHttpUrl(tabUrl)) {
            effPage = effUrl;
            effRef = effUrl;
            try {
              effOrigin = new URL(effUrl).origin;
            } catch (_) {}
          }

          buildCookieHeader(effUrl, effPage || tabUrl, (cookie) => {
            const payload = {
              jobId,
              url: effUrl,
              filename,
              tabId: tabId != null ? tabId : undefined,
              streamKind: kind || undefined,
              cookie: cookie || undefined,
              userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
              capturedHeaders,
            };
            if (effPage && isHttpUrl(effPage)) {
              payload.pageUrl = effPage;
              payload.referer = effRef || effPage;
              if (effOrigin) payload.origin = effOrigin;
            }
            if (plDl) payload.ytDlpDownloadPlaylist = true;
            if (pageOnly && /music\.apple\.com/i.test(effUrl || '')) {
              payload.ytDlpAudioOnly = true;
              payload.streamKind = 'social';
            }
            const cookieBrowser = cookieBrowserFromUa();
            if (cookieBrowser) payload.ytDlpCookiesFromBrowser = cookieBrowser;

            const probePayload = {
              url: payload.url,
              tabId: tabId != null ? tabId : undefined,
              cookie: payload.cookie,
              userAgent: payload.userAgent,
              capturedHeaders: payload.capturedHeaders,
              pageUrl: payload.pageUrl,
              referer: payload.referer,
              origin: payload.origin,
              ytDlpCookiesFromBrowser: cookieBrowser || undefined,
            };

            const buildFinalPayload = (ytFmt, ffmpegPreset, extra = {}) => {
              const finalPayload = { ...payload, ...extra };
              if (ytFmt) finalPayload.ytDlpFormat = ytFmt;
              if (ffmpegPreset) finalPayload.ffmpegPreset = ffmpegPreset;
              const th = document.getElementById(`thumb-${i}`);
              if (pageOnly && th && th.checked) finalPayload.ytDlpWriteThumbnail = true;
              return finalPayload;
            };

            const sendDownload = (finalPayload, onResult) => {
              chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: finalPayload }, (r) => {
                if (chrome.runtime.lastError) {
                  onResult({ ok: false, error: chrome.runtime.lastError.message });
                  return;
                }
                onResult(r || { ok: false });
              });
            };

            const startDl = (ytFmt, ffmpegPreset, extra) => {
              sendDownload(buildFinalPayload(ytFmt, ffmpegPreset, extra), (r) => {
                if (!r?.ok) {
                  resetDlUi();
                  statusEl.style.display = 'block';
                  statusEl.className = 'status err';
                  statusEl.textContent = r?.error || 'Could not start';
                  return;
                }
                resetDlUi();
                if (isSpotifyLike(url, kind)) {
                  statusEl.style.display = 'block';
                  statusEl.className = 'status ok';
                  statusEl.textContent = 'Download complete';
                }
              });
            };

            maybeAskYtdlpFormat(kind, probePayload, (ytFmt) => {
              const ffProbe = { ...probePayload, streamKind: kind };
              const jobOutputPaths = {};
              const ffCtx = {
                filename,
                ext: '.mp4',
                onStart: (preset, cb) => {
                  if (preset == null) {
                    startDl(ytFmt, null);
                    if (cb) cb(null, null);
                    return;
                  }
                  sendDownload(buildFinalPayload(ytFmt, preset), (r) => {
                    if (!r?.ok) {
                      if (cb) cb(r?.error || 'Could not start', null);
                      return;
                    }
                    if (r.jobId) jobOutputPaths[r.jobId] = '';
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
                      if (cb) cb(null, r.jobId);
                    }
                  );
                },
                getJobOutputPath: (jid) => jobOutputPaths[jid] || '',
              };
              const askFf =
                typeof HLS_FFMPEG !== 'undefined' && HLS_FFMPEG.maybeAskFfmpegPreset
                  ? HLS_FFMPEG.maybeAskFfmpegPreset.bind(HLS_FFMPEG)
                  : (_k, _p, ctx) => ctx.onStart(null, () => {});
              askFf(kind, ffProbe, ffCtx, () => {
                resetDlUi();
              });
            }, () => {
              resetDlUi();
              statusEl.style.display = 'block';
              statusEl.className = 'status err';
              statusEl.textContent = 'Canceled';
            });
          });
        };

        if (pageOnly && kind === 'yt' && YT && YT.isYoutubePage(tabUrl)) {
          const hints = YT.playlistHints(tabUrl);
          if (hints.shouldAskPlaylist) {
            YT.showPlaylistPrompt(tabUrl, hints, (pick) => {
              if (pick === null) {
                resetDlUi();
                return;
              }
              startCookieAndDl(pick);
            });
            return;
          }
        }
        startCookieAndDl('single');
      });
    });
  });

  content.textContent = '';
  content.appendChild(list);
}

/** Make sure the active tab has live content scripts (FAB / image grabber). */
function ensureActiveTabScripts(tab, done) {
  if (!tab || tab.id == null) {
    if (done) done(false);
    return;
  }
  const url = String(tab.url || '');
  if (!/^https?:/i.test(url) && !/^file:/i.test(url)) {
    if (done) done(false);
    return;
  }
  const finish = (ok) => {
    if (done) done(!!ok);
  };
  chrome.tabs.sendMessage(tab.id, { type: 'HLS_GRABBER_PING' }, (res) => {
    if (!chrome.runtime.lastError && res && res.ok) {
      finish(true);
      return;
    }
    chrome.runtime.sendMessage({ type: 'REINJECT_PAGE_SCRIPTS', tabId: tab.id }, () => {
      void chrome.runtime.lastError;
      window.setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'HLS_GRABBER_PING' }, (res2) => {
          finish(!chrome.runtime.lastError && res2 && res2.ok);
        });
      }, 250);
    });
  });
}

function loadUi() {
  try {
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' });
  } catch (_) {
    // ignore
  }
  if (window.HGR_THEME && window.HGR_THEME.initExtensionPageTheme) {
    window.HGR_THEME.initExtensionPageTheme();
  }
  refreshHelperHealthForPopup();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0] ? tabs[0] : null;
    const activeUrl = tab ? tab.url || '' : '';
    const spotifyCtx = spotifyContextFromTabUrl(activeUrl);
    ensureActiveTabScripts(tab, () => {
      chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
        const hasPath = !!(response && response.userDownloadPath);
        setPathBar(response && response.userDownloadPath);
        const streams = response?.streams || [];
        _lastStreamsSig = streamsSignature(streams);
        renderStreams(streams, response?.pageTitle || '', hasPath, spotifyCtx);
        renderJobsBanner(response?.jobs || [], {
          running: response?.running,
          queueLength: response?.queueLength,
          max: response?.maxParallel,
        });
        renderPageImages(hasPath);
      });
    });
  });
}

/** Job progress updates session storage often; only patch the banner so filename inputs keep focus. */
function refreshJobsBannerOnly() {
  chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    renderJobsBanner(response?.jobs || [], {
      running: response?.running,
      queueLength: response?.queueLength,
      max: response?.maxParallel,
    });
  });
}

/** Re-fetch streams when the page gathers more while the popup stays open. */
function refreshStreamsIfChanged() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeUrl = tabs && tabs[0] ? tabs[0].url || '' : '';
    const spotifyCtx = spotifyContextFromTabUrl(activeUrl);
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const streams = response.streams || [];
      const sig = streamsSignature(streams);
      if (sig === _lastStreamsSig) {
        refreshJobsBannerOnly();
        return;
      }
      _lastStreamsSig = sig;
      const hasPath = !!(response.userDownloadPath || '').trim();
      setPathBar(response.userDownloadPath);
      renderStreams(streams, response.pageTitle || '', hasPath, spotifyCtx);
      renderJobsBanner(response.jobs || [], {
        running: response.running,
        queueLength: response.queueLength,
        max: response.maxParallel,
      });
      renderPageImages(hasPath);
    });
  });
}

loadUi();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'HLS_GRABBER_LIVE_UPDATE') return;
  const kind = msg.kind || 'jobs';
  if (kind === 'streams' || kind === 'all') refreshStreamsIfChanged();
  else refreshJobsBannerOnly();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'HLS_GET_ALL_RESULT') return;
  // If popup is somehow still open when user cancels the page sheet, reset Get all.
  if (msg.canceled || msg.choice == null) {
    document.querySelectorAll('.get-all-links-btn').forEach((btn) => {
      btn.disabled = false;
      btn.textContent = 'Get all';
    });
  } else {
    refreshJobsBannerOnly();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[IMAGE_GRABBER_KEY]) return;
  if (changes[IMAGE_GRABBER_KEY].newValue === true) {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      renderPageImages(!!(response && response.userDownloadPath));
    });
  } else {
    clearPageImages();
  }
});

document.getElementById('open-options')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* ── Status dot: hover to peek, click to keep it open ── */
(function initStatusDot() {
  const dot = document.getElementById('status-dot');
  const pop = document.getElementById('status-pop');
  if (!dot || !pop) return;
  let pinned = false;
  let hideTimer = null;

  const show = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    pop.hidden = false;
    dot.setAttribute('aria-expanded', 'true');
  };
  const hide = () => {
    pop.hidden = true;
    dot.setAttribute('aria-expanded', 'false');
  };
  const hideSoon = () => {
    if (pinned) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 140);
  };

  dot.addEventListener('mouseenter', show);
  dot.addEventListener('mouseleave', hideSoon);
  pop.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
  pop.addEventListener('mouseleave', hideSoon);
  dot.addEventListener('focus', show);
  dot.addEventListener('blur', () => { if (!pinned) hide(); });
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    pinned = !pinned;
    if (pinned) show(); else hide();
  });
  document.addEventListener('click', (e) => {
    if (pinned && !pop.contains(e.target) && e.target !== dot) {
      pinned = false;
      hide();
    }
  });
})();

/* ── Record video elements (HLS_IOS_SELECT dropdown) ── */
(function initRecordUi() {
  const btn = document.getElementById('record-btn');
  const label = document.getElementById('record-btn-label');
  const statusEl = document.getElementById('record-status');
  const row = document.getElementById('record-row');
  const selectEl = document.getElementById('record-select');
  if (!btn || !label || !statusEl || !row || !selectEl) return;

  let isRecording = false;
  let pollTimer = null;
  let videos = [];
  let embeds = [];
  let selectedIndex = 0;
  let selectEnhanced = false;

  function setStatus(text) {
    if (text) {
      statusEl.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.textContent = '';
      statusEl.hidden = true;
    }
  }

  function shortHost(text, max) {
    const t = String(text || '').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  /** Cross-origin player: give the user a real button, not instructions. */
  function renderEmbedHint(list) {
    if (Array.isArray(list) && list.length) embeds = list;
    if (!embeds.length) return false;
    statusEl.textContent = '';
    statusEl.hidden = false;

    const box = document.createElement('div');
    box.className = 'embed-notice';

    const title = document.createElement('div');
    title.className = 'embed-notice-title';
    title.textContent = 'Can’t record this player';
    box.appendChild(title);

    const text = document.createElement('div');
    text.className = 'embed-notice-text';
    text.textContent =
      'The video is played through another site. To record it, open that site on its own. To just save the file, use a stream below instead.';
    box.appendChild(text);

    embeds.forEach((e) => {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'embed-open-btn';
      openBtn.textContent = `Open ${shortHost(e.host, 30)}`;
      openBtn.title = e.url;
      openBtn.addEventListener('click', () => {
        openBtn.disabled = true;
        openBtn.textContent = 'Opening…';
        chrome.runtime.sendMessage({ type: 'OPEN_URL_IN_TAB', url: e.url }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      });
      box.appendChild(openBtn);

      const link = document.createElement('div');
      link.className = 'embed-notice-url';
      link.textContent = e.url;
      box.appendChild(link);
    });

    statusEl.appendChild(box);
    return true;
  }

  /** frameId of the video the user picked, so embedded players are reachable. */
  function frameIdForIndex(idx) {
    const v = videos[idx];
    return v && Number.isFinite(Number(v.frameId)) ? Number(v.frameId) : 0;
  }

  /** The merged list is re-indexed; each frame still uses its own numbering. */
  function frameLocalIndex(idx) {
    const v = videos[idx];
    return v && Number.isFinite(Number(v.frameIndex)) ? Number(v.frameIndex) : idx;
  }

  function sendToTab(action, cb, extra) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { cb({ ok: false, error: 'No active tab' }); return; }
      // Goes through the background so every frame is covered, not just the top one.
      const msg = Object.assign(
        { type: 'VIDEO_RECORDER_ALL', action, tabId: tab.id },
        extra || {}
      );
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          cb({ ok: false, error: "I can't record on this page. Try reloading it. Some browser pages just won't allow it." });
          return;
        }
        cb(res || { ok: false });
      });
    });
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function shortLabel(text, max) {
    const t = String(text || 'Video').trim();
    const n = max || 42;
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function ensureSelectEnhanced() {
    if (selectEnhanced) return;
    if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
      HLS_IOS_SELECT.enhance(selectEl, { compact: true, className: 'rec-ios-select' });
      selectEnhanced = true;
    }
  }

  function fillSelect() {
    const prev = String(selectedIndex);
    selectEl.textContent = '';
    if (!videos.length) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = 'No videos right now';
      selectEl.appendChild(opt);
      selectEl.disabled = true;
    } else {
      selectEl.disabled = isRecording;
      videos.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = String(v.index);
        if (videos.length === 1) opt.textContent = '1 video on this page';
        else opt.textContent = `${v.index + 1}. ${shortLabel(v.label, 48)}`;
        selectEl.appendChild(opt);
      });
      selectEl.value = prev;
      if (selectEl.selectedIndex < 0) selectEl.selectedIndex = 0;
      selectedIndex = Number(selectEl.value) || 0;
    }
    ensureSelectEnhanced();
    try {
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      // ignore
    }
  }

  function applyVideoList(res) {
    videos = Array.isArray(res && res.videos) ? res.videos : [];
    embeds = Array.isArray(res && res.embeddedPlayers) ? res.embeddedPlayers : [];
    const pref = Number.isFinite(Number(res && res.preferredStartIndex))
      ? Number(res.preferredStartIndex)
      : selectedIndex;
    selectedIndex = videos.length
      ? Math.max(0, Math.min(videos.length - 1, pref | 0))
      : 0;
    fillSelect();
  }

  function enterRecordingUi() {
    isRecording = true;
    btn.classList.add('is-recording');
    label.textContent = 'Stop';
    selectEl.disabled = true;
    if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.closeAll) {
      try { HLS_IOS_SELECT.closeAll(); } catch (_) { /* ignore */ }
    }
    if (!pollTimer) pollTimer = setInterval(updateStatus, 1000);
  }
  function exitRecordingUi() {
    isRecording = false;
    btn.classList.remove('is-recording');
    label.textContent = 'Rec';
    selectEl.disabled = !videos.length;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updateStatus() {
    sendToTab('status', (res) => {
      if (!res || !res.recording) {
        if (isRecording) { exitRecordingUi(); setStatus('Recording saved.'); }
        return;
      }
      const act = res.active || [];
      const paused = act.filter((a) => a.gate && a.gate !== 'rec');
      if (paused.length) {
        const reasons = paused.map((a) => a.reason || a.gate);
        const why = reasons.includes('buffer') ? 'waiting for the video to catch up'
          : reasons.includes('resize') ? 'you resized the window'
          : reasons.includes('seek') ? 'you skipped ahead (hit play to continue)'
          : reasons.includes('hidden') ? 'this tab is in the background'
          : 'waiting for playback';
        setStatus(`Paused for a sec (${why})`);
        return;
      }
      const total = res.total || res.queueTotal || act.length;
      const pos = res.position || 1;
      if (res.sequential && total > 1) {
        const aLabel = act[0] ? act[0].label : 'video';
        const elapsed = act[0] ? fmt(act[0].elapsed) : '';
        setStatus(`Recording ${pos} of ${total}${elapsed ? `, ${elapsed}` : ''} on ${aLabel}`);
      } else {
        let txt = `Recording ${act.length} video${act.length > 1 ? 's' : ''}`;
        if (act.length === 1) txt += `, ${fmt(act[0].elapsed)}`;
        setStatus(txt);
      }
    });
  }

  function setRecordUiVisible(visible) {
    row.hidden = !visible;
    if (!visible) {
      setStatus('');
      videos = [];
    }
  }

  function scanAndUpdate() {
    sendToTab('scan', (res) => {
      if (!res || !res.ok) {
        setRecordUiVisible(false);
        return;
      }
      applyVideoList(res);
      if (res.recording) {
        setRecordUiVisible(true);
        enterRecordingUi();
        updateStatus();
      } else if (res.count > 0) {
        setRecordUiVisible(true);
        if (!statusEl.textContent || statusEl.hidden) {
          setStatus(
            res.count === 1
              ? 'Found 1 video. Hit Rec when you’re ready, or open the list to peek at it.'
              : `Found ${res.count} videos. Pick which one to start with, then hit Rec.`
          );
        }
      } else if (embeds.length) {
        // Nothing recordable here, but we can hand over the player URL.
        setRecordUiVisible(true);
        btn.disabled = true;
        renderEmbedHint();
      } else {
        setRecordUiVisible(false);
      }
    });
  }

  selectEl.addEventListener('change', () => {
    const idx = Number(selectEl.value);
    if (!Number.isFinite(idx)) return;
    selectedIndex = idx;
    if (isRecording) return;
    sendToTab('focus', (res) => {
      if (!res || !res.ok) {
        // The listed video is gone. If a cross-origin player is what is really
        // on the page, offer to open it rather than just complaining.
        if (renderEmbedHint(res && res.embeddedPlayers)) return;
        setStatus(res?.error || 'Couldn’t find that video. Try again.');
        return;
      }
      setStatus(`Got it. Brought you to “${shortLabel(res.label, 48)}”.`);
    }, { index: frameLocalIndex(idx), frameId: frameIdForIndex(idx) });
  });

  btn.addEventListener('click', () => {
    if (isRecording) {
      btn.disabled = true;
      sendToTab('stop', (res) => {
        btn.disabled = false;
        exitRecordingUi();
        if (res && res.ok && res.stopped) {
          setStatus(`Saved ${res.stopped.length} recording${res.stopped.length > 1 ? 's' : ''}.`);
        } else {
          setStatus(res?.error || 'Stopped');
        }
      });
    } else {
      btn.disabled = true;
      if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.closeAll) {
        try { HLS_IOS_SELECT.closeAll(); } catch (_) { /* ignore */ }
      }
      sendToTab('start', (res) => {
        btn.disabled = false;
        if (res && res.ok) {
          enterRecordingUi();
          if (res.sequential && res.total > 1) {
            setStatus(
              `Recording 1 of ${res.total}` +
                (res.remaining ? ` (${res.remaining} waiting in line)` : '')
            );
          } else {
            const fail = (res.details || []).filter((d) => !d.ok);
            let msg = `Recording ${res.count} of ${res.total} video${res.total > 1 ? 's' : ''}`;
            if (fail.length) msg += ` (${fail.length} skipped)`;
            setStatus(msg);
          }
        } else if (!renderEmbedHint(res && res.embeddedPlayers)) {
          setStatus(res?.error || 'Couldn’t start recording');
        }
      }, { startIndex: frameLocalIndex(selectedIndex), frameId: frameIdForIndex(selectedIndex) });
    }
  });

  scanAndUpdate();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.userDownloadPath) {
    loadUi();
    return;
  }
  if (area === 'session' && changes[STREAMS_REV_KEY]) {
    refreshStreamsIfChanged();
    return;
  }
  if (area === 'session' && changes[JOBS_KEY]) {
    refreshJobsBannerOnly();
  }
});
