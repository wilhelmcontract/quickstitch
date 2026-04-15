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

type StitchStats = {
  stitchCount: number;
  gridW: number;
  gridH: number;
  uniqueColors: number;
};

const DEFAULT_DENSITY = 100;
const PREVIEW_SIZE = 640;

export function Estimator() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [density, setDensity] = useState(DEFAULT_DENSITY);
  const [name, setName] = useState("");
  const [stats, setStats] = useState<StitchStats | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const imgRef = useRef<HTMLImageElement | null>(null);
  const stitchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const renderStitches = useCallback(() => {
    const img = imgRef.current;
    const canvas = stitchCanvasRef.current;
    if (!img || !canvas || !img.complete || img.naturalWidth === 0) return;

    const aspect = img.naturalWidth / img.naturalHeight;
    const gridW = density;
    const gridH = Math.max(1, Math.round(density / aspect));

    const cellSize = Math.max(2, Math.floor(PREVIEW_SIZE / Math.max(gridW, gridH)));
    const canvasW = gridW * cellSize;
    const canvasH = gridH * cellSize;

    canvas.width = canvasW;
    canvas.height = canvasH;

    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = gridW;
    sampleCanvas.height = gridH;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return;
    sampleCtx.drawImage(img, 0, 0, gridW, gridH);
    const { data } = sampleCtx.getImageData(0, 0, gridW, gridH);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, 0, canvasW, canvasH);

    let stitchCount = 0;
    const colorBuckets = new Set<string>();
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, cellSize * 0.35);

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const i = (y * gridW + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 32) continue;

        const cx = x * cellSize;
        const cy = y * cellSize;
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.moveTo(cx + cellSize * 0.15, cy + cellSize * 0.15);
        ctx.lineTo(cx + cellSize * 0.85, cy + cellSize * 0.85);
        ctx.moveTo(cx + cellSize * 0.85, cy + cellSize * 0.15);
        ctx.lineTo(cx + cellSize * 0.15, cy + cellSize * 0.85);
        ctx.stroke();

        stitchCount++;
        colorBuckets.add(
          `${r >> 5}-${g >> 5}-${b >> 5}`,
        );
      }
    }

    setStats({
      stitchCount,
      gridW,
      gridH,
      uniqueColors: colorBuckets.size,
    });
  }, [density]);

  useEffect(() => {
    if (!previewUrl) return;
    const id = requestAnimationFrame(renderStitches);
    return () => cancelAnimationFrame(id);
  }, [previewUrl, density, renderStitches]);

  const estimatedMinutes = useMemo(() => {
    if (!stats) return null;
    // Rough heuristic: ~800 stitches per minute on a commercial machine.
    return Math.max(1, Math.round(stats.stitchCount / 800));
  }, [stats]);

  function onFileSelected(f: File | null) {
    if (!f) return;
    setFile(f);
    setSaveError(null);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) onFileSelected(f);
  }

  function handleSave() {
    if (!file || !stats) return;
    setSaveError(null);
    const fd = new FormData();
    fd.set("name", name || "Untitled");
    fd.set("art", file);
    fd.set("stitchCount", String(stats.stitchCount));
    fd.set("gridW", String(stats.gridW));
    fd.set("gridH", String(stats.gridH));

    startTransition(async () => {
      const result = await saveProject(fd);
      if (result?.error) setSaveError(result.error);
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left: Upload + original */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Original art
        </h2>

        {!previewUrl ? (
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 flex min-h-[320px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center hover:border-zinc-400 dark:hover:border-zinc-600"
          >
            <p className="font-medium">Drop an image here</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              or click to browse · PNG, JPG, SVG
            </p>
          </div>
        ) : (
          <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={previewUrl}
              alt="Uploaded artwork"
              onLoad={renderStitches}
              className="max-h-[480px] max-w-full object-contain"
              crossOrigin="anonymous"
            />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onFileSelected(e.target.files?.[0] ?? null)}
        />

        {previewUrl && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Replace artwork
          </button>
        )}
      </section>

      {/* Right: Stitch preview */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Stitch preview
        </h2>

        <div className="mt-4 flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950 p-4">
          {previewUrl ? (
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

        {stats && (
          <dl className="mt-6 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
              <dt className="text-zinc-500">Stitches</dt>
              <dd className="mt-1 text-lg font-semibold">
                {stats.stitchCount.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-md bg-zinc-100 dark:bg-zinc-800 p-3">
              <dt className="text-zinc-500">Grid</dt>
              <dd className="mt-1 text-lg font-semibold">
                {stats.gridW}×{stats.gridH}
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

      {/* Save bar */}
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
