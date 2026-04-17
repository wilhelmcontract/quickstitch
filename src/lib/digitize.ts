import type { DstStitch, DstColorStop, DstParseResult } from "./dstParser";

/**
 * Quickie raster-to-stitch digitizer.
 *
 * Per color (after auto-clustering to a user-specified count and dropping
 * near-white background): build a binary mask, run Zhang-Suen thinning to get
 * a skeleton, label connected components, and classify each component by max
 * thickness (running < 1 mm, satin 1-6 mm, > 6 mm split-or-fill).
 *
 * Satin and running follow the LOCAL skeleton tangent, so curved shapes
 * (script lettering, swooshes) get stitches that follow the curve. Fill uses
 * a straight scanline. Underlay first, then top stitches, both same color.
 */

export type DetectedColor = {
  hex: string;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
};

export type ColorPlan = {
  hex: string;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
  excluded: boolean;
  density: number;
  pullCompMm: number;
  splitWideSatin: boolean;
};

export type Stitch = { x: number; y: number };
export type StitchType = "running" | "satin" | "fill";

export type RegionPlan = {
  colorIndex: number;
  stitchType: StitchType;
  underlay: Stitch[];
  topStitches: Stitch[];
};

export type DigitizeResult = {
  widthMm: number;
  heightMm: number;
  pxPerMm: number;
  regions: RegionPlan[];
  totalStitchCount: number;
  perColorStitchCount: number[];
};

const DEFAULT_BG_BRIGHTNESS = 240;
const DEFAULT_NUM_COLORS = 4;
const COLOR_CANDIDATE_MULTIPLIER = 8;

const RUN_STITCH_LEN_MM = 3.0;
const SATIN_SPACING_MM = 0.4;
const FILL_ROW_SPACING_MM = 0.4;
const FILL_STITCH_LEN_MM = 4.0;
const SATIN_LANE_WIDTH_MM = 5.0;
const SATIN_MAX_THICKNESS_MM = 6.0;
const RUNNING_MAX_THICKNESS_MM = 1.0;

const UNDERLAY_RUN_LEN_MM = 1.5;
const UNDERLAY_FILL_ROW_SPACING_MM = 2.0;
const UNDERLAY_FILL_STITCH_LEN_MM = 3.6;
const NARROW_SATIN_THRESHOLD_MM = 2.5;

const MIN_COMPONENT_PX = 8;

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function isBackground(r: number, g: number, b: number, threshold: number) {
  return r >= threshold && g >= threshold && b >= threshold;
}

type RGBSum = { r: number; g: number; b: number; count: number };

function colorDist(a: RGBSum, b: RGBSum): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Quantize the image to N dominant colors. Starts from the top
 * `N * COLOR_CANDIDATE_MULTIPLIER` 5-bit-per-channel buckets, then
 * agglomeratively merges the closest pair until N remain.
 */
export function detectColors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { numColors?: number; bgThreshold?: number } = {},
): DetectedColor[] {
  const numColors = Math.max(1, options.numColors ?? DEFAULT_NUM_COLORS);
  const bg = options.bgThreshold ?? DEFAULT_BG_BRIGHTNESS;

  const counts = new Map<number, number>();
  const sums = new Map<number, RGBSum>();

  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    const a = data[off + 3];
    if (a < 32) continue;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    if (isBackground(r, g, b, bg)) continue;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const s = sums.get(key);
    if (s) {
      s.r += r;
      s.g += g;
      s.b += b;
      s.count += 1;
    } else {
      sums.set(key, { r, g, b, count: 1 });
    }
  }

  const candidates: RGBSum[] = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, numColors * COLOR_CANDIDATE_MULTIPLIER)
    .map(([key]) => {
      const s = sums.get(key);
      if (!s) throw new Error(`detectColors: missing sum for key ${key}`);
      return {
        r: Math.round(s.r / s.count),
        g: Math.round(s.g / s.count),
        b: Math.round(s.b / s.count),
        count: s.count,
      };
    });

  if (candidates.length === 0) return [];

  // K-means++ seeding: first seed = most common bucket; each next seed is
  // the candidate with the largest (min-distance-to-existing-seeds × count),
  // so colors that are distinct AND non-trivial in area both get picked.
  // Agglomerative merging (the old approach) weighted centroids by pixel
  // count and let the dominant bucket pull nearby distinct colors into one
  // cluster — e.g. a teal background variant would get eaten by a navy
  // cluster even though they're perceptually separate.
  const centers: RGBSum[] = [{ ...candidates[0] }];
  while (centers.length < numColors && centers.length < candidates.length) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      let minDist = Infinity;
      for (const c of centers) {
        const d = colorDist(candidates[i], c);
        if (d < minDist) minDist = d;
      }
      const score = minDist * candidates[i].count;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    centers.push({ ...candidates[bestIdx] });
  }

  // Lloyd iterations — refine centers by reassigning candidates to the
  // nearest center and recomputing the weighted centroid.
  for (let iter = 0; iter < 8; iter++) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const p of candidates) {
      let minDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < centers.length; c++) {
        const d = colorDist(p, centers[c]);
        if (d < minDist) {
          minDist = d;
          bestC = c;
        }
      }
      sums[bestC].r += p.r * p.count;
      sums[bestC].g += p.g * p.count;
      sums[bestC].b += p.b * p.count;
      sums[bestC].count += p.count;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c].count > 0) {
        centers[c] = {
          r: Math.round(sums[c].r / sums[c].count),
          g: Math.round(sums[c].g / sums[c].count),
          b: Math.round(sums[c].b / sums[c].count),
          count: sums[c].count,
        };
      }
    }
  }

  return centers
    .sort((a, b) => b.count - a.count)
    .map((c) => ({
      hex: rgbToHex(c.r, c.g, c.b),
      r: c.r,
      g: c.g,
      b: c.b,
      pixelCount: c.count,
    }));
}

