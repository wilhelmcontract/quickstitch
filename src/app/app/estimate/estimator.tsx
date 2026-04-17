"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { saveProject } from "../actions";
import {
  parseDstFromFile,
  renderDstRealistic,
  type DstParseResult,
} from "@/lib/dstParser";
import {
  digitize,
  digitizeResultToDst,
  type ColorPlan,
  type DigitizeResult,
} from "@/lib/digitize";
import { orMasks, vectorize } from "@/lib/vectorize";

type FileKind = "image" | "dst";

type ImageStats = {
  kind: "image";
  stitchCount: number;
  widthInches: number;
  heightInches: number;
};

type DstStats = {
  kind: "dst";
  stitchCount: number;
  widthInches: number;
  heightInches: number;
};

type Stats = ImageStats | DstStats;

type RgbaImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

const DEFAULT_DESIGN_WIDTH_IN = 4;
const DEFAULT_DETAIL = 4;
const MM_PER_INCH = 25.4;
const DISPLAY_PX_PER_MM = 8;

/**
 * Detail slider (0-10) → vectorize params.
 *   0: few, heavily blurred clusters (2 colors, big AA smoothing).
 *  10: every distinct bucket including pixelated/AA variants (up to 48 slots,
 *      no blur, single-pixel buckets allowed).
 * User combines down manually from the revealed palette.
 */
function detailToVectorizeOptions(detail: number): {
  numColors: number;
  blurRadius: number;
  minBucketCount: number;
} {
  const t = Math.max(0, Math.min(10, detail)) / 10;
  return {
    numColors: Math.round(2 + t * 46),
    blurRadius: Math.round(6 - t * 6),
    minBucketCount: Math.max(1, Math.round(40 - t * 39)),
  };
}

function detectKind(f: File): FileKind {
  return /\.dst$/i.test(f.name) ? "dst" : "image";
}

function defaultColorPlan(c: {
  hex: string;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
}): ColorPlan {
  return {
    ...c,
    excluded: false,
    density: 1.0,
    pullCompMm: 0.2,
    splitWideSatin: false,
  };
}

