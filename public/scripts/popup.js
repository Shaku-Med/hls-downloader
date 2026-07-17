const JOBS_KEY = 'hlsGrabJobsState';

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
const ready = { hasPath: false, active: 0 };

function updateReadyDot() {
  const dot = document.getElementById('status-dot');
  const title = document.getElementById('status-pop-title');
  const body = document.getElementById('status-pop-body');
  if (!dot) return;
  dot.classList.remove('is-setup', 'is-busy');
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
    el.textContent = 'No save folder picked yet. Choose one in Settings.';
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
    setReadyActive(0);
    return;
  }
  host.hidden = false;
  host.textContent = '';
  const sub = document.createElement('div');
  sub.className = 'queue-meta';
  const r = meta?.running ?? 0;
  const q = meta?.queueLength ?? 0;
  const m = meta?.max ?? 4;
  setReadyActive(r + q);
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

function renderStreams(streams, pageTitle, hasPath, spotifyCtx) {
  setContextLine(pageTitle);
  const content = document.getElementById('content');

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

  visibleStreams.forEach((raw, i) => {
    const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
    const url = stream.url || '';
    const defaultName = defaultFileName(i, n, pageTitle, url);

    const item = document.createElement('div');
    item.className = 'stream-item';

    const kind = stream.streamKind ? String(stream.streamKind) : '';
    const pageOnly = stream.pageDownload === true;
    const isAppleMusicPage = /music\.apple\.com/i.test(String(url || ''));
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
    const badge = document.createElement('span');
    badge.className = 'stream-kind-badge';
    badge.textContent = kind || 'stream';
    top.appendChild(h);
    top.appendChild(badge);

    const urlEl = document.createElement('div');
    urlEl.className = 'stream-url';
    if (pageOnly) {
      const intro = document.createElement('div');
      intro.className = 'stream-page-intro';
      intro.textContent = isAppleMusicPage
        ? 'Apple Music: yt-dlp uses the song page URL below (not the FairPlay m3u8 stream).'
        : 'This one grabs straight from the page link below, not a separate stream URL.';
      const link = document.createElement('div');
      link.className = 'stream-page-link';
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
          } else if (pageOnly && /music\.apple\.com/i.test(tabUrl || url || '')) {
            const appleUrl = /music\.apple\.com/i.test(tabUrl || '') ? tabUrl : url;
            effUrl = appleUrl;
            effPage = appleUrl;
            effRef = appleUrl;
            try {
              effOrigin = new URL(appleUrl).origin;
            } catch (_) {}
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

function loadUi() {
  try {
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' });
  } catch (_) {
    // ignore
  }
  if (window.HGR_THEME && window.HGR_THEME.initExtensionPageTheme) {
    window.HGR_THEME.initExtensionPageTheme();
  }
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

/* ── Record video elements ── */
(function initRecordUi() {
  const btn = document.getElementById('record-btn');
  const label = document.getElementById('record-btn-label');
  const statusEl = document.getElementById('record-status');
  if (!btn || !label || !statusEl) return;

  let isRecording = false;
  let pollTimer = null;

  function setStatus(text) {
    if (text) {
      statusEl.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.textContent = '';
      statusEl.hidden = true;
    }
  }

  function sendToTab(action, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { cb({ ok: false, error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'VIDEO_RECORDER', action }, (res) => {
        if (chrome.runtime.lastError) {
          // Content script isn't present here (browser-internal page, web store,
          // PDF viewer) or the page predates the extension being installed/updated.
          cb({ ok: false, error: "I can't record on this page. Try reloading it, or it might be one the browser keeps locked down." });
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

  function enterRecordingUi() {
    isRecording = true;
    btn.classList.add('is-recording');
    label.textContent = 'Stop';
    if (!pollTimer) pollTimer = setInterval(updateStatus, 1000);
  }
  function exitRecordingUi() {
    isRecording = false;
    btn.classList.remove('is-recording');
    label.textContent = 'Rec';
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
        const why = reasons.includes('buffer') ? 'buffering'
          : reasons.includes('resize') ? 'resizing, so try not to resize the window'
          : reasons.includes('seek') ? 'you skipped ahead, it picks back up on play'
          : reasons.includes('hidden') ? 'tab is hidden, come back to it to resume'
          : 'waiting for playback';
        setStatus(`⏸ Paused (${why})`);
        return;
      }
      let txt = `● Recording ${act.length} video${act.length > 1 ? 's' : ''}`;
      if (act.length === 1) txt += ` · ${fmt(act[0].elapsed)}`;
      setStatus(txt);
    });
  }

  function setRecordUiVisible(visible) {
    btn.hidden = !visible;
    if (!visible) setStatus('');
  }

  function scanAndUpdate() {
    sendToTab('scan', (res) => {
      if (!res || !res.ok) {
        setRecordUiVisible(false);
        return;
      }
      if (res.recording) {
        setRecordUiVisible(true);
        enterRecordingUi();
        updateStatus();
      } else if (res.count > 0) {
        setRecordUiVisible(true);
        setStatus(`${res.count} video${res.count > 1 ? 's' : ''} on this page`);
      } else {
        setRecordUiVisible(false);
      }
    });
  }

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
      sendToTab('start', (res) => {
        btn.disabled = false;
        if (res && res.ok) {
          enterRecordingUi();
          const fail = (res.details || []).filter((d) => !d.ok);
          let msg = `● Recording ${res.count} of ${res.total} video${res.total > 1 ? 's' : ''}`;
          if (fail.length) msg += ` · ${fail.length} skipped`;
          setStatus(msg);
        } else {
          setStatus(res?.error || 'Could not start recording');
        }
      });
    }
  });

  scanAndUpdate();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.userDownloadPath) {
    loadUi();
    return;
  }
  if (area === 'session' && changes[JOBS_KEY]) {
    refreshJobsBannerOnly();
  }
});