function buildMasks(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  colors: ColorPlan[],
  bgThreshold: number,
): Uint8Array[] {
  const masks = colors.map(() => new Uint8Array(width * height));
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    const a = data[off + 3];
    if (a < 32) continue;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    if (isBackground(r, g, b, bgThreshold)) continue;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let c = 0; c < colors.length; c++) {
      const dr = r - colors[c].r;
      const dg = g - colors[c].g;
      const db = b - colors[c].b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = c;
      }
    }
    if (bestIdx >= 0) masks[bestIdx][i] = 1;
  }
  return masks;
}

/** Two-pass connected-components labeling with union-find (4-connectivity). */
function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { pixelsByLabel: number[][] } {
  const labels = new Int32Array(width * height);
  const parent: number[] = [0];
  function find(x: number): number {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  }
  let next = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = x > 0 && mask[i - 1] ? labels[i - 1] : 0;
      const up = y > 0 && mask[i - width] ? labels[i - width] : 0;
      if (left && up) {
        labels[i] = Math.min(left, up);
        union(left, up);
      } else if (left) {
        labels[i] = left;
      } else if (up) {
        labels[i] = up;
      } else {
        labels[i] = next;
        parent.push(next);
        next++;
      }
    }
  }
  const remap = new Map<number, number>();
  const pixelsByLabel: number[][] = [];
  for (let i = 0; i < width * height; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let nl = remap.get(root);
    if (nl === undefined) {
      nl = pixelsByLabel.length;
      remap.set(root, nl);
      pixelsByLabel.push([]);
    }
    pixelsByLabel[nl].push(i);
  }
  return { pixelsByLabel };
}

function distanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const dt = new Float32Array(width * height);
  const SQRT2 = Math.SQRT2;
  for (let i = 0; i < width * height; i++) dt[i] = mask[i] ? Infinity : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let m = dt[i];
      if (x > 0) m = Math.min(m, dt[i - 1] + 1);
      if (y > 0) {
        m = Math.min(m, dt[i - width] + 1);
        if (x > 0) m = Math.min(m, dt[i - width - 1] + SQRT2);
        if (x < width - 1) m = Math.min(m, dt[i - width + 1] + SQRT2);
      }
      dt[i] = m;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let m = dt[i];
      if (x < width - 1) m = Math.min(m, dt[i + 1] + 1);
      if (y < height - 1) {
        m = Math.min(m, dt[i + width] + 1);
        if (x > 0) m = Math.min(m, dt[i + width - 1] + SQRT2);
        if (x < width - 1) m = Math.min(m, dt[i + width + 1] + SQRT2);
      }
      dt[i] = m;
    }
  }
  return dt;
}

/**
 * Build a cropped mask containing only the component, padded by 1 pixel.
 * Returns the mask plus the (origin x, y) of the crop in the full image.
 */
function cropMaskOfComponent(
  pixels: number[],
  width: number,
  height: number,
): { mask: Uint8Array; cw: number; ch: number; cx: number; cy: number } {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = Math.max(0, minX - 1);
  const cy = Math.max(0, minY - 1);
  const cMaxX = Math.min(width - 1, maxX + 1);
  const cMaxY = Math.min(height - 1, maxY + 1);
  const cw = cMaxX - cx + 1;
  const ch = cMaxY - cy + 1;
  const mask = new Uint8Array(cw * ch);
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    mask[(y - cy) * cw + (x - cx)] = 1;
  }
  return { mask, cw, ch, cx, cy };
}

