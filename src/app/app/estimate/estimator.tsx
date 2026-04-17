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
const DEFAULT_NUM_COLORS = 4;
const MM_PER_INCH = 25.4;
const DISPLAY_PX_PER_MM = 8;

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
  const [numColors, setNumColors] = useState(DEFAULT_NUM_COLORS);
  const [imageRgba, setImageRgba] = useState<RgbaImage | null>(null);
  const [colorPlans, setColorPlans] = useState<ColorPlan[]>([]);
  const [colorMasks, setColorMasks] = useState<Uint8Array[]>([]);
  const [maskDims, setMaskDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [vectorSvg, setVectorSvg] = useState<string | null>(null);
  const [previewView, setPreviewView] = useState<"stitch" | "vector">("stitch");
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
    runDetect(rgba, numColors);
  }

  function runDetect(rgba: RgbaImage, n: number) {
    const v = vectorize(rgba.data, rgba.width, rgba.height, n);
    setColorPlans(v.palette.map(defaultColorPlan));
    setColorMasks(v.masks);
    setMaskDims({ w: v.width, h: v.height });
    setVectorSvg(v.svgString);
    setSelectedForMerge(new Set());
  }

  function onNumColorsChange(n: number) {
    setNumColors(n);
    if (imageRgba) runDetect(imageRgba, n);
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
  }

  function toggleMergeSelection(i: number) {
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const digitized = useMemo<DigitizeResult | null>(() => {
    if (
      kind !== "image" ||
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
  }, [kind, colorMasks, maskDims, colorPlans, designWidthIn]);

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

  function updateColorPlan(idx: number, patch: Partial<ColorPlan>) {
    setColorPlans((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
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
            {previewView === "stitch" ? "Stitch preview" : "Vector output"}
          </h2>
          {kind === "image" && vectorSvg && (
            <div className="flex gap-1 text-xs">
              <button
                onClick={() => setPreviewView("stitch")}
                className={`rounded-md px-2 py-1 ${
                  previewView === "stitch"
                    ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border border-zinc-300 dark:border-zinc-700"
                }`}
              >
                Stitch
              </button>
              <button
                onClick={() => setPreviewView("vector")}
                className={`rounded-md px-2 py-1 ${
                  previewView === "vector"
                    ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border border-zinc-300 dark:border-zinc-700"
                }`}
              >
                Vector
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950 p-4">
          {!file && (
            <p className="text-sm text-zinc-500">
              Upload artwork to see the stitch preview.
            </p>
          )}
          {file && previewView === "stitch" && (
            <canvas
              ref={stitchCanvasRef}
              className="max-h-[480px] max-w-full object-contain"
            />
          )}
          {file && previewView === "vector" && vectorSvg && (
            <div
              className="[&_svg]:max-h-[480px] [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:w-auto bg-white rounded"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: vectorSvg }}
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
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium"># colors</span>
              <input
                type="number"
                min={1}
                max={12}
                step={1}
                value={numColors}
                onChange={(e) => onNumColorsChange(Number(e.target.value))}
                className="h-9 w-16 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2"
              />
            </label>
          </div>
        )}

        {kind === "image" && colorPlans.length > 0 && (
          <ImageColorList
            plans={colorPlans}
            onUpdate={updateColorPlan}
            stitchCounts={digitized?.perColorStitchCount ?? []}
            selected={selectedForMerge}
            onToggleSelected={toggleMergeSelection}
            onCombine={combineSelected}
          />
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
    </div>
  );
}

function ImageColorList({
  plans,
  onUpdate,
  stitchCounts,
  selected,
  onToggleSelected,
  onCombine,
}: {
  plans: ColorPlan[];
  onUpdate: (idx: number, patch: Partial<ColorPlan>) => void;
  stitchCounts: number[];
  selected: Set<number>;
  onToggleSelected: (idx: number) => void;
  onCombine: () => void;
}) {
  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Colors</p>
        <button
          type="button"
          onClick={onCombine}
          disabled={selected.size < 2}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
        >
          Combine selected ({selected.size})
        </button>
      </div>
      {plans.map((c, idx) => (
        <div
          key={idx}
          className={`rounded-md border p-3 ${
            c.excluded
              ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 opacity-60"
              : selected.has(idx)
                ? "border-blue-500 dark:border-blue-400 ring-1 ring-blue-500"
                : "border-zinc-300 dark:border-zinc-700"
          }`}
        >
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={selected.has(idx)}
              onChange={() => onToggleSelected(idx)}
              title="Select for combine"
            />
            <span
              className="inline-block h-6 w-6 rounded-sm border border-zinc-300 dark:border-zinc-600"
              style={{ backgroundColor: c.hex }}
            />
            <span className="text-sm font-mono">{c.hex}</span>
            <span className="ml-auto text-xs text-zinc-500">
              {stitchCounts[idx].toLocaleString()} stitches
            </span>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={c.excluded}
                onChange={(e) => onUpdate(idx, { excluded: e.target.checked })}
              />
              Off
            </label>
          </div>
          {!c.excluded && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-xs">
                <div className="flex justify-between">
                  <span>Density</span>
                  <span className="text-zinc-500">
                    {c.density.toFixed(2)}×
                  </span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={c.density}
                  onChange={(e) =>
                    onUpdate(idx, { density: Number(e.target.value) })
                  }
                  className="mt-1 w-full"
                />
              </label>
              <label className="text-xs">
                <div className="flex justify-between">
                  <span>Pull comp</span>
                  <span className="text-zinc-500">
                    {c.pullCompMm.toFixed(2)} mm
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={c.pullCompMm}
                  onChange={(e) =>
                    onUpdate(idx, { pullCompMm: Number(e.target.value) })
                  }
                  className="mt-1 w-full"
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={c.splitWideSatin}
                  onChange={(e) =>
                    onUpdate(idx, { splitWideSatin: e.target.checked })
                  }
                />
                <span>Split wide satin (≥6mm)</span>
              </label>
            </div>
          )}
        </div>
      ))}
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
