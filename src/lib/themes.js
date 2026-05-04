// Theme registry. Each theme is a named surface palette.
// `kind` controls which CSS-var family applies on top:
//   - 'dark'  → only the theme-<id> class is added.
//   - 'light' → both `light` AND theme-<id> are added (the `light` class
//                  carries the inverted surface tints, modal-bg, on-accent,
//                  logo-filter, etc., shared across all light themes).
//
// `labelKey` resolves through @/lib/i18n at render time so theme names follow
// the active locale. `swatch` is `[bg, card, accent]`. The accent at swatch[2]
// is the canonical accent for the theme — it drives both the picker preview
// AND the live app accent (passed through `accent.applyThemeAccent` on every
// theme switch).
export const THEMES = [
  // ---------- Dark family ----------
  { id: 'dark',        labelKey: 'theme.dark',        kind: 'dark',  swatch: ['#0d0d10', '#28282e', '#A855F7'] },
  { id: 'midnight',    labelKey: 'theme.midnight',    kind: 'dark',  swatch: ['#0a0c14', '#1f2236', '#818cf8'] },
  { id: 'mocha',       labelKey: 'theme.mocha',       kind: 'dark',  swatch: ['#150f0c', '#2a201c', '#F59E0B'] },
  { id: 'bordeaux',    labelKey: 'theme.bordeaux',    kind: 'dark',  swatch: ['#16090d', '#3d1a23', '#dc2626'] },
  { id: 'forest',      labelKey: 'theme.forest',      kind: 'dark',  swatch: ['#0d130e', '#243024', '#1DB954'] },

  // ---------- Light family ----------
  { id: 'dawn',        labelKey: 'theme.dawn',        kind: 'light', swatch: ['#f4f0fa', '#fbf9fe', '#6E5CE6'] },
  { id: 'paper',       labelKey: 'theme.paper',       kind: 'light', swatch: ['#e8e4dc', '#f7f5ef', '#6366F1'] },
  { id: 'lin',         labelKey: 'theme.lin',         kind: 'light', swatch: ['#ece5d6', '#f7f3e8', '#F59E0B'] },
  { id: 'mint',        labelKey: 'theme.mint',        kind: 'light', swatch: ['#dde9e2', '#f3f8f5', '#1DB954'] },
  { id: 'glacier',     labelKey: 'theme.glacier',     kind: 'light', swatch: ['#dde6ee', '#f3f6fa', '#06B6D4'] },
];

export const DEFAULT_THEME_ID = 'dawn';
export const THEME_IDS = THEMES.map((t) => t.id);
export const themeById = (id) => THEMES.find((t) => t.id === id) || null;
export const darkThemes = () => THEMES.filter((t) => t.kind === 'dark');
export const lightThemes = () => THEMES.filter((t) => t.kind === 'light');
