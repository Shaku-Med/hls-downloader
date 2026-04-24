// tabId -> [{ url, streamKind, capturedHeaders }]
const detectedStreams = {};

function shouldIgnoreAsNoiseUrl(url) {
  const u = String(url).toLowerCase();
  if (u.startsWith('blob:') || u.startsWith('data:')) return true;
  if (
    u.includes('doubleclick') ||
    u.includes('googleads') ||
    u.includes('pagead2.googlesyndication') ||
    u.includes('googletagmanager') ||
    u.includes('analytics') ||
    u.includes('facebook.com/tr') ||
    (u.includes('track') && u.includes('ingest'))
  ) {
    return true;
  }
  if (/[/?#](favicon|pixel|beacon|1x1)[.?&#/]/i.test(u) || /\b(tracking|spacer)\b/i.test(u)) return true;
  if (/[/.](png|jpe?g|gif|webp|svg|ico|html|js|mjs|css|woff2?|ttf|map|json|xml|wasm)(\?|#|$)/i.test(u)) {
    if (!/type=video|mime=video|contenttype=video/i.test(u)) return true;
  }
  if (/\/(seg[-_]?\d+\.|chunk|segment-?\d+|[a-f0-9]{4,20}\.m4s|init\.(mp4|m4a))(?:\?|$)/i.test(u)) return true;
  if (hlsMediaSegmentUrl(u)) return true;
  return false;
}

/**
 * HLS fetches thousands of .ts (or fMP4) chunks; only playlists / progressive URLs are valid ffmpeg inputs.
 */
function hlsMediaSegmentUrl(u) {
  if (u.includes('cdninstagram.com') && /\.(ts|m2ts|mts|aac|fmp4|m4s)(?:[?#]|$)/i.test(u)) return true;
  if (u.includes('fbcdn.net') && /\/(v|t\d+)\/.+\.ts(?:[?#]|$)/i.test(u)) return true;
  if (/[/.]min\.ts(?:[?#]|$)/i.test(u) || /[._-](seg(ment)?|seq|sequence|hls-?chunk|part)[._-]?\d+[/.]/i.test(u)) {
    return true;
  }
  if (/\/(h|seg|s)[-_]?\d{2,5}\.ts(?:[?#]|$)/i.test(u) || /[/.]\d{4,8}\.ts(?:[?#]|$)/i.test(u)) return true;
  if (/[/.]ts(?:[?#]|$)/i.test(u) && /(cdninstagram|fbcdn|twimg|googlevideo|akamai|fastly|cloudfront)/i.test(u)) {
    return true;
  }
  return false;
}

/**
 * @returns {null | { kind: string, reason: string }}
 */
function classifyVideoFromUrl(url) {
  if (shouldIgnoreAsNoiseUrl(url)) return null;
  const u = String(url).toLowerCase();

  if (/[/.](m3u8|m3u)(?:[?#]|$)/.test(u)) {
    return { kind: 'hls', reason: 'path' };
  }
  if (/[/.]mpd(?:[?#]|$)/.test(u) || (u.includes('dash') && (u.includes('manifest') || u.includes('.mpd')))) {
    return { kind: 'dash', reason: 'path' };
  }
  if (/[/.](mp4|webm|mkv|mov|m4v|ogv)(?:[?#]|$)/.test(u)) {
    return { kind: 'direct', reason: 'ext' };
  }
  if (u.includes('googlevideo.com') && (u.includes('videoplayback') || u.includes('mime=video') || /[?&]itag=/.test(u))) {
    return { kind: 'yt', reason: 'host' };
  }
  if (
    (u.includes('video.twimg.com') || u.includes('ext_tw_video') || u.includes('twimg.com/amplify_video') || u.includes('twimg.com/ext_tw_video')) &&
    /\.(mp4|m3u8|m3u)(?:[?#]|$)/.test(u)
  ) {
    return { kind: 'social', reason: 'twitter' };
  }
  if (u.includes('fbcdn.net') && /(video|mp4|m3u8|m3u|dash)/.test(u)) {
    return { kind: 'social', reason: 'fb' };
  }
  if (u.includes('fb.watch') && /\.(mp4|m3u8)/.test(u)) {
    return { kind: 'social', reason: 'fb' };
  }
  if (u.includes('cdninstagram.com')) {
    if (
      /[/.](m3u8|m3u|mp4|mpd|webm)(?:[?#]|$)/i.test(u) ||
      u.includes('m3u8') ||
      (/(?:manifest|playlist|master|hls|dash|progressive)/i.test(u) && (u.includes('m3u8') || u.includes('mpd')))
    ) {
      return { kind: 'social', reason: 'ig' };
    }
    return null;
  }
  if (/(tiktokcdn|tiktokv\.com|ibyteimg\.com|muscdn)\./i.test(u) && /(video|byte|m3u8|mp4|m3u)/.test(u)) {
    return { kind: 'social', reason: 'tiktok' };
  }
  if (u.includes('v.redd.it') && /\.(mp4|m3u8|DASH|HLS)/i.test(u)) {
    return { kind: 'social', reason: 'reddit' };
  }
  if (u.includes('snapchat.com') && /(m3u8|mp4|video)/.test(u)) {
    return { kind: 'social', reason: 'snap' };
  }
  if (u.includes('b-cdn.net') && /(video|m3u8|mp4|mediadelivery)/.test(u)) {
    return { kind: 'direct', reason: 'b-cdn' };
  }
  if (/(ttvnw\.net|jtvnw\.net|usher\.ttvnw\.net)/.test(u) && (u.includes('m3u8') || u.includes('.mp4') || u.includes('playlist'))) {
    return { kind: 'social', reason: 'twitch' };
  }
  if (u.includes('vimeocdn.com') && /(video|m3u8|mp4|avc|dash|hls|segment)/.test(u)) {
    return { kind: 'direct', reason: 'vimeo' };
  }
  if (u.includes('m3u8') && !/segment|chunk\/\d+/.test(u)) {
    return { kind: 'hls', reason: 'query' };
  }
  if (/[?&]mime=video%2f/i.test(u) || /[?&]type=video(&|$|#)/i.test(u) || /[?&]contenttype=video/i.test(u)) {
    return { kind: 'direct', reason: 'query' };
  }
  if (/[?&]format=m3u8|manifest\.m3u8|type=hls|stream_type=hls/i.test(u)) {
    return { kind: 'hls', reason: 'query' };
  }
  if (/[?&]format=dash|type=dash|manifest\.mpd/i.test(u)) {
    return { kind: 'dash', reason: 'query' };
  }
  return null;
}

function getHeaderValue(headers, name) {
  const n = (name || '').toLowerCase();
  for (const h of headers || []) {
    if (h && h.name && h.name.toLowerCase() === n) return h.value || '';
  }
  return '';
}

/**
 * @returns {string | null}
 */
function streamKindFromContentType(contentType) {
  const c = (contentType || '').toLowerCase().split(';')[0].trim();
  if (c === 'application/vnd.apple.mpegurl' || c === 'application/x-mpegurl' || c === 'audio/mpegurl') {
    return 'hls_by_header';
  }
  if (c === 'application/dash+xml' || c === 'application/dash') {
    return 'dash';
  }
  if (c.startsWith('video/') && c !== 'video/fake') {
    return 'by_header';
  }
  if (c === 'application/octet-stream' || c === 'binary/octet-stream') {
    return null;
  }
  return null;
}

function upsertStream(tabId, url, capturedHeaders, streamKind) {
  if (!url || !tabId || tabId < 0) return;
  if (shouldIgnoreAsNoiseUrl(url)) return;
  if (!detectedStreams[tabId]) detectedStreams[tabId] = [];
  const list = detectedStreams[tabId];
  const found = list.find((e) => e.url === url);
  if (found) {
    found.capturedHeaders = { ...found.capturedHeaders, ...capturedHeaders };
    if (streamKind) found.streamKind = streamKind;
    return;
  }
  const fromUrl = streamKind ? null : classifyVideoFromUrl(url);
  const kind = streamKind || (fromUrl && fromUrl.kind);
  if (!kind) return;
  list.push({ url, streamKind: kind, capturedHeaders: { ...capturedHeaders } });
  console.log('Video stream:', kind, url);
  chrome.action.setBadgeText({ text: String(list.length), tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId });
}

/** Prefer master / playlist URLs and progressive video in the popup list. */
function sortStreamsForUi(list) {
  if (!list || !list.length) return [];
  const score = (s) => {
    const u = ((s && s.url) || '').toLowerCase();
    if (hlsMediaSegmentUrl(u)) return -1000;
    if (/(^|[/._-])(main|master|index|source|highest|progressive|manifest)[^/]*\.(m3u8|m3u|mpd|mp4)(?:[?#]|$)/i.test(u)) {
      return 100;
    }
    if ((/\b(playlist|manifest)\b/i.test(u) || u.includes('master') || u.includes('main.m3u8')) && u.includes('m3u8')) {
      return 80;
    }
    if (/[/.](m3u8|m3u|mp4|mpd|webm)(?:[?#]|$)/i.test(u)) return 40;
    if (s && (s.streamKind === 'hls' || s.streamKind === 'hls_by_header' || s.streamKind === 'social')) return 20;
    return 0;
  };
  return [...list].sort((a, b) => score(b) - score(a));
}

function pickForwardHeaders(requestHeaders) {
  const allow = new Set([
    'authorization',
    'cookie',
    'referer',
    'origin',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-dest',
    'sec-fetch-user',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
  ]);
  const out = {};
  for (const h of requestHeaders || []) {
    if (!h || !h.name) continue;
    const n = h.name.toLowerCase();
    if (allow.has(n) && h.value != null && h.value !== '') {
      out[n] = h.value;
    }
  }
  return out;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const url = details.url;
    const hit = classifyVideoFromUrl(url);
    if (!hit) return;
    const tabId = details.tabId;
    const captured = pickForwardHeaders(details.requestHeaders);
    upsertStream(tabId, url, captured, hit.kind);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;
    const url = details.url;
    if (url.startsWith('http:') === false && url.startsWith('https:') === false) return;
    if (shouldIgnoreAsNoiseUrl(url)) return;
    const lower = String(url).toLowerCase();
    if (/[/.]ts(?:[?#]|$)/i.test(lower) && /(cdninstagram|fbcdn|twimg|googlevideo|akamai|cloudfront|fastly)/i.test(lower)) {
      return;
    }
    const ct = getHeaderValue(details.responseHeaders, 'content-type');
    const k = streamKindFromContentType(ct);
    if (!k) return;
    if (k === 'by_header' && /[/.](ts|m2ts|mts|m4s)(?:[?#]|$)/i.test(lower)) return;
    upsertStream(tabId, url, {}, k);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedStreams[tabId] = [];
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedStreams[tabId];
});

// Download queue: up to 4 native host processes, shared pending queue

const NATIVE = 'com.medzy.hlsgrabber';
const JOBS_KEY = 'hlsGrabJobsState';
const USER_PATH_KEY = 'userDownloadPath';
const KEEP_ALARM = 'hlsGrabKeepAlive';
const MAX_SLOTS = 4;

/** @type {{ port: chrome.runtime.Port | null, jobId: string | null }[]} */
const slots = Array.from({ length: MAX_SLOTS }, () => ({ port: null, jobId: null }));
/** @type {{ jobId: string, payload: object }[]} */
const pendingQueue = [];

function genJobId() {
  return `j_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function defaultJobsState() {
  return { jobs: [] };
}

function respond(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (e) {
    console.error('HLS Grabber: sendResponse failed', e);
  }
}

async function getUserDownloadPath() {
  const data = await chrome.storage.local.get(USER_PATH_KEY);
  return (data[USER_PATH_KEY] && String(data[USER_PATH_KEY]).trim()) || '';
}

async function readJobsState() {
  const data = await chrome.storage.session.get(JOBS_KEY);
  return data[JOBS_KEY] || defaultJobsState();
}

async function writeJobsState(jobs) {
  await chrome.storage.session.set({ [JOBS_KEY]: { jobs: [...jobs] } });
}

async function upsertJob(job) {
  const st = await readJobsState();
  const jobs = st.jobs || [];
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i === -1) jobs.push({ ...job, updatedAt: Date.now() });
  else jobs[i] = { ...jobs[i], ...job, updatedAt: Date.now() };
  await writeJobsState(jobs);
  return jobs;
}

async function patchJob(jobId, partial) {
  const st = await readJobsState();
  const jobs = (st.jobs || []).map((j) => (j.id === jobId ? { ...j, ...partial, updatedAt: Date.now() } : j));
  await writeJobsState(jobs);
  return jobs;
}

async function removeJob(jobId) {
  const st = await readJobsState();
  const jobs = (st.jobs || []).filter((j) => j.id !== jobId);
  await writeJobsState(jobs);
}

function countActiveJobs() {
  return pendingQueue.length + slots.filter((s) => s.jobId !== null).length;
}

function syncBadgeAlarm() {
  const n = (() => {
    const running = slots.filter((s) => s.jobId !== null).length;
    return pendingQueue.length + running;
  })();
  if (n > 0) {
    chrome.alarms.create(KEEP_ALARM, { periodInMinutes: 0.1 });
    chrome.action.setBadgeText({ text: n > 9 ? '9+' : String(n) });
    chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  } else {
    chrome.alarms.clear(KEEP_ALARM);
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEP_ALARM) {
    void chrome.storage.session.get(JOBS_KEY);
  }
});

function findSlotIndexByJobId(jobId) {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].jobId === jobId) return i;
  }
  return -1;
}

function onHostMessage(msg, slotIndex) {
  const jobId = msg && msg.jobId;
  if (!jobId) return;
  (async () => {
    if (msg.type === 'progress') {
      await patchJob(jobId, {
        status: 'downloading',
        detail: msg.detail || msg.phase || 'Running',
        outputPath: msg.output || null,
      });
      return;
    }
    if (msg.type !== 'done') {
      return;
    }
    if (msg.idle) {
      return;
    }
    slots[slotIndex].jobId = null;
    if (msg.canceled) {
      await patchJob(jobId, {
        status: 'canceled',
        error: msg.error || 'Canceled',
        outputPath: null,
      });
    } else if (msg.success) {
      await patchJob(jobId, {
        status: 'completed',
        detail: 'Saved',
        error: null,
        outputPath: msg.output || null,
      });
    } else {
      await patchJob(jobId, {
        status: 'error',
        error: msg.error || 'Failed',
        outputPath: null,
      });
    }
    tryDispatch();
  })();
}

function onSlotDisconnect(slotIndex) {
  const j = slots[slotIndex].jobId;
  slots[slotIndex].port = null;
  slots[slotIndex].jobId = null;
  const err = chrome.runtime.lastError?.message;
  (async () => {
    if (j) {
      await patchJob(j, { status: 'error', error: err || 'Lost connection to the download helper' });
    }
    tryDispatch();
  })();
  syncBadgeAlarm();
}

function ensurePort(slotIndex) {
  if (slots[slotIndex].port) return slots[slotIndex].port;
  const port = chrome.runtime.connectNative(NATIVE);
  slots[slotIndex].port = port;
  port.onMessage.addListener((msg) => onHostMessage(msg, slotIndex));
  port.onDisconnect.addListener(() => onSlotDisconnect(slotIndex));
  return port;
}

/**
 * Free slot: no jobId assigned.
 */
function firstFreeSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].jobId === null) return i;
  }
  return -1;
}

async function launchOnSlot(slotIndex, jobId, basePayload) {
  const outDir = await getUserDownloadPath();
  if (!outDir) {
    await patchJob(jobId, {
      status: 'error',
      error: 'Set a save folder in Options (right-click the extension icon).',
    });
    tryDispatch();
    return;
  }
  slots[slotIndex].jobId = jobId;
  await patchJob(jobId, { status: 'connecting', detail: 'Starting' });
  const full = { ...basePayload, jobId, outputDirectory: outDir };
  try {
    ensurePort(slotIndex).postMessage(full);
  } catch (e) {
    slots[slotIndex].jobId = null;
    await patchJob(jobId, { status: 'error', error: String(e) });
    tryDispatch();
  }
  syncBadgeAlarm();
}

function tryDispatch() {
  (async () => {
    for (;;) {
      const i = firstFreeSlot();
      if (i === -1 || pendingQueue.length === 0) break;
      const { jobId, payload } = pendingQueue.shift();
      await launchOnSlot(i, jobId, payload);
    }
  })();
  syncBadgeAlarm();
}

/**
 * Dequeue a queued (not yet running) job by id.
 */
function removeFromPendingOnly(jobId) {
  for (let k = pendingQueue.length - 1; k >= 0; k--) {
    if (pendingQueue[k].jobId === jobId) {
      pendingQueue.splice(k, 1);
      return true;
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STREAMS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const pageTitle = (tabs[0]?.title || '').trim();
      Promise.all([chrome.storage.session.get(JOBS_KEY), chrome.storage.local.get(USER_PATH_KEY)])
        .then(([sess, local]) => {
          const jobsState = (sess && sess[JOBS_KEY]) || defaultJobsState();
          const userDownloadPath = (local && local[USER_PATH_KEY] && String(local[USER_PATH_KEY]).trim()) || '';
          respond(sendResponse, {
            streams: sortStreamsForUi(detectedStreams[tabId] || []),
            pageTitle,
            jobs: jobsState.jobs || [],
            userDownloadPath,
            maxParallel: MAX_SLOTS,
            queueLength: pendingQueue.length,
            running: slots.filter((s) => s.jobId).length,
          });
        })
        .catch((err) => {
          console.error('GET_STREAMS', err);
          respond(sendResponse, {
            streams: sortStreamsForUi(detectedStreams[tabId] || []),
            pageTitle,
            jobs: [],
            userDownloadPath: '',
            maxParallel: MAX_SLOTS,
            queueLength: 0,
            running: 0,
          });
        });
    });
    return true;
  }

  if (message.type === 'GET_DOWNLOAD_STATE') {
    chrome.storage.session
      .get(JOBS_KEY)
      .then((data) => {
        respond(sendResponse, { jobs: (data[JOBS_KEY] && data[JOBS_KEY].jobs) || [] });
      })
      .catch((err) => {
        console.error('GET_DOWNLOAD_STATE', err);
        respond(sendResponse, { jobs: [] });
      });
    return true;
  }

  if (message.type === 'DISMISS_JOB' && message.jobId) {
    removeJob(message.jobId)
      .then(() => respond(sendResponse, { ok: true }))
      .catch((e) => respond(sendResponse, { ok: false, error: String(e) }));
    return true;
  }

  if (message.type === 'DISMISS_DONE') {
    (async () => {
      const st = await readJobsState();
      const jobs = (st.jobs || []).filter((j) => !['completed', 'canceled', 'error'].includes(j.status));
      await writeJobsState(jobs);
      respond(sendResponse, { ok: true });
    })();
    return true;
  }

  if (message.type === 'CANCEL_DOWNLOAD' && message.jobId) {
    (async () => {
      const jobId = message.jobId;
      if (removeFromPendingOnly(jobId)) {
        await patchJob(jobId, { status: 'canceled', error: 'Canceled before it started' });
        tryDispatch();
        respond(sendResponse, { ok: true });
        return;
      }
      const si = findSlotIndexByJobId(jobId);
      if (si >= 0 && slots[si].port) {
        try {
          slots[si].port.postMessage({ type: 'cancel', jobId });
        } catch (e) {
          await patchJob(jobId, { status: 'error', error: String(e) });
          slots[si].jobId = null;
          tryDispatch();
        }
        respond(sendResponse, { ok: true });
        return;
      }
      respond(sendResponse, { ok: true });
    })();
    return true;
  }

  if (message.type === 'START_DOWNLOAD') {
    (async () => {
      const payload = message.payload;
      if (!payload?.url) {
        respond(sendResponse, { ok: false, error: 'No stream URL' });
        return;
      }
      const path = await getUserDownloadPath();
      if (!path) {
        respond(sendResponse, {
          ok: false,
          error: 'Open Options and set a save folder first.',
        });
        return;
      }
      const jobId = payload.jobId || genJobId();
      const label = (payload.filename || 'video').toString() || 'video';
      const { jobId: _jid, outputDirectory: _od, ...base } = payload;
      await upsertJob({
        id: jobId,
        label,
        status: 'queued',
        detail: 'Waiting',
        error: null,
        outputPath: null,
      });
      pendingQueue.push({ jobId, payload: base });
      tryDispatch();
      respond(sendResponse, { ok: true, jobId });
    })();
    return true;
  }

  return false;
});
