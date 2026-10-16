# Batcave: true 3D GEX / exposure surface

**Where:** Regime → Thermal Gamma Map → **3D** (phone: More → Regime first). Grid and the older projected view (now labelled **2.5D**) remain.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| Rendering | 2D canvas, orthographic projection, yaw/tilt sliders | WebGL (three.js) with perspective camera and lighting; drag to orbit, pinch/scroll to zoom, two-finger/right-drag to pan |
| Layers | Net only | Net, calls, puts (server now sends `callExposure` / `putExposure`; net = call + put) |
| Scale | One scale | Fit to layer (default) or shared across net/call/put for comparison |
| Expiry depth | Evenly spaced only | Even, or proportional to days to expiry |
| Strikes | 154 far strikes always hidden | Focused (default) or all strikes |
| Levels | Lines on the floor | Vertical planes for spot, gamma flip, call wall and put wall, with labels |
| Axes | Strike/expiry text | Strike ticks, DTE ticks, dollar height ticks on a back wall, floor grid, colour legend |
| Reading values | Hover/tap tooltip | Hover/tap readout: expiry, DTE, strike, layer value, net and call/put split, OI, traded volume, % of scale; marker with crosshair |
| Camera | Sliders | Reset / top / front / side presets, rotate and zoom buttons (44 px, keyboard reachable) |
| Missing data | — | Grid squares with any unobserved or unpriced corner are left open, never drawn as zero |

## Readability pass (sign and relief)

- **$0 is a see-through divider, not a floor.** It is drawn after the surface without writing depth, so troughs below zero stay visible through it. The back wall is tinted green above zero and red below. Axis labels read "+ long gamma" and "− short gamma" (other Greeks: "+ positive" / "− negative"), and the caption always carries the same sign key.
- **Camera:** the default is about 35° elevation and slightly off-axis. **Front** is a true side elevation, so height reads directly against the ticks.
- **Markers are ribbons clipped to the surface:** spot, flip and walls run from $0 to the surface height only, with a dashed floor trace and the label at the ribbon top. They are no longer full-height walls that extend below the floor.
- **Relief:** a stronger key light, plus contour lines on the surface at every non-zero height tick.
- **Split ± scale:** above and below zero each fit their own largest value, so one huge strike does not flatten the other side. The caption shows both maxima, and the readout states which side's maximum the % refers to.

## Honest boundaries

- Dealer side is the assumed convention (long calls, short puts), not observed inventory. Open interest is the prior close, not intraday positioning.
- The preview uses simulated demo data. Live values require the authenticated Schwab connection and validation described in `docs/REAL_DATA_VALIDATION.md`.
- This is an exposure visualisation, not a forecast or a trade signal.

## Performance

three.js is split into its own chunk (`vendor-three`, ~124 KB gzip) and is requested only when the 3D view is opened; the main vendor bundle is unchanged (587 KB). Devices without WebGL get the 3D button disabled with an explanation and keep the 2.5D view.

## Verification

- `tests/quant/surface3d-model.test.ts` (9): shared vs fit scale, holes for missing cells, DTE spacing, level positions, compression, older-server fallback, tick spacing, and a real demo-chain payload whose call + put layers reproduce the net.
- `tests/quant/thermal-heatmap.test.ts` (+1): per-side split sums to net for all five Greeks; GEX call side ≥ 0, put side ≤ 0.
- `tests/quant/surface3d-model.test.ts` (+3): split scaling and ticks, contours only across observed quads at the right height, ribbon heights that follow the surface and stop at holes.
- Full suite: 733 tests, 731 pass, 2 skipped (native SQLite / Python sidecar dependencies), 0 fail.
- Browser (Chromium, real WebGL via SwiftShader): desktop 1440 px and phone 390 px; three.js not loaded before 3D opens; drag orbit, presets, zoom, rotate, all layer/spacing/scale/strike toggles; tap and hover readout (calls + puts = net confirmed on screen); no document overflow; all controls ≥ 44 px; one WebGL canvas after view switches (no context leak); WebGL-disabled device falls back to 2.5D; zero page errors.
- Not verified: physical iPhone Safari, low-end GPU frame rate, live Schwab data.
