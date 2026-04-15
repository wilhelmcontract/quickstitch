/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * DST (Tajima) Embroidery File Parser
 * Parses DST binary format to extract stitch data and color stops.
 * Header is 512 bytes; stitch data is 3 bytes per command; units are 0.1mm.
 */

export interface DstStitch {
  x: number;
  y: number;
  type: "normal" | "jump" | "trim" | "stop" | "end";
}

export interface DstColorStop {
  stopNumber: number;
  startStitchIndex: number;
  endStitchIndex: number;
  stitchCount: number;
  defaultHex: string;
  assignedThreadId?: string;
  assignedThreadHex?: string;
  assignedThreadName?: string;
  isPuff?: boolean;
}

export interface DstParseResult {
  stitches: DstStitch[];
  colorStops: DstColorStop[];
  totalStitchCount: number;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
  widthMm: number;
  heightMm: number;
  widthInches: number;
  heightInches: number;
}

const DEFAULT_THREAD_COLORS = [
  "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#00FFFF",
  "#FF8000", "#8000FF", "#00FF80", "#FF0080", "#80FF00", "#0080FF",
  "#800000", "#008000", "#000080", "#808000", "#800080", "#008080",
];

function decodeDSTCommand(byte1: number, byte2: number, byte3: number) {
  if ((byte3 & 0xf3) === 0xf3) {
    return { dx: 0, dy: 0, isJump: false, isColorChange: false, isEnd: true };
  }
  const c0 = (byte3 & 0x80) !== 0;
  const c1 = (byte3 & 0x40) !== 0;
  const isJump = c0 && !c1;
  const isColorChange = c0 && c1;

  let dx = 0;
  if (byte1 & 0x01) dx += 1;
  if (byte1 & 0x02) dx -= 1;
  if (byte1 & 0x04) dx += 9;
  if (byte1 & 0x08) dx -= 9;
  if (byte2 & 0x01) dx += 3;
  if (byte2 & 0x02) dx -= 3;
  if (byte2 & 0x04) dx += 27;
  if (byte2 & 0x08) dx -= 27;
  if (byte3 & 0x04) dx += 81;
  if (byte3 & 0x08) dx -= 81;

  let dy = 0;
  if (byte1 & 0x80) dy += 1;
  if (byte1 & 0x40) dy -= 1;
  if (byte1 & 0x20) dy += 9;
  if (byte1 & 0x10) dy -= 9;
  if (byte2 & 0x80) dy += 3;
  if (byte2 & 0x40) dy -= 3;
  if (byte2 & 0x20) dy += 27;
  if (byte2 & 0x10) dy -= 27;
  if (byte3 & 0x20) dy += 81;
  if (byte3 & 0x10) dy -= 81;

  return { dx, dy, isJump, isColorChange, isEnd: false };
}

