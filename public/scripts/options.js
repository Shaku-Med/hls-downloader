const KEY = 'userDownloadPath';
const FLOAT_KEY = 'floatGrabberEnabled';
const IMG_DL_KEY = 'imageHoverDownloadEnabled';
const IMG_SAVE_PATH_KEY = 'imageSaveToKnownPath';

// Right-click menu. Absent means on, so it works without visiting Options.
const CTX_MENU_ENABLED_KEY = 'ctxMenuEnabled';
const CTX_MENU_IMAGE_KEY = 'ctxMenuImage';
const CTX_MENU_MEDIA_KEY = 'ctxMenuMedia';
const CTX_MENU_LINK_KEY = 'ctxMenuLink';
const CTX_MENU_PAGE_KEY = 'ctxMenuPage';
const CTX_MENU_BOXES = [
  ['ctx-on', CTX_MENU_ENABLED_KEY],
  ['ctx-image-on', CTX_MENU_IMAGE_KEY],
  ['ctx-media-on', CTX_MENU_MEDIA_KEY],
  ['ctx-link-on', CTX_MENU_LINK_KEY],
  ['ctx-page-on', CTX_MENU_PAGE_KEY],
];
const REC_DETACH_KEY = 'recordDetachVideoEnabled';
const YTDLP_MODE_KEY = 'ytDlpQualityMode';
const FFMPEG_PRESET_MODE_KEY = 'ffmpegPresetMode';
const YTDLP_MAX_H_KEY = 'ytDlpMaxHeight';
const THEME_MODE_KEY = 'uiThemeMode';
const THEME_ACCENT_KEY = 'uiThemeAccent';
const DL_PROGRESS_LAYOUT_KEY = 'dlProgressLayout';
const DL_PROGRESS_MORPH_KEY = 'dlProgressMorph';
const UI_MORPH_KEY = 'uiMorphMotion';

function showStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.hidden = false;
  el.className = kind === 'ok' ? 'ok' : 'err';
}

function syncAccentRowVisibility() {
  const modeEl = document.getElementById('ui-theme-mode');
  const row = document.getElementById('ui-theme-accent-row');
  if (!modeEl || !row) return;
  const mode = modeEl.value || 'system';
  row.hidden = mode === 'page';
}

function syncImgSavePathRow() {
  const row = document.getElementById('img-save-path-row');
  const imgDlEl = document.getElementById('img-dl-on');
  const pathEl = document.getElementById('path');
  if (!row || !imgDlEl || !pathEl) return;
  const grabberOn = !!imgDlEl.checked;
  const hasPath = pathEl.value.trim().length >= 3;
  row.hidden = !(grabberOn && hasPath);
}

/** Per-entry choices only matter while the menu itself is on. */
function syncCtxItemsRow() {
  const row = document.getElementById('ctx-items-row');
  const master = document.getElementById('ctx-on');
  if (!row || !master) return;
  row.hidden = !master.checked;
}

function load() {
  chrome.storage.local.get(
    [KEY, FLOAT_KEY, IMG_DL_KEY, IMG_SAVE_PATH_KEY, REC_DETACH_KEY, YTDLP_MODE_KEY, FFMPEG_PRESET_MODE_KEY, YTDLP_MAX_H_KEY, THEME_MODE_KEY, THEME_ACCENT_KEY, DL_PROGRESS_LAYOUT_KEY, DL_PROGRESS_MORPH_KEY, UI_MORPH_KEY,
     CTX_MENU_ENABLED_KEY, CTX_MENU_IMAGE_KEY, CTX_MENU_MEDIA_KEY, CTX_MENU_LINK_KEY, CTX_MENU_PAGE_KEY],
    (data) => {
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
    const imgSavePathEl = document.getElementById('img-save-path-on');
    if (imgSavePathEl) imgSavePathEl.checked = data[IMG_SAVE_PATH_KEY] !== false; // default ON when shown
    const recDetachEl = document.getElementById('rec-detach-on');
    if (recDetachEl) recDetachEl.checked = data[REC_DETACH_KEY] !== false; // default ON
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
    const dlLayout = document.getElementById('dl-progress-layout');
    if (dlLayout) {
      const v = data[DL_PROGRESS_LAYOUT_KEY];
      dlLayout.value = v === 'circle' || v === 'pill' ? v : 'bar';
    }
    const dlMorph = document.getElementById('dl-progress-morph');
    if (dlMorph) {
      if (data[UI_MORPH_KEY] != null) dlMorph.checked = data[UI_MORPH_KEY] !== false;
      else dlMorph.checked = data[DL_PROGRESS_MORPH_KEY] !== false;
    }
    for (const [id, key] of CTX_MENU_BOXES) {
      const el = document.getElementById(id);
      if (el) el.checked = data[key] !== false; // default on
    }
    syncAccentRowVisibility();
    syncImgSavePathRow();
    syncCtxItemsRow();
    markClean();
    if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhanceAll) {
      HLS_IOS_SELECT.enhanceAll(document);
    }
  });
}

const saveBtn = document.getElementById('save');
let savedSnapshot = null;

