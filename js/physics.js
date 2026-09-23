/*
 * physics.js — the only source of physical numbers on the page.
 *
 * Pure functions, no DOM. Loaded as a classic script in the browser
 * (window.ES.physics) and with require() by the Node tests.
 *
 * Models and their sources:
 *  - Saturation vapour pressure: Magnus form, Alduchov & Eskridge (1996)
 *    coefficients a = 17.625, b = 243.04 °C, c = 6.1094 hPa.
 *  - Glass inner surface temperature: steady 1-D conduction,
 *    T_s = T_in − U·(T_in − T_out)/h_in with h_in = 7.7 W/m²K (EN ISO 6946
 *    inner surface resistance 0.13 m²K/W).
 *  - Blackbody: Planck's law, CODATA 2018 constants; colour matching by the
 *    CIE 1931 2° observer tabulated at 10 nm (CIE 015:2004);
 *    XYZ → linear sRGB with the IEC 61966-2-1 matrix (D65).
 *  - Cooling load: steady peak sensible + latent model —
 *      transmission  (U_wall·A_wall + U_glass·A_win)·(T_out − T_in), ≥ 0
 *      solar         A_win · I_peak(orientation) · SHGC(glazing)
 *      people        130 W each (≈75 W sensible + 55 W latent, seated)
 *      devices       nameplate W + 5 W/m² lighting
 *      infiltration  0.5 ACH · V · ρc_p (1.2 kg/m³ · 1005 J/kgK) · ΔT, ≥ 0
 *    exterior wall length is taken as 1.5·√area (one and a half façades).
 *  - Drops: spherical cap on a vertical plate; sliding when gravity exceeds
 *    the Furmidge retention force 2·a·γ·(cosθ_r − cosθ_a).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ES = root.ES || {}).physics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = 9.80665;                 // standard gravity, m/s²
  const KELVIN = 273.15;
  const H = 6.62607015e-34;          // Planck constant, J·s
  const C = 299792458;               // speed of light, m/s
  const KB = 1.380649e-23;           // Boltzmann constant, J/K
  const C1 = 2 * H * C * C;          // first radiation constant (radiance form)
  const C2 = H * C / KB;             // second radiation constant, m·K
  const W_TO_BTUH = 3.412142;        // 1 W = 3.412142 BTU/h
  const NU_AIR = 1.5e-5;             // kinematic viscosity of air at 20 °C, m²/s
  const RHO_CP_AIR = 1.2 * 1005 / 3600; // ρ·c_p of air per (m³/h): W per (m³/h·K)

  const MAGNUS_A = 17.625, MAGNUS_B = 243.04, MAGNUS_C = 6.1094;
  const H_IN = 7.7;

  const GLAZING = {
    single: { u: 5.8, shgc: 0.85 },
    double: { u: 2.8, shgc: 0.7 },
    triple: { u: 0.8, shgc: 0.5 },
  };
  const WALL_U = { none: 1.8, medium: 0.8, good: 0.4 };
  const SOLAR_PEAK = { N: 120, E: 450, S: 350, W: 550 }; // W/m² on a vertical façade, summer peak
  const PERSON_W = 130;
  const LIGHTING_W_M2 = 5;
  const ACH = 0.5;
  const UNIT_SIZES = [9000, 12000, 18000, 24000];

  // ---- humidity -----------------------------------------------------------

  function saturationVaporPressure(tC) {
    return MAGNUS_C * Math.exp(MAGNUS_A * tC / (MAGNUS_B + tC));
  }

  function dewPoint(tC, rhPct) {
    const g = Math.log(rhPct / 100) + MAGNUS_A * tC / (MAGNUS_B + tC);
    return MAGNUS_B * g / (MAGNUS_A - g);
  }

  function relativeHumidity(tC, tdC) {
    return 100 * saturationVaporPressure(tdC) / saturationVaporPressure(tC);
  }

  function glassSurfaceTemp(tIn, tOut, u, hIn = H_IN) {
    return tIn - u * (tIn - tOut) / hIn;
  }

  /** Vapour supersaturation of room air over a surface: e_air / e_sat(T_s) − 1. */
  function supersaturation(tRoom, rhPct, tSurface) {
    const eAir = rhPct / 100 * saturationVaporPressure(tRoom);
    return eAir / saturationVaporPressure(tSurface) - 1;
  }

  // ---- radiation and colour ----------------------------------------------

  /** Spectral radiance B(λ, T) in W·sr⁻¹·m⁻³, λ given in nanometres. */
  function planck(nm, T) {
    const l = nm * 1e-9;
    return C1 / (l ** 5 * Math.expm1(C2 / (l * T)));
  }

  // CIE 1931 2° standard observer, 380–780 nm in 10 nm steps (CIE 015:2004).
  // The three columns each sum to ≈10.68, i.e. equal-energy white is x = y = ⅓.
  const CMF = [
    [0.001368, 0.000039, 0.006450], [0.004243, 0.000120, 0.020050], [0.014310, 0.000396, 0.067850],
    [0.043510, 0.001210, 0.207400], [0.134380, 0.004000, 0.645600], [0.283900, 0.011600, 1.385600],
    [0.348280, 0.023000, 1.747060], [0.336200, 0.038000, 1.772110], [0.290800, 0.060000, 1.669200],
    [0.195360, 0.090980, 1.287640], [0.095640, 0.139020, 0.812950], [0.032010, 0.208020, 0.465180],
    [0.004900, 0.323000, 0.272000], [0.009300, 0.503000, 0.158200], [0.063270, 0.710000, 0.078250],
    [0.165500, 0.862000, 0.042160], [0.290400, 0.954000, 0.020300], [0.433450, 0.994950, 0.008750],
    [0.594500, 0.995000, 0.003900], [0.762100, 0.952000, 0.002100], [0.916300, 0.870000, 0.001650],
    [1.026300, 0.757000, 0.001100], [1.062200, 0.631000, 0.000800], [1.002600, 0.503000, 0.000340],
    [0.854450, 0.381000, 0.000190], [0.642400, 0.265000, 0.000050], [0.447900, 0.175000, 0.000020],
    [0.283500, 0.107000, 0], [0.164900, 0.061000, 0], [0.087400, 0.032000, 0], [0.046770, 0.017000, 0],
    [0.022700, 0.008210, 0], [0.011359, 0.004102, 0], [0.005790, 0.002091, 0], [0.002899, 0.001047, 0],
    [0.001440, 0.000520, 0], [0.000690, 0.000249, 0], [0.000332, 0.000120, 0], [0.000166, 0.000060, 0],
    [0.000083, 0.000030, 0], [0.000042, 0.000015, 0],
  ];

  /** CIE 1931 colour matching functions [x̄, ȳ, z̄], linear between table rows. */
  function cie1931(nm) {
    const f = (nm - 380) / 10;
    if (f < 0 || f > 40) return [0, 0, 0];
    const i = Math.min(39, Math.floor(f)), t = f - i, a = CMF[i], b = CMF[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function blackbodyXYZ(T) {
    let X = 0, Y = 0, Z = 0;
    for (let nm = 380; nm <= 780; nm += 1) {
      const b = planck(nm, T);
      const [x, y, z] = cie1931(nm);
      X += b * x; Y += b * y; Z += b * z;
    }
    return [X, Y, Z];
  }

  function xyzToChromaticity([X, Y, Z]) {
    const s = X + Y + Z;
    return [X / s, Y / s];
  }

  function xyzToLinearSRGB([X, Y, Z]) {
    return [
      3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
      -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
      0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    ];
  }

  function normaliseRGB(rgb) {
    const c = rgb.map(v => Math.max(0, v));
    const m = Math.max(...c);
    return c.map(v => v / m);
  }

  /** Linear-sRGB colour of a blackbody (max-normalised) and its luminance Y (arbitrary, consistent units). */
  function blackbodyColor(T) {
    const xyz = blackbodyXYZ(T);
    return { rgb: normaliseRGB(xyzToLinearSRGB(xyz)), Y: xyz[1] };
  }

  /** Linear-sRGB colour of a single emission line (max-normalised). */
  function spectralLineColor(nm) {
    return normaliseRGB(xyzToLinearSRGB(cie1931(nm)));
  }

  function linearToSrgbHex(rgb) {
    const enc = v => {
      const c = Math.min(1, Math.max(0, v));
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(s * 255).toString(16).padStart(2, '0');
    };
    return '#' + rgb.map(enc).join('');
  }

  // ---- thermodynamics -----------------------------------------------------

  function carnotCopCooling(tColdC, tHotC) {
    const tc = tColdC + KELVIN, th = tHotC + KELVIN;
    return th === tc ? Infinity : tc / (th - tc);
  }

  function carnotCopHeating(tColdC, tHotC) {
    const tc = tColdC + KELVIN, th = tHotC + KELVIN;
    return th === tc ? Infinity : th / (th - tc);
  }

  /**
   * A plausible real COP: 45 % of the Carnot limit between evaporator and
   * condenser, each 12 K beyond the air it exchanges with.
   */
  function realisticCopCooling(tInC, tOutC) {
    return 0.45 * carnotCopCooling(tInC - 12, tOutC + 12);
  }

  function wattsToBtuPerHour(w) { return w * W_TO_BTUH; }

  function buoyancyAccel(dT, trefK) { return G * dT / trefK; }

  function reynolds(v, L, nu = NU_AIR) { return v * L / nu; }

  function coolingLoad(room) {
    const glazing = GLAZING[room.glazing] || GLAZING.double;
    const wallU = WALL_U[room.insulation] ?? WALL_U.medium;
    const dT = room.tOut - room.tIn;
    const wallLen = Math.sqrt(room.area) * 1.5;
    const wallA = Math.max(0, wallLen * room.height - room.windowArea);
    const parts = {
      transmission: Math.max(0, (wallU * wallA + glazing.u * room.windowArea) * dT),
      solar: room.windowArea * (SOLAR_PEAK[room.orientation] ?? SOLAR_PEAK.S) * glazing.shgc,
      people: room.people * PERSON_W,
      devices: room.devicesW + room.area * LIGHTING_W_M2,
      infiltration: Math.max(0, room.area * room.height * ACH * RHO_CP_AIR * dT),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { parts, total };
  }

  function recommendUnit(btu) {
    for (const s of UNIT_SIZES) if (btu <= s) return s;
    return null;
  }

  // ---- premixed flames --------------------------------------------------------

  /**
   * Laminar burning velocity of methane–air at 1 atm, 298 K (m/s), Gülder (1984):
   * S_L = W·φ^η·exp(−ξ(φ − 1.075)²), W = 0.422, η = 0.15, ξ = 5.18;
   * zero outside the flammability limits φ ≈ 0.5 … 1.67.
   */
  function laminarFlameSpeed(phi) {
    if (phi < 0.5 || phi > 1.67) return 0;
    return 0.422 * phi ** 0.15 * Math.exp(-5.18 * (phi - 1.075) ** 2);
  }

  /**
   * Height of a Bunsen cone on a port of half-width r (m) with mean exit
   * velocity U: the flame front stands where its normal speed matches the
   * flow, sin α = S_L/U, so H = r·√((U/S_L)² − 1). Zero when the flow is
   * slower than the flame (it would flash back) or there is no premixed flame.
   */
  function coneHeight(r, U, phi) {
    const s = laminarFlameSpeed(phi);
    if (s <= 0 || U <= s) return 0;
    return r * Math.sqrt((U / s) ** 2 - 1);
  }

  // ---- drops on glass -------------------------------------------------------

  /** Volume of a spherical cap with contact radius a and contact angle θ (degrees). */
  function sphericalCapVolume(a, thetaDeg) {
    const t = thetaDeg * Math.PI / 180;
    const c = Math.cos(t), s = Math.sin(t);
    return Math.PI * a ** 3 * (2 - 3 * c + c ** 3) / (3 * s ** 3);
  }

  const DROP = { gamma: 0.072, rho: 998, theta: 40, thetaA: 50, thetaR: 30 };

  /** Contact radius (m) at which a drop on a vertical plate starts to slide. */
  function criticalSlideRadius(o = {}) {
    const p = Object.assign({}, DROP, o);
    const d = Math.cos(p.thetaR * Math.PI / 180) - Math.cos(p.thetaA * Math.PI / 180);
    const shape = sphericalCapVolume(1, p.theta);
    return Math.sqrt(2 * p.gamma * d / (p.rho * G * shape));
  }

  function mergeRadius(r1, r2) { return Math.cbrt(r1 ** 3 + r2 ** 3); }

  return {
    G, KELVIN, NU_AIR, GLAZING, WALL_U, SOLAR_PEAK, PERSON_W, UNIT_SIZES, DROP,
    saturationVaporPressure, dewPoint, relativeHumidity, glassSurfaceTemp, supersaturation,
    planck, cie1931, blackbodyXYZ, xyzToChromaticity, xyzToLinearSRGB, blackbodyColor,
    spectralLineColor, linearToSrgbHex,
    carnotCopCooling, carnotCopHeating, realisticCopCooling, wattsToBtuPerHour,
    buoyancyAccel, reynolds, coolingLoad, recommendUnit, laminarFlameSpeed, coneHeight,
    sphericalCapVolume, criticalSlideRadius, mergeRadius,
  };
});
