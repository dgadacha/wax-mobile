// Ambiances ("moods") assignées par l'IA à chaque titre (cf. /api/ai/tag-library).
// Les CLÉS doivent rester synchronisées avec AI_MOODS dans server.cjs (CJS, pas
// d'import ES possible) — c'est le seul couplage à garder à l'œil.
export const MOODS = [
  { key: 'chill', label: 'Chill' },
  { key: 'energie', label: 'Énergie' },
  { key: 'fete', label: 'Fête' },
  { key: 'focus', label: 'Focus' },
  { key: 'triste', label: 'Mélancolie' },
  { key: 'romance', label: 'Romance' },
  { key: 'sombre', label: 'Sombre' },
];

export const MOOD_LABEL = Object.fromEntries(MOODS.map((m) => [m.key, m.label]));
