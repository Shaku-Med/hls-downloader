function setHelperActionStatus(msg, kind) {
  const el = document.getElementById('helper-action-status');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.style.color =
    kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--danger)' : 'var(--muted)';
}

function copyText(text) {
  const value = String(text || '');
  if (!value) return Promise.reject(new Error('Nothing to copy'));
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(value);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) resolve();
      else reject(new Error('Copy failed'));
    } catch (e) {
      reject(e);
    }
  });
}

function toolLine(tool) {
  if (!tool) return '…';
  if (tool.ok) {
    const ver = (tool.version || 'ok').replace(/^ffmpeg version\s+/i, '');
    return ver.length > 48 ? ver.slice(0, 46) + '…' : ver;
  }
  return tool.version || 'missing';
}

function setInstallCommands(installHint) {
  const cmdEl = document.getElementById('helper-install-cmd');
  const cmdMain = document.getElementById('helper-install-cmd-main');
  if (cmdEl) cmdEl.textContent = installHint;
  if (cmdMain) cmdMain.textContent = installHint;
}

function renderHelperHealth(res) {
  const badge = document.getElementById('helper-status-badge');
  const title = document.getElementById('helper-status-title');
  const body = document.getElementById('helper-status-body');
  const tools = document.getElementById('helper-tools');
  const fix = document.getElementById('helper-fix');
  const steps = document.getElementById('helper-fix-steps');
  const idEl = document.getElementById('helper-ext-id');
  const ffmpegEl = document.getElementById('helper-ffmpeg');
  const ytdlpEl = document.getElementById('helper-ytdlp');
  const pythonEl = document.getElementById('helper-python');

  const status = (res && res.status) || 'error';
  const extensionId = (res && res.extensionId) || chrome.runtime.id || '';
  const installHint =
    (res && res.installHint) || `python python/install.py ${extensionId || 'YOUR_EXTENSION_ID'}`;

  if (idEl) idEl.value = extensionId;
  setInstallCommands(installHint);

  if (badge) {
    badge.className = 'helper-badge';
    badge.classList.add(`is-${status}`);
    badge.textContent =
      status === 'connected'
        ? 'Connected'
        : status === 'degraded'
          ? 'Needs attention'
          : status === 'missing'
            ? 'Missing'
            : status === 'checking'
              ? 'Checking'
              : 'Error';
  }

  if (status === 'connected') {
    if (title) title.textContent = 'Helper is ready';
    if (body) {
      body.textContent = res.hasPath
        ? 'Native host, ffmpeg, and yt-dlp look good. Downloads can write to your save folder.'
        : 'Helper is connected. Set a save folder in Settings so downloads know where to go.';
    }
    if (fix) fix.hidden = true;
  } else if (status === 'degraded') {
    if (title) title.textContent = 'Helper connected, tools incomplete';
    if (body) {
      body.textContent =
        res.error ||
        'The helper answered, but ffmpeg or yt-dlp is missing, or the save folder is not writable.';
    }
    if (fix && steps) {
      fix.hidden = false;
      steps.innerHTML = '';
      const items = [];
      if (res.ffmpeg && !res.ffmpeg.ok) {
        items.push('Install ffmpeg and make sure it is on your PATH, then open a new terminal.');
      }
      if (res.ytdlp && !res.ytdlp.ok) {
        items.push('Install yt-dlp for the helper Python: <code>python -m pip install -U yt-dlp</code>');
      }
      if (res.writeTest && res.writeTest.ran && res.writeTest.ok === false) {
        items.push('Fix the save folder path in Settings, then run Test save folder again.');
      }
      if (!items.length) {
        items.push('Re-run the helper installer from the Stuff Grabber folder, then fully quit and reopen the browser.');
      }
      items.forEach((html) => {
        const li = document.createElement('li');
        li.innerHTML = html;
        steps.appendChild(li);
      });
    }
  } else if (status === 'checking') {
    if (title) title.textContent = 'Checking…';
    if (body) body.textContent = 'Looking for the download helper…';
    if (fix) fix.hidden = true;
  } else {
    if (title) title.textContent = status === 'missing' ? 'Helper not installed' : 'Could not reach helper';
    if (body) {
      body.textContent =
        res.error ||
        'The browser could not start the download helper. Reinstall it with your extension ID, then fully restart the browser.';
    }
    if (fix && steps) {
      fix.hidden = false;
      steps.innerHTML = '';
      [
        'Open a terminal in the Stuff Grabber folder.',
        'Run the command below (ID already filled in).',
        'Fully quit the browser (not just this tab), open it again, and click Check again.',
      ].forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        steps.appendChild(li);
      });
    }
  }

  if (tools) {
    const showTools = !!(res && res.ok);
    tools.hidden = !showTools;
    if (showTools) {
      if (ffmpegEl) ffmpegEl.textContent = toolLine(res.ffmpeg);
      if (ytdlpEl) ytdlpEl.textContent = toolLine(res.ytdlp);
      if (pythonEl) pythonEl.textContent = res.python || '…';
    }
  }
}

