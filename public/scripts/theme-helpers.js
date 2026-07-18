/** Shared theme helpers: read page body colors and apply them to extension UI. */
(function (global) {
  const THEME_MODE_KEY = 'uiThemeMode';
  const THEME_ACCENT_KEY = 'uiThemeAccent';
  const THEME_CSS_VARS = [
    '--bg',
    '--surface',
    '--surface-2',
    '--text',
    '--muted',
    '--line',
    '--accent',
    '--accent-2',
    '--btnText',
  ];

  const FIXED = {
    dark: {
      bg: '#0f1117',
      surface: '#161b27',
      surface2: '#131926',
      text: '#e6e9ef',
      muted: '#95a2bb',
      line: '#293043',
      btnText: '#f8fbff',
      accent: '#4f8cff',
      accent2: '#3574f0',
    },
    light: {
      bg: '#f4f6fb',
      surface: '#ffffff',
      surface2: '#eef2fb',
      text: '#0f172a',
      muted: '#475569',
      line: '#d8e0ef',
      btnText: '#ffffff',
      accent: '#2563eb',
      accent2: '#1d4ed8',
    },
  };

  const ACCENTS = {
    blue: ['#2563eb', '#1d4ed8'],
    violet: ['#8b5cf6', '#7c3aed'],
    emerald: ['#10b981', '#059669'],
    rose: ['#f43f5e', '#e11d48'],
    orange: ['#f97316', '#ea580c'],
  };

  const DARK_ACCENTS = {
    blue: ['#4f8cff', '#3574f0'],
    violet: ['#8b5cf6', '#7c3aed'],
    emerald: ['#10b981', '#059669'],
    rose: ['#f43f5e', '#e11d48'],
    orange: ['#f97316', '#ea580c'],
  };

  function hslToRgb(h, s, l, a) {
    const sat = Math.max(0, Math.min(100, s)) / 100;
    const lit = Math.max(0, Math.min(100, l)) / 100;
    const hue = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * lit - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lit - c / 2;
    let rp = 0;
    let gp = 0;
    let bp = 0;
    if (hue < 60) {
      rp = c;
      gp = x;
    } else if (hue < 120) {
      rp = x;
      gp = c;
    } else if (hue < 180) {
      gp = c;
      bp = x;
    } else if (hue < 240) {
      gp = x;
      bp = c;
    } else if (hue < 300) {
      rp = x;
      bp = c;
    } else {
      rp = c;
      bp = x;
    }
    return {
      r: (rp + m) * 255,
      g: (gp + m) * 255,
      b: (bp + m) * 255,
      a: a == null || Number.isNaN(a) ? 1 : a,
    };
  }

  function parseCssColor(str) {
    const raw = String(str || '').trim();
    if (!raw || raw === 'transparent') return null;
    let m = raw.match(/^rgba?\(([^)]+)\)/i);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      if (parts.length >= 3 && !parts.slice(0, 3).some((n) => Number.isNaN(n))) {
        return {
          r: parts[0],
          g: parts[1],
          b: parts[2],
          a: parts.length >= 4 && !Number.isNaN(parts[3]) ? parts[3] : 1,
        };
      }
    }
    m = raw.match(/^hsla?\(\s*([\d.+-]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)$/i);
    if (m) {
      const h = parseFloat(m[1]);
      const s = parseFloat(m[2]);
      const l = parseFloat(m[3]);
      const a = m[4] != null ? parseFloat(m[4]) : 1;
      if (![h, s, l].some((n) => Number.isNaN(n))) return hslToRgb(h, s, l, a);
    }
    m = raw.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      if (hex.length === 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: 1,
        };
      }
    }
    return null;
  }

  let _colorProbe = null;
  function normalizeCssColor(str, prop) {
    const raw = String(str || '').trim();
    if (!raw || raw === 'transparent') return null;
    const direct = parseCssColor(raw);
    if (direct) return direct;
    try {
      if (typeof document === 'undefined') return null;
      if (!_colorProbe) {
        _colorProbe = document.createElement('span');
        _colorProbe.style.display = 'none';
        document.documentElement.appendChild(_colorProbe);
      }
      const styleProp = prop === 'backgroundColor' ? 'backgroundColor' : 'color';
      _colorProbe.style.backgroundColor = '';
      _colorProbe.style.color = '';
      _colorProbe.style[styleProp] = raw;
      const computed = getComputedStyle(_colorProbe)[styleProp];
      return parseCssColor(computed);
    } catch (_) {
      return null;
    }
  }

  function toCss(c) {
    if (!c) return null;
    if (c.a != null && c.a < 1) {
      return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;
    }
    return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  }

  function relativeLuminance(c) {
    if (!c) return 0;
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function mixRgb(a, b, t) {
    const w = Math.max(0, Math.min(1, t));
    return {
      r: a.r + (b.r - a.r) * w,
      g: a.g + (b.g - a.g) * w,
      b: a.b + (b.b - a.b) * w,
      a: 1,
    };
  }

  function readColorFrom(el, prop) {
    if (!el) return null;
    try {
      const raw = getComputedStyle(el)[prop];
      return normalizeCssColor(raw, prop) || parseCssColor(raw);
    } catch (_) {
      return null;
    }
  }

  function contrastRatio(a, b) {
    if (!a || !b) return 1;
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function readableFallbackText(bgParsed) {
    if (!bgParsed) return '#e6e9ef';
    return relativeLuminance(bgParsed) < 0.5 ? '#e6e9ef' : '#0f172a';
  }

  function ensureReadableText(bgCss, textCss) {
    const bg =
      normalizeCssColor(bgCss, 'backgroundColor') ||
      normalizeCssColor(bgCss, 'color') ||
      parseCssColor(bgCss);
    const text =
      normalizeCssColor(textCss, 'color') ||
      parseCssColor(textCss);
    if (!bg) return readableFallbackText(null);
    if (text && contrastRatio(bg, text) >= 4.5) return toCss(text);
    return readableFallbackText(bg);
  }

  function deriveMutedColor(text, bg, theme) {
    let mix = theme === 'dark' ? 0.52 : 0.62;
    let muted = mixRgb(text, bg, mix);
    for (let i = 0; i < 5 && contrastRatio(bg, muted) < 4.5; i += 1) {
      mix = Math.max(0.12, mix - 0.1);
      muted = mixRgb(text, bg, mix);
    }
    if (contrastRatio(bg, muted) < 4.5) return text;
    return muted;
  }

  function rgbToHsl(c) {
    if (!c) return { h: 0, s: 0, l: 0 };
    const r = Math.max(0, Math.min(255, c.r)) / 255;
    const g = Math.max(0, Math.min(255, c.g)) / 255;
    const b = Math.max(0, Math.min(255, c.b)) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s, l };
  }

  function colorSaturation(c) {
    return rgbToHsl(c).s;
  }

  function isGrayish(c, maxSat) {
    if (!c) return true;
    return colorSaturation(c) < (maxSat == null ? 0.12 : maxSat);
  }

  function isOurUiHost(el) {
    if (!el || !el.closest) return false;
    try {
      return !!el.closest('[data-hls-grabber-fab],[data-hls-image-dl]');
    } catch (_) {
      return false;
    }
  }

  function parseColorValue(raw, prop) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s || s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'unset') return null;
    return (
      normalizeCssColor(s, prop || 'color') ||
      parseCssColor(s)
    );
  }

  const BG_CSS_VARS = [
    '--background',
    '--bg',
    '--color-background',
    '--color-bg',
    '--background-color',
    '--bg-color',
    '--surface',
    '--color-surface',
    '--page-background',
    '--main-bg',
    '--body-bg',
    '--theme-background',
    '--backgroundPrimary',
    '--bgPrimary',
    '--color-canvas-default',
    '--bgColor-default',
    '--yt-spec-base-background',
  ];

  const ACCENT_CSS_VARS = [
    '--primary',
    '--accent',
    '--brand',
    '--color-primary',
    '--color-accent',
    '--brand-color',
    '--primary-color',
    '--accent-color',
    '--theme-color',
    '--theme-primary',
    '--link-color',
    '--color-link',
    '--focus-color',
    '--button-primary-bg',
    '--btn-primary-bg',
    '--color-fg-brand',
    '--fgColor-accent',
    '--yt-spec-brand-button-background',
    '--yt-spec-call-to-action',
  ];

  function readCssVarFrom(el, name) {
    if (!el) return null;
    try {
      const raw = getComputedStyle(el).getPropertyValue(name);
      if (!raw || !String(raw).trim()) return null;
      // Prefer backgroundColor probe for bg-ish vars; color probe otherwise.
      const asBg = /bg|background|surface|canvas/i.test(name);
      return parseColorValue(raw, asBg ? 'backgroundColor' : 'color');
    } catch (_) {
      return null;
    }
  }

  function readFirstCssVar(names) {
    const hosts = [document.documentElement, document.body].filter(Boolean);
    for (const host of hosts) {
      for (const name of names) {
        const c = readCssVarFrom(host, name);
        if (c && c.a > 0.4) return c;
      }
    }
    return null;
  }

  function readMetaThemeColor() {
    try {
      const metas = document.querySelectorAll('meta[name="theme-color" i], meta[name="msapplication-TileColor" i]');
      for (const meta of metas) {
        const content = (meta.getAttribute('content') || '').trim();
        if (!content) continue;
        // Skip media-query metas that don't match when possible.
        const media = (meta.getAttribute('media') || '').trim();
        if (media) {
          try {
            if (!window.matchMedia(media).matches) continue;
          } catch (_) {
            // ignore bad media
          }
        }
        const c = parseColorValue(content, 'backgroundColor');
        if (c && c.a > 0.4) return c;
      }
    } catch (_) {
      // ignore
    }
    return null;
  }

  function readOpaqueBackgroundFrom(el) {
    if (!el) return null;
    const c = readColorFrom(el, 'backgroundColor');
    if (c && c.a > 0.5) return c;
    return null;
  }

  function elementInViewport(r) {
    if (!r) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
    return true;
  }

  function scoreSurfaceCandidate(el, color) {
    if (!el || !color || color.a <= 0.5) return 0;
    try {
      const r = el.getBoundingClientRect();
      if (!elementInViewport(r)) return 0;
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area < 8000) return 0;
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const cover = Math.min(1, area / (vw * vh));
      // Prefer large shells; slight boost for near-root / landmark tags.
      const tag = (el.tagName || '').toLowerCase();
      const landmark =
        tag === 'html' || tag === 'body' || tag === 'main' || tag === 'header' || tag === 'nav' ? 1.15 : 1;
      return cover * color.a * landmark;
    } catch (_) {
      return 0;
    }
  }

  function readVisibleSurfaceBackground() {
    let best = null;
    let bestScore = 0;
    const consider = (el) => {
      if (!el || isOurUiHost(el)) return;
      const c = readOpaqueBackgroundFrom(el);
      if (!c) return;
      const score = scoreSurfaceCandidate(el, c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    };

    consider(document.documentElement);
    consider(document.body);

    const selectors = [
      '#root',
      '#app',
      '#__next',
      '#__nuxt',
      '[data-reactroot]',
      'main',
      '[role="main"]',
      'header',
      'nav',
      '.app',
      '.App',
      '.main',
      '.page',
      '.layout',
      '[class*="background"]',
      '[class*="Background"]',
    ];
    try {
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => consider(el));
      }
    } catch (_) {
      // ignore
    }

    // Scan a limited set of large visible divs / sections.
    try {
      const nodes = document.querySelectorAll('div, section, article, aside');
      const limit = Math.min(nodes.length, 80);
      for (let i = 0; i < limit; i++) consider(nodes[i]);
    } catch (_) {
      // ignore
    }

    return best;
  }

  function readPageBackgroundColor() {
    // 1) CSS design tokens
    const fromVar = readFirstCssVar(BG_CSS_VARS);
    if (fromVar) return fromVar;

    // 2) Walk body → html for opaque backgrounds
    let el = document.body;
    while (el) {
      const found = readOpaqueBackgroundFrom(el);
      if (found) return found;
      el = el.parentElement;
    }
    for (const node of [document.documentElement, document.body]) {
      const found = readOpaqueBackgroundFrom(node);
      if (found) return found;
    }

    // 3) Largest visible opaque surfaces
    const surface = readVisibleSurfaceBackground();
    if (surface) return surface;

    // 4) Soft fallback: theme-color as page chrome (often header bar, not page bg)
    // Prefer not using meta as bg unless nothing else found — handled in readPageColors.
    return null;
  }

  function readPageTextColor(bgCss) {
    const bgParsed =
      normalizeCssColor(bgCss, 'backgroundColor') ||
      parseCssColor(bgCss);

    const textVarNames = [
      '--foreground',
      '--color-foreground',
      '--text',
      '--color-text',
      '--text-color',
      '--color-fg-default',
      '--fgColor-default',
      '--yt-spec-text-primary',
    ];
    const fromVar = readFirstCssVar(textVarNames);
    if (fromVar && bgParsed && contrastRatio(fromVar, bgParsed) >= 4.5) {
      return toCss(fromVar);
    }

    for (const node of [document.body, document.documentElement]) {
      const c = readColorFrom(node, 'color');
      if (c && bgParsed && contrastRatio(c, bgParsed) >= 4.5) return toCss(c);
    }

    try {
      const selectors =
        'main h1,main h2,main p,article p,h1,h2,h3,p,label,li,td,th,span,a,button,nav,header,main,div';
      const nodes = document.querySelectorAll(selectors);
      const candidates = [];
      const limit = Math.min(nodes.length, 140);
      for (let i = 0; i < limit; i++) {
        const el = nodes[i];
        if (!el || isOurUiHost(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || !elementInViewport(r)) continue;
        const sample = String(el.textContent || '').trim();
        if (sample.length < 2) continue;
        const c = readColorFrom(el, 'color');
        if (!c || !bgParsed) continue;
        if (isGrayish(c, 0.05) && sample.length < 4) continue;
        if (contrastRatio(c, bgParsed) >= 4.5) {
          const tag = (el.tagName || '').toLowerCase();
          const weight =
            tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'label' ? 2 : 1;
          candidates.push({ c, weight, len: sample.length });
        }
      }
      if (candidates.length) {
        const darkBg = relativeLuminance(bgParsed) < 0.5;
        candidates.sort((a, b) => {
          if (b.weight !== a.weight) return b.weight - a.weight;
          return darkBg
            ? relativeLuminance(b.c) - relativeLuminance(a.c)
            : relativeLuminance(a.c) - relativeLuminance(b.c);
        });
        return toCss(candidates[0].c);
      }
    } catch (_) {
      // ignore
    }

    return readableFallbackText(bgParsed);
  }

  function accentScore(color, bgParsed) {
    if (!color || color.a < 0.5) return 0;
    const sat = colorSaturation(color);
    if (sat < 0.14) return 0;
    const lum = relativeLuminance(color);
    // Avoid near-white / near-black “accents”
    if (lum > 0.92 || lum < 0.05) return 0;
    let score = sat * 2.2;
    if (bgParsed) {
      const cr = contrastRatio(color, bgParsed);
      if (cr < 1.35) score *= 0.35;
      else score += Math.min(2, cr * 0.15);
    }
    return score;
  }

  function readAccentFromUi(bgParsed) {
    const candidates = [];
    const push = (c, boost) => {
      const score = accentScore(c, bgParsed) * (boost || 1);
      if (score > 0) candidates.push({ c, score });
    };

    const fromVar = readFirstCssVar(ACCENT_CSS_VARS);
    if (fromVar) push(fromVar, 1.35);

    const meta = readMetaThemeColor();
    if (meta && !isGrayish(meta, 0.14)) push(meta, 1.2);

    const selectors = [
      'button',
      '[role="button"]',
      'a.button',
      'a.btn',
      '.btn',
      '.button',
      '[class*="btn-primary"]',
      '[class*="ButtonPrimary"]',
      'input[type="submit"]',
      'a[href]',
    ];
    try {
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        const limit = Math.min(nodes.length, 40);
        for (let i = 0; i < limit; i++) {
          const el = nodes[i];
          if (!el || isOurUiHost(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8 || !elementInViewport(r)) continue;
          const bg = readOpaqueBackgroundFrom(el);
          if (bg) push(bg, sel.includes('primary') || sel === 'button' ? 1.15 : 1);
          const fg = readColorFrom(el, 'color');
          if (fg && !isGrayish(fg, 0.18)) {
            // Link/text accents count less than filled buttons.
            push(fg, bg ? 0.55 : 0.85);
          }
        }
      }
    } catch (_) {
      // ignore
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].c;
  }

  function fallbackAccentFrom(bg, text, theme) {
    const base =
      theme === 'dark'
        ? parseCssColor(FIXED.dark.accent)
        : parseCssColor(FIXED.light.accent);
    if (!bg) return base;
    // Nudge fixed accent toward page text hue when text is somewhat saturated.
    if (text && !isGrayish(text, 0.2)) {
      return mixRgb(base, text, 0.35);
    }
    return mixRgb(base, bg, 0.15);
  }

  function readPageColors() {
    const metaTheme = readMetaThemeColor();
    let bgParsed = readPageBackgroundColor();

    // If we only have theme-color and it looks like a page background (low sat / large chrome), use it.
    if (!bgParsed && metaTheme && (isGrayish(metaTheme, 0.22) || relativeLuminance(metaTheme) < 0.2 || relativeLuminance(metaTheme) > 0.85)) {
      bgParsed = metaTheme;
    }

    const theme =
      bgParsed && relativeLuminance(bgParsed) < 0.5
        ? 'dark'
        : bgParsed
          ? 'light'
          : (() => {
              try {
                return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
              } catch (_) {
                return 'light';
              }
            })();

    const fallbackBg = theme === 'dark' ? FIXED.dark.bg : FIXED.light.bg;
    const bgCss = bgParsed ? toCss(bgParsed) : fallbackBg;
    const bgForContrast =
      normalizeCssColor(bgCss, 'backgroundColor') ||
      parseCssColor(bgCss) ||
      parseCssColor(fallbackBg);

    const textCss = ensureReadableText(bgCss, readPageTextColor(bgCss));
    const textParsed =
      normalizeCssColor(textCss, 'color') ||
      parseCssColor(textCss);

    let accentParsed = readAccentFromUi(bgForContrast);
    if (!accentParsed && metaTheme && !isGrayish(metaTheme, 0.14)) {
      // Use theme-color as accent when it's a brand color (not a near-bg chrome color).
      const metaVsBg = bgForContrast ? contrastRatio(metaTheme, bgForContrast) : 1;
      if (metaVsBg >= 1.25 || colorSaturation(metaTheme) >= 0.25) {
        accentParsed = metaTheme;
      }
    }
    if (!accentParsed) {
      accentParsed = fallbackAccentFrom(bgForContrast, textParsed, theme);
    }

    return {
      bg: bgCss,
      text: textCss,
      accent: toCss(accentParsed),
      theme,
    };
  }

  function readableOn(bgCss) {
    const bg =
      normalizeCssColor(bgCss, 'backgroundColor') ||
      normalizeCssColor(bgCss, 'color') ||
      parseCssColor(bgCss);
    return readableFallbackText(bg);
  }

  function derivePalette(pageColors) {
    const bgCss = pageColors.bg;
    const textCss = ensureReadableText(bgCss, pageColors.text);
    const bg =
      normalizeCssColor(bgCss, 'backgroundColor') ||
      parseCssColor(bgCss) ||
      parseCssColor(FIXED.light.bg);
    const text =
      normalizeCssColor(textCss, 'color') ||
      parseCssColor(textCss) ||
      parseCssColor(readableFallbackText(bg));
    const theme = pageColors.theme || (relativeLuminance(bg) < 0.5 ? 'dark' : 'light');
    const surface = bgCss;
    const surface2 = toCss(mixRgb(bg, text, 0.08));
    const muted = toCss(deriveMutedColor(text, bg, theme));
    const line = toCss(mixRgb(text, bg, 0.16));

    let accentParsed =
      parseColorValue(pageColors.accent, 'color') ||
      fallbackAccentFrom(bg, text, theme);
    // If accent is too close to bg, push it toward a fixed brand hue.
    if (contrastRatio(accentParsed, bg) < 1.35) {
      accentParsed = mixRgb(
        accentParsed,
        theme === 'dark' ? parseCssColor(FIXED.dark.accent) : parseCssColor(FIXED.light.accent),
        0.55
      );
    }
    const accentCss = toCss(accentParsed);
    const accent2 = toCss(mixRgb(accentParsed, bg, 0.22));
    const btnText = readableOn(accentCss);

    return {
      bg: bgCss,
      text: textCss,
      surface,
      surface2,
      muted,
      line,
      accent: accentCss,
      accent2,
      btnText,
      theme,
    };
  }

  function resolveThemeMode(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'dark';
    }
  }

  function fixedPalette(resolved, accent, useAccent) {
    const base = { ...(FIXED[resolved] || FIXED.dark) };
    if (useAccent) {
      const map = resolved === 'dark' ? DARK_ACCENTS : ACCENTS;
      const pair = (map && map[accent]) || map.blue;
      base.accent = pair[0];
      base.accent2 = pair[1];
    }
    return base;
  }

  function applyPaletteToElement(el, palette, map) {
    if (!el || !palette) return;
    const vars = map || {
      bg: '--bg',
      surface: '--surface',
      surface2: '--surface-2',
      text: '--text',
      muted: '--muted',
      line: '--line',
      accent: '--accent',
      accent2: '--accent-2',
      btnText: '--btnText',
    };
    Object.entries(vars).forEach(([key, cssVar]) => {
      if (palette[key] != null) el.style.setProperty(cssVar, palette[key]);
    });
  }

  function applyThemeToHost(host, mode, accent, varMap) {
    if (!host) return 'dark';
    host.setAttribute('data-theme-mode', mode || 'system');
    if (mode === 'page') {
      const palette = derivePalette(readPageColors());
      applyPaletteToElement(host, palette, varMap);
      host.setAttribute('data-theme', palette.theme);
      return palette.theme;
    }
    const resolved = mode === 'light' || mode === 'dark' ? mode : resolveThemeMode(mode);
    const useAccent = mode === 'light' || mode === 'dark';
    applyPaletteToElement(host, fixedPalette(resolved, accent, useAccent), varMap);
    host.setAttribute('data-theme', resolved);
    return resolved;
  }

  function clearCustomThemeVars(root) {
    if (!root) return;
    THEME_CSS_VARS.forEach((v) => root.style.removeProperty(v));
  }

  function setResolvedThemeOnRoot(root, resolved, mode, accent, colors) {
    if (!root) return;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-mode', mode || 'system');
    const useAccent = mode === 'light' || mode === 'dark';
    if (useAccent) {
      root.setAttribute('data-accent', accent || 'blue');
      clearCustomThemeVars(root);
      return;
    }
    root.removeAttribute('data-accent');
    if (mode === 'page' && colors) {
      applyPaletteToElement(root, colors);
      return;
    }
    if (mode === 'system') {
      applyPaletteToElement(root, fixedPalette(resolved, 'blue', false));
      return;
    }
    clearCustomThemeVars(root);
  }

  function findThemeSourceTab(cb) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs && tabs[0];
        if (active && active.id != null && active.url && /^https?:/i.test(active.url)) {
          cb(active);
          return;
        }
        chrome.tabs.query({ currentWindow: true, url: ['http://*/*', 'https://*/*'] }, (webTabs) => {
          if (chrome.runtime.lastError) {
            cb(null);
            return;
          }
          const list = webTabs || [];
          const picked = list.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
          cb(picked || null);
        });
      });
    } catch (_) {
      cb(null);
    }
  }

  function readStoredTheme(cb) {
    try {
      chrome.storage.local.get([THEME_MODE_KEY, THEME_ACCENT_KEY], (cfg) => {
        cb(cfg?.[THEME_MODE_KEY] || 'system', cfg?.[THEME_ACCENT_KEY] || 'blue');
      });
    } catch (_) {
      cb('system', 'blue');
    }
  }

  function applyUiThemeToDocument(mode, accent) {
    const root = document.documentElement;
    const useAccent = mode === 'light' || mode === 'dark';
    const effectiveAccent = useAccent ? accent || 'blue' : 'blue';
    const systemFallback = () => {
      const resolved = resolveThemeMode('system');
      setResolvedThemeOnRoot(root, resolved, 'page', null, fixedPalette(resolved, 'blue', false));
    };

    if (mode === 'page') {
      findThemeSourceTab((tab) => {
        if (!tab || tab.id == null) {
          systemFallback();
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_THEME' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.theme) {
            systemFallback();
            return;
          }
          setResolvedThemeOnRoot(
            root,
            res.theme === 'dark' ? 'dark' : 'light',
            'page',
            null,
            res.colors || null
          );
        });
      });
      return;
    }
    setResolvedThemeOnRoot(root, resolveThemeMode(mode), mode || 'system', effectiveAccent, null);
  }

  function applyStoredThemeToElement(el, cb) {
    if (!el) {
      if (cb) cb();
      return;
    }
    readStoredTheme((mode, accent) => {
      if (mode === 'page') {
        // Already on a web page (FAB / content script): sample locally — don't ping tabs.
        try {
          if (/^https?:$/i.test(String(location.protocol || ''))) {
            const colors = getCurrentPagePalette();
            if (colors && colors.bg) {
              el.setAttribute('data-theme-mode', 'page');
              el.setAttribute('data-theme', colors.theme === 'dark' ? 'dark' : 'light');
              applyPaletteToElement(el, colors);
              if (cb) cb();
              return;
            }
          }
        } catch (_) {
          // fall through
        }
        findThemeSourceTab((tab) => {
          if (!tab || tab.id == null) {
            applyThemeToHost(el, 'system', accent);
            if (cb) cb();
            return;
          }
          chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_THEME' }, (res) => {
            if (res && res.colors) {
              el.setAttribute('data-theme-mode', 'page');
              el.setAttribute('data-theme', res.theme === 'dark' ? 'dark' : 'light');
              applyPaletteToElement(el, res.colors);
            } else {
              applyThemeToHost(el, mode, accent);
            }
            if (cb) cb();
          });
        });
        return;
      }
      applyThemeToHost(el, mode, accent);
      if (cb) cb();
    });
  }

  function initExtensionPageTheme() {
    readStoredTheme((mode, accent) => applyUiThemeToDocument(mode, accent));
    if (global.__hgrExtensionThemeInited) return;
    global.__hgrExtensionThemeInited = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || (!changes[THEME_MODE_KEY] && !changes[THEME_ACCENT_KEY])) return;
        readStoredTheme((mode, accent) => {
          applyUiThemeToDocument(mode, accent);
          if (mode !== 'page') refreshLiveOverlaysFromRoot();
        });
      });
    } catch (_) {
      // ignore
    }
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        readStoredTheme((mode, accent) => {
          if ((mode || 'system') === 'system') applyUiThemeToDocument('system', accent);
        });
      });
    } catch (_) {
      // ignore
    }
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'PAGE_THEME_CHANGED') return;
        readStoredTheme((mode) => {
          if (mode !== 'page') return;
          setResolvedThemeOnRoot(
            document.documentElement,
            msg.theme === 'dark' ? 'dark' : 'light',
            'page',
            null,
            msg.colors || null
          );
          updateAllLiveOverlays(msg.colors || null);
        });
      });
    } catch (_) {
      // ignore
    }
  }

  let _pickerStylesReady = false;
  function ensurePickerStyles() {
    if (_pickerStylesReady || document.getElementById('hgr-picker-theme-css')) {
      _pickerStylesReady = true;
      return;
    }
    try {
      const link = document.createElement('link');
      link.id = 'hgr-picker-theme-css';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('style/modal-theme.css');
      document.head.appendChild(link);
      _pickerStylesReady = true;
    } catch (_) {
      _pickerStylesReady = true;
    }
  }

  /**
   * Shared choice sheet — same modal chrome as ffmpeg / quality dialogs.
   * @param {{
   *   title: string,
   *   subtitle?: string,
   *   choices: Array<{ id: string, label: string, primary?: boolean }>,
   *   cancelLabel?: string,
   *   mount?: ParentNode | null,
   * }} opts
   * @param {(id: string | null) => void} callback — null = canceled
   */
  function showChoicePicker(opts, callback) {
    ensurePickerStyles();
    const title = (opts && opts.title) || 'Choose';
    const subtitle = (opts && opts.subtitle) || '';
    const choices = (opts && opts.choices) || [];
    const cancelLabel = (opts && opts.cancelLabel) || 'Cancel';
    const mount = (opts && opts.mount) || document.documentElement || document.body;
    const overlay = document.createElement('div');
    // Use the same classes as ffmpeg-preset dialogs so theme tokens / CSS match.
    overlay.className = 'hgr-modal-overlay';
    let offLive = () => {};
    let settled = false;
    applyStoredThemeToElement(overlay, () => {
      offLive = bindLiveOverlayTheme(overlay);
      const box = document.createElement('div');
      box.className = 'hgr-modal-box';
      const h = document.createElement('div');
      h.className = 'hgr-modal-title';
      h.textContent = title;
      const sub = document.createElement('div');
      sub.className = 'hgr-modal-sub';
      if (subtitle) sub.textContent = subtitle;
      else sub.hidden = true;
      const form = document.createElement('div');
      form.className = 'hgr-modal-actions';
      const finish = (id) => {
        if (settled) return;
        settled = true;
        offLive();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        callback(id);
      };
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c.primary ? 'hgr-modal-btn-primary' : 'hgr-modal-btn-secondary';
        b.textContent = c.label;
        b.addEventListener('click', () => finish(c.id));
        form.appendChild(b);
      }
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'hgr-modal-btn-ghost';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', () => finish(null));
      form.appendChild(cancel);
      box.appendChild(h);
      box.appendChild(sub);
      box.appendChild(form);
      overlay.appendChild(box);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) finish(null);
      });
      mount.appendChild(overlay);
    });
  }

  /** @param {(row: object | null | undefined) => void} callback */
  function showYtdlpFormatPicker(title, rows, callback) {
    const choices = [
      { id: '__best__', label: 'Best available (auto merge)', primary: true },
      ...((rows || []).map((r, i) => ({
        id: `row:${i}`,
        label: r.label || r.format_id || `Format ${i + 1}`,
      }))),
    ];
    showChoicePicker(
      {
        title: 'Choose quality',
        subtitle: (title && title.trim()) || 'Several formats are available.',
        choices,
        cancelLabel: 'Cancel',
      },
      (id) => {
        if (id == null) {
          callback(undefined);
          return;
        }
        if (id === '__best__') {
          callback(null);
          return;
        }
        const m = /^row:(\d+)$/.exec(id);
        const idx = m ? parseInt(m[1], 10) : -1;
        callback(rows && rows[idx] != null ? rows[idx] : null);
      }
    );
  }

  /**
   * Get-all page links: include thumbnails for the whole batch?
   * @param {number} count
   * @param {(choice: boolean | null) => void} callback — true / false / null(cancel)
   * @param {ParentNode | null} [mount]
   */
  function showBatchThumbnailPrompt(count, callback, mount) {
    const n = Math.max(0, Number(count) || 0);
    showChoicePicker(
      {
        title: `Queue ${n} page link${n === 1 ? '' : 's'}?`,
        subtitle:
          'Include thumbnails for all of them? This choice applies to every download in this batch.',
        choices: [
          { id: 'yes', label: 'Yes, with thumbnails', primary: true },
          { id: 'no', label: 'No, videos only' },
        ],
        cancelLabel: 'Cancel',
        mount: mount || document.body,
      },
      (id) => {
        if (id === 'yes') callback(true);
        else if (id === 'no') callback(false);
        else callback(null);
      }
    );
  }

  function syncThemeFromRoot(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    let computed;
    try {
      computed = getComputedStyle(fromEl);
    } catch (_) {
      computed = null;
    }
    THEME_CSS_VARS.forEach((v) => {
      const inline = fromEl.style.getPropertyValue(v);
      const val = inline || (computed && computed.getPropertyValue(v));
      if (val && String(val).trim()) toEl.style.setProperty(v, String(val).trim());
    });
    ['data-theme', 'data-theme-mode', 'data-accent'].forEach((attr) => {
      if (fromEl.hasAttribute(attr)) toEl.setAttribute(attr, fromEl.getAttribute(attr));
      else toEl.removeAttribute(attr);
    });
  }

  let _cachedThemeMode = 'system';
  let _cachedThemeAccent = 'blue';
  let _lastPageThemeKey = '';
  let _pageThemeCheckTimer = null;
  let _pageThemePollTimer = null;
  const _pageThemeCallbacks = new Set();

  function refreshCachedTheme(cb) {
    readStoredTheme((mode, accent) => {
      _cachedThemeMode = mode || 'system';
      _cachedThemeAccent = accent || 'blue';
      if (cb) cb(_cachedThemeMode, _cachedThemeAccent);
    });
  }

  function getCurrentPagePalette() {
    return derivePalette(readPageColors());
  }

  function pageThemeFingerprint() {
    const p = readPageColors();
    return `${p.bg}|${p.text}|${p.accent || ''}|${p.theme}`;
  }

  function notifyPageThemeChange(force) {
    if (_cachedThemeMode !== 'page') return;
    const palette = getCurrentPagePalette();
    const key = `${palette.bg}|${palette.text}|${palette.accent || ''}|${palette.theme}`;
    if (!force && key === _lastPageThemeKey) return;
    _lastPageThemeKey = key;

    _pageThemeCallbacks.forEach((fn) => {
      try {
        fn(palette);
      } catch (_) {
        // ignore subscriber errors
      }
    });

    updateAllLiveOverlays(palette);

    try {
      chrome.runtime.sendMessage({
        type: 'PAGE_THEME_CHANGED',
        theme: palette.theme,
        colors: palette,
      });
    } catch (_) {
      // ignore
    }
  }

  function schedulePageThemeCheck(force) {
    if (_cachedThemeMode !== 'page') return;
    if (_pageThemeCheckTimer) clearTimeout(_pageThemeCheckTimer);
    _pageThemeCheckTimer = setTimeout(() => {
      _pageThemeCheckTimer = null;
      notifyPageThemeChange(!!force);
    }, 90);
  }

  function onPageThemeChange(cb) {
    if (typeof cb !== 'function') return () => {};
    _pageThemeCallbacks.add(cb);
    return () => _pageThemeCallbacks.delete(cb);
  }

  function initPageThemeWatcher() {
    if (global.__hgrPageThemeWatcherStarted) return;
    global.__hgrPageThemeWatcherStarted = true;

    refreshCachedTheme(() => {
      _lastPageThemeKey = pageThemeFingerprint();
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[THEME_MODE_KEY]) {
          _cachedThemeMode = changes[THEME_MODE_KEY].newValue || 'system';
          if (_cachedThemeMode === 'page') {
            _lastPageThemeKey = '';
            schedulePageThemeCheck(true);
          }
        }
        if (changes[THEME_ACCENT_KEY]) {
          _cachedThemeAccent = changes[THEME_ACCENT_KEY].newValue || 'blue';
        }
      });
    } catch (_) {
      // ignore
    }

    const attachObservers = () => {
      try {
        const obs = new MutationObserver(() => schedulePageThemeCheck(false));
        const opts = {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode', 'color-scheme'],
        };
        if (document.documentElement) obs.observe(document.documentElement, opts);
        if (document.body) obs.observe(document.body, opts);
      } catch (_) {
        // ignore
      }
    };

    if (document.body) attachObservers();
    else document.addEventListener('DOMContentLoaded', attachObservers, { once: true });

    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        schedulePageThemeCheck(true);
      });
    } catch (_) {
      // ignore
    }

    try {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) schedulePageThemeCheck(true);
      });
    } catch (_) {
      // ignore
    }

    _pageThemePollTimer = setInterval(() => {
      if (_cachedThemeMode !== 'page' || document.hidden) return;
      notifyPageThemeChange(false);
    }, 500);
  }

  function bindLiveThemeHost(host, varMap, onApplied) {
    if (!host) return () => {};

    const applyPalette = (palette) => {
      applyPaletteToElement(host, palette, varMap);
      host.setAttribute('data-theme', palette.theme);
      host.setAttribute('data-theme-mode', 'page');
      if (onApplied) onApplied(palette.theme, 'page');
    };

    let offPage = null;

    const syncPageWatch = (mode, accent) => {
      if (offPage) {
        offPage();
        offPage = null;
      }
      if (mode !== 'page') {
        const resolved = applyThemeToHost(host, mode, accent, varMap);
        if (onApplied) onApplied(resolved, mode);
        return;
      }
      const resolved = applyThemeToHost(host, 'page', accent, varMap);
      if (onApplied) onApplied(resolved, 'page');
      offPage = onPageThemeChange((palette) => applyPalette(palette));
    };

    refreshCachedTheme((mode, accent) => syncPageWatch(mode, accent));

    const onStorage = (changes, area) => {
      if (area !== 'local' || (!changes[THEME_MODE_KEY] && !changes[THEME_ACCENT_KEY])) return;
      refreshCachedTheme((mode, accent) => syncPageWatch(mode, accent));
    };

    try {
      chrome.storage.onChanged.addListener(onStorage);
    } catch (_) {
      // ignore
    }

    return () => {
      if (offPage) offPage();
      try {
        chrome.storage.onChanged.removeListener(onStorage);
      } catch (_) {
        // ignore
      }
    };
  }

  const _liveOverlays = new Set();

  function applyPagePaletteToOverlay(el, palette) {
    if (!el || !palette) return;
    applyPaletteToElement(el, palette);
    el.setAttribute('data-theme', palette.theme);
    el.setAttribute('data-theme-mode', 'page');
    el.removeAttribute('data-accent');
  }

  function refreshLiveOverlaysFromRoot() {
    _liveOverlays.forEach((el) => {
      if (!el.isConnected) {
        _liveOverlays.delete(el);
        return;
      }
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          syncThemeFromRoot(document.documentElement, el);
        }
      } catch (_) {
        // ignore
      }
    });
  }

  function updateAllLiveOverlays(palette) {
    if (!palette) return;
    _liveOverlays.forEach((el) => {
      if (!el.isConnected) {
        _liveOverlays.delete(el);
        return;
      }
      applyPagePaletteToOverlay(el, palette);
    });
  }

  /** Keep popup/modal overlays in sync when the page or extension theme changes. */
  function bindLiveOverlayTheme(overlay) {
    if (!overlay) return () => {};
    _liveOverlays.add(overlay);

    const onMsg = (msg) => {
      if (!msg || msg.type !== 'PAGE_THEME_CHANGED') return;
      readStoredTheme((mode) => {
        if (mode !== 'page' || !msg.colors) return;
        applyPagePaletteToOverlay(overlay, msg.colors);
      });
    };

    const onStorage = (changes, area) => {
      if (area !== 'local' || (!changes[THEME_MODE_KEY] && !changes[THEME_ACCENT_KEY])) return;
      readStoredTheme((mode, accent) => {
        if (mode === 'page') return;
        try {
          if (typeof location !== 'undefined' && String(location.protocol).startsWith('chrome-extension')) {
            refreshLiveOverlaysFromRoot();
            return;
          }
        } catch (_) {
          // ignore
        }
        applyThemeToHost(overlay, mode, accent);
      });
    };

    let offPage = null;
    try {
      if (typeof location !== 'undefined' && /^https?:$/i.test(String(location.protocol))) {
        offPage = onPageThemeChange((palette) => {
          readStoredTheme((mode) => {
            if (mode === 'page') applyPagePaletteToOverlay(overlay, palette);
          });
        });
      }
    } catch (_) {
      // ignore
    }

    try {
      chrome.runtime.onMessage.addListener(onMsg);
    } catch (_) {
      // ignore
    }
    try {
      chrome.storage.onChanged.addListener(onStorage);
    } catch (_) {
      // ignore
    }

    return () => {
      _liveOverlays.delete(overlay);
      if (offPage) offPage();
      try {
        chrome.runtime.onMessage.removeListener(onMsg);
      } catch (_) {
        // ignore
      }
      try {
        chrome.storage.onChanged.removeListener(onStorage);
      } catch (_) {
        // ignore
      }
    };
  }

  if (!global.__hgrThemeMessageListener) {
    global.__hgrThemeMessageListener = true;
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'GET_PAGE_THEME') return;
        const page = readPageColors();
        const colors = derivePalette(page);
        sendResponse({ theme: colors.theme, colors });
        return true;
      });
    } catch (_) {
      // ignore outside extension context
    }
  }

  global.HGR_THEME = {
    THEME_MODE_KEY,
    THEME_ACCENT_KEY,
    readPageColors,
    derivePalette,
    getCurrentPagePalette,
    resolveThemeMode,
    fixedPalette,
    applyPaletteToElement,
    applyThemeToHost,
    applyUiThemeToDocument,
    applyStoredThemeToElement,
    initExtensionPageTheme,
    initPageThemeWatcher,
    onPageThemeChange,
    bindLiveThemeHost,
    bindLiveOverlayTheme,
    showChoicePicker,
    showYtdlpFormatPicker,
    showBatchThumbnailPrompt,
    syncThemeFromRoot,
    ACCENTS,
  };

  try {
    if (global.location && /^https?:$/i.test(String(global.location.protocol))) {
      initPageThemeWatcher();
    }
  } catch (_) {
    // ignore
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
