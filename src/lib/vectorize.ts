import ImageTracer from "imagetracerjs";

export type VectorPaletteEntry = {
  hex: string;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
};

export type VectorizeResult = {
  width: number;
  height: number;
  palette: VectorPaletteEntry[];
  masks: Uint8Array[]; // one mask per palette entry, same order as palette
};

const BG_THRESHOLD = 240;

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * K-means++ seeding on 6-bits-per-channel bucketed candidates. The first seed
 * is the most common bucket; each next seed is the candidate that maximizes
 * (min-distance-to-existing-seeds × pixelCount). This keeps distinct colors
 * with non-trivial area — in particular thin bright elements like a shield
 * outline — from losing their slot to yet another shade of the dominant dark
 * background.
 */
function kmeansPPSeed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  numColors: number,
): { r: number; g: number; b: number; a: number }[] {
  type Bucket = { r: number; g: number; b: number; count: number };
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    const a = data[off + 3];
    if (a < 32) continue;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    if (r >= BG_THRESHOLD && g >= BG_THRESHOLD && b >= BG_THRESHOLD) continue;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const existing = buckets.get(key);
    if (existing) {
      existing.r += r;
      existing.g += g;
      existing.b += b;
      existing.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }

  // Keep any bucket with at least ~10 pixels so small-but-distinct regions
  // (e.g. a thin shield outline) still enter the k-means++ candidate pool.
  // Capping at top-N would drop them — the top ranks are all noise variants
  // of whatever dominates the image.
  const minBucketCount = Math.max(8, Math.floor((width * height) * 0.00005));
  const candidates: Bucket[] = Array.from(buckets.values())
    .filter((c) => c.count >= minBucketCount)
    .map((c) => ({
      r: Math.round(c.r / c.count),
      g: Math.round(c.g / c.count),
      b: Math.round(c.b / c.count),
      count: c.count,
    }))
    .sort((a, b) => b.count - a.count);

  if (candidates.length === 0) return [{ r: 0, g: 0, b: 0, a: 255 }];

  const seeds: Bucket[] = [{ ...candidates[0] }];
  while (seeds.length < numColors && seeds.length < candidates.length) {
    let bestI = -1;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      let minDist = Infinity;
      for (const s of seeds) {
        const dr = candidates[i].r - s.r;
        const dg = candidates[i].g - s.g;
        const db = candidates[i].b - s.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < minDist) minDist = d;
      }
      const score = minDist * candidates[i].count;
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    seeds.push({ ...candidates[bestI] });
  }

  return seeds.map((s) => ({ r: s.r, g: s.g, b: s.b, a: 255 }));
}

/** 3×3 binary dilation: output pixel is 1 if any 3×3 neighbor is 1. */
function dilate3(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) {
        out[i] = 1;
        continue;
      }
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            hit = 1;
            break;
          }
        }
      }
      out[i] = hit;
    }
  }
  return out;
}

/** 3×3 binary erosion: output pixel is 1 only if all 3×3 neighbors are 1. */
function erode3(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let allOne = 1;
      for (let dy = -1; dy <= 1 && allOne; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          allOne = 0;
          break;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            allOne = 0;
            break;
          }
          if (!mask[ny * width + nx]) {
            allOne = 0;
            break;
          }
        }
      }
      out[i] = allOne;
    }
  }
  return out;
}

/** Two passes of morphological close (dilate→erode) — rounds pixel-level
 *  jaggies and fills small gaps. One pass is often too subtle to see at the
 *  rendered preview scale; two passes double the smoothing radius while still
 *  preserving region area since dilate and erode cancel each other. */
function smoothMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const once = erode3(dilate3(mask, width, height), width, height);
  return erode3(dilate3(once, width, height), width, height);
}

/**
 * Quantize a raster image into N distinct-color regions using imagetracerjs's
 * color quantization (k-means with selective Gaussian blur preprocessing,
 * which strips anti-aliasing gradients at region edges). Returns the palette
 * plus a per-color binary mask.
 *
 * Asks the tracer for numColors+1 palette slots and discards the near-white
 * slot as background; final output contains up to numColors non-background
 * colors. Trims to numColors sorted by pixel count.
 */
export function vectorize(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  numColors: number,
): VectorizeResult {
  const imgd = { data, width, height };

  const seedPalette = kmeansPPSeed(data, width, height, numColors);

  // colorquantcycles: 1 — use our k-means++ seeds as the final palette
  // without Lloyd refinement. imagetracerjs's refinement can randomize
  // low-count clusters via mincolorratio, which kills a small but distinct
  // region (e.g. a thin shield outline).
  const quant = ImageTracer.colorquantization(imgd, {
    pal: seedPalette,
    colorquantcycles: 1,
    mincolorratio: 0,
    blurradius: 3,
    blurdelta: 20,
  });

  const rawPalette = quant.palette;
  const slotCount = rawPalette.length;
  const rawMasks: Uint8Array[] = Array.from(
    { length: slotCount },
    () => new Uint8Array(width * height),
  );
  const pixelCounts = new Array<number>(slotCount).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = quant.array[y + 1][x + 1];
      if (idx < 0 || idx >= slotCount) continue;
      rawMasks[idx][y * width + x] = 1;
      pixelCounts[idx]++;
    }
  }

  type Entry = { pal: VectorPaletteEntry; mask: Uint8Array };
  const kept: Entry[] = [];
  for (let i = 0; i < slotCount; i++) {
    const c = rawPalette[i];
    if (c.a < 32) continue;
    if (c.r >= BG_THRESHOLD && c.g >= BG_THRESHOLD && c.b >= BG_THRESHOLD) continue;
    if (pixelCounts[i] === 0) continue;
    kept.push({
      pal: {
        hex: rgbToHex(c.r, c.g, c.b),
        r: c.r,
        g: c.g,
        b: c.b,
        pixelCount: pixelCounts[i],
      },
      mask: rawMasks[i],
    });
  }

  kept.sort((a, b) => b.pal.pixelCount - a.pal.pixelCount);
  const trimmed = kept.slice(0, numColors);

  const smoothed = trimmed.map((e) => ({
    pal: e.pal,
    mask: smoothMask(e.mask, width, height),
  }));

  return {
    width,
    height,
    palette: smoothed.map((e) => e.pal),
    masks: smoothed.map((e) => e.mask),
  };
}

/** Bitwise-OR two masks of the same length into a new mask. */
export function orMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}