function refreshHelperHealth(opts) {
  const testWrite = !!(opts && opts.testWrite);
  const recheck = document.getElementById('helper-recheck');
  const testBtn = document.getElementById('helper-test-write');
  if (recheck) recheck.disabled = true;
  if (testBtn) testBtn.disabled = true;
  renderHelperHealth({ status: 'checking', extensionId: chrome.runtime.id || '' });
  setHelperActionStatus(testWrite ? 'Testing save folder…' : 'Checking helper…');

  chrome.runtime.sendMessage({ type: 'GET_HELPER_HEALTH', testWrite }, (res) => {
    if (recheck) recheck.disabled = false;
    if (testBtn) testBtn.disabled = false;
    if (chrome.runtime.lastError) {
      renderHelperHealth({
        ok: false,
        status: 'error',
        error: chrome.runtime.lastError.message,
        extensionId: chrome.runtime.id || '',
      });
      setHelperActionStatus(chrome.runtime.lastError.message, 'err');
      return;
    }
    renderHelperHealth(res || { ok: false, status: 'error', error: 'No response' });
    if (testWrite) {
      if (res && res.writeTest && res.writeTest.ok) {
        setHelperActionStatus('Save folder is writable.', 'ok');
      } else if (res && res.status === 'missing') {
        setHelperActionStatus(res.error || 'Helper isn’t installed yet. Install it first.', 'err');
      } else {
        setHelperActionStatus(
          (res && (res.error || (res.writeTest && res.writeTest.error))) || 'Write test failed.',
          'err'
        );
      }
    } else {
      setHelperActionStatus(
        res && res.ok
          ? res.status === 'connected'
            ? 'All clear.'
            : 'Checked. Peek at the notes above.'
          : null,
        res && res.ok && res.status === 'connected' ? 'ok' : undefined
      );
    }
  });
}

document.getElementById('helper-recheck')?.addEventListener('click', () => refreshHelperHealth());
document.getElementById('helper-test-write')?.addEventListener('click', () => {
  refreshHelperHealth({ testWrite: true });
});
document.getElementById('helper-copy-id')?.addEventListener('click', () => {
  const id = document.getElementById('helper-ext-id')?.value || chrome.runtime.id || '';
  copyText(id)
    .then(() => setHelperActionStatus('Extension ID copied.', 'ok'))
    .catch(() => setHelperActionStatus('Could not copy ID.', 'err'));
});

function wireCopyCmd(btnId, codeId) {
  document.getElementById(btnId)?.addEventListener('click', () => {
    const cmd = document.getElementById(codeId)?.textContent || '';
    copyText(cmd)
      .then(() => setHelperActionStatus('Install command copied.', 'ok'))
      .catch(() => setHelperActionStatus('Could not copy command.', 'err'));
  });
}
wireCopyCmd('helper-copy-cmd', 'helper-install-cmd');
wireCopyCmd('helper-copy-cmd-main', 'helper-install-cmd-main');

if (window.HGR_THEME && window.HGR_THEME.initExtensionPageTheme) {
  window.HGR_THEME.initExtensionPageTheme();
}

const idBoot = chrome.runtime.id || '';
document.getElementById('helper-ext-id').value = idBoot;
setInstallCommands(`python python/install.py ${idBoot || 'YOUR_EXTENSION_ID'}`);
refreshHelperHealth();
