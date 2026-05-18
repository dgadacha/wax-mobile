import { defineStore } from 'pinia';
import { THEMES, DEFAULT_THEME_ID, THEME_IDS, themeById } from '@/lib/themes';
import { setLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n';

const PREFS_KEY = 'ytmp3:prefs';
const LOCALE_IDS = SUPPORTED_LOCALES.map((l) => l.id);

// User-pickable accent palette. Each entry drives every `--accent*` CSS var
// once `applyAccent(hex)` runs. Mobile shell picks from this in Settings.
export const ACCENT_SWATCHES = [
  { id: 'violet',  label: 'Violet',  hex: '#7c5cff' },
  { id: 'sky',     label: 'Ciel',    hex: '#3aa8ff' },
  { id: 'emerald', label: 'Émeraude', hex: '#36c997' },
  { id: 'amber',   label: 'Ambre',   hex: '#ffb547' },
  { id: 'rose',    label: 'Rose',    hex: '#ff5e8a' },
  { id: 'crimson', label: 'Cramoisi', hex: '#ff4660' },
  { id: 'lime',    label: 'Citron',  hex: '#b5dd2e' },
  { id: 'pearl',   label: 'Perle',   hex: '#e7e7e9' },
];

const DEFAULT_ACCENT = ACCENT_SWATCHES[0].hex;

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function applyAccent(hex) {
  const hsl = hexToHsl(hex);
  if (!hsl) return;
  const root = document.documentElement.style;
  const base = `hsl(${hsl.h.toFixed(0)}, ${Math.max(40, hsl.s).toFixed(0)}%, ${Math.min(70, Math.max(50, hsl.l)).toFixed(0)}%)`;
  const bright = `hsl(${hsl.h.toFixed(0)}, ${Math.min(100, hsl.s + 10).toFixed(0)}%, ${Math.min(80, hsl.l + 10).toFixed(0)}%)`;
  const dark = `hsl(${hsl.h.toFixed(0)}, ${hsl.s.toFixed(0)}%, ${Math.max(28, hsl.l - 15).toFixed(0)}%)`;
  const soft = `hsla(${hsl.h.toFixed(0)}, ${hsl.s.toFixed(0)}%, ${hsl.l.toFixed(0)}%, 0.18)`;
  const glow = `hsla(${hsl.h.toFixed(0)}, ${hsl.s.toFixed(0)}%, ${hsl.l.toFixed(0)}%, 0.4)`;
  root.setProperty('--accent', base);
  root.setProperty('--accent-bright', bright);
  root.setProperty('--accent-dark', dark);
  root.setProperty('--accent-soft', soft);
  root.setProperty('--accent-glow', glow);
}

export const usePrefsStore = defineStore('prefs', {
  state: () => ({
    volume: 0.8,
    crossfadeEnabled: false,
    crossfadeDuration: 3,
    themeId: DEFAULT_THEME_ID,
    locale: DEFAULT_LOCALE,
    eq: { bass: 0, mid: 0, treble: 0 },
    sidebarExpanded: false,
    accentColor: DEFAULT_ACCENT,
  }),
  actions: {
    load() {
      try {
        const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        if (typeof p.volume === 'number') this.volume = p.volume;
        if (typeof p.crossfadeEnabled === 'boolean') this.crossfadeEnabled = p.crossfadeEnabled;
        if (typeof p.crossfadeDuration === 'number' && p.crossfadeDuration >= 1 && p.crossfadeDuration <= 12) {
          this.crossfadeDuration = p.crossfadeDuration;
        }
        if (p.locale && LOCALE_IDS.includes(p.locale)) {
          this.locale = p.locale;
        }
        if (p.themeId && THEME_IDS.includes(p.themeId)) {
          this.themeId = p.themeId;
        } else if (p.theme === 'light') {
          // Legacy `theme: 'light'` string from a very-old install —
          // map onto the current Dawn default. Any saved themeId that
          // was removed (cream, sable, peche, lavende, ardoise, vinyle,
          // studio, dracula, nord, tokyo-night, rose-pine, gruvbox,
          // neon) just falls through and the store keeps its initial
          // DEFAULT_THEME_ID (also dawn).
          this.themeId = 'dawn';
        } else if (p.theme === 'dark') {
          this.themeId = 'dark';
        }
        if (p.eq && typeof p.eq === 'object') this.eq = { ...this.eq, ...p.eq };
        if (typeof p.sidebarExpanded === 'boolean') this.sidebarExpanded = p.sidebarExpanded;
        if (typeof p.accentColor === 'string' && /^#?[0-9a-f]{6}$/i.test(p.accentColor)) {
          this.accentColor = p.accentColor;
        }
      } catch {}
      this.applyTheme();
      applyAccent(this.accentColor);
      setLocale(this.locale);
    },
    save() {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
          volume: this.volume,
          crossfadeEnabled: this.crossfadeEnabled,
          crossfadeDuration: this.crossfadeDuration,
          themeId: this.themeId,
          locale: this.locale,
          eq: this.eq,
          sidebarExpanded: this.sidebarExpanded,
          accentColor: this.accentColor,
        }));
      } catch {}
    },
    applyTheme() {
      const t = themeById(this.themeId) || themeById(DEFAULT_THEME_ID);
      const root = document.documentElement;
      // Strip every previous theme-* class so switching is clean.
      for (const cls of [...root.classList]) {
        if (cls.startsWith('theme-')) root.classList.remove(cls);
      }
      root.classList.remove('light');
      root.classList.add(`theme-${t.id}`);
      if (t.kind === 'light') root.classList.add('light');
    },
    setTheme(id) {
      if (!THEME_IDS.includes(id)) return;
      this.themeId = id;
      this.applyTheme();
      this.save();
      // Re-apply accent so --accent-bg picks up the new theme kind. Avoid a
      // direct import (would create a circular dep with accent.js → prefs).
      window.dispatchEvent(new Event('wax:theme-changed'));
    },
    toggleSidebar() {
      this.sidebarExpanded = !this.sidebarExpanded;
      this.save();
    },
    setLocale(loc) {
      if (!LOCALE_IDS.includes(loc)) return;
      this.locale = loc;
      setLocale(loc);
      this.save();
    },
    setAccentColor(hex) {
      if (!/^#?[0-9a-f]{6}$/i.test(hex)) return;
      this.accentColor = hex;
      applyAccent(hex);
      this.save();
    },
  },
});

// Re-export so existing imports `import { THEMES } from '@/stores/prefs'`
// (if any appear later) keep working alongside `@/lib/themes`.
export { THEMES };