export function Estimator() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<FileKind | null>(null);
  const [parsedDst, setParsedDst] = useState<DstParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [designWidthIn, setDesignWidthIn] = useState(DEFAULT_DESIGN_WIDTH_IN);
  const [imageRgba, setImageRgba] = useState<RgbaImage | null>(null);
  const [colorPlans, setColorPlans] = useState<ColorPlan[]>([]);
  const [colorMasks, setColorMasks] = useState<Uint8Array[]>([]);
  const [maskDims, setMaskDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [prepOpen, setPrepOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [detailLevel, setDetailLevel] = useState(DEFAULT_DETAIL);
  const [locateOn, setLocateOn] = useState(false);
  const processedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const detailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedForMerge, setSelectedForMerge] = useState<Set<number>>(
    new Set(),
  );

  const [excludedDstStops, setExcludedDstStops] = useState<Set<number>>(
    new Set(),
  );

  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const imgRef = useRef<HTMLImageElement | null>(null);
  const stitchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalDstCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const imageUrl = useMemo(() => {
    if (kind !== "image" || !file) return null;
    return URL.createObjectURL(file);
  }, [kind, file]);

  useEffect(() => {
    if (!imageUrl) return;
    return () => URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  function onImageLoaded() {
    const img = imgRef.current;
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    const rgba = { data: id.data, width: id.width, height: id.height };
    setImageRgba(rgba);
    runDetect(rgba, detailLevel);
    setAccepted(false);
    setPrepOpen(true);
  }

  function runDetect(rgba: RgbaImage, detail: number) {
    const opts = detailToVectorizeOptions(detail);
    const v = vectorize(rgba.data, rgba.width, rgba.height, opts.numColors, {
      blurRadius: opts.blurRadius,
      minBucketCount: opts.minBucketCount,
    });
    setColorPlans(v.palette.map(defaultColorPlan));
    setColorMasks(v.masks);
    setMaskDims({ w: v.width, h: v.height });
    setSelectedForMerge(new Set());
    setLocateOn(false);
  }

  // Posterized "Processed Bitmap" — each pixel painted with its assigned
  // palette color. Derived so combine/exclude changes update immediately.
  // When locateOn is true, only pixels belonging to currently-selected
  // swatches are painted; the rest stay transparent so the user can see
  // exactly which regions belong to the selection.
  const processedRgba = useMemo<Uint8ClampedArray | null>(() => {
    if (!maskDims || colorMasks.length !== colorPlans.length) return null;
    const rgba = new Uint8ClampedArray(maskDims.w * maskDims.h * 4);
    for (let p = 0; p < colorMasks.length; p++) {
      if (locateOn && !selectedForMerge.has(p)) continue;
      const { r, g, b } = colorPlans[p];
      const mask = colorMasks[p];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const o = i * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }, [colorMasks, colorPlans, maskDims, locateOn, selectedForMerge]);

  // Debounce detail slider: vectorize can be 1-2s of blocking JS on large
  // images, and firing it on every onChange tick makes the slider feel frozen.
  // Coalesce to the last value after the user stops dragging.
  function onDetailChange(d: number) {
    setDetailLevel(d);
    if (detailDebounceRef.current) clearTimeout(detailDebounceRef.current);
    detailDebounceRef.current = setTimeout(() => {
      if (imageRgba) runDetect(imageRgba, d);
    }, 250);
  }

  function acceptPrep() {
    setAccepted(true);
    setPrepOpen(false);
  }

  function cancelPrep() {
    setPrepOpen(false);
  }

  function editPrep() {
    setAccepted(false);
    setPrepOpen(true);
  }

  function combineSelected() {
    if (selectedForMerge.size < 2) return;
    const idx = Array.from(selectedForMerge).sort((a, b) => a - b);
    const keep = idx[0];
    const drop = new Set(idx.slice(1));

    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const i of idx) {
      const c = colorPlans[i];
      r += c.r * c.pixelCount;
      g += c.g * c.pixelCount;
      b += c.b * c.pixelCount;
      total += c.pixelCount;
    }
    const mr = Math.round(r / total);
    const mg = Math.round(g / total);
    const mb = Math.round(b / total);
    const hex = `#${[mr, mg, mb].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const mergedPlan: ColorPlan = {
      ...colorPlans[keep],
      hex,
      r: mr,
      g: mg,
      b: mb,
      pixelCount: total,
    };
    let mergedMask = colorMasks[keep];
    for (const i of idx) {
      if (i === keep) continue;
      mergedMask = orMasks(mergedMask, colorMasks[i]);
    }

    setColorPlans(
      colorPlans
        .map((c, i) => (i === keep ? mergedPlan : c))
        .filter((_, i) => !drop.has(i)),
    );
    setColorMasks(
      colorMasks
        .map((m, i) => (i === keep ? mergedMask : m))
        .filter((_, i) => !drop.has(i)),
    );
    setSelectedForMerge(new Set());
    setLocateOn(false);
  }

  function toggleMergeSelection(i: number) {
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function removeSelected() {
    if (selectedForMerge.size === 0) return;
    const drop = selectedForMerge;
    setColorPlans(colorPlans.filter((_, i) => !drop.has(i)));
    setColorMasks(colorMasks.filter((_, i) => !drop.has(i)));
    setSelectedForMerge(new Set());
    setLocateOn(false);
  }

  const digitized = useMemo<DigitizeResult | null>(() => {
    if (
      kind !== "image" ||
      !accepted ||
      !maskDims ||
      colorPlans.length === 0 ||
      colorMasks.length !== colorPlans.length
    ) {
      return null;
    }
    const widthMm = designWidthIn * MM_PER_INCH;
    return digitize(
      colorMasks,
      maskDims.w,
      maskDims.h,
      widthMm,
      colorPlans,
    );
  }, [kind, accepted, colorMasks, maskDims, colorPlans, designWidthIn]);

  // Render the digitized result using the same DST renderer for realistic look.
  useEffect(() => {
    if (kind !== "image" || !digitized) return;
    const canvas = stitchCanvasRef.current;
    if (!canvas) return;
    const { parseResult, threadColors } = digitizeResultToDst(
      digitized,
      colorPlans,
    );
    renderDstRealistic(parseResult, threadColors, canvas);
  }, [kind, digitized, colorPlans]);

  // Draw the posterized processed bitmap onto its canvas whenever the prep
  // modal is open (the modal mounts the canvas).
  useEffect(() => {
    if (!prepOpen || !processedRgba || !maskDims) return;
    const canvas = processedCanvasRef.current;
    if (!canvas) return;
    canvas.width = maskDims.w;
    canvas.height = maskDims.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imgd = ctx.createImageData(maskDims.w, maskDims.h);
    imgd.data.set(processedRgba);
    ctx.putImageData(imgd, 0, 0);
  }, [prepOpen, processedRgba, maskDims]);

  // DST: per-color-stop normal-stitch counts.
  const normalCountsByStop = useMemo<number[]>(() => {
    if (!parsedDst) return [];
    const counts = new Array<number>(parsedDst.colorStops.length).fill(0);
    let currentColorIndex = 0;
    for (const s of parsedDst.stitches) {
      if (s.type === "end") break;
      if (s.type === "stop") {
        currentColorIndex++;
        continue;
      }
      if (s.type === "normal") counts[currentColorIndex]++;
    }
    return counts;
  }, [parsedDst]);

  const dstStats = useMemo<DstStats | null>(() => {
    if (kind !== "dst" || !parsedDst) return null;
    const excludedNormal = normalCountsByStop.reduce(
      (sum, c, idx) => (excludedDstStops.has(idx) ? sum + c : sum),
      0,
    );
    return {
      kind: "dst",
      stitchCount: Math.max(0, parsedDst.totalStitchCount - excludedNormal),
      widthInches: parsedDst.widthInches,
      heightInches: parsedDst.heightInches,
    };
  }, [kind, parsedDst, excludedDstStops, normalCountsByStop]);

  const imageStats = useMemo<ImageStats | null>(() => {
    if (kind !== "image" || !digitized) return null;
    return {
      kind: "image",
      stitchCount: digitized.totalStitchCount,
      widthInches: digitized.widthMm / MM_PER_INCH,
      heightInches: digitized.heightMm / MM_PER_INCH,
    };
  }, [kind, digitized]);

  const stats: Stats | null = kind === "dst" ? dstStats : imageStats;

  // Render the DST stitch preview when parsed/exclusions change.
  useEffect(() => {
    if (kind !== "dst" || !parsedDst) return;
    const canvas = stitchCanvasRef.current;
    if (!canvas) return;
    const threadColors = parsedDst.colorStops.map(
      (s) => s.assignedThreadHex || s.defaultHex,
    );
    renderDstRealistic(parsedDst, threadColors, canvas, {
      excludedStops: excludedDstStops,
    });
  }, [kind, parsedDst, excludedDstStops]);

  // Render the DST original art preview once when parsed.
  useEffect(() => {
    if (kind !== "dst" || !parsedDst) return;
    const canvas = originalDstCanvasRef.current;
    if (!canvas) return;
    const threadColors = parsedDst.colorStops.map(
      (s) => s.assignedThreadHex || s.defaultHex,
    );
    renderDstRealistic(parsedDst, threadColors, canvas);
  }, [kind, parsedDst]);

  const estimatedMinutes = useMemo(() => {
    if (!stats) return null;
    return Math.max(1, Math.round(stats.stitchCount / 800));
  }, [stats]);

  function onFileSelected(f: File | null) {
    if (!f) return;
    const k = detectKind(f);
    setFile(f);
    setKind(k);
    setSaveError(null);
    setParseError(null);
    setExcludedDstStops(new Set());
    setImageRgba(null);
    setColorPlans([]);
    setSelectedForMerge(new Set());
    setParsedDst(null);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));

    if (k === "dst") {
      parseDstFromFile(f)
        .then(setParsedDst)
        .catch((err: unknown) => {
          const msg =
            err instanceof Error ? err.message : "Could not parse DST file";
          setParseError(msg);
        });
    }
  }

  function toggleDstStop(idx: number) {
    setExcludedDstStops((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    const isAccepted =
      f.type === "image/png" ||
      f.type === "image/jpeg" ||
      /\.(png|jpe?g|dst)$/i.test(f.name);
    if (isAccepted) onFileSelected(f);
  }

  function handleSave() {
    if (!file || !stats) return;
    setSaveError(null);
    const fd = new FormData();
    fd.set("name", name || "Untitled");
    fd.set("art", file);
    fd.set("stitchCount", String(stats.stitchCount));

    startTransition(async () => {
      const result = await saveProject(fd);
      if (result?.error) setSaveError(result.error);
    });
  }

  // Original-art display size in CSS pixels: scale to chosen design width.
  const originalDisplay = useMemo(() => {
    if (kind !== "image" || !imageRgba) return null;
    const aspect = imageRgba.width / imageRgba.height;
    const widthMm = designWidthIn * MM_PER_INCH;
    const heightMm = widthMm / aspect;
    return {
      widthPx: widthMm * DISPLAY_PX_PER_MM,
      heightPx: heightMm * DISPLAY_PX_PER_MM,
    };
  }, [kind, imageRgba, designWidthIn]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Original art
        </h2>

        {!file ? (
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 flex min-h-[320px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center hover:border-zinc-400 dark:hover:border-zinc-600"
          >
            <p className="font-medium">Drop a file here</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              or click to browse · PNG, JPG, DST
            </p>
          </div>
        ) : (
          <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            {kind === "image" && imageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Uploaded artwork"
                onLoad={onImageLoaded}
                style={
                  originalDisplay
                    ? {
                        width: `${originalDisplay.widthPx}px`,
                        height: `${originalDisplay.heightPx}px`,
                      }
                    : undefined
                }
                className="max-h-[480px] max-w-full object-contain"
                crossOrigin="anonymous"
              />
            )}
            {kind === "dst" && (
              <canvas
                ref={originalDstCanvasRef}
                className="max-h-[480px] max-w-full object-contain"
              />
            )}
          </div>
        )}

        {parseError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {parseError}
          </p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".dst,.jpg,.jpeg,.png,image/jpeg,image/png"
          className="hidden"
          onChange={(e) => onFileSelected(e.target.files?.[0] ?? null)}
        />

        {file && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Replace artwork
          </button>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Stitch preview
          </h2>
          {kind === "image" && accepted && (
            <button
              onClick={editPrep}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Edit colors
            </button>
          )}
        </div>

        <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950 p-4">
          {!file && (
            <p className="text-sm text-zinc-500">
              Upload artwork to see the stitch preview.
            </p>
          )}
          {file && kind === "image" && !accepted && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-zinc-500">
                Prepare the artwork first — adjust the processed bitmap, then
                accept.
              </p>
              {colorMasks.length > 0 && (
                <button
                  onClick={() => setPrepOpen(true)}
                  className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  Prepare artwork
                </button>
              )}
            </div>
          )}
          {file && (kind === "dst" || accepted) && (
            <canvas
              ref={stitchCanvasRef}
              className="max-h-[480px] max-w-full object-contain"
            />
          )}
        </div>

        {kind === "image" && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Design width</span>
              <input
                type="number"
                min={0.5}
                max={12}
                step={0.1}
                value={designWidthIn}
                onChange={(e) => setDesignWidthIn(Number(e.target.value))}
                className="h-9 w-20 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2"
              />
              <span className="text-zinc-500">inches</span>
            </label>
          </div>
        )}

        {kind === "dst" && parsedDst && parsedDst.colorStops.length > 0 && (
          <DstColorList
            stops={parsedDst.colorStops.map((s, idx) => ({
              key: String(idx),
              swatch: s.assignedThreadHex || s.defaultHex,
              label: `Stop ${s.stopNumber} · ${normalCountsByStop[idx].toLocaleString()}`,
              tooltip: `${s.assignedThreadHex || s.defaultHex} · ${normalCountsByStop[idx].toLocaleString()} stitches`,
              excluded: excludedDstStops.has(idx),
              onToggle: () => toggleDstStop(idx),
            }))}
          />
        )}

        {stats && (
          <dl className="mt-6 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
              <dt className="text-zinc-500">Stitches</dt>
              <dd className="mt-1 text-lg font-semibold">
                {stats.stitchCount.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
              <dt className="text-zinc-500">Size</dt>
              <dd className="mt-1 text-lg font-semibold">
                {stats.widthInches.toFixed(2)}″ × {stats.heightInches.toFixed(2)}″
              </dd>
            </div>
            <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
              <dt className="text-zinc-500">~Run time</dt>
              <dd className="mt-1 text-lg font-semibold">
                {estimatedMinutes} min
              </dd>
            </div>
          </dl>
        )}
      </section>

      {file && stats && (
        <div className="lg:col-span-2 flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 sm:flex-row sm:items-center">
          <label className="flex-1">
            <span className="sr-only">Project name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="h-10 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
            />
          </label>
          {saveError && (
            <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
          )}
          <button
            onClick={handleSave}
            disabled={isPending}
            className="h-10 rounded-md bg-zinc-900 px-5 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {isPending ? "Saving…" : "Save project"}
          </button>
        </div>
      )}

      {prepOpen && kind === "image" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 lg:col-span-2">
          <div className="w-full max-w-6xl max-h-[95vh] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold">Prepare artwork</h2>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Adjust until the processed bitmap matches what you want to
                  stitch, then accept.
                </p>
              </div>
              <button
                onClick={cancelPrep}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                  Original
                </p>
                <div className="flex items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 h-[320px]">
                  {imageUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={imageUrl}
                      alt="original"
                      className="max-h-full max-w-full object-contain"
                    />
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                  Processed bitmap
                </p>
                <div className="flex items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 h-[320px]">
                  <canvas
                    ref={processedCanvasRef}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-6">
              <label className="flex flex-1 items-center gap-3 text-sm min-w-[240px]">
                <span className="font-medium whitespace-nowrap">Detail</span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={detailLevel}
                  onChange={(e) => onDetailChange(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-8 text-right text-zinc-500">
                  {detailLevel}
                </span>
              </label>
              <span className="text-xs text-zinc-500">
                {colorPlans.length} colors — combine similar ones below
              </span>
            </div>

            {colorPlans.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium">
                    Swatches · {selectedForMerge.size} selected
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setLocateOn((v) => !v)}
                      disabled={!locateOn && selectedForMerge.size < 1}
                      className={`rounded-md px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                        locateOn
                          ? "bg-blue-600 text-white hover:bg-blue-500"
                          : "border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {locateOn ? "Show all" : "Locate"}
                    </button>
                    <button
                      type="button"
                      onClick={removeSelected}
                      disabled={selectedForMerge.size < 1}
                      className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={combineSelected}
                      disabled={selectedForMerge.size < 2}
                      className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Combine
                    </button>
                  </div>
                </div>
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(72px,1fr))]">
                  {colorPlans.map((c, idx) => {
                    const sel = selectedForMerge.has(idx);
                    return (
                      <button
                        key={`${c.hex}-${idx}`}
                        type="button"
                        onClick={() => toggleMergeSelection(idx)}
                        title={`${c.hex} · ${c.pixelCount.toLocaleString()} px`}
                        className={`flex aspect-square flex-col items-center justify-end rounded-md border-2 p-1 text-[10px] font-mono transition ${
                          sel
                            ? "border-blue-500 ring-2 ring-blue-400"
                            : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500"
                        }`}
                        style={{ backgroundColor: c.hex }}
                      >
                        <span
                          className="rounded bg-black/60 px-1 text-white"
                          style={{ textShadow: "0 0 2px rgba(0,0,0,0.8)" }}
                        >
                          {c.hex}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={cancelPrep}
                className="h-10 rounded-md border border-zinc-300 dark:border-zinc-700 px-4 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={acceptPrep}
                disabled={colorPlans.length === 0}
                className="h-10 rounded-md bg-zinc-900 px-5 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Accept &amp; stitch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type DstColorListEntry = {
  key: string;
  swatch: string;
  label: string;
  tooltip: string;
  excluded: boolean;
  onToggle: () => void;
};

function DstColorList({ stops }: { stops: DstColorListEntry[] }) {
  return (
    <div className="mt-6">
      <p className="text-sm font-medium">
        Colors
        <span className="ml-2 text-zinc-500">
          click to exclude from estimate
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {stops.map((e) => (
          <button
            key={e.key}
            type="button"
            onClick={e.onToggle}
            title={e.tooltip}
            className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${
              e.excluded
                ? "border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 line-through"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            <span
              className="inline-block h-4 w-4 rounded-sm border border-zinc-300 dark:border-zinc-600"
              style={{ backgroundColor: e.swatch }}
            />
            <span>{e.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
