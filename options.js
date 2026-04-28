const KEY = 'userDownloadPath';
const FLOAT_KEY = 'floatGrabberEnabled';
const YTDLP_MODE_KEY = 'ytDlpQualityMode';
const YTDLP_MAX_H_KEY = 'ytDlpMaxHeight';

function showStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.hidden = false;
  el.className = kind === 'ok' ? 'ok' : 'err';
}

function load() {
  chrome.storage.local.get([KEY, FLOAT_KEY, YTDLP_MODE_KEY, YTDLP_MAX_H_KEY], (data) => {
    const err = chrome.runtime.lastError;
    if (err) {
      showStatus(String(err), 'err');
      return;
    }
    document.getElementById('path').value = (data && data[KEY]) || '';
    const floatEl = document.getElementById('float-on');
    if (floatEl) floatEl.checked = data[FLOAT_KEY] !== false;
    const qEl = document.getElementById('ytdlp-quality');
    if (qEl) qEl.value = data[YTDLP_MODE_KEY] === 'ask' ? 'ask' : 'auto';
    const hEl = document.getElementById('ytdlp-max-h');
    if (hEl) {
      const v = data[YTDLP_MAX_H_KEY];
      hEl.value = v != null && String(v).trim() !== '' ? String(v) : '';
    }
  });
}

function saveToLocalStorage({ quiet } = {}) {
  const p = document.getElementById('path').value.trim();
  if (!p) {
    if (!quiet) showStatus('Enter a folder path first.', 'err');
    return;
  }
  chrome.storage.local.set({ [KEY]: p }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      showStatus(String(err), 'err');
      return;
    }
    if (!quiet) {
      showStatus('Saved. That folder will be used for new downloads.', 'ok');
    } else {
      const el = document.getElementById('status');
      el.hidden = false;
      el.className = 'ok';
      el.textContent = 'Saved to this browser (change anytime).';
    }
  });
}

let debounceTimer;

const pathInput = document.getElementById('path');
pathInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const p = pathInput.value.trim();
    if (p.length >= 3) saveToLocalStorage({ quiet: true });
  }, 600);
});

pathInput.addEventListener('blur', () => {
  clearTimeout(debounceTimer);
  const p = pathInput.value.trim();
  if (p.length >= 3) saveToLocalStorage({ quiet: true });
});

document.getElementById('save').addEventListener('click', () => saveToLocalStorage({ quiet: false }));

const floatOn = document.getElementById('float-on');
if (floatOn) {
  floatOn.addEventListener('change', () => {
    chrome.storage.local.set({ [FLOAT_KEY]: !!floatOn.checked });
  });
}

const ytdlpQuality = document.getElementById('ytdlp-quality');
if (ytdlpQuality) {
  ytdlpQuality.addEventListener('change', () => {
    const v = ytdlpQuality.value === 'ask' ? 'ask' : 'auto';
    chrome.storage.local.set({ [YTDLP_MODE_KEY]: v });
  });
}

const ytdlpMaxH = document.getElementById('ytdlp-max-h');
if (ytdlpMaxH) {
  const persistMaxH = () => {
    const raw = ytdlpMaxH.value.trim();
    if (!raw) {
      chrome.storage.local.remove(YTDLP_MAX_H_KEY);
      return;
    }
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) chrome.storage.local.set({ [YTDLP_MAX_H_KEY]: n });
  };
  ytdlpMaxH.addEventListener('change', persistMaxH);
  ytdlpMaxH.addEventListener('blur', persistMaxH);
}

window.addEventListener('pageshow', (e) => {
  if (e.persisted) load();
});

load();
