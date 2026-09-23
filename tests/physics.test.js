// Unit tests for js/physics.js — every number the site prints comes from there.
// Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics.js');

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected} ± ${tol}, got ${actual}`);

test('Magnus saturation vapour pressure over water', () => {
  near(P.saturationVaporPressure(0), 6.1094, 1e-4, 'e_s(0 °C) hPa');
  near(P.saturationVaporPressure(20), 23.39, 0.1, 'e_s(20 °C) hPa'); // steam tables 23.39
  near(P.saturationVaporPressure(30), 42.47, 0.15, 'e_s(30 °C) hPa'); // steam tables 42.47
});

test('dew point matches Magnus reference values', () => {
  near(P.dewPoint(20, 50), 9.26, 0.02, 'Td(20 °C, 50 %)');
  near(P.dewPoint(22, 75), 17.37, 0.02, 'Td(22 °C, 75 %)');
  near(P.dewPoint(22, 45), 9.52, 0.02, 'Td(22 °C, 45 %)');
  for (const t of [-10, 0, 25]) near(P.dewPoint(t, 100), t, 1e-9, `Td(${t}, 100 %)`);
});

test('relative humidity inverts dew point', () => {
  for (const [t, rh] of [[22, 75], [5, 30], [30, 90]]) {
    near(P.relativeHumidity(t, P.dewPoint(t, rh)), rh, 1e-9, `RH round trip ${t}/${rh}`);
  }
});

test('glass surface temperature from U-value and inside film coefficient', () => {
  near(P.glassSurfaceTemp(20, 0, 5.8), 20 - 5.8 * 20 / 7.7, 1e-12, 'single glazing');
  assert.deepEqual(Object.keys(P.GLAZING).sort(), ['double', 'single', 'triple']);
  const td = P.dewPoint(22, 75);
  assert.ok(P.glassSurfaceTemp(22, -2, P.GLAZING.single.u) < td, 'single glazing condenses');
  assert.ok(P.glassSurfaceTemp(22, -2, P.GLAZING.triple.u) > td, 'triple glazing stays dry');
});

test('supersaturation sign follows dew point', () => {
  assert.ok(P.supersaturation(22, 75, 5) > 0);
  assert.ok(P.supersaturation(22, 75, 20) < 0);
  near(P.supersaturation(22, 75, P.dewPoint(22, 75)), 0, 1e-9, 'S at dew point');
});

test('Planck law obeys Wien displacement and Stefan–Boltzmann', () => {
  let best = 0, peak = 0;
  for (let nm = 400; nm <= 800; nm += 0.05) {
    const b = P.planck(nm, 5000);
    if (b > best) { best = b; peak = nm; }
  }
  near(peak, 2.897771955e6 / 5000, 0.1, 'Wien peak nm at 5000 K');

  // pi * integral of B over wavelength = sigma T^4
  const T = 1500;
  let sum = 0;
  const lo = Math.log(50), hi = Math.log(2e6), n = 20000, dl = (hi - lo) / n;
  for (let i = 0; i < n; i++) {
    const nm = Math.exp(lo + (i + 0.5) * dl);
    sum += P.planck(nm, T) * nm * 1e-9 * dl; // dλ = λ d(lnλ), λ in metres
  }
  const sigma = 5.670374419e-8;
  near(Math.PI * sum / (sigma * T ** 4), 1, 0.002, 'Stefan–Boltzmann ratio');
});

test('blackbody chromaticity sits on the CIE 1931 Planckian locus', () => {
  // Reference points of the Planckian locus (CIE 1931 2° observer).
  const locus = [
    [1000, 0.6528, 0.3444],
    [1500, 0.5857, 0.3931],
    [2000, 0.5267, 0.4133],
    [3000, 0.4369, 0.4041],
    [6500, 0.3135, 0.3237],
  ];
  for (const [T, x, y] of locus) {
    const [cx, cy] = P.xyzToChromaticity(P.blackbodyXYZ(T));
    near(cx, x, 0.001, `x(${T} K)`);
    near(cy, y, 0.001, `y(${T} K)`);
  }
});

test('blackbody colour ordering and luminance growth', () => {
  const c1500 = P.blackbodyColor(1500), c2000 = P.blackbodyColor(2000), c6500 = P.blackbodyColor(6500);
  assert.ok(c1500.rgb[0] > c1500.rgb[1] && c1500.rgb[1] > c1500.rgb[2], '1500 K is red > green > blue');
  const [r, g, b] = c6500.rgb;
  assert.ok(Math.max(r, g, b) / Math.min(r, g, b) < 1.15, '6500 K is near neutral');
  assert.ok(Math.max(...c2000.rgb) === 1, 'rgb is max-normalised');
  assert.ok(c2000.Y / c1500.Y > 20 && c2000.Y / c1500.Y < 200, 'luminance rises steeply with T');
  assert.ok(c1500.rgb.every(v => v >= 0), 'out-of-gamut channels clamp at 0');
});

test('spectral line colours: CH* 431 nm is blue, C2* 516 nm is green', () => {
  const ch = P.spectralLineColor(431), c2 = P.spectralLineColor(516);
  assert.ok(ch[2] > ch[1] && ch[2] > ch[0], 'CH* blue dominant');
  assert.ok(c2[1] > c2[0] && c2[1] > c2[2], 'C2* green dominant');
});

test('Carnot limits', () => {
  near(P.carnotCopCooling(25, 35), 298.15 / 10, 1e-9, 'cooling COP 25→35 °C');
  near(P.carnotCopHeating(-7, 35), 308.15 / 42, 1e-9, 'heating COP -7→35 °C');
  assert.equal(P.carnotCopCooling(30, 30), Infinity);
});

test('unit conversions and flow numbers', () => {
  near(P.wattsToBtuPerHour(1000), 3412.142, 1e-3, 'W → BTU/h');
  near(P.buoyancyAccel(10, 300), 9.80665 * 10 / 300, 1e-12, 'Boussinesq acceleration');
  near(P.reynolds(3, 0.06), 12000, 1e-6, 'Re of AC outlet');
});

test('cooling load: worked example and invariants', () => {
  const room = {
    area: 20, height: 2.7, windowArea: 3, orientation: 'W', insulation: 'medium',
    glazing: 'double', people: 2, devicesW: 300, tOut: 35, tIn: 24,
  };
  const out = P.coolingLoad(room);
  // Independent arithmetic of the documented model (see physics.js header).
  const wallLen = Math.sqrt(20) * 1.5;
  const wallA = wallLen * 2.7 - 3;
  const trans = (0.8 * wallA + 2.8 * 3) * 11;
  const solar = 3 * 550 * 0.7;
  const people = 2 * 130;
  const devices = 300 + 20 * 5;
  const infil = 20 * 2.7 * 0.5 * (1.2 * 1005 / 3600) * 11;
  near(out.parts.transmission, trans, 1e-9, 'transmission');
  near(out.parts.solar, solar, 1e-9, 'solar');
  near(out.parts.people, people, 1e-9, 'people');
  near(out.parts.devices, devices, 1e-9, 'devices');
  near(out.parts.infiltration, infil, 1e-9, 'infiltration');
  near(out.total, trans + solar + people + devices + infil, 1e-9, 'total = sum of parts');

  const more = P.coolingLoad({ ...room, people: 3 });
  near(more.total - out.total, 130, 1e-9, 'one person = 130 W');
  assert.ok(P.coolingLoad({ ...room, tOut: 40 }).total > out.total, 'hotter outside → more load');
  const cold = P.coolingLoad({ ...room, tOut: 10 });
  for (const [k, v] of Object.entries(cold.parts)) assert.ok(v >= 0, `${k} non-negative`);
});

test('standard unit selection', () => {
  assert.equal(P.recommendUnit(8000), 9000);
  assert.equal(P.recommendUnit(9000), 9000);
  assert.equal(P.recommendUnit(9001), 12000);
  assert.equal(P.recommendUnit(23000), 24000);
  assert.equal(P.recommendUnit(30000), null);
});

test('drop mechanics: cap volume, sliding threshold, coalescence', () => {
  near(P.sphericalCapVolume(1, 90), 2 * Math.PI / 3, 1e-12, 'hemisphere');
  const a = P.criticalSlideRadius();
  assert.ok(a > 1.5e-3 && a < 3e-3, `critical radius ${a} m should be 1.5–3 mm`);
  near(P.mergeRadius(1, 1), Math.cbrt(2), 1e-12, 'equal drops');
  const r = P.mergeRadius(0.3, 1.1);
  near(r ** 3, 0.3 ** 3 + 1.1 ** 3, 1e-12, 'volume conserved');
});
