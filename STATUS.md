# Quickstitch — session status (2026-04-17)

Snapshot of where things stand so you can pick up from home without re-reading the whole conversation.

## What shipped and is working

- **Vector re-architecture**: `src/lib/vectorize.ts` wraps imagetracerjs's `colorquantization`. `digitize()` now takes precomputed per-color masks instead of building them from raw pixels.
- **Prep-artwork modal** (Hatch-style): on upload, modal opens with Original + Processed bitmap side-by-side. Detail slider (0–10) drives `numColors` (2→48), `blurRadius` (6→0), `minBucketCount` (40→1). Stitching is gated on the Accept button; no stitches render until the processed bitmap is approved.
- **Swatch grid in modal**: click to select, then **Combine** (merges palette + OR's masks) or **Remove** (drops the selected from palette + masks). **Locate** toggle isolates only the selected swatches' pixels in the processed bitmap so you can see exactly what region a swatch owns.
- **Slider debounce** (250ms) so vectorize doesn't re-run on every pixel of drag.
- **Main preview after Accept**:
  - Stitch canvas with the realistic DST render
  - Per-color diagnostic strip: `#hex · stitchType · stitch count` (e.g. `#10b981 · satin · 432`)
  - **Edit colors** button reopens the prep modal
- **Color isolation enforced**: `buildMasks` bug that rerouted excluded colors' pixels into neighbours was fixed early; excluded/removed regions now stay empty.
- **Stitch calibration** (from your reference `shield running.DST` / `shield satin.DST`):
  - Running stitch length: 1.5mm
  - Satin spacing: 0.4mm, dynamic bar width from skeleton walk-out
  - Fill: 4mm stitch / 0.4mm row spacing @ 55°, tatami stagger on a global grid, serpentine rows
  - Classifier: `<1.5mm` running, `1.5–6mm` satin, `>6mm` fill
- **One skeleton polyline = one region**: transitions between sub-polylines (e.g. shield ring + pointed-bottom branch) now become jump stitches instead of visible threads across the interior.
- **Page fills viewport** (max-width removed from `/app/estimate`).
- **CLAUDE.md pre-push rule**: auto-push at ≥90% confidence with explicit trace; below 90% stop and report.

## What is still broken

### Shield outline renders as solid fill

- Upload `C:\Users\colet\OneDrive\Desktop\wip\Untitled-1.png` (1024×1024 RGBA, green ring on white/transparent, white interior).
- Accepted output: `#68b381 · fill · 8,563 stitches`.
- Expected: satin bars around the ~5mm green ring only; interior unstitched.
- Observed: solid muted-green shield-shape covering the entire shield (ring + interior).

### What's been ruled out

- K-means++ seeding correctly filters transparent/near-white → seeds come only from the green ring.
- Per-polyline region split (commit `3ca029a`) can't fix this because the shape is classified as `fill`, not `satin`, so the skeleton-satin path never runs.
- Stitch-length / classifier threshold changes are correct; they just don't apply when the mask is wrong.

### Last push that didn't fix it

`1fce4dc Filter background at mask-building, not just seeding` — theory was that imagetracerjs assigns every pixel to the nearest palette slot (it has no "no-color" slot), so transparent + near-white pixels were entering the green mask. Fix applied the same (alpha<32 || rgb≥240) filter to the mask-building loop that already ran during seeding.

**User tested after deploy: same exact result.** Theory was wrong, or something else is compounding.

## Diagnostic steps for next session

Do these **before** any more code pushes:

1. **Verify Vercel deployment** actually shipped `1fce4dc`. Check the deploys tab.
2. **Run the pipeline against the shield PNG in Node** to see what mask actually comes out. I started a script at `/tmp/test-vectorize.mjs` but `pngjs` isn't installed. Either:
   - `npm i -D pngjs` and complete the script.
   - Or decode via `sharp` (if easier to add).
   - Output: palette size, per-color mask pixel count, per-color mask bounding box. Compare mask pixel count to expected ring perimeter × ring thickness.
3. **If Node says mask is ring-shaped** but app still renders solid fill, the bug is between state and digitize — inspect:
   - `combineSelected` / `removeSelected` mask updates (do they actually replace `colorMasks` correctly?)
   - Mask staleness across re-runs of `runDetect`
   - Whether `digitize` is using the current `colorMasks` or a stale closure
4. **If Node says mask is solid-shield**, imagetracerjs is bleeding bg into the mask despite the filter — investigate its `blur` preprocessing (partial alpha on blurred edges might mean `a<32` filter misses bg pixels that got slightly opaque from blur).

## Key files

| File | Purpose |
|---|---|
| `src/lib/vectorize.ts` | imagetracerjs wrapper + k-means++ seeding + mask morph smoothing |
| `src/lib/digitize.ts` | mask → regions → satin / fill / running stitch emission |
| `src/lib/dstParser.ts` | DST parsing + realistic thread rendering |
| `src/app/app/estimate/estimator.tsx` | UI: prep modal, stitch preview, swatches, diagnostic strip |
| `src/lib/imagetracerjs.d.ts` | type stub for the untyped library |

## Key lesson from this session

Pushed too many "this should fix it" changes without actually verifying the theory against real data. Next session: **verify in Node before pushing any mask-related change.** One round trip of verification is cheaper than one wrong push + deploy + re-test cycle.

See `MEMORY.md` for long-term notes; `project_shield_mask_bug_open.md` and `feedback_trace_before_pushing.md` capture the specifics.
