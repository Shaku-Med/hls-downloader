const JOBS_KEY = 'hlsGrabJobsState';
const THEME_MODE_KEY = 'uiThemeMode';
const THEME_ACCENT_KEY = 'uiThemeAccent';

function resolveThemeMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) {
    return 'dark';
  }
}

function applyUiTheme(mode, accent) {
  const root = document.documentElement;
  const resolved = resolveThemeMode(mode);
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode || 'system');
  root.setAttribute('data-accent', accent || 'blue');
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

function ytdlpFormatSelection(row) {
  if (!row) return '';
  if (row.has_video && row.has_audio) return String(row.format_id);
  if (row.has_video) return `${row.format_id}+bestaudio/best`;
  return '';
}

/** @param {(row: object | null | undefined) => void} callback - null = best auto, undefined = canceled */
function showYtdlpFormatPicker(title, rows, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:100000;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;';
  const box = document.createElement('div');
  box.style.cssText =
    'background:#fff;border-radius:12px;padding:14px 16px;max-width:380px;width:100%;max-height:78vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.18);';
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:6px;color:#1c1917;';
  h.textContent = 'Choose quality';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:12px;color:#57534e;margin-bottom:12px;line-height:1.4;';
  sub.textContent = (title && title.trim()) || 'Several formats are available.';
  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'text-align:left;padding:10px 12px;border:1px solid #e7e2dc;border-radius:8px;background:#faf8f5;font-size:13px;cursor:pointer;font-family:inherit;';
    b.addEventListener('mouseenter', () => {
      b.style.background = '#fff7ed';
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = '#faf8f5';
    });
    b.addEventListener('click', onClick);
    return b;
  };
  form.appendChild(
    mkBtn('Best available (auto merge)', () => {
      document.body.removeChild(overlay);
      callback(null);
    })
  );
  for (const r of rows) {
    const rowRef = r;
    form.appendChild(
      mkBtn(rowRef.label || rowRef.format_id, () => {
        document.body.removeChild(overlay);
        callback(rowRef);
      })
    );
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText =
    'margin-top:10px;padding:8px 12px;border:none;background:transparent;color:#78716c;font-size:12px;cursor:pointer;font-family:inherit;width:100%;';
  cancel.addEventListener('click', () => {
    document.body.removeChild(overlay);
    callback(undefined);
  });
  box.appendChild(h);
  box.appendChild(sub);
  box.appendChild(form);
  box.appendChild(cancel);
  overlay.appendChild(box);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      document.body.removeChild(overlay);
      callback(undefined);
    }
  });
  document.body.appendChild(overlay);
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

function setPathBar(userDownloadPath) {
  const el = document.getElementById('path-line');
  if (!el) return;
  if (userDownloadPath) {
    const short = userDownloadPath.length > 42 ? userDownloadPath.slice(0, 40) + '…' : userDownloadPath;
    el.textContent = `Saves to ${short}`;
    el.classList.remove('path-missing');
  } else {
    el.textContent = 'No save folder yet. Set one in Options.';
    el.classList.add('path-missing');
  }
}

function renderJobsBanner(jobs, meta) {
  const host = document.getElementById('download-banner');
  if (!host) return;
  const list = (jobs || []).filter((j) => j && j.id);
  if (list.length === 0) {
    host.hidden = true;
    host.textContent = '';
    return;
  }
  host.hidden = false;
  host.textContent = '';
  const sub = document.createElement('div');
  sub.className = 'queue-meta';
  const r = meta?.running ?? 0;
  const q = meta?.queueLength ?? 0;
  const m = meta?.max ?? 4;
  const pill = document.getElementById('queue-pill');
  if (pill) {
    const active = r + q;
    pill.textContent = active > 0 ? `${active} active` : 'Idle';
    pill.classList.toggle('is-active', active > 0);
  }
  let line = `${r} of ${m} slots busy`;
  if (q > 0) line += `. ${q} in queue`;
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
      if (job.ffmpegPreset && ['queued', 'connecting', 'downloading'].includes(job.status)) {
        detail = detail ? `${detail} · preset ${job.ffmpegPreset}` : `preset ${job.ffmpegPreset}`;
      }
      d.textContent = detail;
    }
    card.appendChild(t);
    card.appendChild(d);
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
  statusEl.textContent = 'Queued. Close the popup if you need to. Up to 4 at once, then a line forms.';
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
    el.textContent = `This page: ${short}.`;
  } else {
    el.textContent = 'Type a file name in the box, or we will guess it from the link.';
  }
}

