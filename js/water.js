/*
 * water.js — condensation on the inside of a window on a winter night.
 *
 * Environment (physics.js): glass surface temperature from the glazing
 * U-value, dew point by Magnus, supersaturation S = e_air/e_sat(T_glass) − 1.
 * S > 0 condenses, S < 0 evaporates — the page never decides this, the
 * numbers do.
 *
 * Drops (CPU, millimetres, y down):
 *   growth       d(a²)/dt = K·S  (diffusion-limited; time-lapsed ×TL)
 *   nucleation   rate ∝ S, biased to the colder lower pane
 *   sliding      gravity ρgV(a) against Furmidge retention 2aγ(cosθr − cosθa),
 *                surface heterogeneity makes it stick-slip and meander;
 *                real-time, not time-lapsed
 *   trails       sliding drops shed small drops and sweep the fog
 *   coalescence  touching contact circles merge, volume conserved
 * Fog (GPU): sub-visible droplets as a thickness field that grows with S and
 * is wiped by fingers and sliding drops. Drops are lenses: each shows an
 * inverted, minified image of the scene behind the glass, with a dark
 * totally-internally-reflecting rim.
 */
(function (ES) {
  'use strict';
  const P = ES.physics;
  const TL = 30;                                   // time-lapse for condensation and evaporation
  const QUALITY = [
    { dpr: 1, px: 0.8e6, bg: 0.4, max: 900 },
    { dpr: 1.25, px: 1.3e6, bg: 0.5, max: 1400 },
    { dpr: 1.5, px: 2.0e6, bg: 0.5, max: 1800 },
  ];
  const D = P.DROP;
  const SHAPE = P.sphericalCapVolume(1, D.theta);  // V = SHAPE·a³
  const WEIGHT = D.rho * P.G * SHAPE;              // F_g = WEIGHT·a³, a in m
  const PIN = 2 * D.gamma * (Math.cos(D.thetaR * Math.PI / 180) - Math.cos(D.thetaA * Math.PI / 180)); // F = PIN·a
  const DRAG = 0.4;                                // contact-line + viscous drag, F = DRAG·a·v
  const K_GROW = 0.0015;                           // mm²/s at S = 1
  const NUCLEATION = 2e-5;                         // drops per mm² per s at S = 1
  const FINGER = 6;                                // mm

  const VS_INST = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aI;   // x, y, radius (mm, y down), speed mm/s or stamp strength
uniform vec2 uRes;
uniform float uPxPerMm, uStretchK;
out vec2 vL;
out float vR, vW, vStretch;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float stretch = 1.0 + min(aI.w * uStretchK, 0.8);
  vec2 local = vec2(corner.x * 1.2, corner.y < 0.0 ? -1.2 * stretch : 1.2);
  vec2 px = (aI.xy + local * aI.z) * uPxPerMm;
  vL = local; vR = aI.z * uPxPerMm; vW = aI.w; vStretch = stretch;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
}`;

  const DROP_FS = `
in vec2 vL; in float vR, vW, vStretch;
out vec4 o;
void main() {
  vec2 p = vec2(vL.x, vL.y < 0.0 ? vL.y / vStretch : vL.y);   // trailing top of a sliding drop is drawn out
  float d = length(p);
  float cov = clamp((1.0 - d) * vR + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec2 puv = vec2(p.x, -p.y) / max(d, 1.0);
  o = vec4(puv * cov, vR * cov, cov);
}`;

  const STAMP_FS = `
in vec2 vL; in float vR, vW, vStretch;
out vec4 o;
void main() {
  float m = 1.0 - smoothstep(0.65, 1.0, length(vL));
  o = vec4(vec3(1.0 - vW * m), 1.0);
}`;

  const FOG_INIT = `
in vec2 vUv; out vec4 o;
void main() { o = vec4(0.55 + 0.3 * (1.0 - vUv.y) + 0.15 * vnoise(vUv * vec2(9.0, 5.0)), 0.0, 0.0, 1.0); }`;

  const FOG_STEP = `
uniform sampler2D uFog;
uniform float uDt, uGrow, uDry;
in vec2 vUv; out vec4 o;
void main() {
  float f = texture(uFog, vUv).r;
  float cold = 0.7 + 0.6 * (1.0 - vUv.y);                       // the lower pane runs colder
  float n = 0.7 + 0.6 * vnoise(vUv * vec2(9.0, 5.0));           // uneven nucleation sites
  f += uDt * uGrow * cold * n * (1.0 - f);
  f -= uDt * uDry * f * (1.6 - 0.6 * n);
  o = vec4(clamp(f, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

  const BG = `
uniform float uTime, uSnow, uAspect;
uniform int uLo, uHi;     // −1, 1: uniform bounds keep ANGLE from unrolling the 3×3 search
in vec2 vUv; out vec4 o;
vec3 bokeh(vec2 uv, float scale, float seed) {
  vec2 g = uv * scale, id = floor(g);
  vec3 acc = vec3(0.0);
  for (int j = uLo; j <= uHi; j++) for (int i = uLo; i <= uHi; i++) {
    vec2 c = id + vec2(i, j);
    if (hash12(c * 1.7 + seed) < 0.5) continue;
    vec2 h = hash22(c + seed);
    vec2 pos = c + 0.5 + (h - 0.5) * 0.8;
    float d = length(g - pos) / (0.26 + 0.24 * hash12(c + seed * 3.1));
    float disc = smoothstep(1.0, 0.93, d) * (0.72 + 0.28 * smoothstep(0.55, 0.97, d));
    float k = hash12(c + seed * 7.3);
    vec3 col = k < 0.55 ? vec3(1.0, 0.52, 0.16) : k < 0.86 ? vec3(0.95, 0.88, 0.76) : k < 0.94 ? vec3(0.18, 0.78, 1.0) : vec3(1.0, 0.22, 0.55);
    acc += col * disc * (0.85 + 0.15 * sin(uTime * (0.4 + h.x) + h.y * 6.283));
  }
  return acc;
}
void main() {
  vec2 uv = vec2(vUv.x * uAspect, vUv.y);
  vec3 col = mix(vec3(0.020, 0.013, 0.010), vec3(0.002, 0.004, 0.012), smoothstep(0.0, 0.9, vUv.y));
  float bh = 0.22 + 0.34 * hash12(vec2(floor(uv.x * 6.0), 3.0));
  col = mix(col, vec3(0.003, 0.003, 0.005), smoothstep(bh + 0.03, bh - 0.03, vUv.y) * 0.9);
  float band = smoothstep(0.9, 0.2, vUv.y);
  col += (bokeh(uv, 4.5, 1.0) * 0.9 + bokeh(uv, 8.5, 7.0) * 0.55 + bokeh(uv + vec2(0.0, 0.1), 14.0, 13.0) * 0.3) * band;
  for (int k = 0; k < 2; k++) {
    float fk = float(k), sc = 9.0 + fk * 13.0;
    vec2 su = uv * sc + vec2(sin(uTime * 0.3 + fk) * 0.8, uTime * (0.8 + fk * 0.7));
    vec2 f = fract(su) - 0.5, h = hash22(floor(su) + fk * 5.0);
    float flake = smoothstep(0.2 - fk * 0.09, 0.0, length(f - (h - 0.5) * 0.7)) * step(0.62, h.x);
    col += vec3(0.10, 0.11, 0.13) * flake * uSnow;
  }
  o = vec4(col, 1.0);
}`;

  const COMPOSITE = `
uniform sampler2D uBg, uFog, uDrops;
uniform vec2 uRes;
uniform float uRoom;
in vec2 vUv; out vec4 o;
void main() {
  float fog = textureBicubic(uFog, vUv).r;
  float grain = hash12(floor(gl_FragCoord.xy * 0.75));
  float f = clamp(fog * (0.85 + 0.3 * grain), 0.0, 1.0);
  vec3 sharp = textureLod(uBg, vUv, 0.0).rgb;
  vec3 blur = textureLod(uBg, vUv, 1.0 + 5.0 * fog).rgb;
  vec3 col = mix(sharp, blur, smoothstep(0.0, 0.35, fog));
  vec3 veil = vec3(0.050, 0.056, 0.066) * uRoom + blur * 0.25;   // room light scattered back by the droplets
  col = mix(col, veil, f * 0.8);
  vec4 d = texelFetch(uDrops, ivec2(gl_FragCoord.xy), 0);
  if (d.a > 0.002) {
    vec2 p = d.xy / d.a;
    float rpx = d.z / d.a;
    float l2 = min(dot(p, p), 1.0);
    const float SIN_T = 0.6428;                                  // contact angle 40°
    vec3 n = normalize(vec3(p * SIN_T, sqrt(1.0 - l2 * SIN_T * SIN_T)));
    vec2 centre = vUv - p * rpx / uRes;
    vec2 uvR = centre - p * rpx * 7.0 / uRes;                    // inverted, minified image of the far scene
    vec3 refr = textureLod(uBg, uvR, 0.6).rgb;
    float fres = 0.02 + 0.98 * pow(1.0 - n.z, 5.0);
    float rim = smoothstep(0.5, 1.0, sqrt(l2));                  // total internal reflection at the edge
    vec3 dc = refr * (1.0 - 0.9 * rim) * (1.0 - fres);
    vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
    float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), L), 0.0), 140.0);
    dc += vec3(1.0, 0.9, 0.78) * spec * 3.0 * uRoom + vec3(0.05, 0.055, 0.065) * fres * uRoom;
    col = mix(col, dc, d.a);
  }
  o = vec4(dither(toSrgb(aces(col * 1.4))), 1.0);
}`;

  // value noise on the CPU for surface heterogeneity (4 mm cells)
  const HN = 64, HGRID = new Float32Array(HN * HN).map(() => Math.random());
  function hetero(x, y) {
    const gx = x / 4, gy = y / 4;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const at = (i, j) => HGRID[((j & (HN - 1)) * HN) + (i & (HN - 1))];
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (at(ix, iy) * (1 - u) + at(ix + 1, iy) * u) * (1 - v) + (at(ix, iy + 1) * (1 - u) + at(ix + 1, iy + 1) * u) * v;
  }

  class WaterSim {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = new ES.gl.Ctx(canvas);
      const ctx = this.ctx, gl = ctx.gl;
      this.prog = {
        drop: ctx.program(DROP_FS, '', VS_INST), stamp: ctx.program(STAMP_FS, '', VS_INST),
        fogInit: ctx.program(FOG_INIT), fogStep: ctx.program(FOG_STEP), bg: ctx.program(BG), comp: ctx.program(COMPOSITE),
      };
      this.cap = QUALITY[2].max;
      this.x = new Float32Array(this.cap); this.y = new Float32Array(this.cap); this.r = new Float32Array(this.cap);
      this.vy = new Float32Array(this.cap); this.vx = new Float32Array(this.cap);
      this.pin = new Float32Array(this.cap); this.trail = new Float32Array(this.cap);
      this.moving = new Uint8Array(this.cap);
      this.n = 0;
      this.inst = new Float32Array(this.cap * 4 * 3);
      this.vao = gl.createVertexArray();
      this.buf = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(ctx.vao);
      this.env = { tin: 22, rh: 75, tout: -2, glazing: 'single' };
      this.dehumidify = false;
      this.stats = { fps: 0, simTime: 0, quality: 1, drops: 0, water: 0 };
      this.qi = -1;
      this.time = 0;
      this.pointer = ES.gl.trackPointer(canvas);
      this.prevPtr = null;
      this.carried = 0;
      this.stamps = [];
      this.derive();
    }

    setEnv(e) { Object.assign(this.env, e); this.derive(); }

    derive() {
      const e = this.env, u = P.GLAZING[e.glazing].u;
      const ts = P.glassSurfaceTemp(e.tin, e.tout, u);
      this.derived = {
        surface: ts, dew: P.dewPoint(e.tin, e.rh), S: P.supersaturation(e.tin, e.rh, ts),
      };
      this.derived.state = this.derived.S > 0 ? 'condensing' : 'drying';
      return this.derived;
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
      if (!force && !s.changed) return;
      const ctx = this.ctx, gl = ctx.gl;
      const first = !this.fog;
      this.mmPerCss = 1 / Math.min(7, Math.max(4, s.cssW / 200));
      this.Wmm = s.cssW * this.mmPerCss;
      this.Hmm = s.cssH * this.mmPerCss;
      this.pxPerMm = s.w / this.Wmm;
      for (const t of [this.fog, this.drops]) if (t) ctx.free(t);
      if (this.bg) { gl.deleteTexture(this.bg.tex); gl.deleteFramebuffer(this.bg.fbo); }
      this.fog = ctx.double(Math.max(2, s.w >> 1), Math.max(2, s.h >> 1), 'R');
      this.drops = ctx.target(s.w, s.h, 'RGBA', 'nearest');
      this.bg = this.mipTarget(Math.max(2, Math.round(s.w * q.bg)), Math.max(2, Math.round(s.h * q.bg)));
      ctx.draw(this.prog.fogInit, this.fog.read, {});   // drops keep their mm positions; fog restarts settled
      if (first) this.seed(q.max * 0.45);
      while (this.n > q.max) this.kill(this.n - 1);
    }

    mipTarget(w, h) {
      const gl = this.ctx.gl;
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, this.ctx.formats.RGBA.internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo, w, h, texel: [1 / w, 1 / h] };
    }

    add(x, y, r) {
      if (this.n >= QUALITY[this.qi].max) return -1;
      const i = this.n++;
      this.x[i] = x; this.y[i] = y; this.r[i] = r; this.vx[i] = 0; this.vy[i] = 0;
      this.pin[i] = 0.8 + 0.5 * Math.random(); this.trail[i] = 0; this.moving[i] = 0;
      return i;
    }

    kill(i) {
      const j = --this.n;
      if (i === j) return;
      this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.r[i] = this.r[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
      this.pin[i] = this.pin[j]; this.trail[i] = this.trail[j]; this.moving[i] = this.moving[j];
    }

    /** A window that has been fogging for a while: mostly small drops, a few near the sliding size. */
    seed(count) {
      for (let k = 0; k < count; k++) {
        const u = Math.random();
        this.add(Math.random() * this.Wmm, this.Hmm * Math.pow(Math.random(), 0.7), 0.08 + 1.7 * u * u * u);
      }
    }

    physics(dt) {
      const dv = this.derived, S = dv.S, W = this.Wmm, H = this.Hmm;
      // condensation / evaporation, time-lapsed
      const g = K_GROW * S * dt * TL;
      for (let i = this.n - 1; i >= 0; i--) {
        const r2 = this.r[i] * this.r[i] + g;
        if (r2 < 0.0004) this.kill(i); else this.r[i] = Math.sqrt(r2);
      }
      if (S > 0) {
        let expect = NUCLEATION * W * H * S * dt * TL;
        while (expect > 0) {
          if (Math.random() < Math.min(1, expect)) this.add(Math.random() * W, H * Math.pow(Math.random(), 0.7), 0.06 + 0.12 * Math.random());
          expect -= 1;
        }
      }
      // gravity against contact-line pinning (real time)
      this.stamps.length = 0;
      for (let i = this.n - 1; i >= 0; i--) {
        const a = this.r[i] * 1e-3;
        const fg = WEIGHT * a * a * a;
        const fp = PIN * a * this.pin[i] * (0.8 + 0.4 * hetero(this.x[i], this.y[i]));
        if (!this.moving[i] && fg > fp) this.moving[i] = 1;
        if (this.moving[i] && fg < 0.7 * fp) { this.moving[i] = 0; this.vy[i] = 0; }
        if (this.moving[i]) {
          const vt = Math.max(0, (fg - 0.7 * fp) / (DRAG * a)) * 1000;   // mm/s
          this.vy[i] += (vt - this.vy[i]) * (1 - Math.exp(-dt / 0.05));
          this.vx[i] = 0.35 * this.vy[i] * (hetero(this.x[i] + 37, this.y[i] * 0.5) - 0.5);
          const dy = this.vy[i] * dt;
          this.y[i] += dy; this.x[i] += this.vx[i] * dt;
          this.trail[i] += dy;
          this.stamps.push(this.x[i], this.y[i], this.r[i] * 1.15, 1.0);
          if (this.trail[i] > 1.3 * this.r[i]) {
            this.trail[i] = 0;
            const rt = this.r[i] * (0.12 + 0.12 * Math.random());
            this.add(this.x[i] + (Math.random() - 0.5) * this.r[i] * 0.4, this.y[i] - this.r[i] * 0.9, rt);
            this.r[i] = Math.cbrt(Math.max(this.r[i] ** 3 - rt ** 3, 1e-6));
          }
          if (this.y[i] - this.r[i] > H + 2) { this.kill(i); continue; }
        } else if (this.r[i] > 0.5) {
          this.stamps.push(this.x[i], this.y[i], this.r[i] * 1.7, 0.04);   // dry halo around a big drop
        }
      }
      this.coalesce();
    }

    coalesce() {
      const cell = 1.2, n = this.n;
      const cols = Math.ceil(this.Wmm / cell) + 2, rows = Math.ceil(this.Hmm / cell) + 8;
      const size = cols * rows;
      if (!this.head || this.head.length < size) this.head = new Int32Array(size);
      if (!this.next || this.next.length < this.cap) this.next = new Int32Array(this.cap);
      const head = this.head.fill(-1, 0, size), next = this.next;
      let rmax = 0;
      const cx = (x) => Math.min(cols - 1, Math.max(0, Math.floor(x / cell) + 1));
      const cy = (y) => Math.min(rows - 1, Math.max(0, Math.floor(y / cell) + 4));
      for (let i = 0; i < n; i++) {
        const k = cy(this.y[i]) * cols + cx(this.x[i]);
        next[i] = head[k]; head[k] = i;
        if (this.r[i] > rmax) rmax = this.r[i];
      }
      const dead = this.dead && this.dead.length >= n ? this.dead.fill(0, 0, n) : (this.dead = new Uint8Array(this.cap));
      for (let i = 0; i < n; i++) {
        if (dead[i]) continue;
        const reach = Math.ceil((this.r[i] + rmax) / cell);
        const gx = cx(this.x[i]), gy = cy(this.y[i]);
        for (let yy = Math.max(0, gy - reach); yy <= Math.min(rows - 1, gy + reach); yy++) {
          for (let xx = Math.max(0, gx - reach); xx <= Math.min(cols - 1, gx + reach); xx++) {
            for (let j = head[yy * cols + xx]; j !== -1; j = next[j]) {
              if (j === i || dead[j]) continue;
              const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i], rr = this.r[i] + this.r[j];
              if (dx * dx + dy * dy >= rr * rr) continue;
              const vi = this.r[i] ** 3, vj = this.r[j] ** 3, v = vi + vj;
              this.x[i] = (this.x[i] * vi + this.x[j] * vj) / v;
              this.y[i] = (this.y[i] * vi + this.y[j] * vj) / v;
              this.vy[i] = (this.vy[i] * vi + this.vy[j] * vj) / v;
              this.moving[i] = this.moving[i] | this.moving[j];
              this.r[i] = Math.cbrt(v);
              dead[j] = 1;
            }
          }
        }
      }
      for (let i = n - 1; i >= 0; i--) if (dead[i]) { this.kill(i); dead[i] = dead[this.n] || 0; }
    }

    wipe() {
      const p = this.pointer;
      if (!(p.down && p.inside)) {
        if (this.carried > 0 && this.prevPtr) {
          this.add(this.prevPtr[0], Math.min(this.Hmm, this.prevPtr[1] + FINGER * 0.8), Math.cbrt(this.carried));
          this.carried = 0;
        }
        this.prevPtr = null;
        return;
      }
      const x = p.x * this.Wmm, y = (1 - p.y) * this.Hmm;
      const from = this.prevPtr || [x, y];
      const len = Math.hypot(x - from[0], y - from[1]);
      const steps = Math.max(1, Math.ceil(len / 2));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, sx = from[0] + (x - from[0]) * t, sy = from[1] + (y - from[1]) * t;
        this.stamps.push(sx, sy, FINGER, 1.0);
        for (let i = this.n - 1; i >= 0; i--) {
          const dx = this.x[i] - sx, dy = this.y[i] - sy;
          if (dx * dx + dy * dy < FINGER * FINGER) { this.carried += this.r[i] ** 3 * 0.8; this.kill(i); }
        }
      }
      if (this.carried > 3.5 ** 3) {       // too much water on the fingertip: it runs off
        this.add(x, Math.min(this.Hmm, y + FINGER * 0.9), Math.cbrt(this.carried));
        this.carried = 0;
      }
      this.prevPtr = [x, y];
    }

    upload(list, count) {
      const gl = this.ctx.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, count * 4);
      return list;
    }

    drawInstanced(prog, target, count, uniforms, blend) {
      const ctx = this.ctx, gl = ctx.gl;
      if (!count) return;
      ctx.use(prog, uniforms);
      ctx.bind(target);
      gl.enable(gl.BLEND);
      gl.blendFunc(blend[0], blend[1]);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(ctx.vao);
      gl.disable(gl.BLEND);
    }

    step(dt) {
      if (this.dehumidify && this.env.rh > 45) this.setEnv({ rh: Math.max(45, this.env.rh - 2.2 * dt) });
      this.physics(dt);
      this.wipe();
      const ctx = this.ctx, gl = ctx.gl, S = this.derived.S;
      ctx.draw(this.prog.fogStep, this.fog.write, {
        uFog: this.fog.read, uDt: dt, uGrow: S > 0 ? 0.12 * Math.min(S, 3) * TL / 10 : 0,
        uDry: S < 0 ? 0.6 * Math.min(-S, 1) * TL / 10 : 0,
      });
      this.fog.swap();
      const ns = this.stamps.length / 4;
      if (ns) {
        this.inst.set(this.stamps.length > this.inst.length ? this.stamps.slice(0, this.inst.length) : this.stamps);
        this.upload(null, Math.min(ns, this.inst.length / 4));
        this.drawInstanced(this.prog.stamp, this.fog.read, Math.min(ns, this.inst.length / 4), {
          uRes: [this.fog.w, this.fog.h], uPxPerMm: this.pxPerMm * this.fog.w / this.canvas.width, uStretchK: 0,
        }, [gl.ZERO, gl.SRC_COLOR]);
      }
      this.time += dt;
      this.stats.simTime += dt;
    }

    render() {
      const ctx = this.ctx, gl = ctx.gl, c = this.canvas;
      ctx.draw(this.prog.bg, this.bg, { uTime: this.time, uSnow: this.env.tout < 1 ? 1 : 0, uAspect: this.bg.w / this.bg.h, uLo: -1, uHi: 1 });
      gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      for (let i = 0; i < this.n; i++) {
        const o = i * 4;
        this.inst[o] = this.x[i]; this.inst[o + 1] = this.y[i]; this.inst[o + 2] = this.r[i]; this.inst[o + 3] = this.moving[i] ? this.vy[i] : 0;
      }
      this.upload(null, this.n);
      ctx.clear(this.drops, [0, 0, 0, 0]);
      this.drawInstanced(this.prog.drop, this.drops, this.n, {
        uRes: [c.width, c.height], uPxPerMm: this.pxPerMm, uStretchK: 0.004,
      }, [gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
      ctx.draw(this.prog.comp, null, { uBg: this.bg, uFog: this.fog.read, uDrops: this.drops, uRes: [c.width, c.height], uRoom: 1.0 });
    }

    warmup(seconds) {
      for (let t = 0; t < seconds; t += 1 / 30) this.step(1 / 30);
      this.render();
    }

    frame(dt, now) {
      if (this.ctx.lost) return;
      this.resize(false);
      this.step(Math.min(dt, 1 / 30));
      this.render();
      let vol = 0;
      for (let i = 0; i < this.n; i++) vol += SHAPE * this.r[i] ** 3;          // mm³ = mg
      Object.assign(this.stats, { drops: this.n, water: vol / (this.Wmm * this.Hmm) * 1000 }); // g/m²
    }
  }

  WaterSim.QUALITY = QUALITY;
  WaterSim.TL = TL;
  ES.WaterSim = WaterSim;
})(window.ES = window.ES || {});
