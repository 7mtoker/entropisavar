// Zero-dependency browser harness shared by the black-box tests:
// a static file server, headless Edge/Chrome over the DevTools protocol,
// a PNG decoder and a few pixel metrics.
//
// Kind to the machine: the test process lowers its own priority before it
// starts the browser (Windows children inherit BELOW_NORMAL), the viewport is
// small, and every run has a hard watchdog.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export const served = new Map();
export function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      const body = readFileSync(file);
      served.set(p, createHash('sha256').update(body).digest('hex').slice(0, 16));
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------- browser
function findBrowser() {
  const c = [process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const exe = c.find(p => p && existsSync(p));
  if (!exe) throw new Error('no Chromium-based browser found (set BROWSER)');
  return exe;
}

/**
 * gl: 'gpu' uses the real GPU through ANGLE (what visitors get);
 *     'swiftshader' renders on the CPU (portable, heavier on the machine).
 */
export async function launch({ gl = process.env.E2E_GL || 'gpu', width = 1280, height = 800 } = {}) {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: carry on */ }
  const dir = mkdtempSync(join(os.tmpdir(), 'es-e2e-'));
  const glArgs = gl === 'swiftshader'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--ignore-gpu-blocklist'];
  const args = ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--renderer-process-limit=2',
    '--hide-scrollbars', '--mute-audio', `--window-size=${width},${height}`, ...glArgs, 'about:blank'];
  const exe = findBrowser();
  const proc = spawn(exe, args, { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n').map(s => s.trim());
      if (port && path) return { proc, dir, exe, gl, ws: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error('browser did not expose a DevTools port');
}

export async function shutdown(br, cdp, srv) {
  try { await Promise.race([cdp?.send('Browser.close'), sleep(1500)]); } catch { /* gone */ }
  try { br?.proc.kill(); } catch { /* gone */ }
  srv?.close();
  await sleep(300);
  try { if (br) rmSync(br.dir, { recursive: true, force: true }); } catch { /* profile still locked */ }
}

/** Kill everything and exit if a run takes longer than `ms`. */
export function watchdog(ms, onFire) {
  const t = setTimeout(async () => {
    console.log(`WATCHDOG: run exceeded ${Math.round(ms / 1000)} s, aborting`);
    try { await onFire(); } finally { process.exit(2); }
  }, ms);
  t.unref();
  return t;
}

export class CDP {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); this.listeners = new Set(); }
  open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    };
    return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

export async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await page.send(`${d}.enable`);
  return page;
}

export class Page {
  constructor(cdp, sid) {
    this.cdp = cdp; this.sid = sid; this.errors = []; this.requests = [];
    cdp.on((m) => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push(`exception: ${d.exception?.description || d.text}`);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400)}`);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
      } else if (m.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: m.params.request.url, type: m.params.type });
      }
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sid); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, timeout = 30000, what = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expression)) return true; } catch { /* page still loading */ }
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${what}`);
  }
  async goto(url) {
    const loaded = new Promise((res) => {
      const off = this.cdp.on((m) => { if (m.sessionId === this.sid && m.method === 'Page.loadEventFired') { off(); res(); } });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  }
  async center(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ${selector.replace(/'/g, '')}');
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  }
  async click(selector) {
    const { x, y } = await this.center(selector);
    await sleep(80);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }
  /** Set a control the way a user ends up setting it: value, then input + change. */
  async set(selector, value) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing control ${selector.replace(/'/g, '')}');
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  text(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`); }
  attr(selector, name) { return this.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`); }
  async shot(selector, name) {
    await this.center(selector);
    await this.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const clip = await this.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: b.x + scrollX, y: b.y + scrollY, width: Math.min(b.width, innerWidth), height: Math.min(b.height, innerHeight), scale: 1 }; })()`);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const buf = Buffer.from(data, 'base64');
    writeFileSync(join(OUT, `${name}.png`), buf);
    return decodePNG(buf);
  }
  /** Wait until a simulation has advanced `seconds` of simulated time. */
  async simAdvance(sim, seconds, timeout = 60000) {
    const t0 = await this.eval(`ES.sims.${sim}?.stats.simTime ?? 0`);
    await this.waitFor(`(ES.sims.${sim}?.stats.simTime ?? 0) >= ${t0 + seconds}`, timeout, `${sim} +${seconds}s`);
  }
}

// ---------------------------------------------------------------- pixels
export function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0, depth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; if (d[12]) throw new Error('interlaced PNG'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth}`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      if (bpp >= 3) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; }
      else out[o] = out[o + 1] = out[o + 2] = line[s];
      out[o + 3] = 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
export function lumaStats(img) {
  const n = img.w * img.h, L = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { L[i] = luma(img.data, i * 4); s += L[i]; }
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
  const sorted = Float32Array.from(L).sort();
  return { mean, std: Math.sqrt(v / n), p5: sorted[Math.floor(n * 0.05)], p50: sorted[Math.floor(n * 0.5)] };
}
export function meanAbsDiff(a, b) {
  let s = 0;
  const n = Math.min(a.data.length, b.data.length) / 4;
  for (let i = 0; i < n; i++) s += Math.abs(luma(a.data, i * 4) - luma(b.data, i * 4));
  return s / n;
}
/** Hasler & Süsstrunk (2003) colourfulness. */
export function colourfulness(img) {
  const n = img.w * img.h;
  let mrg = 0, myb = 0, srg = 0, syb = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b;
    mrg += rg; myb += yb; srg += rg * rg; syb += yb * yb;
  }
  mrg /= n; myb /= n;
  const sd = Math.sqrt(Math.max(0, srg / n - mrg * mrg) + Math.max(0, syb / n - myb * myb));
  return sd + 0.3 * Math.hypot(mrg, myb);
}
export function flameColour(img) {
  let bright = 0, blue = 0, warm = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4, r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    if (Math.max(r, g, b) < 70) continue;
    bright++;
    if (b > r && b >= g * 0.9) blue++;
    else if (r > b * 1.25 && r >= g * 0.95) warm++;
  }
  return { bright, frac: bright / (img.w * img.h), blue: bright ? blue / bright : 0, warm: bright ? warm / bright : 0 };
}