/** Zhang-Suen thinning to a 1-pixel-wide skeleton. */
function skeletonize(
  src: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const skel = new Uint8Array(src);
  const toRemove: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      toRemove.length = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!skel[i]) continue;
          const p2 = skel[i - width];
          const p3 = skel[i - width + 1];
          const p4 = skel[i + 1];
          const p5 = skel[i + width + 1];
          const p6 = skel[i + width];
          const p7 = skel[i + width - 1];
          const p8 = skel[i - 1];
          const p9 = skel[i - width - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          let A = 0;
          if (p2 === 0 && p3 === 1) A++;
          if (p3 === 0 && p4 === 1) A++;
          if (p4 === 0 && p5 === 1) A++;
          if (p5 === 0 && p6 === 1) A++;
          if (p6 === 0 && p7 === 1) A++;
          if (p7 === 0 && p8 === 1) A++;
          if (p8 === 0 && p9 === 1) A++;
          if (p9 === 0 && p2 === 1) A++;
          if (A !== 1) continue;
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toRemove.push(i);
        }
      }
      for (const i of toRemove) {
        skel[i] = 0;
        changed = true;
      }
    }
  }
  return skel;
}

function neighborsOf(
  skel: Uint8Array,
  i: number,
  width: number,
  height: number,
): number[] {
  const x = i % width;
  const y = (i - x) / width;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (skel[ni]) out.push(ni);
    }
  }
  return out;
}

/** Trace skeleton pixels into a list of polylines (in pixel coords). */
function traceSkeleton(
  skel: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number }[][] {
  const visited = new Uint8Array(width * height);
  const polylines: { x: number; y: number }[][] = [];

  function tracePath(start: number) {
    const path: { x: number; y: number }[] = [];
    let cur = start;
    let prev = -1;
    while (!visited[cur]) {
      visited[cur] = 1;
      const xc = cur % width;
      const yc = (cur - xc) / width;
      path.push({ x: xc, y: yc });
      const ns = neighborsOf(skel, cur, width, height).filter(
        (n) => n !== prev && !visited[n],
      );
      if (ns.length === 0) break;
      prev = cur;
      cur = ns[0];
    }
    if (path.length >= 2) polylines.push(path);
  }

  for (let i = 0; i < width * height; i++) {
    if (!skel[i] || visited[i]) continue;
    if (neighborsOf(skel, i, width, height).length === 1) tracePath(i);
  }
  for (let i = 0; i < width * height; i++) {
    if (!skel[i] || visited[i]) continue;
    tracePath(i);
  }
  return polylines;
}

/** Cast a ray from (x,y) in direction (dx,dy) until it exits the mask; returns distance in pixels. */
function ptMm(x: number, y: number, pxPerMm: number): Stitch {
  return { x: x / pxPerMm, y: y / pxPerMm };
}