export function parseDstFile(buffer: ArrayBuffer): DstParseResult {
  const dataView = new DataView(buffer);
  if (buffer.byteLength < 515) throw new Error("Invalid DST file: file too small");

  const bodySize = buffer.byteLength - 512;
  const extraBytes = bodySize % 3;
  if (extraBytes !== 0) {
    console.warn(`DST file has ${extraBytes} extra bytes at the end - will ignore them`);
  }

  const stitches: DstStitch[] = [];
  let x = 0;
  let y = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  let colorChangeCount = 0;
  const endOffset = buffer.byteLength - extraBytes;

  for (let offset = 512; offset < endOffset; offset += 3) {
    const byte1 = dataView.getUint8(offset);
    const byte2 = dataView.getUint8(offset + 1);
    const byte3 = dataView.getUint8(offset + 2);
    const result = decodeDSTCommand(byte1, byte2, byte3);

    if (result.isEnd) {
      stitches.push({ x, y, type: "end" });
      break;
    }
    if (result.isColorChange) colorChangeCount++;

    x += result.dx;
    y += result.dy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    let stitchType: DstStitch["type"] = "normal";
    if (result.isColorChange) stitchType = "stop";
    else if (result.isJump) stitchType = "jump";
    stitches.push({ x, y, type: stitchType });
  }

  const widthMm = (maxX - minX) / 10;
  const heightMm = (maxY - minY) / 10;
  const widthInches = widthMm / 25.4;
  const heightInches = heightMm / 25.4;

  const colorStops: DstColorStop[] = [];
  let currentStopStart = 0;
  let stopNumber = 1;

  for (let i = 0; i < stitches.length; i++) {
    const stitch = stitches[i];
    if (stitch.type === "stop" || stitch.type === "end" || i === stitches.length - 1) {
      colorStops.push({
        stopNumber,
        startStitchIndex: currentStopStart,
        endStitchIndex: i,
        stitchCount: i - currentStopStart + 1,
        defaultHex:
          DEFAULT_THREAD_COLORS[(stopNumber - 1) % DEFAULT_THREAD_COLORS.length],
      });
      if (stitch.type === "stop") {
        stopNumber++;
        currentStopStart = i + 1;
      }
    }
    if (stitch.type === "end") break;
  }

  const normalStitchCount = stitches.filter((s) => s.type === "normal").length;

  return {
    stitches,
    colorStops,
    totalStitchCount: normalStitchCount,
    bounds: {
      minX, minY, maxX, maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
    widthMm,
    heightMm,
    widthInches: Math.round(widthInches * 100) / 100,
    heightInches: Math.round(heightInches * 100) / 100,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function adjustBrightness(
  rgb: { r: number; g: number; b: number },
  factor: number,
): string {
  const spread =
    Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  if (spread < 30) {
    const avg = Math.min(
      255,
      Math.max(0, Math.round(((rgb.r + rgb.g + rgb.b) / 3) * factor)),
    );
    return `rgb(${avg},${avg},${avg})`;
  }
  const r = Math.min(255, Math.max(0, Math.round(rgb.r * factor)));
  const g = Math.min(255, Math.max(0, Math.round(rgb.g * factor)));
  const b = Math.min(255, Math.max(0, Math.round(rgb.b * factor)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Draw one realistic thread segment on the given context: cylindrical perpendicular
 * gradient + along-stitch shading + top highlight stripe. Caller is responsible for
 * any coordinate system flips.
 */
export function drawRealisticStitch(
  ctx: CanvasRenderingContext2D,
  prevX: number,
  prevY: number,
  x: number,
  y: number,
  color: string,
  threadWidth = 1.8,
  lightAngle = 135,
) {
  const rgb = hexToRgb(color);
  if (!rgb) return;

  const dx = x - prevX;
  const dy = y - prevY;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.5) return;

  const angle = Math.atan2(dy, dx);
  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);
  const halfWidth = threadWidth / 2;
  const lightAngleRad = (lightAngle * Math.PI) / 180;
  const lightFacing = 0.5 + 0.5 * Math.cos(angle - lightAngleRad + Math.PI / 2);

  const perpGradient = ctx.createLinearGradient(
    prevX + perpX * halfWidth,
    prevY + perpY * halfWidth,
    prevX - perpX * halfWidth,
    prevY - perpY * halfWidth,
  );
  const darkEdge = adjustBrightness(rgb, 0.82);
  const lightCenter = adjustBrightness(rgb, 1.08 + lightFacing * 0.04);
  const darkEdge2 = adjustBrightness(rgb, 0.78);
  perpGradient.addColorStop(0, darkEdge2);
  perpGradient.addColorStop(0.22, color);
  perpGradient.addColorStop(0.45, lightCenter);
  perpGradient.addColorStop(0.68, color);
  perpGradient.addColorStop(1, darkEdge);

  ctx.strokeStyle = perpGradient;
  ctx.lineWidth = threadWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(prevX, prevY);
  ctx.lineTo(x, y);
  ctx.stroke();

  const alongGradient = ctx.createLinearGradient(prevX, prevY, x, y);
  alongGradient.addColorStop(0, "rgba(0,0,0,0.25)");
  alongGradient.addColorStop(0.2, "rgba(0,0,0,0.06)");
  alongGradient.addColorStop(0.5, "rgba(255,255,255,0.12)");
  alongGradient.addColorStop(0.8, "rgba(0,0,0,0.06)");
  alongGradient.addColorStop(1, "rgba(0,0,0,0.22)");

  ctx.strokeStyle = alongGradient;
  ctx.lineWidth = threadWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(prevX, prevY);
  ctx.lineTo(x, y);
  ctx.stroke();

  const highlightOffset = -threadWidth * 0.15;
  ctx.strokeStyle = `rgba(255,255,255,${0.15 + 0.1 * lightFacing})`;
  ctx.lineWidth = threadWidth * 0.3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(
    prevX + perpX * highlightOffset,
    prevY + perpY * highlightOffset,
  );
  ctx.lineTo(x + perpX * highlightOffset, y + perpY * highlightOffset);
  ctx.stroke();
}

/**
 * Render parsed DST data realistically into a target canvas.
 * `excludedStops` is a set of zero-based color-stop indices to skip drawing.
 */
export function renderDstRealistic(
  result: DstParseResult,
  threadColors: string[],
  canvas: HTMLCanvasElement,
  options: {
    scale?: number;
    threadWidth?: number;
    lightAngle?: number;
    excludedStops?: Set<number>;
    padding?: number;
  } = {},
): { width: number; height: number } {
  const {
    scale = 4,
    threadWidth = 1.8,
    lightAngle = 135,
    excludedStops,
    padding = 20,
  } = options;
  const { stitches, bounds } = result;

  const widthPx = (bounds.width / 10) * scale + padding * 2;
  const heightPx = (bounds.height / 10) * scale + padding * 2;
  canvas.width = Math.max(widthPx, 100);
  canvas.height = Math.max(heightPx, 100);

  const ctx = canvas.getContext("2d");
  if (!ctx) return { width: canvas.width, height: canvas.height };

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(0, canvas.height);
  ctx.scale(1, -1);

  const toCanvasX = (vx: number) => ((vx - bounds.minX) / 10) * scale + padding;
  const toCanvasY = (vy: number) => ((vy - bounds.minY) / 10) * scale + padding;

  let currentColorIndex = 0;
  let prevX = 0;
  let prevY = 0;
  let isFirstPoint = true;
  let consecutiveJumps = 0;

  for (let i = 0; i < stitches.length; i++) {
    const stitch = stitches[i];
    if (stitch.type === "end") break;

    const x = toCanvasX(stitch.x);
    const y = toCanvasY(stitch.y);

    if (stitch.type === "stop") {
      currentColorIndex++;
      prevX = x;
      prevY = y;
      isFirstPoint = true;
      consecutiveJumps = 0;
      continue;
    }

    if (stitch.type === "jump") {
      prevX = x;
      prevY = y;
      isFirstPoint = false;
      consecutiveJumps++;
      continue;
    }

    if (isFirstPoint || consecutiveJumps >= 2) {
      prevX = x;
      prevY = y;
      isFirstPoint = false;
      consecutiveJumps = 0;
      continue;
    }
    consecutiveJumps = 0;

    if (!excludedStops?.has(currentColorIndex)) {
      const color = threadColors[currentColorIndex] || "#000000";
      drawRealisticStitch(ctx, prevX, prevY, x, y, color, threadWidth, lightAngle);
    }

    prevX = x;
    prevY = y;
  }

  ctx.restore();
  return { width: canvas.width, height: canvas.height };
}

export async function parseDstFromFile(file: File): Promise<DstParseResult> {
  const buffer = await file.arrayBuffer();
  return parseDstFile(buffer);
}
