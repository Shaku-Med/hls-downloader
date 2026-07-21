/** Shared HLS/DASH ffmpeg x264 preset picker (popup + FAB). */
(function (global) {
  const FFMPEG_PRESET_MODE_KEY = 'ffmpegPresetMode';
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';

  const ALL_PRESETS = [
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
    'placebo',
  ];

  const PRESET_RANK = Object.fromEntries(ALL_PRESETS.map((p, i) => [p, i]));

  const THEME_PALETTE = {
    dark: {
      bg: '#000000',
      surface: '#1c1c1e',
      surface2: '#2c2c2e',
      text: '#ffffff',
      muted: '#8e8e93',
      line: 'rgba(84, 84, 88, 0.65)',
      btnText: '#ffffff',
      accents: {
        blue: ['#0a84ff', '#409cff'],
        violet: ['#bf5af2', '#da8fff'],
        emerald: ['#30d158', '#63e689'],
        rose: ['#ff375f', '#ff6482'],
        orange: ['#ff9f0a', '#ffb340'],
      },
    },
    light: {
      bg: '#f2f2f7',
      surface: '#ffffff',
      surface2: '#ffffff',
      text: '#000000',
      muted: '#8e8e93',
      line: 'rgba(60, 60, 67, 0.18)',
      btnText: '#ffffff',
      accents: {
        blue: ['#007aff', '#0a84ff'],
        violet: ['#af52de', '#bf5af2'],
        emerald: ['#34c759', '#30d158'],
        rose: ['#ff2d55', '#ff375f'],
        orange: ['#ff9500', '#ff9f0a'],
      },
    },
  };

  let _stylesReady = false;

  function resolveThemeMode(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'dark';
    }
  }

  function ensureModalStyles() {
    if (_stylesReady || document.getElementById('hgr-modal-theme-css')) {
      _stylesReady = true;
      return;
    }
    try {
      const link = document.createElement('link');
      link.id = 'hgr-modal-theme-css';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('style/modal-theme.css');
      document.head.appendChild(link);
      _stylesReady = true;
    } catch (_) {
      // popup may already include modal-theme.css via popup.html
      _stylesReady = true;
    }
  }

  function applyModalTheme(el, mode, accent) {
    if (!el) return;
    ensureModalStyles();
    if (
      global.HGR_THEME &&
      typeof global.location !== 'undefined' &&
      String(global.location.protocol).startsWith('chrome-extension')
    ) {
      global.HGR_THEME.syncThemeFromRoot(document.documentElement, el);
      return;
    }
    if (global.HGR_THEME && typeof global.HGR_THEME.applyThemeToHost === 'function') {
      global.HGR_THEME.applyThemeToHost(el, mode || 'system', accent || 'blue');
      return;
    }
    if (mode === 'page' && global.HGR_THEME && global.HGR_THEME.readPageColors) {
      const palette = global.HGR_THEME.derivePalette(global.HGR_THEME.readPageColors());
      global.HGR_THEME.applyPaletteToElement(el, palette);
      el.setAttribute('data-theme', palette.theme);
      el.setAttribute('data-theme-mode', 'page');
      el.removeAttribute('data-accent');
      return;
    }
    const resolved = resolveThemeMode(mode);
    const pal = THEME_PALETTE[resolved] || THEME_PALETTE.dark;
    const accKey = accent || 'blue';
    const acc = (pal.accents && pal.accents[accKey]) || pal.accents.blue;
    el.style.setProperty('--bg', pal.bg);
    el.style.setProperty('--surface', pal.surface);
    el.style.setProperty('--surface-2', pal.surface2);
    el.style.setProperty('--text', pal.text);
    el.style.setProperty('--muted', pal.muted);
    el.style.setProperty('--line', pal.line);
    el.style.setProperty('--btnText', pal.btnText);
    el.style.setProperty('--accent', acc[0]);
    el.style.setProperty('--accent-2', acc[1]);
    el.setAttribute('data-theme', resolved);
    el.setAttribute('data-theme-mode', mode || 'system');
    if (mode === 'page') el.removeAttribute('data-accent');
    else el.setAttribute('data-accent', accKey);
  }

  function readUiTheme(cb) {
    try {
      chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
        cb(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
      });
    } catch (_) {
      cb('system', 'blue');
    }
  }

  function formatDuration(sec) {
    const s = Math.max(0, Number(sec) || 0);
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!n || n <= 0) return '';
    if (n >= 1_073_741_824) return `~${(n / 1_073_741_824).toFixed(1)} GB`;
    if (n >= 1_048_576) return `~${Math.round(n / 1_048_576)} MB`;
    if (n >= 1024) return `~${Math.round(n / 1024)} KB`;
    return `~${n} B`;
  }

  function normalizePreset(p) {
    const v = (p || '').toLowerCase();
    return ALL_PRESETS.includes(v) ? v : 'veryfast';
  }

  function presetTradeoffs(preset, comparedTo) {
    const p = normalizePreset(preset);
    const ref = normalizePreset(comparedTo || p);
    const rank = PRESET_RANK[p] ?? 2;
    const refRank = PRESET_RANK[ref] ?? 2;
    const gains = [];
    const losses = [];
    if (rank < refRank) {
      gains.push('Encodes faster, so the download finishes sooner');
      gains.push('Lower CPU use while encoding');
      losses.push('Larger output at the same quality (CRF)');
      losses.push('Less efficient compression');
    } else if (rank > refRank) {
      gains.push('Better compression, so a smaller file at the same quality');
      gains.push('Cleaner detail on longer or high-bitrate sources');
      losses.push('Slower re-encode');
      losses.push('Higher CPU use while encoding');
    } else {
      gains.push('Balanced choice for this source length/size');
      losses.push('Go faster to finish sooner, or slower for smaller files');
    }
    if (p === 'placebo') losses.push('Very slow, and rarely worth it for grabs');
    if (p === 'ultrafast') losses.push('Largest files, best kept for very short clips');
    return { title: p, gains, losses };
  }

  function numberedNameHint(stem, ext) {
    const base = (stem || 'video').trim() || 'video';
    const e = ext && ext.startsWith('.') ? ext : '.mp4';
    return `${base} (1)${e}`;
  }

  function ffmpegPresetLikelyApplies(kind, url) {
    const k = (kind || '').toLowerCase();
    if (k === 'social' || k === 'yt') return false;
    if (k === 'hls' || k === 'dash' || k === 'mpd' || k === 'm3u8' || k === 'apple_hls') return true;
    const u = (url || '').toLowerCase();
    return u.includes('.m3u8') || u.includes('.mpd') || u.includes('/hls/');
  }

  function jobSupportsFfmpegPreset(job) {
    if (!job) return false;
    const k = (job.streamKind || '').toLowerCase();
    if (k === 'social' || k === 'yt') return false;
    if (job.ffmpegPreset) return true;
    if (['hls', 'dash', 'mpd', 'm3u8', 'apple_hls'].includes(k)) return true;
    const u = (job.streamUrl || '').toLowerCase();
    return u.includes('.m3u8') || u.includes('.mpd') || u.includes('/hls/');
  }

  /**
   * Add preset controls on active jobs and delete button on canceled partials.
   * @param {object} job
   * @param {HTMLElement} card
   * @param {{ onRefresh?: () => void }} [options]
   */
  function enhanceJobCard(job, card, options) {
    if (!job || !card) return;
    const onRefresh = (options && options.onRefresh) || (() => {});

    if (['queued', 'connecting', 'downloading'].includes(job.status) && jobSupportsFfmpegPreset(job)) {
      const row = document.createElement('div');
      row.className = 'hgr-job-preset-row';
      const lab = document.createElement('span');
      lab.className = 'hgr-job-preset-label';
      lab.textContent = 'Preset';
      const sel = document.createElement('select');
      sel.className = 'hgr-job-preset-select';
      sel.title = 'x264 encoding preset';
      const current = normalizePreset(job.ffmpegPreset || 'veryfast');
      for (const p of ALL_PRESETS) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p + (p === current ? ' ✓' : '');
        sel.appendChild(opt);
      }
      sel.value = current;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hgr-job-preset-btn';
      btn.textContent = 'Change';
      btn.addEventListener('click', () => {
        const newPreset = normalizePreset(sel.value);
        if (newPreset === current && job.ffmpegPreset) return;
        const stem = job.fileStem || job.label || 'video';
        const fileLabel = job.outputPath
          ? job.outputPath.split(/[/\\]/).pop()
          : `${stem}.mp4`;
        const basePayload = job.downloadPayload
          ? { ...job.downloadPayload, jobId: job.id, ffmpegPreset: newPreset }
          : null;
        if (!basePayload) {
          onRefresh();
          return;
        }
        const runSwitch = (deleteFile) => {
          chrome.runtime.sendMessage(
            {
              type: 'SWITCH_FFMPEG_PRESET',
              jobId: job.id,
              newPreset,
              deleteFile,
              payload: basePayload,
            },
            (r) => {
              if (chrome.runtime.lastError || !r?.ok) {
                window.alert(
                  chrome.runtime.lastError?.message || r?.error || 'Could not restart download'
                );
              }
              onRefresh();
            }
          );
        };
        if (job.outputPath && job.status === 'downloading') {
          showDeletePartialConfirm(
            fileLabel,
            numberedNameHint(stem, '.mp4'),
            (deleteFile) => {
              if (deleteFile === undefined) return;
              runSwitch(deleteFile);
            }
          );
        } else {
          runSwitch(true);
        }
      });
      row.appendChild(lab);
      row.appendChild(sel);
      row.appendChild(btn);
      card.appendChild(row);
      if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
        HLS_IOS_SELECT.enhance(sel, { compact: true });
      }
    }

    if (job.status === 'canceled' && job.outputPath) {
      const pathRow = document.createElement('div');
      pathRow.className = 'hgr-job-partial-path';
      pathRow.textContent = job.outputPath;
      const actRow = document.createElement('div');
      actRow.className = 'hgr-job-actions-row';
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'hgr-job-delete-btn';
      delBtn.textContent = 'Delete partial file';
      delBtn.addEventListener('click', () => {
        delBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'DELETE_JOB_FILE', jobId: job.id }, (r) => {
          if (chrome.runtime.lastError || !r?.ok) {
            delBtn.disabled = false;
            window.alert(chrome.runtime.lastError?.message || r?.error || 'Could not delete file');
            return;
          }
          onRefresh();
        });
      });
      actRow.appendChild(delBtn);
      card.appendChild(pathRow);
      card.appendChild(actRow);
    }
  }

  function detachOverlayTheme(overlay) {
    if (overlay && typeof overlay._hgrOffLiveTheme === 'function') {
      overlay._hgrOffLiveTheme();
      overlay._hgrOffLiveTheme = null;
    }
  }

  function mkOverlayBox(themeMode, themeAccent) {
    ensureModalStyles();
    const overlay = document.createElement('div');
    overlay.className = 'hgr-modal-overlay';
    if (global.HGR_THEME && typeof global.HGR_THEME.hardenModalOverlay === 'function') {
      global.HGR_THEME.hardenModalOverlay(overlay);
    }
    applyModalTheme(overlay, themeMode, themeAccent);
    if (global.HGR_THEME && global.HGR_THEME.bindLiveOverlayTheme) {
      overlay._hgrOffLiveTheme = global.HGR_THEME.bindLiveOverlayTheme(overlay);
    }
    const box = document.createElement('div');
    box.className = 'hgr-modal-box';
    if (global.HGR_THEME && typeof global.HGR_THEME.hardenModalBox === 'function') {
      global.HGR_THEME.hardenModalBox(box);
    }
    overlay.appendChild(box);
    return { overlay, box };
  }

  /** @param {(deleteFile: boolean|undefined) => void} callback — true=delete, false=keep, undefined=cancel */
  function showDeletePartialConfirm(fileLabel, numberedHint, callback, themeMode, themeAccent) {
    readUiTheme((mode, accent) => {
      const { overlay, box } = mkOverlayBox(themeMode || mode, themeAccent || accent);
      const h = document.createElement('div');
      h.className = 'hgr-modal-title';
      h.textContent = 'Delete partial file?';
      const sub = document.createElement('div');
      sub.className = 'hgr-modal-sub';
      sub.innerHTML = `Restart with a new preset. Delete the in-progress file <strong>${fileLabel || 'output'}</strong>?`;
      if (numberedHint) {
        sub.innerHTML += `<br>If you keep it, the new encode saves as <strong>${numberedHint}</strong>.`;
      }
      const row = document.createElement('div');
      row.className = 'hgr-modal-actions';
      const close = (v) => {
        detachOverlayTheme(overlay);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        callback(v);
      };
      const danger = document.createElement('button');
      danger.type = 'button';
      danger.className = 'hgr-modal-btn-danger';
      danger.textContent = 'Yes, delete it and start over';
      danger.addEventListener('click', () => close(true));
      const secondary = document.createElement('button');
      secondary.type = 'button';
      secondary.className = 'hgr-modal-btn-secondary';
      secondary.textContent = 'No, keep it and save the new one with a number';
      secondary.addEventListener('click', () => close(false));
      const ghost = document.createElement('button');
      ghost.type = 'button';
      ghost.className = 'hgr-modal-btn-ghost';
      ghost.textContent = 'Cancel';
      ghost.addEventListener('click', () => close(undefined));
      row.appendChild(danger);
      row.appendChild(secondary);
      row.appendChild(ghost);
      box.appendChild(h);
      box.appendChild(sub);
      box.appendChild(row);
      // Mount on <html>: the floater host follows <body>, so a body-mounted
      // overlay would stack behind the floating panel.
      (document.documentElement || document.body).appendChild(overlay);
    });
  }

  /**
   * @param {object} probe
   * @param {object} ctx { filename, ext, onStart(preset, cb), onSwitch(opts, cb) }
   * @param {() => void} onCancel
   * @param {string} [themeMode]
   * @param {string} [themeAccent]
   */
  function showFfmpegPresetPicker(probe, ctx, onCancel, themeMode, themeAccent) {
    const recommended = normalizePreset(probe.recommendedPreset);
    const allowed = (probe.allowedPresets || ALL_PRESETS).filter((p) => ALL_PRESETS.includes(p));
    const presets = allowed.length ? allowed : ALL_PRESETS;
    const durTxt = probe.durationSec > 0.5 ? formatDuration(probe.durationSec) : 'unknown length';
    const sizeTxt = probe.sizeBytes > 0 ? formatSize(probe.sizeBytes) : '';
    const detectBits = [durTxt, sizeTxt].filter(Boolean).join(', ');
    const stem = (ctx && ctx.filename) || 'video';
    const ext = (ctx && ctx.ext) || '.mp4';

    let activeJobId = null;
    let activePreset = recommended;
    let starting = false;

    const { overlay, box } = mkOverlayBox(themeMode, themeAccent);

    const h = document.createElement('div');
    h.className = 'hgr-modal-title';
    h.textContent = 'Encoding speed (x264 preset)';

    const sub = document.createElement('div');
    sub.className = 'hgr-modal-sub';
    let subHtml = `Re-encodes to MP4. Detected: <strong>${detectBits || 'source'}</strong>.`;
    if (probe.autoReason && !probe.envLocked) {
      subHtml += `<br>Auto-selected <strong>${recommended}</strong> (${probe.autoReason}).`;
    }
    if (probe.envLocked) {
      subHtml += `<br>Locked by <code>HLS_GRABBER_FFMPEG_PRESET</code> on your PC.`;
    }
    sub.innerHTML = subHtml;

    const status = document.createElement('div');
    status.className = 'hgr-modal-status';
    status.textContent = 'Choose a preset, then click Start download.';

    const label = document.createElement('label');
    label.className = 'hgr-modal-label';
    label.textContent = 'x264 preset';

    const select = document.createElement('select');
    select.className = 'hgr-modal-select';
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p + (p === recommended ? ' (recommended)' : '');
      select.appendChild(opt);
    }
    select.value = recommended;

    const trade = document.createElement('div');
    trade.className = 'hgr-modal-trade';

    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'hgr-modal-btn-primary';
    switchBtn.disabled = starting;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'hgr-modal-btn-ghost';
    cancelBtn.textContent = 'Close';

    if (probe.envLocked) {
      status.textContent = `Preset locked to ${recommended}. Close to continue.`;
      switchBtn.textContent = 'Locked by environment';
      switchBtn.disabled = true;
      select.disabled = true;
    }

    const updateTrade = () => {
      const sel = normalizePreset(select.value);
      const t = presetTradeoffs(sel, recommended);
      trade.innerHTML =
        `<div class="hgr-modal-trade-title">${t.title}</div>` +
        `<div class="hgr-modal-trade-gain">Gain: ${t.gains.join('; ')}</div>` +
        `<div class="hgr-modal-trade-loss">Trade-off: ${t.losses.join('; ')}</div>`;
      switchBtn.disabled = (!activeJobId && probe.envLocked) || (activeJobId && sel === activePreset) || starting;
      switchBtn.textContent =
        activeJobId && sel !== activePreset
          ? `Cancel & restart as ${sel}`
          : activeJobId
            ? `Using ${activePreset}`
            : 'Start download';
    };

    select.addEventListener('change', updateTrade);

    const btnRow = document.createElement('div');
    btnRow.className = 'hgr-modal-actions';

    const closeOverlay = () => {
      detachOverlayTheme(overlay);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    const doStart = (preset) => {
      if (!ctx || typeof ctx.onStart !== 'function') return;
      starting = true;
      switchBtn.disabled = true;
      status.textContent = `Starting with preset ${preset}…`;
      ctx.onStart(preset, (err, jobId) => {
        starting = false;
        if (err) {
          status.textContent = `Could not start: ${err}`;
          updateTrade();
          return;
        }
        activeJobId = jobId;
        activePreset = preset;
        select.value = preset;
        status.textContent = `Downloading with preset ${activePreset}. Change preset below to restart.`;
        updateTrade();
      });
    };

    const doSwitch = () => {
      const newPreset = normalizePreset(select.value);
      if (!activeJobId || newPreset === activePreset) {
        if (!activeJobId && !probe.envLocked) doStart(newPreset);
        return;
      }
      const showConfirm = (fileLabel) => {
        showDeletePartialConfirm(
          fileLabel,
          numberedNameHint(stem, ext),
          (deleteFile) => {
            if (deleteFile === undefined) return;
            starting = true;
            switchBtn.disabled = true;
            status.textContent = `Switching to ${newPreset}…`;
            ctx.onSwitch(
              { jobId: activeJobId, preset: newPreset, deleteFile },
              (err, sameJobId) => {
                starting = false;
                if (err) {
                  status.textContent = `Restart failed: ${err}`;
                  updateTrade();
                  return;
                }
                activeJobId = sameJobId || activeJobId;
                activePreset = newPreset;
                status.textContent = `Restarted with preset ${activePreset}.`;
                updateTrade();
              }
            );
          },
          themeMode,
          themeAccent
        );
      };
      chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATE' }, (res) => {
        const job = (res && res.jobs || []).find((j) => j.id === activeJobId);
        const outPath = job && job.outputPath;
        const fileLabel = outPath ? outPath.split(/[/\\]/).pop() : `${stem}${ext}`;
        showConfirm(fileLabel);
      });
    };

    switchBtn.addEventListener('click', doSwitch);
    cancelBtn.addEventListener('click', () => {
      closeOverlay();
      if (typeof onCancel === 'function') onCancel();
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) {
        closeOverlay();
        if (typeof onCancel === 'function') onCancel();
      }
    });

    btnRow.appendChild(switchBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(h);
    box.appendChild(sub);
    box.appendChild(status);
    box.appendChild(label);
    box.appendChild(select);
    box.appendChild(trade);
    box.appendChild(btnRow);
    if (typeof HLS_IOS_SELECT !== 'undefined' && HLS_IOS_SELECT.enhance) {
      HLS_IOS_SELECT.enhance(select);
    }
    // Mount on <html>: the floater host follows <body>, so a body-mounted
    // overlay would stack behind the floating panel.
    (document.documentElement || document.body).appendChild(overlay);
    updateTrade();
  }

  /**
   * @param {string} kind
   * @param {object} probePayload
   * @param {object} ctx passed to showFfmpegPresetPicker
   * @param {() => void} onCancel
   */
  function maybeAskFfmpegPreset(kind, probePayload, ctx, onCancel) {
    if (!ffmpegPresetLikelyApplies(kind, probePayload && probePayload.url)) {
      if (ctx && typeof ctx.onStart === 'function') ctx.onStart(null, () => {});
      return;
    }
    chrome.storage.local.get([FFMPEG_PRESET_MODE_KEY, THEME_MODE_KEY, THEME_ACCENT_KEY], (opt) => {
      if (chrome.runtime.lastError) {
        if (ctx && typeof ctx.onStart === 'function') ctx.onStart(null, () => {});
        return;
      }
      const themeMode = opt?.[THEME_MODE_KEY] || 'system';
      const themeAccent = opt?.[THEME_ACCENT_KEY] || 'blue';
      const mode = opt && opt[FFMPEG_PRESET_MODE_KEY];
      const ask = mode !== 'auto';
      if (!ask) {
        if (ctx && typeof ctx.onStart === 'function') ctx.onStart(null, () => {});
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'GET_FFMPEG_ENCODE_PRESET', payload: probePayload },
        (res) => {
          if (chrome.runtime.lastError || !res || !res.ok || !res.applies) {
            if (ctx && typeof ctx.onStart === 'function') ctx.onStart(null, () => {});
            return;
          }
          showFfmpegPresetPicker(res, ctx, onCancel, themeMode, themeAccent);
        }
      );
    });
  }

  global.HLS_FFMPEG = {
    FFMPEG_PRESET_MODE_KEY,
    THEME_MODE_KEY,
    THEME_ACCENT_KEY,
    ALL_PRESETS,
    formatDuration,
    formatSize,
    presetTradeoffs,
    ffmpegPresetLikelyApplies,
    jobSupportsFfmpegPreset,
    enhanceJobCard,
    applyModalTheme,
    ensureModalStyles,
    showFfmpegPresetPicker,
    showDeletePartialConfirm,
    maybeAskFfmpegPreset,
    numberedNameHint,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
