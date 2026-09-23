# Entropisavar — implementation plan

Goal: a futuristic, sarcastic marketing site for a fictional HVAC company whose
centrepiece is three real-time, physically based simulations — air, fire,
water — drawn entirely in code (no images, fonts, icon sets, audio or
libraries).

## Constraints

- Zero ready-made assets: no `<img>`, no bitmap/vector files, no web fonts, no
  CDN scripts, no `data:` media. Every visual is WebGL2, CSS or hand-written
  inline SVG. System font stack only.
- Opens from disk (`file://`): classic scripts on a single `window.ES`
  namespace, no ES modules, no fetch.
- Every physical number shown on the page comes from `js/physics.js`, which
  is unit-tested in Node.
- Honest exaggeration: where the rendering amplifies an effect (heat-haze
  refraction, time-lapse growth) the page says so.

## Files

| file | responsibility |
|---|---|
| `index.html` | markup, copy, inline SVG glyphs |
| `css/site.css` | tokens, layout, HUD components |
| `js/physics.js` | pure formulas: Magnus dew point, glazing surface temp, Planck + CIE 1931 blackbody colour, Carnot COP, cooling load, drop mechanics. UMD (browser + Node) |
| `js/gl.js` | WebGL2 toolkit: context + float targets, programs, ping-pong, bloom, async PBO readback |
| `js/air.js` | Boussinesq air solver (AC jet, heat plume, closed room), 3 views: visible / thermal / schlieren |
| `js/fire.js` | reacting-flow solver: one-step Arrhenius chemistry, mixture fraction, soot, thermal expansion, blackbody + chemiluminescence rendering |
| `js/water.js` | condensation on glass: CPU drop mechanics (growth, Furmidge pinning, coalescence, trails) + GPU fog and refraction |
| `js/app.js` | lazy start/pause per section, quality governor, controls, calculator, form |
| `tests/physics.test.js` | unit tests for `physics.js` (node:test) |
| `tests/static-check.mjs` | asset ban, title, file:// safety, no network calls |
| `tests/e2e.mjs` | black-box: headless Edge/Chrome over CDP, screenshots decoded and measured |
| `tests/run-all.mjs` | acceptance entry point for `radar task new --accept` |

## Order (TDD)

1. `physics.test.js` red → `physics.js` green.
2. `static-check.mjs` and `e2e.mjs` written from `docs/contract.md` before the page exists (red).
3. `gl.js`, then one simulation at a time, each rendered and looked at before the next.
4. Page shell, copy, calculator, form.
5. `run-all.mjs` green; behaviour-proof report in `docs/proof.md`.