/** Build a polyline's cumulative arc-length table (pixels). */
function polylineArcLength(poly: { x: number; y: number }[]): number[] {
  const arc = [0];
  for (let i = 1; i < poly.length; i++) {
    const dx = poly[i].x - poly[i - 1].x;
    const dy = poly[i].y - poly[i - 1].y;
    arc.push(arc[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  return arc;
}

type Sample = { x: number; y: number; tx: number; ty: number };

/** Sample points along a polyline at fixed pixel intervals, with local tangent. */
function sampleAlong(
  poly: { x: number; y: number }[],
  spacingPx: number,
): Sample[] {
  const arc = polylineArcLength(poly);
  const total = arc[arc.length - 1];
  const samples: Sample[] = [];
  let cursor = 0;
  let segIdx = 0;
  while (cursor <= total + 1e-6) {
    while (segIdx < poly.length - 1 && arc[segIdx + 1] < cursor) segIdx++;
    if (segIdx >= poly.length - 1) break;
    const t = (cursor - arc[segIdx]) / Math.max(1e-6, arc[segIdx + 1] - arc[segIdx]);
    const x = poly[segIdx].x + t * (poly[segIdx + 1].x - poly[segIdx].x);
    const y = poly[segIdx].y + t * (poly[segIdx + 1].y - poly[segIdx].y);
    const tx = poly[segIdx + 1].x - poly[segIdx].x;
    const ty = poly[segIdx + 1].y - poly[segIdx].y;
    const tlen = Math.sqrt(tx * tx + ty * ty) || 1;
    samples.push({ x, y, tx: tx / tlen, ty: ty / tlen });
    cursor += spacingPx;
  }
  return samples;
}

function generateRunningFromSkeleton(
  polylines: { x: number; y: number }[][],
  pxPerMm: number,
  density: number,
): Stitch[] {
  const stepPx = (RUN_STITCH_LEN_MM / Math.max(0.1, density)) * pxPerMm;
  const out: Stitch[] = [];
  for (const poly of polylines) {
    const samples = sampleAlong(poly, stepPx);
    for (const s of samples) out.push(ptMm(s.x, s.y, pxPerMm));
  }
  return out;
}

function principalAngle(pixels: number[], width: number): number {
  let sx = 0,
    sy = 0;
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    sx += x;
    sy += y;
  }
  const mx = sx / pixels.length;
  const my = sy / pixels.length;
  let sxx = 0,
    sxy = 0,
    syy = 0;
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

type AxisProfile = {
  cx: number;
  cy: number;
  cosA: number;
  sinA: number;
  tMin: number;
  tMax: number;
  tStart: number;
  sMinByT: Float32Array;
  sMaxByT: Float32Array;
};

function buildAxisProfile(
  pixels: number[],
  width: number,
  angle: number,
): AxisProfile {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  let sx = 0,
    sy = 0;
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    sx += x;
    sy += y;
  }
  const cx = sx / pixels.length;
  const cy = sy / pixels.length;

  const tValues = new Float32Array(pixels.length);
  const sValues = new Float32Array(pixels.length);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k];
    const x = i % width;
    const y = (i - x) / width;
    const dx = x - cx;
    const dy = y - cy;
    const t = dx * cosA + dy * sinA;
    const s = -dx * sinA + dy * cosA;
    tValues[k] = t;
    sValues[k] = s;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const tStart = Math.floor(tMin);
  const tEnd = Math.ceil(tMax);
  const buckets = tEnd - tStart + 1;
  const sMinByT = new Float32Array(buckets);
  const sMaxByT = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    sMinByT[b] = Infinity;
    sMaxByT[b] = -Infinity;
  }
  for (let k = 0; k < pixels.length; k++) {
    const b = Math.floor(tValues[k]) - tStart;
    const s = sValues[k];
    if (s < sMinByT[b]) sMinByT[b] = s;
    if (s > sMaxByT[b]) sMaxByT[b] = s;
  }
  return { cx, cy, cosA, sinA, tMin, tMax, tStart, sMinByT, sMaxByT };
}

function perpAt(p: AxisProfile, t: number): { sMin: number; sMax: number } {
  const b = Math.floor(t) - p.tStart;
  if (b < 0 || b >= p.sMinByT.length) {
    return { sMin: Infinity, sMax: -Infinity };
  }
  return { sMin: p.sMinByT[b], sMax: p.sMaxByT[b] };
}

function emitSatinLane(
  prof: AxisProfile,
  sLoFn: (t: number) => number,
  sHiFn: (t: number) => number,
  isValidT: (t: number) => boolean,
  pxPerMm: number,
  density: number,
  pullCompPx: number,
): Stitch[] {
  const spacingPx = (SATIN_SPACING_MM / Math.max(0.1, density)) * pxPerMm;
  const out: Stitch[] = [];
  let toggle = false;
  for (let t = prof.tMin; t <= prof.tMax + 1e-6; t += spacingPx) {
    if (!isValidT(t)) continue;
    const sLo = sLoFn(t) - pullCompPx;
    const sHi = sHiFn(t) + pullCompPx;
    if (!isFinite(sLo) || !isFinite(sHi)) continue;
    const px = prof.cx + t * prof.cosA;
    const py = prof.cy + t * prof.sinA;
    const a = ptMm(px + sLo * -prof.sinA, py + sLo * prof.cosA, pxPerMm);
    const b = ptMm(px + sHi * -prof.sinA, py + sHi * prof.cosA, pxPerMm);
    if (toggle) out.push(b, a);
    else out.push(a, b);
    toggle = !toggle;
  }
  return out;
}

function polyLen(poly: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) {
    const dx = poly[i].x - poly[i - 1].x;
    const dy = poly[i].y - poly[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

function smoothPoly(
  poly: { x: number; y: number }[],
  halfWin: number,
): { x: number; y: number }[] {
  if (poly.length < 3) return poly;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < poly.length; i++) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(poly.length - 1, i + halfWin);
    for (let j = lo; j <= hi; j++) {
      sx += poly[j].x;
      sy += poly[j].y;
      n++;
    }
    out.push({ x: sx / n, y: sy / n });
  }
  return out;
}

