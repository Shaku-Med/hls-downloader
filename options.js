const KEY = 'userDownloadPath';
const FLOAT_KEY = 'floatGrabberEnabled';

function showStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.hidden = false;
  el.className = kind === 'ok' ? 'ok' : 'err';
}

function load() {
  chrome.storage.local.get([KEY, FLOAT_KEY], (data) => {
    const err = chrome.runtime.lastError;
    if (err) {
      showStatus(String(err), 'err');
      return;
    }
    document.getElementById('path').value = (data && data[KEY]) || '';
    const floatEl = document.getElementById('float-on');
    if (floatEl) floatEl.checked = data[FLOAT_KEY] !== false;
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

window.addEventListener('pageshow', (e) => {
  if (e.persisted) load();
});

load();
