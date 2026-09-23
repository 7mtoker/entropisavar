// Black-box behaviour proof for docs/contract.md.
// Drives headless Edge/Chrome over the DevTools protocol with no npm packages:
// a local static server, a tiny CDP client, a PNG decoder and pixel metrics.
// Verdicts come from pixels and visible text; internal state is only used to
// wait for simulated time to pass.
// Run: node tests/e2e.mjs   (exit 0 = every clause passed)
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const P = require('../js/physics.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const served = new Map();
function startServer() {
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

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'es-e2e-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio',
    '--window-size=1440,900', 'about:blank'];
  const exe = findBrowser();
  const proc = spawn(exe, args, { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n').map(s => s.trim());
      if (port && path) return { proc, dir, exe, ws: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error('browser did not expose a DevTools port');
}

class CDP {
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

class Page {
  constructor(cdp, sid) {
    this.cdp = cdp; this.sid = sid; this.errors = []; this.requests = [];
    cdp.on((m) => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push(`exception: ${d.exception?.description || d.text}`);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
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
      await sleep(150);
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
  /** Set a control the way a user would end up setting it, firing input + change. */
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
function decodePNG(buf) {
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
function lumaStats(img) {
  const n = img.w * img.h, L = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { L[i] = luma(img.data, i * 4); s += L[i]; }
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
  const sorted = Float32Array.from(L).sort();
  return { mean, std: Math.sqrt(v / n), p5: sorted[Math.floor(n * 0.05)], p50: sorted[Math.floor(n * 0.5)] };
}
function meanAbsDiff(a, b) {
  let s = 0;
  const n = Math.min(a.data.length, b.data.length) / 4;
  for (let i = 0; i < n; i++) s += Math.abs(luma(a.data, i * 4) - luma(b.data, i * 4));
  return s / n;
}
/** Hasler & Süsstrunk (2003) colourfulness. */
function colourfulness(img) {
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
function flameColour(img) {
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

// ---------------------------------------------------------------- clauses
const results = [];
const verdict = (id, pass, obs) => { results.push({ id, v: pass ? 'pass' : 'fail', obs }); };
const num = (s) => Number(String(s).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));

async function run() {
  const srv = await startServer();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const br = await launch();
  const cdp = new CDP(br.ws);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await page.send(`${d}.enable`);
  await page.viewport(1440, 900);

  try {
    await page.goto(`${origin}/index.html`);
    await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready');
    const caps = await page.eval('JSON.stringify(ES.caps || {})');
    console.log('browser:', br.exe, '| caps:', caps);

    // P6 — build identity
    const buildOnDisk = /const BUILD = '([^']+)'/.exec(readFileSync(join(ROOT, 'js', 'app.js'), 'utf8'))?.[1];
    const buildInPage = await page.eval('ES.build');
    verdict('P6', buildOnDisk && buildOnDisk === buildInPage, `page ES.build=${buildInPage}, app.js BUILD=${buildOnDisk}`);

    // C3 — air hero animates
    await page.simAdvance('air', 1.5);
    const a1 = await page.shot('#hava .sim-stage', 'c3-air-a');
    await page.simAdvance('air', 1.0);
    const a2 = await page.shot('#hava .sim-stage', 'c3-air-b');
    const s1 = lumaStats(a1), d12 = meanAbsDiff(a1, a2);
    verdict('C3', s1.std > 6 && d12 > 0.25, `std=${s1.std.toFixed(1)} mean|Δ|=${d12.toFixed(2)} over 1 s sim`);

    // C4 — thermal view is false colour
    const cVis = colourfulness(a2);
    await page.click('[data-air-view="thermal"]');
    await page.simAdvance('air', 0.3);
    const th = await page.shot('#hava .sim-stage', 'c4-air-thermal');
    const cTh = colourfulness(th);
    verdict('C4', cTh > 30 && cTh > cVis * 1.5, `colourfulness visible=${cVis.toFixed(1)} thermal=${cTh.toFixed(1)}`);
    await page.click('[data-air-view="visible"]');

    // C5, C6 — fire colour follows the air shutter
    await page.center('#ates .sim-stage');
    await page.waitFor('ES.sims.fire && ES.sims.fire.stats.simTime > 0', 30000, 'fire start');
    await page.click('#fire-ignite');
    await page.set('#fire-phi', '0.85');
    await page.simAdvance('fire', 2.5);
    const lean = flameColour(await page.shot('#ates .sim-stage', 'c6-fire-lean'));
    await page.set('#fire-phi', '2.6');
    await page.simAdvance('fire', 3.0);
    const rich = flameColour(await page.shot('#ates .sim-stage', 'c6-fire-rich'));
    verdict('C5', rich.frac > 0.005, `flame-lit pixel share ${(rich.frac * 100).toFixed(2)} %`);
    verdict('C6', lean.blue > 0.5 && rich.warm > 0.6,
      `lean φ=0.85: blue ${(lean.blue * 100).toFixed(0)} % of lit px; rich φ=2.6: warm ${(rich.warm * 100).toFixed(0)} %`);

    // C7 — dew point readout
    await page.center('#su .sim-stage');
    await page.set('#w-tin', '22'); await page.set('#w-rh', '75'); await page.set('#w-tout', '-2');
    const td75 = await page.text('[data-out="dewpoint"]');
    await page.set('#w-rh', '45');
    const td45 = await page.text('[data-out="dewpoint"]');
    const want75 = P.dewPoint(22, 75).toFixed(1).replace('.', ','), want45 = P.dewPoint(22, 45).toFixed(1).replace('.', ',');
    verdict('C7', td75?.includes(want75) && td45?.includes(want45), `22 °C/75 % → "${td75}" (want ${want75}); 45 % → "${td45}" (want ${want45})`);

    // C8 — glazing flips the state
    await page.set('#w-rh', '75');
    await page.click('#w-glz-single');
    const st1 = await page.attr('[data-out="state"]', 'data-state'), tx1 = await page.text('[data-out="state"]');
    await page.click('#w-glz-triple');
    const st2 = await page.attr('[data-out="state"]', 'data-state'), tx2 = await page.text('[data-out="state"]');
    verdict('C8', st1 === 'condensing' && st2 === 'drying', `single: ${st1} "${tx1}"; triple: ${st2} "${tx2}"`);

    // C9 — the glass fogs and clears (veil on the darkest pixels)
    await page.simAdvance('water', 8);
    const dry = lumaStats(await page.shot('#su .sim-stage', 'c9-water-dry'));
    await page.set('#w-rh', '90');
    await page.click('#w-glz-single');
    await page.simAdvance('water', 8);
    const wet = lumaStats(await page.shot('#su .sim-stage', 'c9-water-wet'));
    verdict('C9', wet.p5 > dry.p5 + 3 && wet.std < dry.std,
      `dark-end p5 dry=${dry.p5.toFixed(1)} → wet=${wet.p5.toFixed(1)}; contrast std ${dry.std.toFixed(1)} → ${wet.std.toFixed(1)}`);

    // C10 — calculator matches the model
    const room = { area: 20, height: 2.7, windowArea: 3, orientation: 'W', insulation: 'medium', glazing: 'double', people: 2, devicesW: 300, tOut: 35, tIn: 24 };
    const ids = { area: 'c-area', height: 'c-height', windowArea: 'c-window', orientation: 'c-orient', insulation: 'c-insul', glazing: 'c-glazing', people: 'c-people', devicesW: 'c-devices', tOut: 'c-tout', tIn: 'c-tin' };
    for (const [k, id] of Object.entries(ids)) await page.set(`#${id}`, room[k]);
    const shown2 = num(await page.text('[data-out="btu"]'));
    await page.set('#c-people', 5);
    const shown5 = num(await page.text('[data-out="btu"]'));
    const want2 = Math.round(P.wattsToBtuPerHour(P.coolingLoad(room).total));
    const want5 = Math.round(P.wattsToBtuPerHour(P.coolingLoad({ ...room, people: 5 }).total));
    verdict('C10', shown2 === want2 && shown5 === want5, `2 people: shown ${shown2}, model ${want2}; 5 people: shown ${shown5}, model ${want5}`);

    // C12 — form stays on the page
    const reqBefore = page.requests.length, href = await page.eval('location.href');
    await page.click('#contact-form button[type="submit"]');
    await sleep(200);
    const emptyState = await page.attr('[data-out="form-reply"]', 'data-state');
    const emptyText = await page.text('[data-out="form-reply"]');
    await page.set('#f-name', 'Deneme Kişi'); await page.set('#f-phone', '0555 000 00 00');
    await page.set('#f-msg', 'Klimam kendi kendine Carnot çevrimi hakkında konuşuyor.');
    await page.click('#contact-form button[type="submit"]');
    await sleep(300);
    const okState = await page.attr('[data-out="form-reply"]', 'data-state');
    const okText = await page.text('[data-out="form-reply"]');
    const newReq = page.requests.slice(reqBefore).filter(r => !r.url.startsWith('data:'));
    const stayed = (await page.eval('location.href')) === href;
    verdict('C12', emptyState === 'error' && okState === 'ok' && /demo/i.test(okText) && stayed && newReq.length === 0,
      `empty → ${emptyState} "${emptyText}"; filled → ${okState} "${okText}"; new requests ${newReq.length}; stayed ${stayed}`);

    // C2 — everything came from our own server
    const foreign = page.requests.filter(r => !r.url.startsWith(origin) && !/^(data|blob|about):/.test(r.url));
    const media = page.requests.filter(r => ['Image', 'Font', 'Media'].includes(r.type));
    verdict('C2', foreign.length === 0 && media.length === 0,
      `${page.requests.length} requests, foreign ${foreign.length}, image/font/media ${media.length}; served ${[...served.keys()].join(' ')}`);

    const fps = await page.eval('JSON.stringify(Object.fromEntries(Object.entries(ES.sims).map(([k, s]) => [k, s && { fps: +s.stats.fps.toFixed(1), q: s.stats.quality }])))');
    console.log('fps (SwiftShader, informative only):', fps);

    // C11 — phone width
    await page.viewport(390, 844, true);
    await page.goto(`${origin}/index.html`);
    await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready (mobile)');
    await sleep(500);
    const sw = await page.eval('({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: innerWidth })');
    await page.shot('#hava .sim-stage', 'c11-mobile-hero');
    verdict('C11', sw.doc <= sw.vw && sw.body <= sw.vw, `scrollWidth doc=${sw.doc} body=${sw.body} viewport=${sw.vw}`);

    // C1 — no errors, also when opened from disk
    await page.viewport(1440, 900);
    await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
    await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready (file://)');
    await sleep(1500);
    verdict('C1', page.errors.length === 0, page.errors.length ? page.errors.slice(0, 5).join(' | ') : 'no exception or console error (http and file://)');
  } catch (err) {
    verdict('HARNESS', false, err.stack || String(err));
    if (page.errors.length) console.log('page errors:', page.errors.slice(0, 8).join('\n  '));
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* already gone */ }
    br.proc.kill();
    srv.close();
    await sleep(300);
    try { rmSync(br.dir, { recursive: true, force: true }); } catch { /* profile still locked */ }
  }

  console.log('\nserved:', JSON.stringify(Object.fromEntries(served)));
  console.log('\n| Clause | Verdict | Observation |\n|---|---|---|');
  for (const r of results) console.log(`| ${r.id} | ${r.v} | ${r.obs.replace(/\|/g, '/')} |`);
  const failed = results.filter(r => r.v !== 'pass');
  writeFileSync(join(OUT, 'e2e-results.json'), JSON.stringify({ at: new Date().toISOString(), results, served: Object.fromEntries(served) }, null, 2));
  console.log(failed.length ? `\ne2e: ${failed.length} clause(s) failed` : '\ne2e: pass');
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