/**
 * Satin that FOLLOWS the component's skeleton (the centerline/spine). At each
 * sample along the skeleton the stitch runs perpendicular to the local tangent
 * from one edge of the mask to the other, so curved shapes (rings, script,
 * arcs) get stitches that follow the curve instead of crossing it at a single
 * fixed axis.
 */
function generateSkeletonSatin(
  pixels: number[],
  width: number,
  height: number,
  pxPerMm: number,
  density: number,
  pullCompMm: number,
): { underlay: Stitch[]; top: Stitch[] } {
  const spacingPx = (SATIN_SPACING_MM / Math.max(0.1, density)) * pxPerMm;
  const pullCompPx = pullCompMm * pxPerMm;

  const crop = cropMaskOfComponent(pixels, width, height);
  const skel = skeletonize(crop.mask, crop.cw, crop.ch);
  const localPolys = traceSkeleton(skel, crop.cw, crop.ch)
    .filter((p) => p.length >= 3)
    .map((p) => smoothPoly(smoothPoly(p, 6), 6));
  if (localPolys.length === 0) return { underlay: [], top: [] };

  let primary = localPolys[0];
  for (const p of localPolys) {
    if (polyLen(p) > polyLen(primary)) primary = p;
  }

  const insideLocal = (lx: number, ly: number): boolean => {
    const ix = Math.floor(lx);
    const iy = Math.floor(ly);
    if (ix < 0 || iy < 0 || ix >= crop.cw || iy >= crop.ch) return false;
    return crop.mask[iy * crop.cw + ix] !== 0;
  };

  const walkOut = (
    lx: number,
    ly: number,
    dx: number,
    dy: number,
  ): number => {
    const step = 0.5;
    const maxSteps = Math.max(crop.cw, crop.ch) * 2;
    let d = 0;
    for (let i = 1; i <= maxSteps; i++) {
      const nx = lx + dx * step * i;
      const ny = ly + dy * step * i;
      if (!insideLocal(nx, ny)) break;
      d = step * i;
    }
    return d;
  };

  const top: Stitch[] = [];
  let toggle = false;
  for (const s of sampleAlong(primary, spacingPx)) {
    if (!insideLocal(s.x, s.y)) continue;
    const perpX = -s.ty;
    const perpY = s.tx;
    const upper = walkOut(s.x, s.y, perpX, perpY);
    const lower = walkOut(s.x, s.y, -perpX, -perpY);
    if (upper + lower < 0.5 * pxPerMm) continue;
    const uEnd = upper + pullCompPx;
    const lEnd = lower + pullCompPx;
    const gx = s.x + crop.cx;
    const gy = s.y + crop.cy;
    const ax = gx - perpX * lEnd;
    const ay = gy - perpY * lEnd;
    const bx = gx + perpX * uEnd;
    const by = gy + perpY * uEnd;
    if (toggle) top.push(ptMm(bx, by, pxPerMm), ptMm(ax, ay, pxPerMm));
    else top.push(ptMm(ax, ay, pxPerMm), ptMm(bx, by, pxPerMm));
    toggle = !toggle;
  }

  const underlay: Stitch[] = [];
  const edgeWalkStepPx = 2.0 * pxPerMm;
  for (const s of sampleAlong(primary, edgeWalkStepPx)) {
    const gx = s.x + crop.cx;
    const gy = s.y + crop.cy;
    underlay.push(ptMm(gx, gy, pxPerMm));
  }

  return { underlay, top };
}

