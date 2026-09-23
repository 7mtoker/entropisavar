/*
 * gl.js — the WebGL2 toolkit the three simulations share.
 *
 *  Ctx       context + half-float render targets + program cache + draw()
 *  Bloom     physically plausible glow: 13-tap downsample / tent upsample
 *            chain (Jimenez 2014), soft-knee threshold
 *  Readback  asynchronous GPU → CPU copies through a pixel-pack buffer and a
 *            fence, so reading simulation statistics never stalls a frame
 *  GLSL      shared shader library (bicubic sampling, tone mapping, noise)
 */
(function (ES) {
  'use strict';

  const VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // One oversized triangle covers the viewport; no vertex buffers needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const GLSL = `
// B-spline bicubic filtering from four bilinear taps (Sigg & Hadwiger 2005).
vec4 textureBicubic(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 st = uv * size - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 / 6.0) * (-f3 + 3.0 * f2 - 3.0 * f + 1.0);
  vec2 w1 = (1.0 / 6.0) * (3.0 * f3 - 6.0 * f2 + 4.0);
  vec2 w2 = (1.0 / 6.0) * (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0);
  vec2 w3 = (1.0 / 6.0) * f3;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 p0 = (i - 1.0 + w1 / g0 + 0.5) / size;
  vec2 p1 = (i + 1.0 + w3 / g1 + 0.5) / size;
  return g0.y * (g0.x * texture(t, p0) + g1.x * texture(t, vec2(p1.x, p0.y)))
       + g1.y * (g0.x * texture(t, vec2(p0.x, p1.y)) + g1.x * texture(t, p1));
}

// ACES filmic curve, Narkowicz 2015 fit.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// Interleaved gradient noise (Jimenez 2014): one LSB of dither kills banding.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 dither(vec3 c) { return c + (ign(gl_FragCoord.xy) - 0.5) / 255.0; }

// Hash without sine (Hoskins) and value noise with quintic fade.
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s;
}
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
// Anti-aliased coverage of a signed distance given in the same units as px.
float cover(float d, float px) { return clamp(0.5 - d / px, 0.0, 1.0); }
`;

  class Ctx {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        alpha: false, depth: false, stencil: false, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 yok');
      this.gl = gl;
      this.floatRead = !!gl.getExtension('EXT_color_buffer_float');
      const half = gl.getExtension('EXT_color_buffer_half_float');
      if (!this.floatRead && !half) throw new Error('float render targets yok');
      gl.getExtension('OES_texture_float_linear');
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      this.formats = {
        RGBA: this.pick([[gl.RGBA16F, gl.RGBA]]),
        RG: this.pick([[gl.RG16F, gl.RG], [gl.RGBA16F, gl.RGBA]]),
        R: this.pick([[gl.R16F, gl.RED], [gl.RG16F, gl.RG], [gl.RGBA16F, gl.RGBA]]),
      };
      if (!this.formats.RGBA) throw new Error('RGBA16F render target yok');
      this.cache = new Map();
      this.parallel = gl.getExtension('KHR_parallel_shader_compile');
      this.lost = false;
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    }

    /** First half-float format the driver can render into. */
    pick(candidates) {
      const gl = this.gl;
      for (const [internal, format] of candidates) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, gl.HALF_FLOAT, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        if (ok) return { internal, format, type: gl.HALF_FLOAT };
      }
      return null;
    }

    /**
     * Queue a program. Compilation is not waited on here: with
     * KHR_parallel_shader_compile the driver builds it off the main thread and
     * `ready()` reports when every queued program is done, so a slow shader
     * compiler (ANGLE on D3D) cannot freeze the page.
     */
    program(fragment, defines = '', vertex = VS) {
      const key = vertex + defines + fragment;
      if (this.cache.has(key)) return this.cache.get(key);
      const gl = this.gl;
      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const fsSrc = `#version 300 es
