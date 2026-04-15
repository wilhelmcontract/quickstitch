"use client";

import {
  useCallback,
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
  drawRealisticStitch,
  type DstParseResult,
} from "@/lib/dstParser";

type ImageBucket = {
  key: string;
  r: number;
  g: number;
  b: number;
  count: number;
};

type ImageStats = {
  kind: "image";
  stitchCount: number;
  gridW: number;
  gridH: number;
  uniqueColors: number;
};

type DstStats = {
  kind: "dst";
  stitchCount: number;
  widthInches: number;
  heightInches: number;
};

type Stats = ImageStats | DstStats;

type FileKind = "image" | "dst";

const DEFAULT_DENSITY = 100;
const PREVIEW_SIZE = 640;

function detectKind(f: File): FileKind {
  return /\.dst$/i.test(f.name) ? "dst" : "image";
}

export function Estimator() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<FileKind | null>(null);
  const [parsedDst, setParsedDst] = useState<DstParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [density, setDensity] = useState(DEFAULT_DENSITY);
  const [name, setName] = useState("");
  const [imageStats, setImageStats] = useState<ImageStats | null>(null);

  const [imageBuckets, setImageBuckets] = useState<ImageBucket[]>([]);
  const [excludedBuckets, setExcludedBuckets] = useState<Set<string>>(
    new Set(),
  );
  const [excludedDstStops, setExcludedDstStops] = useState<Set<number>>(
    new Set(),
  );

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

  const renderImageStitches = useCallback(() => {
    const img = imgRef.current;
    const canvas = stitchCanvasRef.current;
    if (!img || !canvas || !img.complete || img.naturalWidth === 0) return;

    const aspect = img.naturalWidth / img.naturalHeight;
    const gridW = density;
    const gridH = Math.max(1, Math.round(density / aspect));

    const cellSize = Math.max(
      2,
      Math.floor(PREVIEW_SIZE / Math.max(gridW, gridH)),
    );
    const canvasW = gridW * cellSize;
    const canvasH = gridH * cellSize;

    canvas.width = canvasW;
    canvas.height = canvasH;

    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = gridW;
    sampleCanvas.height = gridH;
    const sampleCtx = sampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!sampleCtx) return;
    sampleCtx.drawImage(img, 0, 0, gridW, gridH);
    const { data } = sampleCtx.getImageData(0, 0, gridW, gridH);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const checkSize = 12;
    for (let cy = 0; cy < canvasH; cy += checkSize) {
      for (let cx = 0; cx < canvasW; cx += checkSize) {
        const isDark =
          (Math.floor(cx / checkSize) + Math.floor(cy / checkSize)) % 2 === 0;
        ctx.fillStyle = isDark ? "#d4d4d8" : "#f4f4f5";
        ctx.fillRect(cx, cy, checkSize, checkSize);
      }
    }

    let stitchCount = 0;
    const bucketMap = new Map<
      string,
      { r: number; g: number; b: number; count: number }
    >();
    const threadWidth = Math.max(1.5, cellSize * 0.6);

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const i = (y * gridW + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 32) continue;

        const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
        const bucket = bucketMap.get(key);
        if (bucket) {
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          bucket.count += 1;
        } else {
          bucketMap.set(key, { r, g, b, count: 1 });
        }

        if (excludedBuckets.has(key)) continue;

        const cx = x * cellSize;
        const cy = y * cellSize;
        const x1 = cx + cellSize * 0.1;
        const ymid = cy + cellSize * 0.5;
        const x2 = cx + cellSize * 0.9;
        const hex = `#${[r, g, b]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")}`;
        drawRealisticStitch(ctx, x1, ymid, x2, ymid, hex, threadWidth);
        stitchCount++;
      }
    }

    const bucketList: ImageBucket[] = Array.from(bucketMap.entries())
      .map(([key, v]) => ({
        key,
        r: Math.round(v.r / v.count),
        g: Math.round(v.g / v.count),
        b: Math.round(v.b / v.count),
        count: v.count,
      }))
      .sort((a, b) => b.count - a.count);

    setImageBuckets(bucketList);
    setImageStats({
      kind: "image",
      stitchCount,
      gridW,
      gridH,
      uniqueColors: bucketList.filter((c) => !excludedBuckets.has(c.key))
        .length,
    });
  }, [density, excludedBuckets]);

  useEffect(() => {
    if (kind !== "image" || !imageUrl) return;
    const id = requestAnimationFrame(renderImageStitches);
    return () => cancelAnimationFrame(id);
  }, [kind, imageUrl, density, excludedBuckets, renderImageStitches]);

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

  const stats: Stats | null = kind === "dst" ? dstStats : imageStats;

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
    setExcludedBuckets(new Set());
    setExcludedDstStops(new Set());
    setImageStats(null);
    setImageBuckets([]);
    setParsedDst(null);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));

    if (k === "dst") {
      parseDstFromFile(f)
        .then(setParsedDst)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Could not parse DST file";
          setParseError(msg);
        });
    }
  }

  function toggleImageBucket(key: string) {
    setExcludedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
    if (stats.kind === "image") {
      fd.set("gridW", String(stats.gridW));
      fd.set("gridH", String(stats.gridH));
    }

    startTransition(async () => {
      const result = await saveProject(fd);
      if (result?.error) setSaveError(result.error);
    });
  }

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
                onLoad={renderImageStitches}
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Stitch preview
        </h2>

        <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950 p-4">
          {file ? (
            <canvas
              ref={stitchCanvasRef}
              className="max-h-[480px] max-w-full object-contain"
            />
          ) : (
            <p className="text-sm text-zinc-500">
              Upload artwork to see the stitch preview.
            </p>
          )}
        </div>

        {kind === "image" && (
          <div className="mt-4 grid gap-2">
            <label className="flex items-center justify-between text-sm">
              <span className="font-medium">Stitch density</span>
              <span className="text-zinc-500">{density} across</span>
            </label>
            <input
              type="range"
              min={40}
              max={240}
              step={4}
              value={density}
              onChange={(e) => setDensity(Number(e.target.value))}
              className="w-full"
            />
          </div>
        )}

        {kind === "image" && imageBuckets.length > 0 && (
          <ColorList
            entries={imageBuckets.map((c) => ({
              key: c.key,
              swatch: `rgb(${c.r},${c.g},${c.b})`,
              label: c.count.toLocaleString(),
              tooltip: `rgb(${c.r}, ${c.g}, ${c.b}) · ${c.count} px`,
              excluded: excludedBuckets.has(c.key),
              onToggle: () => toggleImageBucket(c.key),
            }))}
          />
        )}

        {kind === "dst" && parsedDst && parsedDst.colorStops.length > 0 && (
          <ColorList
            entries={parsedDst.colorStops.map((s, idx) => {
              const n = normalCountsByStop[idx];
              return {
                key: String(idx),
                swatch: s.assignedThreadHex || s.defaultHex,
                label: `Stop ${s.stopNumber} · ${n.toLocaleString()}`,
                tooltip: `${s.assignedThreadHex || s.defaultHex} · ${n.toLocaleString()} stitches`,
                excluded: excludedDstStops.has(idx),
                onToggle: () => toggleDstStop(idx),
              };
            })}
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
            {stats.kind === "image" ? (
              <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
                <dt className="text-zinc-500">Grid</dt>
                <dd className="mt-1 text-lg font-semibold">
                  {stats.gridW}×{stats.gridH}
                </dd>
              </div>
            ) : (
              <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
                <dt className="text-zinc-500">Size</dt>
                <dd className="mt-1 text-lg font-semibold">
                  {stats.widthInches.toFixed(2)}″ × {stats.heightInches.toFixed(2)}″
                </dd>
              </div>
            )}
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

type ColorListEntry = {
  key: string;
  swatch: string;
  label: string;
  tooltip: string;
  excluded: boolean;
  onToggle: () => void;
};

function ColorList({ entries }: { entries: ColorListEntry[] }) {
  return (
    <div className="mt-6">
      <p className="text-sm font-medium">
        Colors
        <span className="ml-2 text-zinc-500">
          click to exclude from estimate
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {entries.map((e) => (
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