function renderStreams(streams, pageTitle, hasPath, spotifyCtx) {
  setContextLine(pageTitle);
  const content = document.getElementById('content');

  if (!streams || streams.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>Nothing here yet</strong><br>Start the video, then open this again.';
    content.textContent = '';
    content.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'stream-list';
  const n = streams.length;
  if (spotifyCtx && spotifyCtx.isSpotify) {
    list.appendChild(buildSpotifyPromptCard(spotifyCtx, hasPath));
  }

  streams.forEach((raw, i) => {
    const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
    const url = stream.url || '';
    const defaultName = defaultFileName(i, n, pageTitle, url);

    const item = document.createElement('div');
    item.className = 'stream-item';

    const kind = stream.streamKind ? String(stream.streamKind) : '';
    const pageOnly = stream.pageDownload === true;
    const top = document.createElement('div');
    top.className = 'stream-top';
    const h = document.createElement('div');
    h.className = 'stream-label';
    h.textContent = pageOnly
      ? 'Download this video'
      : n > 1
        ? `Stream ${i + 1} of ${n}` + (kind ? ` (${kind})` : '')
        : kind
          ? `Stream (${kind})`
          : 'Stream';
    const badge = document.createElement('span');
    badge.className = 'stream-kind-badge';
    badge.textContent = kind || 'stream';
    top.appendChild(h);
    top.appendChild(badge);

    const urlEl = document.createElement('div');
    urlEl.className = 'stream-url';
    if (pageOnly) {
      const intro = document.createElement('div');
      intro.style.cssText = 'font-size:11px;color:#57534e;line-height:1.4;margin-bottom:6px;';
      intro.textContent =
        'Social media: yt-dlp downloads from the page URL below (not a separate stream link).';
      const link = document.createElement('div');
      link.style.cssText =
        'word-break:break-all;font-family:ui-monospace,Cascadia Code,Consolas,monospace;font-size:11px;';
      link.textContent = url;
      urlEl.appendChild(intro);
      urlEl.appendChild(link);
    } else {
      urlEl.textContent = url;
    }

    const field = document.createElement('div');
    field.className = 'field';
    const isSubtitle = kind === 'subtitle';
    const lab = document.createElement('label');
    lab.setAttribute('for', `name-${i}`);
    lab.textContent = isSubtitle ? 'File name (no .vtt)' : 'File name (no .mp4)';
    const row = document.createElement('div');
    row.className = 'row';
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
    btn.textContent = pageOnly ? 'Download this' : 'Download';
    row.appendChild(input);
    row.appendChild(btn);
    field.appendChild(lab);
    field.appendChild(row);
    if (pageOnly) {
      const thumbLab = document.createElement('label');
      thumbLab.style.cssText =
        'display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-size:12px;color:#44403c;cursor:pointer;font-weight:500;';
      const tcb = document.createElement('input');
      tcb.type = 'checkbox';
      tcb.id = `thumb-${i}`;
      tcb.style.cssText = 'width:auto;margin-top:2px;flex-shrink:0;';
      thumbLab.appendChild(tcb);
      const tsp = document.createElement('span');
      tsp.textContent = 'Also save thumbnail (jpg next to the video)';
      thumbLab.appendChild(tsp);
      field.appendChild(thumbLab);
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.id = `status-${i}`;
    statusEl.style.display = 'none';

    item.appendChild(top);
    item.appendChild(urlEl);
    item.appendChild(field);
    item.appendChild(statusEl);
    list.appendChild(item);

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
          btn.textContent = pageOnly ? 'Download this' : 'Download';
          statusEl.removeAttribute('data-bg-run');
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

            const probePayload = {
              url: payload.url,
              tabId: tabId != null ? tabId : undefined,
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

function loadUi() {
  try {
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' });
  } catch (_) {
    // ignore
  }
  chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
    applyUiTheme(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
  });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeUrl = tabs && tabs[0] ? tabs[0].url || '' : '';
    const spotifyCtx = spotifyContextFromTabUrl(activeUrl);
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      const hasPath = !!(response && response.userDownloadPath);
      setPathBar(response && response.userDownloadPath);
      renderStreams(response?.streams || [], response?.pageTitle || '', hasPath, spotifyCtx);
      renderJobsBanner(response?.jobs || [], {
        running: response?.running,
        queueLength: response?.queueLength,
        max: response?.maxParallel,
      });
      const pill = document.getElementById('queue-pill');
      if (pill && (!response?.jobs || response.jobs.length === 0)) {
        pill.textContent = 'Idle';
        pill.classList.remove('is-active');
      }
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

loadUi();

document.getElementById('open-options')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[THEME_MODE_KEY] || changes[THEME_ACCENT_KEY])) {
    chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
      applyUiTheme(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
    });
  }
  if (area === 'local' && changes.userDownloadPath) {
    loadUi();
    return;
  }
  if (area === 'session' && changes[JOBS_KEY]) {
    refreshJobsBannerOnly();
  }
});
