// Dominant color extraction from a cover image. Used by the player
// to drive the per-track accent — when a new track loads, we pull
// the most vibrant color from its cover and feed it into the same
// --accent CSS variables the theme picker uses. Reverts to theme
// accent on stop / track-less state.
//
// Approach: downsample the image to 40x40 via canvas (40^2 = 1600
// pixels is plenty for a histogram of dominant colors), bucket by
// hue in 30° slices + a saturated/desaturated split, pick the
// bucket with the highest population that ALSO has decent
// saturation (>30%). Skips greyscale buckets so a dark album cover
// doesn't reduce the UI to grey.
//
// CORS: the cover endpoint already sends Access-Control-Allow-Origin
// permissively, so crossOrigin='anonymous' on the <img> lets us
// readPixels without the canvas being tainted.

const SIZE = 40;
let cachedCanvas = null;
function getCanvas() {
  if (cachedCanvas) return cachedCanvas;
  cachedCanvas = document.createElement('canvas');
  cachedCanvas.width = SIZE;
  cachedCanvas.height = SIZE;
  return cachedCanvas;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
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
  return { h, s, l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/**
 * @param {string} url cover image URL (same-origin or CORS-enabled)
 * @returns {Promise<string|null>} dominant hex (#RRGGBB) or null on failure
 */
export function extractDominantColor(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = getCanvas();
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
        // 12 hue buckets × 3 lightness bands. Each cell collects
        // population + a saturation-weighted sum so we can pick the
        // most-vibrant within the most-populated bucket.
        const buckets = new Map(); // key → { count, hSum, sSum, lSum }
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 200) continue; // skip transparent
          const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          // Skip near-greyscale (would make UI look washed out)
          if (s < 0.18) continue;
          // Skip very dark / very bright (no useful chroma)
          if (l < 0.15 || l > 0.85) continue;
          const hueBucket = Math.floor(h / 30); // 12 buckets
          const lightBand = l < 0.4 ? 0 : l < 0.65 ? 1 : 2;
          const key = `${hueBucket}|${lightBand}`;
          const cur = buckets.get(key) || { count: 0, hSum: 0, sSum: 0, lSum: 0 };
          cur.count += 1;
          cur.hSum += h;
          cur.sSum += s;
          cur.lSum += l;
          buckets.set(key, cur);
        }
        if (buckets.size === 0) return resolve(null);
        // Pick the bucket with the highest count × average saturation —
        // favours both prevalence AND vibrancy.
        let best = null;
        let bestScore = 0;
        for (const cell of buckets.values()) {
          const avgS = cell.sSum / cell.count;
          const score = cell.count * avgS;
          if (score > bestScore) { bestScore = score; best = cell; }
        }
        if (!best) return resolve(null);
        const h = best.hSum / best.count;
        const s = Math.min(0.85, Math.max(0.55, best.sSum / best.count)); // boost a touch
        const l = Math.min(0.65, Math.max(0.5, best.lSum / best.count));  // target midtone for UI
        resolve(hslToHex(h, s, l));
      } catch (e) {
        // Canvas tainted (CORS) or any other read failure
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
