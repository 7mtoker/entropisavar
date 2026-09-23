/*
 * air.js — a vertical section through a 2.7 m room: a split AC on the right
 * wall, a gaming PC on the floor, sun-warmed walls.
 *
 * Physics: incompressible flow with Boussinesq buoyancy a = g·(T − T̄)/T̄
 * (the hydrostatic part relative to the room mean is absorbed by pressure),
 * the AC outlet as a momentum + enthalpy source, walls exchanging heat with a
 * thin boundary layer, and a thermostat with hysteresis reading the air that
 * actually reaches the unit's intake. Mist is condensate carried by the cold
 * jet; it evaporates as the parcel warms.
 *
 * Views: visible (mist + heat-haze refraction), thermal (ironbow + isotherms),
 * schlieren (knife-edge on ∂T/∂x).
 */
(function (ES) {
  'use strict';
  const P = ES.physics;
  const T_REF = 25;                 // °C — the scalar field stores T − T_REF (x) and mist (y)
  const ROOM_H = 2.7;               // m
  const RX = 24, RY = 14;           // readback grid
  const QUALITY = [
    { ny: 88, dpr: 1, px: 0.8e6, jacobi: 14 },
    { ny: 120, dpr: 1.25, px: 1.3e6, jacobi: 18 },
    { ny: 150, dpr: 1.5, px: 2.0e6, jacobi: 24 },
  ];
  const FAN = { quiet: 1.6, auto: 2.6, turbo: 4.0 }; // outlet velocity, m/s
  const SLOT = 0.06;                                   // outlet slot height, m
  const WALL_T = 31, CEIL_T = 33;                      // sun-loaded envelope, °C

  const SHARED = `
const float T_REF = ${T_REF.toFixed(1)};
uniform vec2 uDomain;
uniform vec4 uJet;      // centre (m), half-length along the jet, half-width
uniform vec2 uJetDir;
uniform vec4 uAc;       // AC body: centre, half extents (m)
uniform vec4 uPc;       // PC body
uniform vec4 uVent;     // PC exhaust
float jetMask(vec2 x) {
  vec2 d = x - uJet.xy;
  vec2 l = vec2(dot(d, uJetDir), dot(d, vec2(-uJetDir.y, uJetDir.x)));
  return smoothstep(1.0, 0.55, abs(l.x) / uJet.z) * smoothstep(1.0, 0.45, abs(l.y) / uJet.w);
}
float boxMask(vec2 x, vec4 b) { return step(sdBox(x - b.xy, b.zw, 0.0), 0.0); }
`;

  const INIT = `
uniform float uT0, uStrat;
in vec2 vUv; out vec4 o;
void main() { o = vec4(uT0 - ${T_REF.toFixed(1)} + uStrat * (vUv.y - 0.5), 0.0, 0.0, 1.0); }`;

  const FORCES = `${SHARED}
uniform sampler2D uVel, uScal;
uniform float uDt, uMeanT, uJetSpeed, uVentSpeed;
in vec2 vUv; out vec4 o;
void main() {
  vec2 x = vUv * uDomain;
  vec2 v = texture(uVel, vUv).xy;
  float T = texture(uScal, vUv).x + T_REF;
  v.y += uDt * 9.80665 * (T - uMeanT) / (uMeanT + 273.15);
  float k = 1.0 - exp(-uDt / 0.04);
  v = mix(v, uJetDir * uJetSpeed, jetMask(x) * k);
  float vent = smoothstep(1.0, 0.4, abs(x.x - uVent.x) / uVent.z) * smoothstep(1.0, 0.3, abs(x.y - uVent.y) / uVent.w);
  v = mix(v, vec2(0.0, uVentSpeed), vent * k);
  float solid = max(boxMask(x, uAc), boxMask(x, uPc));
  o = vec4(v * (1.0 - solid), 0.0, 1.0);
}`;

  const HEAT = `${SHARED}
uniform sampler2D uScal;
uniform float uDt, uSupplyT, uSupplyFog, uVentT, uWallT, uCeilT, uCell;
in vec2 vUv; out vec4 o;
void main() {
  vec2 x = vUv * uDomain;
  vec2 s = texture(uScal, vUv).xy;
  float T = s.x + T_REF, fog = s.y;
  float k = 1.0 - exp(-uDt / 0.04);
  float jm = jetMask(x) * k;
  T = mix(T, uSupplyT, jm);
  fog = mix(fog, uSupplyFog, jm);
  float vent = smoothstep(1.0, 0.4, abs(x.x - uVent.x) / uVent.z) * smoothstep(1.0, 0.3, abs(x.y - uVent.y) / uVent.w);
  T = mix(T, uVentT, vent * k);
  // PC case skin warms the air touching it
  float skin = 1.0 - smoothstep(0.0, 2.0 * uCell, sdBox(x - uPc.xy, uPc.zw, 0.0));
  T = mix(T, uVentT - 10.0, skin * (1.0 - exp(-uDt / 4.0)));
  // envelope: a boundary layer two cells thick exchanges heat with the walls
  float dSide = min(min(x.x, uDomain.x - x.x), x.y);
  float dCeil = uDomain.y - x.y;
  float wSide = 1.0 - smoothstep(0.0, 2.5 * uCell, dSide);
  float wCeil = 1.0 - smoothstep(0.0, 2.5 * uCell, dCeil);
  float kw = 1.0 - exp(-uDt / 18.0);
  T = mix(T, uWallT, wSide * kw);
  T = mix(T, uCeilT, wCeil * kw);
  // condensate mist evaporates as the parcel warms above the supply air
  fog *= exp(-uDt * (0.06 + 0.55 * max(0.0, T - uSupplyT - 1.5)));
  o = vec4(T - T_REF, clamp(fog, 0.0, 1.0), 0.0, 1.0);
}`;

  const REDUCE = `
uniform sampler2D uScal;
in vec2 vUv; out vec4 o;
void main() {
  vec2 cell = 1.0 / vec2(${RX}.0, ${RY}.0);
  vec4 s = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    s += textureLod(uScal, vUv + ((vec2(i, j) + 0.5) / 4.0 - 0.5) * cell, 0.0);
  o = s / 16.0;
}`;

  const DISPLAY = `${SHARED}
uniform sampler2D uScal;
uniform vec2 uRes;
uniform int uMode, uOne;   // uOne = 1: a uniform loop start keeps ANGLE from unrolling
uniform float uTime, uFlap, uLed, uSupplyT, uRgb, uHaze;
in vec2 vUv; out vec4 o;

vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 ironbow(float t) {
  vec3 c[8] = vec3[8](vec3(0.00, 0.00, 0.05), vec3(0.12, 0.04, 0.36), vec3(0.37, 0.05, 0.55), vec3(0.70, 0.13, 0.49),
                      vec3(0.91, 0.33, 0.23), vec3(0.98, 0.60, 0.08), vec3(0.99, 0.87, 0.28), vec3(1.00, 0.98, 0.88));
  float f = clamp(t, 0.0, 1.0) * 7.0;
  int i = min(int(f), 6);
  return lin(mix(c[i], c[i + 1], f - float(i)));
}
float grid(float x, float step, float px) {
  float d = abs(fract(x / step + 0.5) - 0.5) * step;
  return 1.0 - smoothstep(0.35 * px, 1.1 * px, d);
}
vec3 wall(vec2 x, float px) {
  vec3 c = vec3(0.010, 0.013, 0.019);
  float lamp = exp(-pow((x.x - uDomain.x * 0.34) / 1.3, 2.0)) * (0.35 + 0.65 * x.y / uDomain.y);
  c += vec3(0.020, 0.024, 0.032) * lamp;
  float minor = max(grid(x.x, 0.1, px), grid(x.y, 0.1, px));
  float major = max(grid(x.x, 0.5, px), grid(x.y, 0.5, px));
  c += vec3(0.004, 0.007, 0.010) * minor + vec3(0.010, 0.018, 0.026) * major;
  c *= 1.0 - 0.35 * smoothstep(0.35, 0.0, x.y);          // floor shadow
  return c;
}
float temp(vec2 uv) { return textureBicubic(uScal, uv).x + T_REF; }

// AC in side profile: body, intake grille, LED strip, louvre.
vec4 acLayer(vec2 x, float px, bool thermal) {
  float d = sdBox(x - uAc.xy, uAc.zw, 0.035);
  float a = cover(d, px);
  float h = (x.y - (uAc.y - uAc.w)) / (2.0 * uAc.w);
  vec3 c = lin(vec3(0.80, 0.83, 0.86)) * (0.20 + 0.16 * h);
  c += vec3(0.10) * (1.0 - smoothstep(0.0, 3.0 * px, abs(d))) * step(uAc.y + uAc.w * 0.6, x.y);
  float grille = step(uAc.y + uAc.w - 0.04, x.y) * step(0.5, fract((x.x - uAc.x) * 90.0));
  c *= 1.0 - 0.45 * grille;
  float ledX = uAc.x - uAc.z + 0.012;
  float led = 1.0 - smoothstep(0.0, 1.5 * px, sdSegment(x, vec2(ledX, uAc.y - 0.02), vec2(ledX, uAc.y + 0.06)));
  c = mix(c, vec3(0.20, 0.75, 1.0) * (0.2 + 2.2 * uLed), led);
  vec2 hinge = vec2(uAc.x - uAc.z + 0.04, uAc.y - uAc.w + 0.01);
  vec2 tip = hinge + vec2(-cos(uFlap), -sin(uFlap)) * 0.11;
  float flap = cover(sdSegment(x, hinge, tip) - 0.005, px);
  c = mix(c, lin(vec3(0.72, 0.75, 0.78)) * 0.22, flap);
  a = max(a, flap);
  if (thermal) c = ironbow((uSupplyT + 3.0 - 14.0) / 22.0) * (0.9 + 0.1 * h);
  return vec4(c, a);
}
vec3 hue(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
vec4 pcLayer(vec2 x, float px, bool thermal) {
  float d = sdBox(x - uPc.xy, uPc.zw, 0.012);
  float a = cover(d, px);
  vec3 c = vec3(0.012, 0.013, 0.016);
  c += vec3(0.03) * smoothstep(uPc.y - uPc.w, uPc.y + uPc.w, x.y) * step(0.0, -d - 0.012); // glass panel sheen
  for (int i = 0; i < 3; i++) {
    vec2 fc = vec2(uPc.x - uPc.z * 0.42, uPc.y + uPc.w * 0.62 - float(i) * uPc.w * 0.62);
    vec2 q = x - fc;
    float r = length(q);
    float ring = 1.0 - smoothstep(0.0, 1.6 * px, abs(r - 0.056));
    float ang = atan(q.y, q.x) + uTime * 14.0;
    float blades = step(r, 0.05) * smoothstep(0.35, 0.6, abs(sin(ang * 4.5))) * 0.35;
    vec3 rgb = hue(uRgb + float(i) * 0.12);
    c += rgb * (ring * 1.6 + blades * 0.08 + 0.05 * exp(-r * 40.0));
  }
  if (thermal) c = ironbow((40.0 + 4.0 * smoothstep(uPc.y - uPc.w, uPc.y + uPc.w, x.y) - 14.0) / 22.0);
  return vec4(c, a);
}

void main() {
  vec2 x = vUv * uDomain;
  float px = uDomain.y / uRes.y;
  vec2 e = 1.0 / vec2(textureSize(uScal, 0));
  float Tl = temp(vUv - vec2(e.x, 0.0)), Tr = temp(vUv + vec2(e.x, 0.0));
  float Tb = temp(vUv - vec2(0.0, e.y)), Tt = temp(vUv + vec2(0.0, e.y));
  vec2 grad = vec2(Tr - Tl, Tt - Tb) / (2.0 * e * uDomain);   // °C per metre
  vec3 col;
  if (uMode == 1) {
    float T = temp(vUv);
    col = ironbow((T - 14.0) / 22.0);
    float fw = max(fwidth(T), 1e-4);
    float iso1 = 1.0 - clamp(abs(fract(T + 0.5) - 0.5) / (fw * 1.1), 0.0, 1.0);
    float iso5 = 1.0 - clamp(abs(fract(T / 5.0 + 0.5) - 0.5) * 5.0 / (fw * 1.4), 0.0, 1.0);
    col *= 1.0 - 0.35 * iso1;
    col = mix(col, vec3(1.0), 0.28 * iso5);
    vec4 ac = acLayer(x, px, true); col = mix(col, ac.rgb, ac.a);
    vec4 pc = pcLayer(x, px, true); col = mix(col, pc.rgb, pc.a);
  } else if (uMode == 2) {
    float k = dot(grad, normalize(vec2(1.0, 0.18)));
    float I = 0.5 + 0.5 * tanh(k * 0.018);
    col = lin(vec3(I) * vec3(1.0, 0.97, 0.92));
    vec2 c = (vUv - 0.5) * vec2(uDomain.x / uDomain.y, 1.0);
    col *= smoothstep(1.05, 0.35, length(c));
    vec4 ac = acLayer(x, px, false); col = mix(col, vec3(0.004), ac.a);
    vec4 pc = pcLayer(x, px, false); col = mix(col, vec3(0.004), pc.a);
  } else {
    vec2 xr = x - grad * uHaze;                 // refraction by the index gradient (exaggerated, see page)
    col = wall(xr, px);
    float fog = textureBicubic(uScal, vUv).y;
    vec2 L = normalize(vec2(-0.45, 1.0));
    float occ = 0.0;
    for (int i = uOne; i <= 6; i++) occ += textureLod(uScal, vUv + L * float(i) * 5.0 * e, 0.0).y;
    float lit = exp(-occ * 0.55);
    float tau = fog * 2.4;
    float ledGlow = uLed * exp(-length((x - (uAc.xy - vec2(uAc.z, uAc.w))) / 0.6));
    vec3 mist = vec3(0.30, 0.36, 0.43) * (0.25 + 0.75 * lit) + vec3(0.05, 0.16, 0.24) * ledGlow;
    col = col * exp(-tau) + mist * (1.0 - exp(-tau));
    vec4 ac = acLayer(x, px, false); col = mix(col, ac.rgb, ac.a);
    vec4 pc = pcLayer(x, px, false); col = mix(col, pc.rgb, pc.a);
    col = aces(col * 1.6);
  }
  o = vec4(dither(toSrgb(col)), 1.0);
}`;

  class AirSim {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = new ES.gl.Ctx(canvas);
      const ctx = this.ctx;
      this.fluid = new ES.Fluid(ctx, { scalar: 'RG', vorticity: 2.5, jacobi: 18, ambient: [4, 0, 0, 0] });
      this.prog = {
        init: ctx.program(INIT), forces: ctx.program(FORCES), heat: ctx.program(HEAT),
        reduce: ctx.program(REDUCE), display: ctx.program(DISPLAY),
      };
      this.reduced = ctx.target(RX, RY, 'RGBA', 'nearest');
      this.readback = new ES.gl.Readback(ctx, RX, RY);
      this.view = 0;
      this.setpoint = 24;
      this.fan = 'auto';
      this.swing = true;
      this.humid = true;
      this.state = { compressor: true, supplyT: 16, fog: 0.8, returnT: 29, meanT: 29, flapPhase: 0 };
      this.stats = { fps: 0, simTime: 0, quality: 1, meanT: 29, probeT: null, supplyT: 16, speed: FAN.auto, compressor: true };
      this.qi = -1;
      this.lastRead = 0;
      this.time = 0;
      this.pointer = ES.gl.trackPointer(canvas);
      this.probe = null;
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
      const aspect = Math.max(0.5, s.cssW / s.cssH);
      const ny = q.ny, nx = Math.round(ny * aspect);
      if (!force && !s.changed && this.fluid.nx === nx) return;
      const fresh = !this.fluid.vel;
      this.W = ROOM_H * aspect;
      this.fluid.resize(nx, ny, this.W, ROOM_H);
      this.fluid.o.jacobi = q.jacobi;
      this.geometry();
      if (fresh) this.reset();
    }

    geometry() {
      const W = this.W;
      this.ac = [W - 0.15, 2.30, 0.15, 0.15];
      const pcX = Math.min(W - 0.9, Math.max(W * 0.6, 0.5));
      this.pc = [pcX, 0.24, 0.23, 0.24];
      this.vent = [pcX + 0.06, 0.51, 0.09, 0.025];
    }

    reset() {
      this.ctx.draw(this.prog.init, this.fluid.scal.read, { uT0: 29, uStrat: 1.8 });
      Object.assign(this.state, { compressor: true, supplyT: 16, returnT: 29, meanT: 29 });
    }

    flapAngle() {
      const base = 0.62;
      if (!this.swing) return base;
      return base + 0.42 * Math.sin(this.state.flapPhase);
    }

    jet() {
      const th = this.flapAngle();
      const dir = [-Math.cos(th), -Math.sin(th)];
      const hinge = [this.ac[0] - this.ac[2] + 0.06, this.ac[1] - this.ac[3] - 0.012];
      return { dir, u: [hinge[0] + dir[0] * 0.05, hinge[1] + dir[1] * 0.05, 0.05, SLOT / 2], th };
    }

    thermostat(dt) {
      const st = this.state;
      if (st.returnT > this.setpoint + 0.4) st.compressor = true;
      else if (st.returnT < this.setpoint - 0.4) st.compressor = false;
      const target = st.compressor ? st.returnT - 11 : st.returnT;
      st.supplyT += (target - st.supplyT) * (1 - Math.exp(-dt / 6));
      const fogTarget = this.humid && st.compressor ? 0.85 : 0;
      st.fog += (fogTarget - st.fog) * (1 - Math.exp(-dt / 2.5));
      if (this.swing) st.flapPhase += dt * (2 * Math.PI / 11);
    }

    readStats(now) {
      if (this.readback.poll()) {
        const d = this.readback.data;
        let sum = 0;
        for (let i = 0; i < RX * RY; i++) sum += d[i * 4];
        this.state.meanT = sum / (RX * RY) + T_REF;
        // intake sits just above-left of the unit
        const ix = Math.min(RX - 1, Math.floor((this.ac[0] - this.ac[2] - 0.15) / this.W * RX));
        const iy = Math.min(RY - 1, Math.floor((this.ac[1] + this.ac[3] + 0.05) / ROOM_H * RY));
        this.state.returnT = d[(iy * RX + ix) * 4] + T_REF;
        if (this.pointer.inside) {
          const px = Math.min(RX - 1, Math.max(0, Math.floor(this.pointer.x * RX)));
          const py = Math.min(RY - 1, Math.max(0, Math.floor(this.pointer.y * RY)));
          this.probe = d[(py * RX + px) * 4] + T_REF;
        } else this.probe = null;
      }
      if (now - this.lastRead > 250) {
        this.ctx.draw(this.prog.reduce, this.reduced, { uScal: this.fluid.scal.read });
        if (this.readback.request(this.reduced)) this.lastRead = now;
      }
    }

    step(dt) {
      const f = this.fluid, st = this.state;
      this.thermostat(dt);
      const jet = this.jet();
      const speed = FAN[this.fan];
      const shared = { uDomain: [this.W, ROOM_H], uJet: jet.u, uJetDir: jet.dir, uAc: this.ac, uPc: this.pc, uVent: this.vent };
      const p = this.pointer;
      f.step(dt, {
        sources: () => {
          f.pass(this.prog.heat, f.scal, {
            ...shared, uDt: dt, uSupplyT: st.supplyT, uSupplyFog: st.fog, uVentT: 45, uWallT: WALL_T, uCeilT: CEIL_T, uCell: f.h,
          });
          f.pass(this.prog.forces, f.vel, { ...shared, uDt: dt, uMeanT: st.meanT, uJetSpeed: speed, uVentSpeed: 0.7 });
          if (p.down && p.inside) {
            const k = ROOM_H / this.canvas.getBoundingClientRect().height;
            const vx = Math.max(-5, Math.min(5, p.dx * k)), vy = Math.max(-5, Math.min(5, p.dy * k));
            f.splat(f.vel, [p.x, p.y], 0.045, [vx * 0.35, vy * 0.35, 0, 0]);
            p.dx *= 0.5; p.dy *= 0.5;
          }
        },
      });
      this.time += dt;
      this.stats.simTime += dt;
    }

    render() {
      const c = this.canvas, st = this.state;
      this.ctx.draw(this.prog.display, null, {
        uScal: this.fluid.scal.read, uDomain: [this.W, ROOM_H], uRes: [c.width, c.height], uMode: this.view, uOne: 1,
        uTime: this.time, uFlap: this.flapAngle(), uLed: st.compressor ? 1 : 0.15, uSupplyT: st.supplyT,
        uRgb: this.time * 0.08, uHaze: 4.5e-5, uAc: this.ac, uPc: this.pc, uVent: this.vent,
        uJet: this.jet().u, uJetDir: this.jet().dir,
      });
    }

    warmup(seconds) {
      for (let t = 0; t < seconds; t += 1 / 30) this.step(1 / 30);
      this.render();
    }

    frame(dt, now) {
      if (this.ctx.lost) return;
      this.resize(false);
      this.step(Math.min(dt, 1 / 30));
      this.readStats(now);
      this.render();
      const st = this.state, s = this.stats;
      Object.assign(s, {
        meanT: st.meanT, supplyT: st.supplyT, compressor: st.compressor, probeT: this.probe,
        speed: FAN[this.fan], reynolds: P.reynolds(FAN[this.fan], SLOT),
        buoyancy: P.buoyancyAccel(st.meanT - st.supplyT, st.meanT + P.KELVIN),
      });
    }
  }

  AirSim.QUALITY = QUALITY;
  AirSim.FAN = FAN;
  ES.AirSim = AirSim;
})(window.ES = window.ES || {});
