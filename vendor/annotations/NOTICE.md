# OpenChamber annotation provenance

The four `.ts` sources in this directory are copied without source changes from OpenChamber commit `651a0564880633fbcdc2ac3f84d08e42c7748a64` (version 2.7.0):

- `packages/ui/src/lib/browser/annotationOverlay.ts`
- `packages/ui/src/lib/browser/annotationPrompt.ts`
- `packages/ui/src/lib/browser/annotationScreenshot.ts`
- `packages/ui/src/lib/browser/contract.ts`

The corresponding `.js` files are generated with esbuild 0.25.12, ESM, platform browser, target es2022. No functional source changes were applied. The overlay includes its upstream inline attachment icon SVG.

Copyright (c) 2025 Bohdan Triapitsyn. MIT licensed. The complete license is retained in `../LICENSE.openchamber` and applies to these copied substantial portions. Include this notice and that license with distribution. No upstream branding/logo assets are included here.

`src/annotations.js` is a DSH-specific adapter around those primitives. It adds host-owned lifecycle, cancellation, navigation cleanup, bounded payload/capture validation, capture format normalization, and truthful attachment metadata. It does not give guest pages any new host IPC or global bridge.

Regenerate JavaScript from the exact TypeScript sources:

```powershell
.\node_modules\.bin\esbuild.ps1 vendor/annotations/annotationOverlay.ts vendor/annotations/contract.ts vendor/annotations/annotationPrompt.ts vendor/annotations/annotationScreenshot.ts --outdir=vendor/annotations --format=esm --platform=browser --target=es2022
```
