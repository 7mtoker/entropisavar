/*
 * fire.js — a boiler burner bar in a refractory chamber, 42 cm tall.
 *
 * Chemistry: one-step, second-order Arrhenius reaction F + O → P,
 *   ω = A·exp(−T_a/T)·F·O,  T_a = 12 000 K,  ΔT_ad ≈ 1 900 K,
 * with a conserved mixture fraction Z so the oxidiser is known everywhere:
 *   O = Z/φ + (1 − Z)·O_air − (Z − F)
 * (burner stream: fuel 1, oxidiser 1/φ; room air: oxidiser O_air = 1).
 * Lean mixtures burn out as premixed flames; rich ones leave fuel that only
 * burns where room air mixes in — a diffusion flame, where soot forms on the
 * fuel side and oxidises at the tip.
 *
 * Flow: low-Mach buoyancy g·(1 − T_amb/T) and thermal expansion ∇·u = q/T
 * fed into the pressure solve. Radiation loss ∝ (soot + gas)·(T⁴ − T_amb⁴).
 * Light: soot glows as a grey body through a Planck/CIE 1931 lookup table,
 * the reaction zone emits CH* (431 nm), C2* (516 nm) and CO2* continuum, and
 * the same soot absorbs the background (Beer–Lambert).
 */
(function (ES) {
  'use strict';
  const P = ES.physics;
  const DOMAIN_H = 0.42;           // m
  const BAR_H = 0.028;             // burner bar height, m
  const PORTS = 7, PITCH = 0.036, PORT_HW = 0.006;
  const CROSSFIRE_S = 0.5;          // time for the ignition front to run the bar's crossfire slots
  const ALPHA0 = 1.2e-4;            // thickened thermal diffusivity at 300 K, m²/s (×~21 at 1800 K)
  const RX = 16, RY = 8;
  const QUALITY = [
    { ny: 100, dpr: 1, px: 0.7e6, jacobi: 14, bloom: 4 },
    { ny: 136, dpr: 1.25, px: 1.2e6, jacobi: 20, bloom: 5 },
    { ny: 170, dpr: 1.5, px: 1.8e6, jacobi: 24, bloom: 6 },
  ];

  const CHEM = `
const float TA = 12000.0, T_AMB = 300.0;
uniform float uPhi, uA, uQ;
// Units: 1 = the fuel of a stoichiometric mixture. The burner stream carries
// φ fuel and 1 oxidiser; it is mostly air, so room air also carries 1.
// Unburnt fuel at mixture fraction Z is Z·φ; oxidiser left is 1 − consumed.
float oxidiser(vec4 s) { return max(1.0 - max(s.w * uPhi - s.x, 0.0), 0.0); }
// Rate = max(Arrhenius kinetics, eddy-dissipation mixing limit). Kinetics decide
// ignition; above ~1000 K the flame burns as fast as fuel and air are mixed
// (Magnussen & Hjertager 1977): r = min(F, O)/τ_mix.
const float INV_TAU_MIX = 600.0;
float burnRateAt(vec4 s, float T) {
  float F = max(s.x, 0.0), O = oxidiser(s);
  float kinetic = uA * exp(-TA / max(T, 250.0)) * F * O;
  float mixing = INV_TAU_MIX * min(F, O) * smoothstep(800.0, 1100.0, T);
  return max(kinetic, mixing);
}
float burnRate(vec4 s) { return burnRateAt(s, s.y); }
`;

  const DIV_SOURCE = `${CHEM}
float divSource(ivec2 c) {
  vec4 s = texelFetch(uScal, c, 0);
  return min(burnRate(s) * uQ / max(s.y, T_AMB), 400.0);
}`;

  const GEOM = `
uniform vec2 uDomain;
uniform vec4 uBurner;    // first port centre x, pitch, port half-width, port count
uniform float uBarH;
float portIndex(vec2 x) { return floor((x.x - uBurner.x) / uBurner.y + 0.5); }
float inPort(vec2 x) {
  float i = portIndex(x);
  if (i < 0.0 || i > uBurner.w - 1.0 || x.y > uBarH) return 0.0;
  return step(abs(x.x - (uBurner.x + i * uBurner.y)), uBurner.z);
}
float profile(vec2 x) {
  float i = portIndex(x);
  float d = (x.x - (uBurner.x + i * uBurner.y)) / uBurner.z;
  return max(1.0 - d * d, 0.0);
}
// One blade (ramp) per port; secondary air rises through the gaps between blades.
float inBar(vec2 x) {
  float i = portIndex(x);
  if (i < 0.0 || i > uBurner.w - 1.0) return 0.0;
  return step(abs(x.x - (uBurner.x + i * uBurner.y)), uBurner.z + 0.006) * step(x.y, uBarH);
}
// Finned-tube heat exchanger across the top; flue gas leaves through the central opening.
const float HX_Y0 = 0.020, HX_Y1 = 0.042, FLUE_HW = 0.065;
float inHx(vec2 x) {
  return step(uDomain.y - HX_Y1, x.y) * step(x.y, uDomain.y - HX_Y0) * step(FLUE_HW, abs(x.x - 0.5 * uDomain.x));
}
`;

  const FORCES = `${GEOM}
uniform sampler2D uVel, uScal;
uniform float uDt, uPortV;
in vec2 vUv; out vec4 o;
void main() {
  vec2 x = vUv * uDomain;
  vec2 v = texture(uVel, vUv).xy;
  float T = texture(uScal, vUv).y;
  v.y += uDt * 9.80665 * (1.0 - 300.0 / max(T, 250.0));
  float port = inPort(x), bar = inBar(x);
  v = mix(v, vec2(0.0, uPortV * profile(x)), port);
  v *= 1.0 - max(bar * (1.0 - port), inHx(x));
  o = vec4(v, 0.0, 1.0);
}`;

  // Sub-grid flame base, one texel per port. Real port flames anchor in a
  // rim recirculation zone far below this grid's 3 mm; the closure keeps a
  // port's base burning while the gas a few cells up is burning and the
  // cross-flow at the exit stays below a blow-off speed. Blow on it hard
  // enough and it detaches, exactly as a real one does.
  const ANCHOR = `
uniform sampler2D uScal, uVel, uPrev;
uniform vec4 uBurner;
uniform float uBarH, uH, uBlowOff, uIgn;
uniform vec2 uIgnPos;
uniform int uNx, uNy;     // probe box size in cells (uniform bounds: not unrolled)
out vec4 o;
void main() {
  float pc = uBurner.x + floor(gl_FragCoord.x) * uBurner.y;
  // hottest gas in a box around the port exit: the flame sheath sits on the jet's edges
  float t = 0.0;
  for (int j = 0; j < uNy; j++) for (int i = 0; i < uNx; i++) {
    vec2 p = vec2(pc - uBurner.z - 2.0 * uH + float(i) * uH, uBarH + (1.5 + float(j)) * uH);
    t = max(t, texelFetch(uScal, ivec2(floor(p / uH)), 0).y);
  }
  // cross-flow at both rims
  float vl = texelFetch(uVel, ivec2(floor(vec2(pc - uBurner.z, uBarH + 1.5 * uH) / uH)), 0).x;
  float vr = texelFetch(uVel, ivec2(floor(vec2(pc + uBurner.z, uBarH + 1.5 * uH) / uH)), 0).x;
  float vx = max(abs(vl), abs(vr));
  // latch: an attached base stays attached until blown off or starved of gas
  float prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).x;
  float fuel = texelFetch(uScal, ivec2(floor(vec2(pc, uBarH + 0.5 * uH) / uH)), 0).x;
  bool crossfire = uIgn > 0.5 && abs(pc - uIgnPos.x) < 0.5 * uBurner.y;   // the running front reaches this port
  // the igniter's own expansion must not count as a gust: blow-off only detaches an attached base
  bool lit = fuel > 0.05 && (crossfire || t > 1100.0 || (prev > 0.5 && vx < uBlowOff));
  o = vec4(lit ? 1.0 : 0.0, t, vx, 1.0);
}`;

  const SOURCES = `${GEOM}${CHEM}
uniform sampler2D uScal, uAnchor;
uniform float uDt, uGas, uSpark, uIgn, uSootForm, uSootOx, uH, uCone;
uniform vec2 uSparkPos, uIgnPos;
in vec2 vUv; out vec4 o;
void main() {
  vec2 x = vUv * uDomain;
  vec4 s = texture(uScal, vUv);
  float port = inPort(x), bar = inBar(x);
  s = mix(s, vec4(uGas * uPhi, 300.0, 0.0, uGas), port);
  s = mix(s, vec4(0.0, 480.0, 0.0, 0.0), bar * (1.0 - port));   // hot deck metal
  vec2 d = x - uSparkPos;
  s.y = max(s.y, mix(s.y, 2300.0, uSpark * exp(-dot(d, d) / 2.0e-5)));
  // crossfire: the ignition front runs along the bar from port to port
  vec2 g = (x - uIgnPos) / vec2(0.008, 0.005);
  s.y = max(s.y, mix(s.y, 1900.0, uIgn * exp(-dot(g, g))));
  // Sub-grid flame base of an attached port: the premixed Bunsen cone
  // (height from S_L(φ), physics.coneHeight) plus the rims where the outer
  // diffusion flame is anchored. It lends the reaction rate the flame-zone
  // temperature only; enthalpy is untouched, so products leave adiabatic.
  float pi = portIndex(x);
  float tRate = s.y;
  if (pi >= 0.0 && pi <= uBurner.w - 1.0 && x.y > uBarH && texelFetch(uAnchor, ivec2(int(pi), 0), 0).x > 0.5) {
    float dx = abs(x.x - (uBurner.x + pi * uBurner.y)), dy = x.y - uBarH;
    bool rim = abs(dx - uBurner.z) < uH && dy < 2.0 * uH;
    bool cone = uCone > 0.0 && dx < uBurner.z && dy < uCone * (1.0 - dx / uBurner.z) + 0.5 * uH;
    if (rim || cone) tRate = max(s.y, 1650.0);
  }
  for (int i = 0; i < 2; i++) {
    float h = 0.5 * uDt;
    float r = min(burnRateAt(s, max(s.y, tRate)) * h, min(max(s.x, 0.0), oxidiser(s)));
    s.x -= r;
    s.y += r * uQ;
    float O = oxidiser(s);
    float rich = clamp((s.x - O) / (s.x + 0.05), 0.0, 1.0);
    float form = uSootForm * s.x * rich * smoothstep(1250.0, 1650.0, s.y);
    float burn = uSootOx * s.z * (O + 0.02) * smoothstep(1300.0, 1850.0, s.y);
    s.z = max(s.z + h * (form - burn), 0.0);
  }
  float t4 = pow(s.y / 1000.0, 4.0) - 0.0081;
  s.y -= uDt * 900.0 * (min(s.z, 1.5) + 0.015) * t4;
  s.y = clamp(s.y, 280.0, 2600.0);
  o = s;
}`;

  // Implicit heat and species diffusion, one Jacobi sweep of (1 − r∇²)x = b.
  // α grows with temperature (≈ T^1.7) and is thickened so the flame spans a
  // few cells (thickened-flame model, Colin et al. 2000): this is what gives
  // the flame a propagation speed to hold onto the port rims.
  // Soot is carried but not diffused (particles: Lewis number ≫ 1).
  const DIFFUSE = `
uniform sampler2D uX, uB;
uniform float uR0;
uniform vec4 uAmbient;
out vec4 o;
vec4 at(ivec2 c, ivec2 s) {
  if (c.y >= s.y) return uAmbient;                              // flue: room-temperature air above
  return texelFetch(uX, clamp(c, ivec2(0), s - 1), 0);          // walls and inlet: zero flux
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uX, 0);
  vec4 b = texelFetch(uB, c, 0);
  // α ∝ T^1.7, capped at 4× so a one-cell flame sheet is not diffused below ignition
  float r = uR0 * min(pow(clamp(b.y / 300.0, 1.0, 9.0), 1.7), 4.0);
  vec4 sum = at(c + ivec2(1, 0), s) + at(c - ivec2(1, 0), s) + at(c + ivec2(0, 1), s) + at(c - ivec2(0, 1), s);
  vec4 x = (b + r * sum) / (1.0 + 4.0 * r);
  x.z = b.z;
  o = x;
}`;

  const REDUCE = `${CHEM}
uniform sampler2D uScal;
uniform ivec2 uBlk;       // block size per output texel; uniform bounds keep the loop a loop
out vec4 o;
void main() {
  ivec2 s = textureSize(uScal, 0);
  ivec2 o0 = ivec2(gl_FragCoord.xy) * uBlk;
  float mt = 0.0, ss = 0.0, mq = 0.0, n = 0.0;
  for (int j = 0; j < uBlk.y; j++) {
    for (int i = 0; i < uBlk.x; i += 2) {
      vec4 v = texelFetch(uScal, min(o0 + ivec2(i, j), s - 1), 0);
      mt = max(mt, v.y); ss += v.z; mq = max(mq, burnRate(v)); n += 1.0;
    }
  }
  o = vec4(mt, ss / max(n, 1.0), mq, 0.0);
}`;

  const DISPLAY = `${GEOM}${CHEM}
uniform sampler2D uScal, uLut, uGlow, uAlbedo;
uniform vec2 uRes, uSparkPos, uRodBase;
uniform float uExposure, uChemGain, uHaze, uTime, uSpark;
uniform float uIrr;   // glow → irradiance, normalised by bloom levels so albedo·uIrr < 1 (no feedback runaway)
uniform vec3 uChem;
in vec2 vUv; out vec4 o;
vec3 blackbody(float T) {
  vec4 l = texture(uLut, vec2(clamp((T - 300.0) / 2700.0, 0.0, 1.0), 0.5));
  return l.rgb * exp2(l.a);
}
vec3 chamber(vec2 uv) {
  vec3 irr = texture(uGlow, uv).rgb * uIrr + vec3(0.004, 0.005, 0.007);
  return texture(uAlbedo, uv).rgb * irr;
}
vec3 steel(vec2 x, vec2 uv, float px) {
  float brushed = vnoise(vec2(x.x * 60.0, x.y * 4000.0));   // brushed along the bar: horizontal grain
  vec3 c = vec3(0.42, 0.43, 0.45) * (0.8 + 0.25 * brushed);
  vec3 irr = texture(uGlow, vec2(uv.x, uv.y + 0.06)).rgb * uIrr * 1.25 + vec3(0.006);
  c *= irr;
  // temper colours where the metal ran hottest, next to the ports
  float i = portIndex(x);
  float dp = abs(x.x - (uBurner.x + i * uBurner.y));
  float heat = exp(-dp / 0.012) * smoothstep(uBarH - 0.012, uBarH, x.y);
  c = mix(c, c * vec3(1.25, 0.95, 0.55), heat * 0.6);
  c += vec3(0.08, 0.06, 0.04) * (1.0 - smoothstep(0.0, 2.0 * px, uBarH - x.y)) * length(texture(uGlow, uv).rgb) * uIrr;
  return c;
}
void main() {
  vec2 x = vUv * uDomain;
  float px = uDomain.y / uRes.y;
  vec2 e = 1.0 / vec2(textureSize(uScal, 0));
  float rl = T_AMB / textureBicubic(uScal, vUv - vec2(e.x, 0.0)).y, rr = T_AMB / textureBicubic(uScal, vUv + vec2(e.x, 0.0)).y;
  float rb = T_AMB / textureBicubic(uScal, vUv - vec2(0.0, e.y)).y, rt = T_AMB / textureBicubic(uScal, vUv + vec2(0.0, e.y)).y;
  vec2 gRho = vec2(rr - rl, rt - rb) / (2.0 * e * uDomain);
  vec2 xr = x + gRho * uHaze;
  vec3 col = chamber(xr / uDomain);
  vec4 s = textureBicubic(uScal, vUv);
  float tau = max(s.z, 0.0) * 2.6;
  float a = exp(-tau);
  col = col * a + blackbody(s.y) * uExposure * (1.0 - a);
  // the reaction sheet is seen edge-on through the flame's depth: a soft glow, not a hairline
  float q = 0.4 * burnRate(s) + 0.15 * (burnRate(texture(uScal, vUv + vec2(1.5 * e.x, 0.0))) + burnRate(texture(uScal, vUv - vec2(1.5 * e.x, 0.0)))
          + burnRate(texture(uScal, vUv + vec2(0.0, 1.5 * e.y))) + burnRate(texture(uScal, vUv - vec2(0.0, 1.5 * e.y))));
  col += uChem * q * uChemGain;
  float bar = inBar(x) * (1.0 - inPort(x));
  if (bar > 0.0) col = mix(col, steel(x, vUv, px), bar);
  // heat exchanger: copper tubes in aluminium fins, lit from below by the flame
  if (x.y > uDomain.y - HX_Y1 - 0.01 && abs(x.x - 0.5 * uDomain.x) > FLUE_HW - 0.01) {
    vec2 q = vec2(mod(x.x, 0.03) - 0.015, x.y - (uDomain.y - 0.031));
    float tube = cover(length(q) - 0.0085, px);
    float fin = cover(abs(mod(x.x, 0.004) - 0.002) - 0.0004, px) * inHx(x);
    vec3 lit = texture(uGlow, vec2(vUv.x, vUv.y - 0.05)).rgb * uIrr * 1.4 + 0.004;
    vec3 fins = vec3(0.30, 0.31, 0.33) * lit;
    vec3 copper = vec3(0.55, 0.27, 0.14) * lit * (0.6 + 0.8 * smoothstep(0.0085, -0.0085, q.y));
    col = mix(col, vec3(0.02, 0.02, 0.025), inHx(x) * 0.85);
    col = mix(col, fins, fin);
    col = mix(col, copper, tube * step(FLUE_HW, abs(x.x - 0.5 * uDomain.x)));
  }
  col = mix(col, vec3(0.0), inPort(x) * 0.9);
  // ignition electrode: kanthal rod in a ceramic sleeve
  vec2 tip = uSparkPos + vec2(0.0, 0.004);
  float rod = cover(sdSegment(x, uRodBase, tip) - 0.0012, px);
  float sleeve = cover(sdSegment(x, uRodBase, mix(uRodBase, tip, 0.35)) - 0.0028, px);
  vec3 rodCol = vec3(0.30, 0.29, 0.28) * (texture(uGlow, vUv).rgb * uIrr * 1.25 + 0.01);
  col = mix(col, rodCol, rod);
  col = mix(col, vec3(0.55, 0.53, 0.50) * (texture(uGlow, vUv).rgb * uIrr * 1.25 + 0.02), sleeve);
  if (uSpark > 0.0) {
    vec2 a0 = tip, a1 = vec2(uSparkPos.x, uBarH);
    float t = clamp(dot(x - a0, a1 - a0) / dot(a1 - a0, a1 - a0), 0.0, 1.0);
    float jag = (vnoise(vec2(t * 18.0, uTime * 60.0)) - 0.5) * 0.004 * sin(3.14159 * t);
    float dArc = length(x - mix(a0, a1, t) - vec2(jag, 0.0));
    col += vec3(0.55, 0.62, 1.0) * uSpark * (exp(-dArc / 0.0004) * 40.0 + exp(-dArc / 0.004) * 1.5);
  }
  o = vec4(clamp(col, 0.0, 6.0e4), 1.0);
}`;

  // Refractory board albedo, drawn once per resize: coarse grain + panel seams.
  const ALBEDO = `
uniform vec2 uDomain, uRes;
in vec2 vUv; out vec4 o;
float seam(float v, float step, float px) { return 1.0 - smoothstep(0.0, 1.5 * px, abs(fract(v / step + 0.5) - 0.5) * step); }
void main() {
  vec2 x = vUv * uDomain;
  float px = uDomain.y / uRes.y;
  float g = fbm(x * 70.0) * 0.6 + fbm(x * 380.0) * 0.4;
  vec3 alb = vec3(0.34, 0.30, 0.26) * (0.72 + 0.4 * g);
  alb *= 1.0 - 0.55 * max(seam(x.x, 0.14, px), seam(x.y + 0.03, 0.14, px));
  o = vec4(alb, 1.0);
}`;

  const COMPOSITE = `
uniform sampler2D uHdr, uBloom;
uniform float uBloomK;
in vec2 vUv; out vec4 o;
void main() {
  vec3 c = texture(uHdr, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  o = vec4(dither(toSrgb(aces(c))), 1.0);
}`;

  function makeLut(ctx) {
    const gl = ctx.gl, n = 256, data = new Float32Array(n * 4);
    const ref = P.blackbodyColor(2000).Y;
    for (let i = 0; i < n; i++) {
      const T = 300 + 2700 * i / (n - 1);
      const c = P.blackbodyColor(T);
      data.set([c.rgb[0], c.rgb[1], c.rgb[2], Math.max(-40, Math.log2(c.Y / ref))], i * 4);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex };
  }

  // Chemiluminescence: CH* 431 nm, C2* Swan band 516 nm (grows in rich premix), CO2* continuum.
  const CH = P.spectralLineColor(431), C2 = P.spectralLineColor(516), CO2 = [0.32, 0.42, 1.0];
  function chemColour(phi) {
    const w2 = 0.12 + 0.35 * Math.min(1, Math.max(0, (phi - 1) / 0.5));
    const c = [0, 1, 2].map(i => CH[i] + C2[i] * w2 + CO2[i] * 0.6);
    const m = Math.max(...c);
    return c.map(v => v / m);
  }

  class FireSim {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = new ES.gl.Ctx(canvas);
      const ctx = this.ctx;
      this.fluid = new ES.Fluid(ctx, {
        // Atmospheric boiler cell: refractory side walls, secondary air drawn in
        // from below around the burner, flue open at the top. (Open sides let a
        // uniform cross-wind drift unchecked — divergence-free, invisible to pressure.)
        open: [0, 0, 1, 1], ambient: [0, 300, 0, 0], scalar: 'RGBA', vorticity: 7, jacobi: 20, damp: 0.05, divSource: DIV_SOURCE,
      });
      this.prog = {
        forces: ctx.program(FORCES), sources: ctx.program(SOURCES), reduce: ctx.program(REDUCE),
        display: ctx.program(DISPLAY), composite: ctx.program(COMPOSITE), albedo: ctx.program(ALBEDO),
        diffuse: ctx.program(DIFFUSE), anchor: ctx.program(ANCHOR),
      };
      this.anchor = ctx.double(PORTS, 1, 'RGBA', 'nearest');
      this.lut = makeLut(ctx);
      this.bloom = new ES.gl.Bloom(ctx, 5);
      this.reduced = ctx.target(RX, RY, 'RGBA', 'nearest');
      this.readback = new ES.gl.Readback(ctx, RX, RY);
      this.phi = 1.6;
      this.flow = 0.75;
      // Fast-chemistry regime: diffusion flames are mixing-limited (Burke–Schumann);
      // at 300 K the rate is ~1e-11 /s, so nothing auto-ignites in the room.
      this.chem = { uA: 3.0e6, uQ: 1900 };
      this.flame = { state: 'igniting', gas: 1, attempts: 0, spark: 0, sparkUntil: 0, lostAt: 0, present: false, maxT: 300, soot: 0 };
      this.stats = { fps: 0, simTime: 0, quality: 1, maxT: 300, state: 'igniting', current: 0 };
      this.qi = -1;
      this.time = 0;
      this.lastRead = 0;
      this.pointer = ES.gl.trackPointer(canvas);
    }

    setQuality(q) {
      if (q === this.qi) return;
      this.qi = q;
      this.stats.quality = q;
      this.resize(true);
    }

    resize(force) {
      const q = QUALITY[this.qi];
      const s = ES.gl.fit(this.canvas, q.dpr, 1, q.px);
      const aspect = Math.max(0.6, s.cssW / s.cssH);
      const ny = q.ny, nx = Math.round(ny * aspect);
      if (!force && !s.changed && this.fluid.nx === nx) return;
      this.W = DOMAIN_H * aspect;
      this.fluid.resize(nx, ny, this.W, DOMAIN_H);
      this.fluid.o.jacobi = q.jacobi;
      if (this.hdr) { this.ctx.free(this.hdr); this.ctx.free(this.albedo); }
      this.hdr = this.ctx.target(s.w, s.h, 'RGBA', 'linear');
      this.albedo = this.ctx.target(s.w, s.h, 'RGBA', 'linear');
      this.ctx.draw(this.prog.albedo, this.albedo, { uDomain: [this.W, DOMAIN_H], uRes: [s.w, s.h] });
      this.bloom.levels = q.bloom;
      this.bloom.resize(s.w, s.h);
      const span = (PORTS - 1) * PITCH;
      this.burner = [this.W / 2 - span / 2, PITCH, PORT_HW, PORTS];
      this.sparkPos = [this.burner[0] - PORT_HW - 0.002, BAR_H + 0.006];
      this.rodBase = [this.burner[0] - 0.06, BAR_H + 0.045];
    }

    ignite() {
      const fl = this.flame;
      if (fl.state === 'lockout') { fl.attempts = 0; }
      fl.gas = 1;
      fl.attempts++;
      fl.state = 'igniting';
      fl.ignStart = this.time;
      fl.sparkUntil = this.time + CROSSFIRE_S + 0.1;
      fl.lostAt = this.time;
    }

    /** Where the crossfire front is now, and whether it is running. */
    ignition() {
      const t = (this.time - (this.flame.ignStart ?? -9)) / CROSSFIRE_S;
      if (t < 0 || t > 1) return { on: 0, pos: [0, 0] };
      const span = (PORTS - 1) * PITCH;
      return { on: 1, pos: [this.burner[0] + t * span, BAR_H + 0.007] };
    }

    /** Ionisation flame supervision: retry after a safety time, lock out after three failures. */
    supervise() {
      const fl = this.flame, t = this.time;
      if (fl.state === 'lockout') return;
      if (t < fl.sparkUntil + 0.3) return;            // the ignition kernel itself would read as flame
      if (fl.present) { fl.state = 'lit'; fl.attempts = 0; return; }
      if (fl.state === 'lit') { fl.state = 'out'; fl.lostAt = t; return; }
      if (t - Math.max(fl.lostAt, fl.sparkUntil) < 0.8) return;
      if (fl.attempts >= 3) { fl.state = 'lockout'; fl.gas = 0; return; }
      this.ignite();
    }

    readStats(now) {
      if (this.readback.poll()) {
        const d = this.readback.data;
        let maxLow = 300, maxAll = 300, soot = 0;
        for (let j = 0; j < RY; j++) for (let i = 0; i < RX; i++) {
          const k = (j * RX + i) * 4;
          maxAll = Math.max(maxAll, d[k]);
          if (j < RY / 2) maxLow = Math.max(maxLow, d[k]);
          soot += d[k + 1];
        }
        const fl = this.flame;
        fl.present = maxLow > 1000;
        fl.maxT = maxAll;
        fl.soot = soot / (RX * RY);
        this.supervise();
      }
      if (now - this.lastRead > 200) {
        const blk = [Math.ceil(this.fluid.nx / RX), Math.ceil(this.fluid.ny / RY)];
        this.ctx.draw(this.prog.reduce, this.reduced, { uScal: this.fluid.scal.read, uBlk: blk, uPhi: this.phi, ...this.chem });
        if (this.readback.request(this.reduced)) this.lastRead = now;
      }
    }

    step(dt) {
      const f = this.fluid, fl = this.flame;
      fl.spark = this.time < fl.sparkUntil && (this.time * 12) % 1 < 0.55 ? 1 : 0;
      const geom = { uDomain: [this.W, DOMAIN_H], uBurner: this.burner, uBarH: BAR_H };
      const portV = (0.3 + 0.9 * this.flow) * fl.gas;
      this.cone = P.coneHeight(PORT_HW, portV * 2 / 3, this.phi);   // mean of the Poiseuille profile
      const p = this.pointer, ign = this.ignition();
      f.step(dt, {
        sources: () => {
          this.diffuse(dt);
          this.ctx.draw(this.prog.anchor, this.anchor.write, {
            uScal: f.scal.read, uVel: f.vel.read, uPrev: this.anchor.read, uBurner: this.burner, uBarH: BAR_H, uH: f.h,
            uBlowOff: 2.5, uNx: Math.ceil((2 * PORT_HW) / f.h) + 5, uNy: 5, uIgn: ign.on * fl.gas, uIgnPos: ign.pos,
          });
          this.anchor.swap();
          f.pass(this.prog.sources, f.scal, {
            ...geom, ...this.chem, uAnchor: this.anchor.read, uH: f.h, uPhi: this.phi, uDt: dt, uGas: fl.gas, uSpark: fl.spark,
            uSparkPos: this.sparkPos, uIgn: ign.on * fl.gas, uIgnPos: ign.pos, uSootForm: 18.0, uSootOx: 25.0, uCone: this.cone,
          });
          f.pass(this.prog.forces, f.vel, { ...geom, uDt: dt, uPortV: portV });
          if (p.down && p.inside) {
            const k = DOMAIN_H / this.canvas.getBoundingClientRect().height;
            const vx = Math.max(-4, Math.min(4, p.dx * k)), vy = Math.max(-4, Math.min(4, p.dy * k));
            f.splat(f.vel, [p.x, p.y], 0.06, [vx * 0.5, vy * 0.5, 0, 0]);
            p.dx *= 0.5; p.dy *= 0.5;
          }
        },
        projectUniforms: () => ({ uPhi: this.phi, ...this.chem }),
      });
      this.time += dt;
      this.stats.simTime += dt;
    }

    /** Eight Jacobi sweeps, ping-ponging through the advection scratch targets. */
    diffuse(dt) {
      const f = this.fluid, ctx = this.ctx, N = 5;
      const base = { uB: f.scal.read, uR0: ALPHA0 * dt / (f.h * f.h), uAmbient: [0, 300, 0, 0] };
      let src = f.scal.read;
      for (let i = 0; i < N; i++) {
        const dst = i === N - 1 ? f.scal.write : (i % 2 === 0 ? f.hat : f.back);
        ctx.draw(this.prog.diffuse, dst, { ...base, uX: src });
        src = dst;
      }
      f.scal.swap();
    }

    render() {
      const c = this.canvas, ctx = this.ctx, fl = this.flame;
      ctx.draw(this.prog.display, this.hdr, {
        uScal: this.fluid.scal.read, uLut: this.lut, uGlow: this.bloom.wide, uAlbedo: this.albedo, uIrr: 1.6 / this.bloom.mips.length,
        uDomain: [this.W, DOMAIN_H], uRes: [c.width, c.height], uBurner: this.burner, uBarH: BAR_H,
        uPhi: this.phi, ...this.chem, uExposure: 9.0, uChemGain: 0.0012, uHaze: 2.2e-4,
        uChem: chemColour(this.phi), uTime: this.time, uSpark: fl.spark, uSparkPos: this.sparkPos, uRodBase: this.rodBase,
      });
      const glow = this.bloom.apply(this.hdr, 0.9, 0.6);
      ctx.draw(this.prog.composite, null, { uHdr: this.hdr, uBloom: glow, uBloomK: 0.9 / this.bloom.mips.length });
    }

    warmup(seconds) {
      this.ignite();
      for (let t = 0; t < seconds; t += 1 / 30) this.step(1 / 30);
      this.render();
    }

    frame(dt, now) {
      if (this.ctx.lost) return;
      this.resize(false);
      this.step(Math.min(dt, 1 / 30));
      this.readStats(now);
      this.render();
      const fl = this.flame;
      const portV = (0.3 + 0.9 * this.flow) * fl.gas, sl = P.laminarFlameSpeed(this.phi);
      Object.assign(this.stats, {
        maxT: fl.maxT, state: fl.state, soot: fl.soot, attempts: fl.attempts,
        cone: this.cone, sl, exitU: portV * 2 / 3, flashback: sl > 0 && portV * 2 / 3 <= sl,
        current: fl.present ? (1.5 + 3 * this.flow) * (0.93 + 0.14 * Math.random()) : 0,
      });
    }
  }

  FireSim.QUALITY = QUALITY;
  ES.FireSim = FireSim;
})(window.ES = window.ES || {});