function generateSplitSatin(
  pixels: number[],
  width: number,
  pxPerMm: number,
  density: number,
  pullCompMm: number,
  laneWidthMm: number,
): { underlay: Stitch[]; top: Stitch[] } {
  const angle = principalAngle(pixels, width);
  const prof = buildAxisProfile(pixels, width, angle);
  const pullCompPx = pullCompMm * pxPerMm;

  let sMinAll = Infinity;
  let sMaxAll = -Infinity;
  for (let b = 0; b < prof.sMinByT.length; b++) {
    if (prof.sMinByT[b] < sMinAll) sMinAll = prof.sMinByT[b];
    if (prof.sMaxByT[b] > sMaxAll) sMaxAll = prof.sMaxByT[b];
  }
  const totalThickPx = sMaxAll - sMinAll;
  const totalThickMm = totalThickPx / pxPerMm;
  const lanes = Math.max(2, Math.ceil(totalThickMm / laneWidthMm));
  const lanePx = totalThickPx / lanes;

  const top: Stitch[] = [];
  const underlay: Stitch[] = [];

  for (let li = 0; li < lanes; li++) {
    const sLane0 = sMinAll + li * lanePx;
    const sLane1 = sMinAll + (li + 1) * lanePx;
    const sLoFn = (t: number) => Math.max(perpAt(prof, t).sMin, sLane0);
    const sHiFn = (t: number) => Math.min(perpAt(prof, t).sMax, sLane1);
    const isValidT = (t: number) => {
      const { sMin, sMax } = perpAt(prof, t);
      if (!isFinite(sMin) || !isFinite(sMax)) return false;
      return sMin < sLane1 && sMax > sLane0;
    };
    top.push(
      ...emitSatinLane(prof, sLoFn, sHiFn, isValidT, pxPerMm, density, pullCompPx),
    );

    const sMid = (sLane0 + sLane1) / 2;
    const stepPx = UNDERLAY_RUN_LEN_MM * pxPerMm;
    const forward: Stitch[] = [];
    for (let t = prof.tMin; t <= prof.tMax + 1e-6; t += stepPx) {
      if (!isValidT(t)) continue;
      const px = prof.cx + t * prof.cosA;
      const py = prof.cy + t * prof.sinA;
      forward.push(
        ptMm(px + sMid * -prof.sinA, py + sMid * prof.cosA, pxPerMm),
      );
    }
    underlay.push(...forward);
  }

  return { underlay, top };
}

function generateFill(
  pixels: number[],
  width: number,
  pxPerMm: number,
  density: number,
  pullCompMm: number,
): { underlay: Stitch[]; top: Stitch[] } {
  const FILL_ANGLE_DEG = 55;
  const fillAngle = (FILL_ANGLE_DEG * Math.PI) / 180;
  // Stitches run AT 55°; rows advance PERPENDICULAR to 55° (= 145°).
  const prof = buildAxisProfile(pixels, width, fillAngle + Math.PI / 2);
  const pullCompPx = pullCompMm * pxPerMm;

  const rowSpacingPx = (FILL_ROW_SPACING_MM / Math.max(0.1, density)) * pxPerMm;
  const stitchLenPx = FILL_STITCH_LEN_MM * pxPerMm;
  const minStitchPx = 0.3 * pxPerMm;

  // Global s-range so stagger anchors to a single grid across every row.
  // Without this, each row's stitch endpoints align to its own sStart/sEnd,
  // producing a random alignment that doesn't read as a tatami brick pattern.
  let sMinAll = Infinity;
  let sMaxAll = -Infinity;
  for (let b = 0; b < prof.sMinByT.length; b++) {
    if (prof.sMinByT[b] < sMinAll) sMinAll = prof.sMinByT[b];
    if (prof.sMaxByT[b] > sMaxAll) sMaxAll = prof.sMaxByT[b];
  }
  const anchorS = Math.floor(sMinAll / stitchLenPx) * stitchLenPx;

  const top: Stitch[] = [];
  let rowIdx = 0;
  for (let t = prof.tMin; t <= prof.tMax + 1e-6; t += rowSpacingPx) {
    const { sMin, sMax } = perpAt(prof, t);
    if (!isFinite(sMin) || !isFinite(sMax)) {
      rowIdx++;
      continue;
    }
    const sStart = sMin - pullCompPx;
    const sEnd = sMax + pullCompPx;
    // Classic tatami: odd rows shift by half a stitch length on the shared grid.
    const rowAnchor = anchorS + (rowIdx % 2 === 1 ? stitchLenPx / 2 : 0);

    const k0 = Math.ceil((sStart - rowAnchor) / stitchLenPx);
    const k1 = Math.floor((sEnd - rowAnchor) / stitchLenPx);
    const pts: number[] = [];
    if (k0 > k1) {
      if (sEnd - sStart >= minStitchPx) pts.push(sStart, sEnd);
    } else {
      const firstGrid = rowAnchor + k0 * stitchLenPx;
      const lastGrid = rowAnchor + k1 * stitchLenPx;
      if (firstGrid - sStart >= minStitchPx) pts.push(sStart);
      for (let k = k0; k <= k1; k++) pts.push(rowAnchor + k * stitchLenPx);
      if (sEnd - lastGrid >= minStitchPx) pts.push(sEnd);
    }
    if (pts.length < 2) {
      rowIdx++;
      continue;
    }
    if (rowIdx % 2 === 1) pts.reverse();
    for (const s of pts) {
      const px = prof.cx + t * prof.cosA + s * -prof.sinA;
      const py = prof.cy + t * prof.sinA + s * prof.cosA;
      top.push(ptMm(px, py, pxPerMm));
    }
    rowIdx++;
  }

  // Underlay: back-and-forth parallel lines at ~10°. Each row runs across
  // the region edge-to-edge, then steps to the next row and runs back.
  const underlay: Stitch[] = [];
  const UNDERLAY_ANGLE_DEG = 10;
  const underlayRowAngle = (UNDERLAY_ANGLE_DEG * Math.PI) / 180;
  const advanceAngle = underlayRowAngle + Math.PI / 2;
  const profU = buildAxisProfile(pixels, width, advanceAngle);
  const underlayRowPx = UNDERLAY_FILL_ROW_SPACING_MM * pxPerMm;
  const underlayStitchPx = UNDERLAY_FILL_STITCH_LEN_MM * pxPerMm;
  let rowReverse = false;
  for (let t = profU.tMin; t <= profU.tMax + 1e-6; t += underlayRowPx) {
    const { sMin, sMax } = perpAt(profU, t);
    if (!isFinite(sMin) || !isFinite(sMax)) continue;
    if (rowReverse) {
      for (let s = sMax; s >= sMin - 1e-6; s -= underlayStitchPx) {
        const px = profU.cx + t * profU.cosA + s * -profU.sinA;
        const py = profU.cy + t * profU.sinA + s * profU.cosA;
        underlay.push(ptMm(px, py, pxPerMm));
      }
    } else {
      for (let s = sMin; s <= sMax + 1e-6; s += underlayStitchPx) {
        const px = profU.cx + t * profU.cosA + s * -profU.sinA;
        const py = profU.cy + t * profU.sinA + s * profU.cosA;
        underlay.push(ptMm(px, py, pxPerMm));
      }
    }
    rowReverse = !rowReverse;
  }

  return { underlay, top };
}

