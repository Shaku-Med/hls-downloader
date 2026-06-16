const KEY = 'userDownloadPath';
const FLOAT_KEY = 'floatGrabberEnabled';
const IMG_DL_KEY = 'imageHoverDownloadEnabled';
const YTDLP_MODE_KEY = 'ytDlpQualityMode';
const FFMPEG_PRESET_MODE_KEY = 'ffmpegPresetMode';
const YTDLP_MAX_H_KEY = 'ytDlpMaxHeight';
const THEME_MODE_KEY = 'uiThemeMode';
const THEME_ACCENT_KEY = 'uiThemeAccent';

function showStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.hidden = false;
  el.className = kind === 'ok' ? 'ok' : 'err';
}

function load() {
  chrome.storage.local.get([KEY, FLOAT_KEY, IMG_DL_KEY, YTDLP_MODE_KEY, FFMPEG_PRESET_MODE_KEY, YTDLP_MAX_H_KEY, THEME_MODE_KEY, THEME_ACCENT_KEY], (data) => {
    const err = chrome.runtime.lastError;
    if (err) {
      showStatus(String(err), 'err');
      return;
    }
    document.getElementById('path').value = (data && data[KEY]) || '';
    const floatEl = document.getElementById('float-on');
    if (floatEl) floatEl.checked = data[FLOAT_KEY] !== false;
    const imgDlEl = document.getElementById('img-dl-on');
    if (imgDlEl) imgDlEl.checked = data[IMG_DL_KEY] === true; // default OFF
    const qEl = document.getElementById('ytdlp-quality');
    if (qEl) qEl.value = data[YTDLP_MODE_KEY] === 'ask' ? 'ask' : 'auto';
    const fpEl = document.getElementById('ffmpeg-preset-mode');
    if (fpEl) fpEl.value = data[FFMPEG_PRESET_MODE_KEY] === 'auto' ? 'auto' : 'ask';
    const hEl = document.getElementById('ytdlp-max-h');
    if (hEl) {
      const v = data[YTDLP_MAX_H_KEY];
      hEl.value = v != null && String(v).trim() !== '' ? String(v) : '';
    }
    const tm = document.getElementById('ui-theme-mode');
    if (tm) tm.value = data[THEME_MODE_KEY] || 'system';
    const ta = document.getElementById('ui-theme-accent');
    if (ta) ta.value = data[THEME_ACCENT_KEY] || 'blue';
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

const imgDlOn = document.getElementById('img-dl-on');
if (imgDlOn) {
  imgDlOn.addEventListener('change', () => {
    chrome.storage.local.set({ [IMG_DL_KEY]: !!imgDlOn.checked });
  });
}

const ytdlpQuality = document.getElementById('ytdlp-quality');
if (ytdlpQuality) {
  ytdlpQuality.addEventListener('change', () => {
    const v = ytdlpQuality.value === 'ask' ? 'ask' : 'auto';
    chrome.storage.local.set({ [YTDLP_MODE_KEY]: v });
  });
}

const ffmpegPresetMode = document.getElementById('ffmpeg-preset-mode');
if (ffmpegPresetMode) {
  ffmpegPresetMode.addEventListener('change', () => {
    const v = ffmpegPresetMode.value === 'ask' ? 'ask' : 'auto';
    chrome.storage.local.set({ [FFMPEG_PRESET_MODE_KEY]: v });
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

const themeMode = document.getElementById('ui-theme-mode');
if (themeMode) {
  themeMode.addEventListener('change', () => {
    chrome.storage.local.set({ [THEME_MODE_KEY]: themeMode.value || 'system' });
  });
}

const themeAccent = document.getElementById('ui-theme-accent');
if (themeAccent) {
  themeAccent.addEventListener('change', () => {
    chrome.storage.local.set({ [THEME_ACCENT_KEY]: themeAccent.value || 'blue' });
  });
}

window.addEventListener('pageshow', (e) => {
  if (e.persisted) load();
});

load();
