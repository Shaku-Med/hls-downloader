/**
 * Fallback after the normal download fails. Sends bytes the page already
 * kept from the player, on a new helper job. The first attempt is unchanged.
 */
const playerCopyPacks = new Map();
const PLAYER_COPY_CHUNK = 256000;

function playerCopyWorthRetry(error, job) {
  const text = String(error || '');
  if (!text) return false;
  if (/cancel/i.test(text)) return false;
  if (/fairplay|widevine|\bdrm\b|not installed/i.test(text)) return false;
  if (job && (job.playerCopyTried || (job.downloadPayload && job.downloadPayload.playerCopyTried))) return false;
  return true;
}

function frameIdsForTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId: tabId, allFrames: true },
          func: () => true,
        },
        (results) => {
          if (chrome.runtime.lastError || !results) {
            resolve([0]);
            return;
          }
          const ids = [];
          for (const row of results) {
            if (row && row.frameId != null && ids.indexOf(row.frameId) === -1) ids.push(row.frameId);
          }
          resolve(ids.length ? ids : [0]);
        }
      );
    } catch (_) {
      resolve([0]);
    }
  });
}

// Not askFrame: background.js has one, and loaded into the same worker this
// would replace it. Chrome loads this file after background.js declares its
// own, so its 4 second timeout went missing for every other caller, and one
// frame that never answered could stall the recording status for good.
// The page side waits up to 8 seconds for the player, hence the longer limit.
function playerCopyAskFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 10000);
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: frameId }, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          done(null);
          return;
        }
        done(res || null);
      });
    } catch (_) {
      clearTimeout(timer);
      done(null);
    }
  });
}

async function playerCopyInventory(tabId) {
  const frames = await frameIdsForTab(tabId);
  const inits = [];
  const segments = [];
  const seen = new Set();
  for (const frameId of frames) {
    const res = await playerCopyAskFrame(tabId, frameId, { type: 'PLAYER_COPY_INVENTORY' });
    if (!res || !res.ok) continue;
    for (const item of res.inits || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      inits.push({ url: item.url, frameId: frameId, size: item.size || 0 });
    }
    for (const item of res.segments || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      segments.push({ url: item.url, frameId: frameId, size: item.size || 0 });
    }
  }
  return { inits, segments };
}

async function pullPlayerCopyBytes(tabId, part, tabFrames) {
  if (part && part.bytes && part.bytes.length) return part.bytes;
  const size = Math.max(0, Number(part.size) || 0);
  const frames = [part.frameId];
  for (const id of tabFrames || []) if (frames.indexOf(id) === -1) frames.push(id);
  for (const frameId of frames) {
    const chunks = [];
    let offset = 0;
    let known = size;
    let found = false;
    for (;;) {
      const res = await playerCopyAskFrame(tabId, frameId, {
        type: 'PLAYER_COPY_CHUNK',
        url: part.url,
        offset: offset,
        length: PLAYER_COPY_CHUNK,
      });
      if (!res || !res.ok || !res.base64) break;
      found = true;
      known = Number(res.size) || known;
      const raw = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
      chunks.push(raw);
      offset += raw.length;
      if (!raw.length || offset >= known) break;
    }
    if (found && chunks.length) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    }
  }
  return null;
}

