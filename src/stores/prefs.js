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

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Blend two hex colors. `mix=0` returns `a`, `mix=1` returns `b`. Used by
// applyTheme to derive --card-hover / --bg-elev / --border from a theme's
// two-color swatch instead of carrying a full per-theme palette.
function mixHex(a, b, mix) {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const m = Math.max(0, Math.min(1, mix));
  const r = Math.round(ra.r + (rb.r - ra.r) * m);
  const g = Math.round(ra.g + (rb.g - ra.g) * m);
  const bl = Math.round(ra.b + (rb.b - ra.b) * m);
  return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('');
}

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

// Apply the user's saved accent. Called when playback stops so the
// track-derived adaptive accent (set by extractDominantColor in the
// player) reverts to whatever the user picked in Settings.
export function revertAccentToUser() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    applyAccent(p.accentColor || DEFAULT_ACCENT);
  } catch {
    applyAccent(DEFAULT_ACCENT);
  }
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
    // MP3 download bitrate sent with every POST /api/library/:id/download.
    // 320 is iTunes-quality default; 128 / 192 lower the storage cost
    // for users with limited offline-cache room or capped data plans.
    downloadQuality: '320', // '128' | '192' | '320'
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
        // One-time migration: the legacy desktop fork defaulted to 'en'.
        // Mobile users expect French unless they switched explicitly. If
        // the stored locale is 'en' and the migration flag is missing,
        // switch to 'fr' once and stamp the flag so subsequent loads
        // honour an explicit en choice. To re-pick en post-migration,
        // use Settings → language (TODO).
        if (this.locale === 'en' && !p.mobileLocaleMigrated) {
          this.locale = 'fr';
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
        if (['128', '192', '320'].includes(p.downloadQuality)) {
          this.downloadQuality = p.downloadQuality;
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
          downloadQuality: this.downloadQuality,
          mobileLocaleMigrated: true,
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

      // Mobile doesn't import the desktop's giant style.css that contains
      // the per-theme palettes — push the swatch values into our CSS
      // variables directly. swatch[0] = bg, swatch[1] = card; we derive
      // the rest. Accent stays under the user's accent-picker control.
      const [bg, card] = t.swatch;
      const s = root.style;
      s.setProperty('--bg', bg);
      s.setProperty('--main', bg);
      s.setProperty('--card', card);
      s.setProperty('--card-hover', mixHex(card, t.kind === 'light' ? bg : '#ffffff', 0.06));
      s.setProperty('--bg-elev', mixHex(bg, card, 0.5));
      s.setProperty('--border', mixHex(card, t.kind === 'light' ? '#000000' : '#ffffff', 0.08));
      if (t.kind === 'light') {
        s.setProperty('--text', '#15161c');
        s.setProperty('--text-soft', '#3c3e48');
        s.setProperty('--text-muted', '#7a7d88');
      } else {
        s.setProperty('--text', '#f3f4f6');
        s.setProperty('--text-soft', '#c8ccd6');
        s.setProperty('--text-muted', '#7d8595');
      }

      // Drive iOS Safari's status-bar tint + Android Chrome's system UI
      // color via the <meta name="theme-color"> tag. Without this, the
      // status-bar zone keeps the static theme-color from index.html
      // (#0d0f14, dark) — looks fine on dark themes but creates a black
      // strip above the page when the user switches to a light theme.
      let themeMeta = document.querySelector('meta[name="theme-color"]');
      if (!themeMeta) {
        themeMeta = document.createElement('meta');
        themeMeta.name = 'theme-color';
        document.head.appendChild(themeMeta);
      }
      themeMeta.content = bg;
      // Apple's apple-mobile-web-app-status-bar-style also flips dark/
      // light icons. `default` = dark icons (best on light bg),
      // `black-translucent` = white icons (best on dark bg). Updated at
      // theme switch even though Safari only reads it on PWA INSTALL
      // — at least new installs get the right one. Existing PWAs need
      // to be re-added to the Home Screen for the icon color to change.
      let appleStatus = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (!appleStatus) {
        appleStatus = document.createElement('meta');
        appleStatus.name = 'apple-mobile-web-app-status-bar-style';
        document.head.appendChild(appleStatus);
      }
      appleStatus.content = t.kind === 'light' ? 'default' : 'black-translucent';

      // Make sure html + body bg fill iOS safe-area zones (status-bar +
      // home-indicator). Without these explicit settings, the safe-area
      // zones show iOS's default white in PWA standalone mode.
      document.documentElement.style.backgroundColor = bg;
      document.body.style.backgroundColor = bg;
    },
    setTheme(id) {
      if (!THEME_IDS.includes(id)) return;
      this.themeId = id;
      this.applyTheme();
      // Each theme carries a canonical accent in swatch[2]. Push it
      // through the accent picker so the chosen color follows the
      // theme — user can still override afterwards by tapping a swatch.
      const t = themeById(id);
      if (t && t.swatch[2]) this.setAccentColor(t.swatch[2]);
      // Belt + suspenders: explicit save in case setAccentColor
      // short-circuits on a malformed hex, or some future refactor
      // breaks that chain. The chosen themeId persists regardless.
      this.save();
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
