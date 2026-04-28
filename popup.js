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
    if (job.status === 'error') {
      d.textContent = job.error || '';
    } else if (job.status === 'canceled') {
      d.textContent = job.error || 'Canceled';
    } else {
      d.textContent = job.detail || job.error || '';
    }
    card.appendChild(t);
    card.appendChild(d);
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

function renderStreams(streams, pageTitle, hasPath) {
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

  streams.forEach((raw, i) => {
    const stream = typeof raw === 'string' ? { url: raw, capturedHeaders: {} } : raw;
    const url = stream.url || '';
    const defaultName = defaultFileName(i, n, pageTitle, url);

    const item = document.createElement('div');
    item.className = 'stream-item';

    const kind = stream.streamKind ? String(stream.streamKind) : '';
    const h = document.createElement('div');
    h.className = 'stream-label';
    h.textContent =
      n > 1
        ? `Stream ${i + 1} of ${n}` + (kind ? ` — ${kind}` : '')
        : (kind ? `Stream — ${kind}` : 'Stream');

    const urlEl = document.createElement('div');
    urlEl.className = 'stream-url';
    urlEl.textContent = url;

    const field = document.createElement('div');
    field.className = 'field';
    const lab = document.createElement('label');
    lab.setAttribute('for', `name-${i}`);
    lab.textContent = 'File name (no .mp4)';
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
    btn.textContent = 'Download';
    if (!hasPath) {
      btn.disabled = true;
      btn.title = 'Add a save folder in Options first';
    }
    row.appendChild(input);
    row.appendChild(btn);
    field.appendChild(lab);
    field.appendChild(row);

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.id = `status-${i}`;
    statusEl.style.display = 'none';

    item.appendChild(h);
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
      setStatusRunInBackground(statusEl);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const tabUrl = tab?.url || '';
        const tabId = tab?.id;
        const capturedHeaders = stream.capturedHeaders || {};
        buildCookieHeader(url, tabUrl, (cookie) => {
          const payload = {
            jobId,
            url,
            filename,
            tabId: tabId != null ? tabId : undefined,
            streamKind: kind || undefined,
            cookie: cookie || undefined,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
            capturedHeaders,
          };
          if (isHttpUrl(tabUrl)) {
            payload.referer = tabUrl;
            try {
              payload.origin = new URL(tabUrl).origin;
            } catch (_) {}
          }
          chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload }, (r) => {
            if (chrome.runtime.lastError) {
              btn.disabled = false;
              btn.textContent = 'Download';
              statusEl.removeAttribute('data-bg-run');
              statusEl.className = 'status err';
              statusEl.textContent = chrome.runtime.lastError.message;
              return;
            }
            if (!r?.ok) {
              btn.disabled = false;
              btn.textContent = 'Download';
              statusEl.removeAttribute('data-bg-run');
              statusEl.className = 'status err';
              statusEl.textContent = r?.error || 'Could not start';
              return;
            }
            btn.disabled = false;
            btn.textContent = 'Download';
          });
        });
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
  chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
    const hasPath = !!(response && response.userDownloadPath);
    setPathBar(response && response.userDownloadPath);
    renderStreams(response?.streams || [], response?.pageTitle || '', hasPath);
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
  if (area === 'local' && changes.userDownloadPath) {
    loadUi();
    return;
  }
  if (area === 'session' && changes[JOBS_KEY]) {
    loadUi();
  }
});