async function tryPlayerCopyFallback(jobId, known, error) {
  let job = known;
  if (!job || job.playerCopyTried || !job.downloadPayload) {
    try {
      const st = await readJobsState();
      const fresh = (st.jobs || []).find((j) => j && j.id === jobId);
      if (fresh) job = Object.assign({}, job || {}, fresh);
    } catch (_) {
      // ignore
    }
  }
  if (!playerCopyWorthRetry(error, job)) return false;
  const tabId = job && job.tabId != null ? job.tabId : null;
  if (tabId == null) return false;
  let pack = { inits: [], segments: [] };
  try {
    pack = await playerCopyInventory(tabId);
  } catch (_) {
    pack = { inits: [], segments: [] };
  }
  const net = playerNetParts(tabId);
  const seen = new Set();
  const inits = [];
  const segments = [];
  function take(list, dest) {
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      dest.push(item);
    }
  }
  take(net.inits, inits);
  take(net.segments, segments);
  take(pack.inits, inits);
  take(pack.segments, segments);
  if (!segments.length) return false;
  pack = { inits: inits, segments: segments };
  const base = (job && job.downloadPayload) || {};
  const payload = Object.assign({}, base, {
    type: 'player_copy',
    playerCopyTried: true,
    // Kept so a second failure can still say why the first one happened.
    playerCopyFirstError: String(error || '').slice(0, 600),
    filename: base.filename || (job && (job.fileStem || job.label)) || 'video',
    tabId: tabId,
    ffmpegPreset: base.ffmpegPreset || (job && job.ffmpegPreset) || null,
  });
  playerCopyPacks.set(jobId, { tabId: tabId, inits: pack.inits, segments: pack.segments });
  const jobs = await patchJob(jobId, {
    status: 'queued',
    detail: 'Trying the copy the player already loaded',
    error: null,
    playerCopyTried: true,
    downloadPayload: payload,
  });
  const saved = (jobs || []).find((j) => j && j.id === jobId);
  if (saved) _jobCache.set(jobId, saved);
  enqueueDownload(jobId, payload);
  return true;
}

const PLAYER_COPY_PLAYLISTS_MAX = 2 * 1024 * 1024;

/**
 * Media playlists that list at least one of the captured segments.
 *
 * The helper uses them to keep only one stream and put it in order. Matching
 * on the file name keeps the playlists of other tabs and other videos out.
 */
