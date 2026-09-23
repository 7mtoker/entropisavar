/*
 * fluid.js — incompressible Navier–Stokes on the GPU, shared by air and fire.
 *
 * Collocated grid in physical units (metres, seconds, m/s). One step:
 *   1. scalars: MacCormack advection (Selle et al. 2008) with min/max limiter
 *   2. velocity: semi-Lagrangian advection, RK2 back-trace (Stam 1999)
 *   3. sim-specific sources and body forces (callback)
 *   4. vorticity confinement (Fedkiw, Stam & Jensen 2001)
 *   5. pressure projection: Jacobi relaxation of ∇²p = ∇·u − s, where s is an
 *      optional volume source (thermal expansion in the flame)
 * Each side of the box is a free-slip wall or an open boundary (p = 0,
 * inflow carries the ambient scalar state).
 */
(function (ES) {
  'use strict';

  const TRACE = `
uniform sampler2D uVel;
uniform vec2 uInv;
uniform float uDt;
uniform vec4 uOpen;
uniform vec4 uAmbient;
vec2 trace(vec2 uv, float dt) {
  vec2 v1 = texture(uVel, uv).xy;
  vec2 mid = uv - 0.5 * dt * v1 * uInv;
  return uv - dt * texture(uVel, mid).xy * uInv;
}
bool outside(vec2 p) {
  return (p.x < 0.0 && uOpen.x > 0.5) || (p.x > 1.0 && uOpen.y > 0.5)
      || (p.y < 0.0 && uOpen.z > 0.5) || (p.y > 1.0 && uOpen.w > 0.5);
}
`;

  const ADVECT_SCALAR = `${TRACE}
uniform sampler2D uSrc;
in vec2 vUv; out vec4 o;
void main() {
  vec2 p = trace(vUv, uDt);
  o = outside(p) ? uAmbient : texture(uSrc, p);
}`;

  const MACCORMACK = `${TRACE}
uniform sampler2D uPhi, uHat, uBack;
in vec2 vUv; out vec4 o;
void main() {
  vec2 p = trace(vUv, uDt);
  if (outside(p)) { o = uAmbient; return; }
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 s = textureSize(uPhi, 0);
  vec4 r = texelFetch(uHat, c, 0) + 0.5 * (texelFetch(uPhi, c, 0) - texelFetch(uBack, c, 0));
  ivec2 i = clamp(ivec2(floor(p * vec2(s) - 0.5)), ivec2(0), s - 2);
  vec4 a = texelFetch(uPhi, i, 0), b = texelFetch(uPhi, i + ivec2(1, 0), 0);
  vec4 d = texelFetch(uPhi, i + ivec2(0, 1), 0), e = texelFetch(uPhi, i + ivec2(1, 1), 0);
  o = clamp(r, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));
}`;

  const ADVECT_VELOCITY = `${TRACE}
uniform float uDamp;
in vec2 vUv; out vec4 o;
void main() {
  vec2 v = texture(uVel, trace(vUv, uDt)).xy * exp(-uDamp * uDt);
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uVel, 0);
  if ((c.x == 0 && uOpen.x < 0.5) || (c.x == s.x - 1 && uOpen.y < 0.5)) v.x = 0.0;
  if ((c.y == 0 && uOpen.z < 0.5) || (c.y == s.y - 1 && uOpen.w < 0.5)) v.y = 0.0;
  o = vec4(v, 0.0, 1.0);
}`;

  // Neighbour fetch with the boundary rule of each side.
  const STENCIL = `
uniform vec4 uOpen;
vec2 velAt(sampler2D t, ivec2 c, ivec2 s, vec2 vc) {
  if (c.x < 0) return uOpen.x > 0.5 ? vc : vec2(-vc.x, vc.y);
  if (c.x >= s.x) return uOpen.y > 0.5 ? vc : vec2(-vc.x, vc.y);
  if (c.y < 0) return uOpen.z > 0.5 ? vc : vec2(vc.x, -vc.y);
  if (c.y >= s.y) return uOpen.w > 0.5 ? vc : vec2(vc.x, -vc.y);
  return texelFetch(t, c, 0).xy;
}
float pAt(sampler2D t, ivec2 c, ivec2 s, float pc) {
  if (c.x < 0) return uOpen.x > 0.5 ? 0.0 : pc;
  if (c.x >= s.x) return uOpen.y > 0.5 ? 0.0 : pc;
  if (c.y < 0) return uOpen.z > 0.5 ? 0.0 : pc;
  if (c.y >= s.y) return uOpen.w > 0.5 ? 0.0 : pc;
  return texelFetch(t, c, 0).x;
}
`;

  const DIVERGENCE = (source) => `${STENCIL}
uniform sampler2D uVel, uScal;
uniform float uInv2H;
${source || 'float divSource(ivec2 c) { return 0.0; }'}
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uVel, 0);
  vec2 vc = texelFetch(uVel, c, 0).xy;
  float d = (velAt(uVel, c + ivec2(1, 0), s, vc).x - velAt(uVel, c - ivec2(1, 0), s, vc).x
           + velAt(uVel, c + ivec2(0, 1), s, vc).y - velAt(uVel, c - ivec2(0, 1), s, vc).y) * uInv2H;
  o = vec4(d - divSource(c), 0.0, 0.0, 1.0);
}`;

  const JACOBI = `${STENCIL}
uniform sampler2D uP, uDiv;
uniform float uH2;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uP, 0);
  float pc = texelFetch(uP, c, 0).x;
  float sum = pAt(uP, c - ivec2(1, 0), s, pc) + pAt(uP, c + ivec2(1, 0), s, pc)
            + pAt(uP, c - ivec2(0, 1), s, pc) + pAt(uP, c + ivec2(0, 1), s, pc);
  o = vec4((sum - uH2 * texelFetch(uDiv, c, 0).x) * 0.25, 0.0, 0.0, 1.0);
}`;

  const GRADIENT = `${STENCIL}
uniform sampler2D uP, uVel;
uniform float uInv2H;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uP, 0);
  float pc = texelFetch(uP, c, 0).x;
  vec2 g = vec2(pAt(uP, c + ivec2(1, 0), s, pc) - pAt(uP, c - ivec2(1, 0), s, pc),
                pAt(uP, c + ivec2(0, 1), s, pc) - pAt(uP, c - ivec2(0, 1), s, pc)) * uInv2H;
  vec2 v = texelFetch(uVel, c, 0).xy - g;
  if ((c.x == 0 && uOpen.x < 0.5) || (c.x == s.x - 1 && uOpen.y < 0.5)) v.x = 0.0;
  if ((c.y == 0 && uOpen.z < 0.5) || (c.y == s.y - 1 && uOpen.w < 0.5)) v.y = 0.0;
  o = vec4(v, 0.0, 1.0);
}`;

  const CURL = `${STENCIL}
uniform sampler2D uVel;
uniform float uInv2H;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uVel, 0);
  vec2 vc = texelFetch(uVel, c, 0).xy;
  float w = (velAt(uVel, c + ivec2(1, 0), s, vc).y - velAt(uVel, c - ivec2(1, 0), s, vc).y
           - velAt(uVel, c + ivec2(0, 1), s, vc).x + velAt(uVel, c - ivec2(0, 1), s, vc).x) * uInv2H;
  o = vec4(w, 0.0, 0.0, 1.0);
}`;

  const VORTICITY = `
uniform sampler2D uVel, uCurl;
uniform float uEps, uH, uDt;
out vec4 o;
float wAt(ivec2 c, ivec2 s) { return abs(texelFetch(uCurl, clamp(c, ivec2(0), s - 1), 0).x); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), s = textureSize(uCurl, 0);
  vec2 g = 0.5 * vec2(wAt(c + ivec2(1, 0), s) - wAt(c - ivec2(1, 0), s), wAt(c + ivec2(0, 1), s) - wAt(c - ivec2(0, 1), s));
  vec2 n = g / (length(g) + 1e-5);
  float w = texelFetch(uCurl, c, 0).x;
  vec2 v = texelFetch(uVel, c, 0).xy + uDt * uEps * uH * w * vec2(n.y, -n.x);
  o = vec4(v, 0.0, 1.0);
}`;

  const SPLAT = `
uniform sampler2D uSrc;
uniform vec2 uCenter;
uniform float uAspect, uRadius;
uniform vec4 uValue;
in vec2 vUv; out vec4 o;
void main() {
  vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
  o = texture(uSrc, vUv) + uValue * exp(-dot(d, d) / (uRadius * uRadius));
}`;

  class Fluid {
    constructor(ctx, options) {
      this.ctx = ctx;
      this.o = Object.assign({
        open: [0, 0, 0, 0], ambient: [0, 0, 0, 0], scalar: 'RGBA', divSource: null,
        jacobi: 28, vorticity: 0, damp: 0, maccormack: true,
      }, options);
      this.p = {
        advS: ctx.program(ADVECT_SCALAR),
        mc: ctx.program(MACCORMACK),
        advV: ctx.program(ADVECT_VELOCITY),
        div: ctx.program(DIVERGENCE(this.o.divSource)),
        jac: ctx.program(JACOBI),
        grad: ctx.program(GRADIENT),
        curl: ctx.program(CURL),
        vort: ctx.program(VORTICITY),
        splat: ctx.program(SPLAT),
      };
    }

    resize(nx, ny, width, height) {
      const ctx = this.ctx;
      const prev = this.vel ? { vel: this.vel, scal: this.scal, pr: this.pr, hat: this.hat, back: this.back, div: this.div, curl: this.curl } : null;
      Object.assign(this, { nx, ny, width, height, h: height / ny });
      this.vel = ctx.double(nx, ny, 'RG');
      this.scal = ctx.double(nx, ny, this.o.scalar);
      this.hat = ctx.target(nx, ny, this.o.scalar);
      this.back = ctx.target(nx, ny, this.o.scalar);
      this.pr = ctx.double(nx, ny, 'R', 'nearest');
      this.div = ctx.target(nx, ny, 'R', 'nearest');
      this.curl = ctx.target(nx, ny, 'R', 'nearest');
      if (prev) {
        ctx.copy(prev.vel.read, this.vel.read);
        ctx.copy(prev.scal.read, this.scal.read);
        for (const t of Object.values(prev)) ctx.free(t);
      } else {
        ctx.clear(this.scal.read, this.o.ambient);
      }
    }

    get inv() { return [1 / this.width, 1 / this.height]; }

    common(dt) {
      return { uInv: this.inv, uDt: dt, uOpen: this.o.open, uAmbient: this.o.ambient };
    }

    advect(dt) {
      const { ctx, p } = this, u = this.common(dt);
      if (this.o.maccormack) {
        ctx.draw(p.advS, this.hat, { ...u, uVel: this.vel.read, uSrc: this.scal.read });
        ctx.draw(p.advS, this.back, { ...u, uDt: -dt, uVel: this.vel.read, uSrc: this.hat });
        ctx.draw(p.mc, this.scal.write, { ...u, uVel: this.vel.read, uPhi: this.scal.read, uHat: this.hat, uBack: this.back });
      } else {
        ctx.draw(p.advS, this.scal.write, { ...u, uVel: this.vel.read, uSrc: this.scal.read });
      }
      this.scal.swap();
      ctx.draw(p.advV, this.vel.write, { ...u, uVel: this.vel.read, uDamp: this.o.damp });
      this.vel.swap();
    }

    vorticity(dt, eps) {
      if (!(eps > 0)) return;
      const { ctx, p } = this;
      ctx.draw(p.curl, this.curl, { uVel: this.vel.read, uOpen: this.o.open, uInv2H: 0.5 / this.h });
      ctx.draw(p.vort, this.vel.write, { uVel: this.vel.read, uCurl: this.curl, uEps: eps, uH: this.h, uDt: dt });
      this.vel.swap();
    }

    project(iterations, extra = {}) {
      const { ctx, p } = this, open = this.o.open;
      ctx.draw(p.div, this.div, { ...extra, uVel: this.vel.read, uScal: this.scal.read, uOpen: open, uInv2H: 0.5 / this.h });
      const h2 = this.h * this.h;
      for (let i = 0; i < iterations; i++) {
        ctx.draw(p.jac, this.pr.write, { uP: this.pr.read, uDiv: this.div, uOpen: open, uH2: h2 });
        this.pr.swap();
      }
      ctx.draw(p.grad, this.vel.write, { uP: this.pr.read, uVel: this.vel.read, uOpen: open, uInv2H: 0.5 / this.h });
      this.vel.swap();
    }

    /** Add a Gaussian blob to a field; centre in uv, radius as a fraction of the domain height. */
    splat(field, center, radius, value) {
      this.ctx.draw(this.p.splat, field.write, {
        uSrc: field.read, uCenter: center, uAspect: this.width / this.height, uRadius: radius, uValue: value,
      });
      field.swap();
    }

    /** Run a sim-specific pass that reads the current fields and writes one of them. */
    pass(prog, field, uniforms) {
      this.ctx.draw(prog, field.write, { ...uniforms, uVel: this.vel.read, uScal: this.scal.read });
      field.swap();
    }

    step(dt, hooks) {
      this.advect(dt);
      hooks.sources(dt);
      this.vorticity(dt, hooks.vorticity ?? this.o.vorticity);
      this.project(hooks.jacobi ?? this.o.jacobi, hooks.projectUniforms ? hooks.projectUniforms() : {});
    }
  }

  ES.Fluid = Fluid;
})(window.ES = window.ES || {});
