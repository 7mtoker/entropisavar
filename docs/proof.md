# Behaviour proof: Entropisavar site — 2026-09-24

Contract: `docs/contract.md`
Build under test: `ES.build = 2026.09.24-1`, equal to `BUILD` in `js/app.js` on disk (P6).
Served files (SHA-256, first 16 hex): index.html be33215756a37bf3 · site.css 411a5b3f92e3961d ·
physics.js bfeda5d6a5d5cfea · gl.js 46f013a47f0bbe9d · fluid.js 5add247602345abc ·
air.js 11ad886997724462 · fire.js 9b3dbefb6a797098 · water.js ad32da0678d07ed4 · app.js d24f725bd101d5df
Browser: headless Edge, real GPU (ANGLE D3D11, Intel UHD), below-normal priority.
Evidence: `tests/out/run-all.log`, `tests/out/e2e-results.json`, screenshots `tests/out/c*.png`.

| Clause | Verdict | Observation |
|---|---|---|
| C1 | pass | no exception or console error over the whole run, http and file:// |
| C2 | pass | 9 requests, all to the local server; 0 image/font/media |
| C3 | pass | hero luminance std 39.2; mean abs frame difference 0.82 over ≥1 s simulated |
| C4 | pass | colourfulness visible 34.4 → thermal 112.1 |
| C5 | pass | 9.0 % of the chamber pixels are flame-lit |
| C6 | pass | φ 0.85: 100 % of lit pixels blue-dominant; φ 2.6: 77 % warm (pixels, not labels — P5) |
| C7 | pass | 22 °C/75 % → "17,4 °C"; 45 % → "9,5 °C" (physics.dewPoint) |
| C8 | pass | single glazing → condensing "Yoğuşma"; triple → drying "Kuruma" |
| C9 | pass | darkest-5 % luminance 8.3 dry → 32.2 fogged; contrast std 76.3 → 54.2 |
| C10 | pass | 2 people 7 302 BTU/h = model; 5 people 8 632 = model |
| C11 | pass | 390 px viewport: scrollWidth 390 |
| C12 | pass | empty submit names the missing field; filled submit says "demo", 0 new requests, same URL |
| P6 | pass | page build equals the constant on disk |

Probes run: P1 (RH, φ and glazing varied, observations moved with them), P2 (two
screenshots per animation clause), P3 (empty form), P5 (flame colour from pixels), P6.

Findings fixed during the proof:
1. C8/C9 — the hidden radio inputs of a segmented control stacked at the group's
   corner and swallowed clicks meant for the first label ("Tek" selected "Üçlü").
   Fixed with `pointer-events: none` on the hidden inputs; the test now clicks labels.
2. Fire — a uniform cross-wind accumulated through open side boundaries
   (divergence-free, invisible to the pressure solve). Side walls closed, air
   drawn from below, flue opening in a heat-exchanger baffle.
3. Fire — bloom used as irradiance fed back with gain ≈4 and whited out the frame;
   irradiance is now normalised by the number of bloom levels.

Blockers: none.
