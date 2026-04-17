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

  const quant = ImageTracer.colorquantization(imgd, {
    numberofcolors: numColors + 1,
    colorsampling: 2,
    colorquantcycles: 3,
    mincolorratio: 0.0005,
    blurradius: 5,
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

  return {
    width,
    height,
    palette: trimmed.map((e) => e.pal),
    masks: trimmed.map((e) => e.mask),
  };
}

/** Bitwise-OR two masks of the same length into a new mask. */
export function orMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}