precision highp float;
precision highp sampler2D;
${defines}
${GLSL}
${fragment}`;
      const p = gl.createProgram();
      const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fsSrc);
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      const prog = { p, u: null, vs, fs, fsSrc };
      this.cache.set(key, prog);
      return prog;
    }

    /** True when every queued program has finished compiling (always true without the extension). */
    ready() {
      if (!this.parallel) return true;
      for (const prog of this.cache.values()) {
        if (!prog.u && !this.gl.getProgramParameter(prog.p, this.parallel.COMPLETION_STATUS_KHR)) return false;
      }
      return true;
    }

    /** Check the link result once and collect uniform locations. */
    finish(prog) {
      if (prog.u) return prog;
      const gl = this.gl;
      if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
        const log = gl.getShaderInfoLog(prog.fs) || gl.getShaderInfoLog(prog.vs) || gl.getProgramInfoLog(prog.p);
        const lines = prog.fsSrc.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        throw new Error(`shader derlenemedi: ${log}\n${lines}`);
      }
      const u = {};
      const n = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog.p, i);
        u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(prog.p, info.name), type: info.type };
      }
      gl.detachShader(prog.p, prog.vs); gl.detachShader(prog.p, prog.fs);
      gl.deleteShader(prog.vs); gl.deleteShader(prog.fs);
      prog.u = u;
      prog.fsSrc = null;
      return prog;
    }

    target(w, h, kind = 'RGBA', filter = 'linear') {
      const gl = this.gl, f = this.formats[kind];
      const tex = gl.createTexture();
      const flt = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, flt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, flt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, f.type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo, w, h, texel: [1 / w, 1 / h], kind };
    }

    double(w, h, kind, filter) {
      let a = this.target(w, h, kind, filter), b = this.target(w, h, kind, filter);
      return {
        get read() { return a; }, get write() { return b; },
        swap() { const t = a; a = b; b = t; },
        w, h, texel: [1 / w, 1 / h],
      };
    }

    free(t) {
      if (!t) return;
      const gl = this.gl;
      if (t.read) { this.free(t.read); this.free(t.write); return; }
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }

    clear(target, rgba) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
      gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    /** Run a fragment program over `target` (null = canvas) with typed uniforms. */
    draw(prog, target, uniforms, blend) {
      const gl = this.gl;
      this.use(prog, uniforms);
      this.bind(target);
      if (blend) { gl.enable(gl.BLEND); gl.blendFunc(blend[0], blend[1]); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (blend) gl.disable(gl.BLEND);
    }

    bind(target) {
      const gl = this.gl;
      if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    }

    /** Make `prog` current and upload uniforms by their declared GLSL type. */
    use(prog, uniforms) {
      const gl = this.gl;
      this.finish(prog);
      gl.useProgram(prog.p);
      let unit = 0;
      for (const name in uniforms) {
        const info = prog.u[name];
        if (!info) continue; // optimised away by the compiler
        const v = uniforms[name];
        switch (info.type) {
          case gl.SAMPLER_2D:
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, v.tex || v);
            gl.uniform1i(info.loc, unit++);
            break;
          case gl.FLOAT: gl.uniform1f(info.loc, v); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(info.loc, v); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(info.loc, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(info.loc, v); break;
          case gl.INT: case gl.BOOL: gl.uniform1i(info.loc, v); break;
          case gl.INT_VEC2: gl.uniform2iv(info.loc, v); break;
          case gl.FLOAT_MAT2: gl.uniformMatrix2fv(info.loc, false, v); break;
          default: break;
        }
      }
    }

    /** Copy (and resample) one texture into a target of any size. */
    copy(src, dst) {
      this.draw(this.program(`uniform sampler2D uSrc; in vec2 vUv; out vec4 o; void main() { o = texture(uSrc, vUv); }`), dst, { uSrc: src });
    }
  }

  class Bloom {
    constructor(ctx, levels = 6) {
      this.ctx = ctx;
      this.levels = levels;
      this.mips = [];
      this.pre = ctx.program(`
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThreshold, uKnee;
in vec2 vUv; out vec4 o;
vec3 tap(vec2 d) { return min(texture(uSrc, vUv + d * uTexel).rgb, vec3(64.0)); }
void main() {
  vec3 c = tap(vec2(0)) * 0.125
    + (tap(vec2(-2, 2)) + tap(vec2(2, 2)) + tap(vec2(-2, -2)) + tap(vec2(2, -2))) * 0.03125
    + (tap(vec2(0, 2)) + tap(vec2(-2, 0)) + tap(vec2(2, 0)) + tap(vec2(0, -2))) * 0.0625
    + (tap(vec2(-1, 1)) + tap(vec2(1, 1)) + tap(vec2(-1, -1)) + tap(vec2(1, -1))) * 0.125;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-5);
  o = vec4(c * max(rq, br - uThreshold) / max(br, 1e-5), 1.0);
}`);
      this.down = ctx.program(`
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUv; out vec4 o;
vec3 tap(vec2 d) { return texture(uSrc, vUv + d * uTexel).rgb; }
void main() {
  vec3 c = tap(vec2(0)) * 0.125
    + (tap(vec2(-2, 2)) + tap(vec2(2, 2)) + tap(vec2(-2, -2)) + tap(vec2(2, -2))) * 0.03125
    + (tap(vec2(0, 2)) + tap(vec2(-2, 0)) + tap(vec2(2, 0)) + tap(vec2(0, -2))) * 0.0625
    + (tap(vec2(-1, 1)) + tap(vec2(1, 1)) + tap(vec2(-1, -1)) + tap(vec2(1, -1))) * 0.125;
  o = vec4(c, 1.0);
}`);
      this.up = ctx.program(`
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uWeight;
in vec2 vUv; out vec4 o;
void main() {
  vec4 d = uTexel.xyxy * vec4(1, 1, -1, 0);
  vec3 s = texture(uSrc, vUv - d.xy).rgb + texture(uSrc, vUv - d.wy).rgb * 2.0 + texture(uSrc, vUv - d.zy).rgb
    + texture(uSrc, vUv + d.zw).rgb * 2.0 + texture(uSrc, vUv).rgb * 4.0 + texture(uSrc, vUv + d.xw).rgb * 2.0
    + texture(uSrc, vUv + d.zy).rgb + texture(uSrc, vUv + d.wy).rgb * 2.0 + texture(uSrc, vUv + d.xy).rgb;
  o = vec4(s * (uWeight / 16.0), 1.0);
}`);
    }

    resize(w, h) {
      for (const m of this.mips) this.ctx.free(m);
      this.mips = [];
      let mw = w, mh = h;
      for (let i = 0; i < this.levels; i++) {
        mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
        this.mips.push(this.ctx.target(mw, mh, 'RGBA', 'linear'));
        if (mw <= 2 || mh <= 2) break;
      }
    }

    /** Returns the glow texture (half resolution of `src`). */
    apply(src, threshold = 1.0, knee = 0.5) {
      const { ctx, mips } = this, gl = ctx.gl;
      ctx.draw(this.pre, mips[0], { uSrc: src, uTexel: src.texel, uThreshold: threshold, uKnee: knee });
      for (let i = 1; i < mips.length; i++) ctx.draw(this.down, mips[i], { uSrc: mips[i - 1], uTexel: mips[i - 1].texel });
      for (let i = mips.length - 1; i > 0; i--) {
        ctx.draw(this.up, mips[i - 1], { uSrc: mips[i], uTexel: mips[i].texel, uWeight: 1.0 }, [gl.ONE, gl.ONE]);
      }
      return mips[0];
    }

    /** Heavily blurred level, used as a cheap irradiance map for "the flame lights the room". */
    get wide() { return this.mips[Math.min(3, this.mips.length - 1)]; }
  }

  class Readback {
    constructor(ctx, w, h) {
      const gl = ctx.gl;
      this.ctx = ctx; this.w = w; this.h = h;
      this.data = new Float32Array(w * h * 4);
      this.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.data.byteLength, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.sync = null;
      this.ready = false;
    }
    /** Queue a copy of `target` (must be w×h, float). Returns false while one is in flight. */
    request(target) {
      if (this.sync || !this.ctx.floatRead) return false;
      const gl = this.ctx.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return true;
    }
    /** True once fresh data landed in `this.data`. */
    poll() {
      if (!this.sync) return false;
      const gl = this.ctx.gl;
      if (gl.getSyncParameter(this.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
      gl.deleteSync(this.sync);
      this.sync = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.ready = true;
      return true;
    }
  }

  /** Backing-store size for a canvas: CSS size × min(dpr, cap) × scale, clamped by a pixel budget. */
  function fit(canvas, dprCap, scale, maxPixels) {
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(1, r.width), cssH = Math.max(1, r.height);
    let k = Math.min(window.devicePixelRatio || 1, dprCap) * scale;
    if (cssW * cssH * k * k > maxPixels) k = Math.sqrt(maxPixels / (cssW * cssH));
    const w = Math.max(2, Math.round(cssW * k)), h = Math.max(2, Math.round(cssH * k));
    const changed = canvas.width !== w || canvas.height !== h;
    if (changed) { canvas.width = w; canvas.height = h; }
    return { w, h, cssW, cssH, changed };
  }

  /** Pointer tracking in canvas-normalised coordinates (0..1, y up), with velocity. */
  function trackPointer(el, onMove) {
    const state = { x: 0.5, y: 0.5, dx: 0, dy: 0, down: false, inside: false, t: 0 };
    const at = (e) => {
      const r = el.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, r];
    };
    el.addEventListener('pointerdown', (e) => {
      const [x, y] = at(e);
      Object.assign(state, { x, y, dx: 0, dy: 0, down: true, inside: true, t: performance.now() });
      if (e.pointerType !== 'mouse') el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const [x, y, r] = at(e);
      const now = performance.now(), dt = Math.max(1, now - state.t) / 1000;
      state.dx = (x - state.x) * r.width / dt;   // CSS px per second
      state.dy = (y - state.y) * r.height / dt;
      Object.assign(state, { x, y, inside: true, t: now });
      onMove && onMove(state, e);
    });
    const up = () => { state.down = false; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => { state.inside = false; state.down = false; });
    return state;
  }

  ES.gl = { Ctx, Bloom, Readback, fit, trackPointer, GLSL };
})(window.ES = window.ES || {});