function playerCopyPlaylistsFor(pack) {
  const tails = new Set();
  for (const item of (pack.segments || []).concat(pack.inits || [])) {
    try {
      const path = new URL(item.url).pathname;
      const tail = path.slice(path.lastIndexOf('/') + 1);
      if (tail) tails.add(tail);
    } catch (_) {
      // ignore
    }
  }
  const out = [];
  const seenText = new Set();
  let size = 0;
  if (typeof hlsPlaylistCache === 'undefined' || !tails.size) return out;
  for (const [key, rec] of hlsPlaylistCache) {
    const text = rec && rec.text;
    if (!text || seenText.has(text) || /#EXT-X-STREAM-INF/i.test(text)) continue;
    let listed = false;
    for (const tail of tails) {
      if (text.indexOf(tail) !== -1) {
        listed = true;
        break;
      }
    }
    if (!listed) continue;
    if (size + text.length > PLAYER_COPY_PLAYLISTS_MAX) break;
    seenText.add(text);
    size += text.length;
    out.push({ url: rec.playlistUrl || key, text: text });
  }
  return out;
}

async function pumpPlayerCopyParts(slotIndex, jobId, full) {
  const pack = playerCopyPacks.get(jobId);
  const port = slots[slotIndex] && slots[slotIndex].port;
  const end = (abort) => {
    playerCopyPacks.delete(jobId);
    if (!port) return;
    try {
      port.postMessage({ type: 'player_copy_end', jobId: jobId, abort: !!abort });
    } catch (_) {
      // ignore
    }
  };
  if (!pack || !port) {
    end(true);
    return;
  }
  try {
    port.postMessage({
      type: 'player_copy_playlists',
      jobId: jobId,
      playlists: playerCopyPlaylistsFor(pack),
    });
    const tabFrames = await frameIdsForTab(pack.tabId);
    const groups = [
      { role: 'init', items: pack.inits || [] },
      { role: 'segment', items: pack.segments || [] },
    ];
    for (const group of groups) {
      for (let index = 0; index < group.items.length; index++) {
        const bytes = await pullPlayerCopyBytes(pack.tabId, group.items[index], tabFrames);
        if (!bytes || !bytes.length) continue;
        const count = Math.max(1, Math.ceil(bytes.length / PLAYER_COPY_CHUNK));
        for (let c = 0; c < count; c++) {
          const slice = bytes.subarray(c * PLAYER_COPY_CHUNK, Math.min(bytes.length, (c + 1) * PLAYER_COPY_CHUNK));
          port.postMessage({
            type: 'player_copy_part',
            jobId: jobId,
            role: group.role,
            index: index,
            url: group.items[index].url,
            chunkIndex: c,
            chunkCount: count,
            base64: uint8ToBase64(slice),
          });
        }
      }
    }
    end(false);
  } catch (_) {
    end(true);
  }
}

const playerNetBins = new Map();
const playerNetReqs = new Map();
const playerNetTabs = new Set();
const PLAYER_NET_MAX = 160 * 1024 * 1024;
const PLAYER_NET_PART = 24 * 1024 * 1024;

function playerNetParts(tabId) {
  const bin = playerNetBins.get(tabId);
  if (!bin) return { inits: [], segments: [] };
  const map = (list) =>
    list.map((item) => ({
      url: item.url,
      size: item.bytes.length,
      bytes: item.bytes,
      frameId: -1,
    }));
  return { inits: map(bin.inits), segments: map(bin.segments) };
}

function playerNetInteresting(url, mime) {
  const u = String(url || '');
  const ct = String(mime || '').toLowerCase();
  if (/\.m3u8?(?:[?#]|$)/i.test(u)) return true;
  if (/\.(?:m4s|cmfv|cmfa|cmft|ts)(?:[?#]|$)/i.test(u)) return true;
  if (ct.indexOf('mpegurl') !== -1 || ct.indexOf('mp2t') !== -1) return true;
  if ((ct.indexOf('mp4') !== -1 || ct.indexOf('video/') === 0 || ct.indexOf('audio/') === 0) && /\.mp4(?:[?#]|$)/i.test(u)) {
    return true;
  }
  return false;
}

function playerNetSniff(buf) {
  if (!buf || buf.length < 8) return '';
  if (buf[0] === 0x23 && buf[1] === 0x45 && buf[2] === 0x58 && buf[3] === 0x54) return 'playlist';
  if (buf[0] === 0x47) return 'segment';
  const box = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  if (box === 'ftyp' || box === 'styp') return 'init';
  if (box === 'moof' || box === 'mdat') return 'segment';
  return '';
}

function playerNetBytesFromBody(body, base64Encoded) {
  if (!body) return null;
  if (!base64Encoded) return new TextEncoder().encode(body);
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  const step = 0x8000;
  for (let i = 0; i < bin.length; i += step) {
    const end = Math.min(bin.length, i + step);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}

function playerNetKeep(tabId, url, bytes) {
  if (!bytes || bytes.length < 8 || bytes.length > PLAYER_NET_PART) return;
  const kind = playerNetSniff(bytes);
  if (kind === 'playlist') {
    try {
      const text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 500000)));
      if (typeof storeHlsPlaylist === 'function') storeHlsPlaylist(tabId, url, text, url);
    } catch (_) {
      // ignore
    }
    return;
  }
  if (kind !== 'init' && kind !== 'segment') return;
  let bin = playerNetBins.get(tabId);
  if (!bin) {
    bin = { total: 0, seen: new Set(), inits: [], segments: [] };
    playerNetBins.set(tabId, bin);
  }
  if (bin.seen.has(url)) return;
  if (bin.total + bytes.length > PLAYER_NET_MAX) return;
  bin.seen.add(url);
  bin.total += bytes.length;
  const row = { url: url, bytes: bytes };
  if (kind === 'init') bin.inits.push(row);
  else bin.segments.push(row);
}

function playerCopyIsFirefox() {
  try {
    return /\bFirefox\//i.test(String((typeof navigator !== 'undefined' && navigator.userAgent) || ''));
  } catch (_) {
    return false;
  }
}

function ensurePlayerCopyDebug(tabId) {
  if (playerCopyIsFirefox()) return;
  if (!chrome.debugger || tabId == null || tabId < 0 || playerNetTabs.has(tabId)) return;
  playerNetTabs.add(tabId);
  try {
    chrome.debugger.attach({ tabId: tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        playerNetTabs.delete(tabId);
        return;
      }
      chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable', {}, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch (_) {
    playerNetTabs.delete(tabId);
  }
}

try {
  if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (!details || details.tabId < 0) return;
        if (!/\.m3u8?(?:[?#]|$)/i.test(String(details.url || ''))) return;
        ensurePlayerCopyDebug(details.tabId);
      },
      { urls: ['<all_urls>'] }
    );
  }
} catch (_) {
  // ignore
}

try {
  if (chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (!source || source.tabId == null || !params) return;
      if (method === 'Network.responseReceived') {
        const response = params.response || {};
        if (response.status && (response.status < 200 || response.status >= 300)) return;
        if (!playerNetInteresting(response.url, response.mimeType)) return;
        playerNetReqs.set(params.requestId, { tabId: source.tabId, url: response.url || '' });
        return;
      }
      if (method !== 'Network.loadingFinished') return;
      const meta = playerNetReqs.get(params.requestId);
      playerNetReqs.delete(params.requestId);
      if (!meta || !meta.url) return;
      try {
        chrome.debugger.sendCommand(
          { tabId: meta.tabId },
          'Network.getResponseBody',
          { requestId: params.requestId },
          (res) => {
            if (chrome.runtime.lastError || !res || !res.body) return;
            try {
              const bytes = playerNetBytesFromBody(res.body, !!res.base64Encoded);
              playerNetKeep(meta.tabId, meta.url, bytes);
            } catch (_) {
              // ignore
            }
          }
        );
      } catch (_) {
        // ignore
      }
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source && source.tabId != null) playerNetTabs.delete(source.tabId);
    });
  }
} catch (_) {
  // ignore
}

function firefoxHeader(headers, name) {
  const want = String(name || '').toLowerCase();
  for (const h of headers || []) {
    if (h && String(h.name || '').toLowerCase() === want) return h.value || '';
  }
  return '';
}

function firefoxMediaResponse(details) {
  const url = String((details && details.url) || '');
  const ct = firefoxHeader(details && details.responseHeaders, 'content-type').toLowerCase();
  if (/\.m3u8?(?:[?#]|$)/i.test(url) || ct.indexOf('mpegurl') !== -1) return false;
  if (/\.(?:m4s|cmfv|cmfa|cmft|ts|mp4)(?:[?#]|$)/i.test(url)) return true;
  return ct.indexOf('mp2t') !== -1 || ct.indexOf('mp4') !== -1;
}

function captureFirefoxMediaBody(details) {
  let filter;
  try {
    filter = chrome.webRequest.filterResponseData(details.requestId);
  } catch (_) {
    return;
  }
  const chunks = [];
  let size = 0;
  let dropped = false;
  filter.ondata = (event) => {
    const chunk = event.data;
    if (!dropped && size + chunk.byteLength <= PLAYER_NET_PART) {
      try {
        chunks.push(chunk.slice(0));
        size += chunk.byteLength;
      } catch (_) {
        dropped = true;
      }
    } else {
      dropped = true;
    }
    try {
      filter.write(chunk);
    } catch (_) {
      // ignore
    }
  };
  filter.onstop = () => {
    try {
      filter.close();
    } catch (_) {
      // ignore
    }
    if (dropped || !size) return;
    try {
      const buf = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        const u8 = new Uint8Array(c);
        buf.set(u8, off);
        off += u8.byteLength;
      }
      playerNetKeep(details.tabId, details.url, buf);
    } catch (_) {
      // ignore
    }
  };
  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch (_) {
      // ignore
    }
  };
}

try {
  if (
    playerCopyIsFirefox() &&
    chrome.webRequest &&
    typeof chrome.webRequest.filterResponseData === 'function'
  ) {
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (!details || !details.url || details.tabId < 0) return;
        if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) return;
        if (!firefoxMediaResponse(details)) return;
        captureFirefoxMediaBody(details);
      },
      { urls: ['<all_urls>'] },
      ['blocking', 'responseHeaders']
    );
  }
} catch (_) {
  // ignore
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    playerNetBins.delete(tabId);
    playerNetTabs.delete(tabId);
    if (chrome.debugger) {
      try {
        chrome.debugger.detach({ tabId: tabId }, () => {
          void chrome.runtime.lastError;
        });
      } catch (_) {
        // ignore
      }
    }
  });
} catch (_) {
  // ignore
}