function boolField(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}

function selectField(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '') : '';
}

function fieldSnapshot() {
  const pathEl = document.getElementById('path');
  const hEl = document.getElementById('ytdlp-max-h');
  const layout = selectField('dl-progress-layout');
  const ctx = {};
  for (const [id, key] of CTX_MENU_BOXES) {
    ctx[key] = boolField(id);
  }
  return {
    path: ((pathEl && pathEl.value) || '').trim(),
    maxH: ((hEl && hEl.value) || '').trim(),
    floatOn: boolField('float-on'),
    imgDlOn: boolField('img-dl-on'),
    imgSavePathOn: boolField('img-save-path-on'),
    recDetachOn: boolField('rec-detach-on'),
    ytdlpQuality: selectField('ytdlp-quality') === 'ask' ? 'ask' : 'auto',
    ffmpegPreset: selectField('ffmpeg-preset-mode') === 'auto' ? 'auto' : 'ask',
    themeMode: selectField('ui-theme-mode') || 'system',
    themeAccent: selectField('ui-theme-accent') || 'blue',
    dlLayout: layout === 'circle' || layout === 'pill' ? layout : 'bar',
    morphOn: boolField('dl-progress-morph'),
    ...ctx,
  };
}

function isDirty() {
  if (!savedSnapshot) return false;
  return JSON.stringify(fieldSnapshot()) !== JSON.stringify(savedSnapshot);
}

function syncSaveButton() {
  if (!saveBtn) return;
  saveBtn.disabled = !isDirty();
}

function markClean() {
  savedSnapshot = fieldSnapshot();
  syncSaveButton();
}

function onFormEdit() {
  const status = document.getElementById('status');
  if (status && status.classList.contains('ok')) {
    status.hidden = true;
    status.textContent = '';
  }
  syncAccentRowVisibility();
  syncImgSavePathRow();
  syncCtxItemsRow();
  syncSaveButton();
}

function persistMaxHeight(raw) {
  if (!raw) {
    chrome.storage.local.remove(YTDLP_MAX_H_KEY);
    return;
  }
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) chrome.storage.local.set({ [YTDLP_MAX_H_KEY]: n });
}

function saveToLocalStorage({ quiet } = {}) {
  const snap = fieldSnapshot();
  if (!snap.path && savedSnapshot && savedSnapshot.path) {
    if (!quiet) showStatus('Enter a folder path first.', 'err');
    return;
  }
  const toSet = {
    [FLOAT_KEY]: snap.floatOn,
    [IMG_DL_KEY]: snap.imgDlOn,
    [IMG_SAVE_PATH_KEY]: snap.imgSavePathOn,
    [REC_DETACH_KEY]: snap.recDetachOn,
    [YTDLP_MODE_KEY]: snap.ytdlpQuality,
    [FFMPEG_PRESET_MODE_KEY]: snap.ffmpegPreset,
    [THEME_MODE_KEY]: snap.themeMode,
    [THEME_ACCENT_KEY]: snap.themeAccent,
    [DL_PROGRESS_LAYOUT_KEY]: snap.dlLayout,
    [UI_MORPH_KEY]: snap.morphOn,
    [DL_PROGRESS_MORPH_KEY]: snap.morphOn,
  };
  for (const [, key] of CTX_MENU_BOXES) {
    toSet[key] = !!snap[key];
  }
  if (snap.path) toSet[KEY] = snap.path;
  chrome.storage.local.set(toSet, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      showStatus(String(err), 'err');
      return;
    }
    persistMaxHeight(snap.maxH);
    markClean();
    syncImgSavePathRow();
    if (!quiet) {
      showStatus(
        snap.path
          ? 'Saved. New downloads and page controls will use these settings.'
          : 'Saved.',
        'ok'
      );
    }
  });
}

function trySave() {
  if (!isDirty()) return;
  saveToLocalStorage({ quiet: false });
}

const pathInput = document.getElementById('path');
pathInput.addEventListener('input', onFormEdit);
pathInput.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  trySave();
});

if (saveBtn) {
  saveBtn.addEventListener('click', () => trySave());
}

[
  'float-on',
  'img-dl-on',
  'img-save-path-on',
  'rec-detach-on',
  'ytdlp-quality',
  'ffmpeg-preset-mode',
  'ytdlp-max-h',
  'ui-theme-mode',
  'ui-theme-accent',
  'dl-progress-layout',
  'dl-progress-morph',
  ...CTX_MENU_BOXES.map(([id]) => id),
].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', onFormEdit);
  if (el.matches('input[type="text"]')) el.addEventListener('input', onFormEdit);
});

const ytdlpMaxH = document.getElementById('ytdlp-max-h');
if (ytdlpMaxH) {
  ytdlpMaxH.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    trySave();
  });
}

window.addEventListener('pageshow', (e) => {
  if (e.persisted) load();
  else syncAccentRowVisibility();
});

if (window.HGR_THEME && window.HGR_THEME.initExtensionPageTheme) {
  window.HGR_THEME.initExtensionPageTheme();
}

load();