function classifyByThickness(
  maxThicknessMm: number,
  splitWideSatin: boolean,
): StitchType | "split-satin" {
  if (maxThicknessMm < RUNNING_MAX_THICKNESS_MM) return "running";
  if (maxThicknessMm <= SATIN_MAX_THICKNESS_MM) return "satin";
  return splitWideSatin ? "split-satin" : "fill";
}

export function digitize(
  imageData: { data: Uint8ClampedArray; width: number; height: number },
  designWidthMm: number,
  colors: ColorPlan[],
  options: { bgThreshold?: number } = {},
): DigitizeResult {
  const { data, width, height } = imageData;
  const bg = options.bgThreshold ?? DEFAULT_BG_BRIGHTNESS;
  const masks = buildMasks(data, width, height, colors, bg);

  let bMinX = width;
  let bMaxX = -1;
  let bMinY = height;
  let bMaxY = -1;
  for (let ci = 0; ci < colors.length; ci++) {
    if (colors[ci].excluded) continue;
    const m = masks[ci];
    for (let i = 0; i < width * height; i++) {
      if (!m[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      if (x < bMinX) bMinX = x;
      if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y;
      if (y > bMaxY) bMaxY = y;
    }
  }
  if (bMaxX < 0) {
    return {
      widthMm: 0,
      heightMm: 0,
      pxPerMm: 0,
      regions: [],
      totalStitchCount: 0,
      perColorStitchCount: new Array<number>(colors.length).fill(0),
    };
  }
  const bboxWPx = bMaxX - bMinX + 1;
  const bboxHPx = bMaxY - bMinY + 1;
  const pxPerMm = bboxWPx / designWidthMm;
  const heightMm = bboxHPx / pxPerMm;
  const offsetXMm = bMinX / pxPerMm;
  const offsetYMm = bMinY / pxPerMm;

  const regions: RegionPlan[] = [];
  const perColorStitchCount = new Array<number>(colors.length).fill(0);
  let total = 0;

  for (let ci = 0; ci < colors.length; ci++) {
    const color = colors[ci];
    if (color.excluded) continue;
    const dt = distanceTransform(masks[ci], width, height);
    const { pixelsByLabel } = connectedComponents(masks[ci], width, height);
    for (const pixels of pixelsByLabel) {
      if (pixels.length < MIN_COMPONENT_PX) continue;

      let maxD = 0;
      for (const i of pixels) if (dt[i] > maxD) maxD = dt[i];
      const maxThicknessMm = (maxD * 2) / pxPerMm;
      const type = classifyByThickness(maxThicknessMm, color.splitWideSatin);

      let underlay: Stitch[] = [];
      let top: Stitch[] = [];
      let stitchType: StitchType;

      if (type === "running") {
        const crop = cropMaskOfComponent(pixels, width, height);
        const cropSkel = skeletonize(crop.mask, crop.cw, crop.ch);
        const localPolys = traceSkeleton(cropSkel, crop.cw, crop.ch);
        const polylines = localPolys.map((poly) =>
          poly.map((p) => ({ x: p.x + crop.cx, y: p.y + crop.cy })),
        );
        top = generateRunningFromSkeleton(polylines, pxPerMm, color.density);
        stitchType = "running";
      } else if (type === "satin") {
        const r = generateSkeletonSatin(
          pixels,
          width,
          height,
          pxPerMm,
          color.density,
          color.pullCompMm,
        );
        underlay = r.underlay;
        top = r.top;
        stitchType = "satin";
      } else if (type === "split-satin") {
        const r = generateSplitSatin(
          pixels,
          width,
          pxPerMm,
          color.density,
          color.pullCompMm,
          SATIN_LANE_WIDTH_MM,
        );
        underlay = r.underlay;
        top = r.top;
        stitchType = "satin";
      } else {
        const r = generateFill(
          pixels,
          width,
          pxPerMm,
          color.density,
          color.pullCompMm,
        );
        underlay = r.underlay;
        top = r.top;
        stitchType = "fill";
      }

      for (const s of underlay) {
        s.x -= offsetXMm;
        s.y -= offsetYMm;
      }
      for (const s of top) {
        s.x -= offsetXMm;
        s.y -= offsetYMm;
      }

      const count = underlay.length + top.length;
      total += count;
      perColorStitchCount[ci] += count;
      regions.push({ colorIndex: ci, stitchType, underlay, topStitches: top });
    }
  }

  return {
    widthMm: designWidthMm,
    heightMm,
    pxPerMm,
    regions,
    totalStitchCount: total,
    perColorStitchCount,
  };
}

/**
 * Convert digitize output into the same DstParseResult format used by the
 * DST parser, so the existing renderDstRealistic renderer can draw it with
 * the same realistic thread look. Coordinates are converted from mm (y-down)
 * to DST units (0.1mm, y-up). Jumps are inserted between disconnected regions.
 */
export function digitizeResultToDst(
  result: DigitizeResult,
  colors: ColorPlan[],
): { parseResult: DstParseResult; threadColors: string[] } {
  const stitches: DstStitch[] = [];
  const threadColors: string[] = [];
  let lastColorIndex = -1;

  for (const region of result.regions) {
    if (colors[region.colorIndex].excluded) continue;

    if (region.colorIndex !== lastColorIndex) {
      if (lastColorIndex >= 0) {
        const last = stitches[stitches.length - 1];
        stitches.push({ x: last?.x ?? 0, y: last?.y ?? 0, type: "stop" });
      }
      threadColors.push(colors[region.colorIndex].hex);
      lastColorIndex = region.colorIndex;
    }

    const allStitches = [...region.underlay, ...region.topStitches];
    for (let i = 0; i < allStitches.length; i++) {
      const s = allStitches[i];
      const x = Math.round(s.x * 10);
      const y = Math.round(-s.y * 10);
      if (i === 0 && stitches.length > 0) {
        stitches.push({ x, y, type: "jump" });
      }
      stitches.push({ x, y, type: "normal" });
    }
  }

  stitches.push({ x: 0, y: 0, type: "end" });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let normalCount = 0;
  for (const s of stitches) {
    if (s.type === "end") break;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
    if (s.type === "normal") normalCount++;
  }
  if (!isFinite(minX)) {
    minX = 0; maxX = 0; minY = 0; maxY = 0;
  }

  const colorStops: DstColorStop[] = [];
  let currentStopStart = 0;
  let stopNumber = 1;
  for (let i = 0; i < stitches.length; i++) {
    const st = stitches[i];
    if (st.type === "stop" || st.type === "end" || i === stitches.length - 1) {
      colorStops.push({
        stopNumber,
        startStitchIndex: currentStopStart,
        endStitchIndex: i,
        stitchCount: i - currentStopStart + 1,
        defaultHex: threadColors[stopNumber - 1] ?? "#000000",
      });
      if (st.type === "stop") {
        stopNumber++;
        currentStopStart = i + 1;
      }
    }
    if (st.type === "end") break;
  }

  const widthMm = (maxX - minX) / 10;
  const heightMm = (maxY - minY) / 10;

  const parseResult: DstParseResult = {
    stitches,
    colorStops,
    totalStitchCount: normalCount,
    bounds: {
      minX, minY, maxX, maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
    widthMm,
    heightMm,
    widthInches: Math.round((widthMm / 25.4) * 100) / 100,
    heightInches: Math.round((heightMm / 25.4) * 100) / 100,
  };

  return { parseResult, threadColors };
}
