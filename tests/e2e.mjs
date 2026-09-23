// Black-box behaviour proof for docs/contract.md.
// Verdicts come from pixels and visible text; internal state is only read to
// wait for simulated time to pass. Browser plumbing lives in harness.mjs
// (below-normal priority, small viewport, watchdog).
// Run: node tests/e2e.mjs   (exit 0 = every clause passed)
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  ROOT, OUT, sleep, served, startServer, launch, shutdown, watchdog, CDP, openPage,
  lumaStats, meanAbsDiff, colourfulness, flameColour,
} from './harness.mjs';

const require = createRequire(import.meta.url);
const P = require('../js/physics.js');
const results = [];
const verdict = (id, pass, obs) => { results.push({ id, v: pass ? 'pass' : 'fail', obs }); console.log(`${pass ? 'pass' : 'FAIL'} ${id}: ${obs}`); };
const num = (s) => Number(String(s).replace(/[^\d]/g, ''));

const srv = await startServer();
const origin = `http://127.0.0.1:${srv.address().port}`;
const br = await launch({ width: 1280, height: 800 });
const cdp = new CDP(br.ws);
watchdog(480000, () => shutdown(br, cdp, srv));
await cdp.open();
const page = await openPage(cdp);
await page.viewport(1280, 800);

try {
  await page.goto(`${origin}/index.html`);
  await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready');
  console.log('browser:', br.exe, br.gl, '| caps:', await page.eval('JSON.stringify(ES.caps || {})'));

  // P6 — build identity
  const buildOnDisk = /const BUILD = '([^']+)'/.exec(readFileSync(join(ROOT, 'js', 'app.js'), 'utf8'))?.[1];
  const buildInPage = await page.eval('ES.build');
  verdict('P6', !!buildOnDisk && buildOnDisk === buildInPage, `page ES.build=${buildInPage}, app.js BUILD=${buildOnDisk}`);

  // C3 — air hero animates
  await page.waitFor('ES.sims.air && ES.sims.air.stats.simTime > 0', 30000, 'air start');
  await page.simAdvance('air', 1.5);
  const a1 = await page.shot('#hava .sim-stage', 'c3-air-a');
  await page.simAdvance('air', 1.0);
  const a2 = await page.shot('#hava .sim-stage', 'c3-air-b');
  const s1 = lumaStats(a1), d12 = meanAbsDiff(a1, a2);
  verdict('C3', s1.std > 6 && d12 > 0.25, `std=${s1.std.toFixed(1)} mean|Δ|=${d12.toFixed(2)} over ≥1 s sim`);

  // C4 — thermal view is false colour
  const cVis = colourfulness(a2);
  await page.click('[data-air-view="thermal"]');
  await page.simAdvance('air', 0.3);
  const cTh = colourfulness(await page.shot('#hava .sim-stage', 'c4-air-thermal'));
  verdict('C4', cTh > 30 && cTh > cVis * 1.5, `colourfulness visible=${cVis.toFixed(1)} thermal=${cTh.toFixed(1)}`);
  await page.click('[data-air-view="visible"]');

  // C5, C6 — fire colour follows the air shutter (measured from pixels, P5)
  await page.center('#ates .sim-stage');
  await page.waitFor('ES.sims.fire && ES.sims.fire.stats.simTime > 0', 30000, 'fire start');
  await page.set('#fire-phi', '0.85');
  await page.simAdvance('fire', 3);
  const lean = flameColour(await page.shot('#ates .sim-stage', 'c6-fire-lean'));
  await page.set('#fire-phi', '2.6');
  await page.simAdvance('fire', 3);
  const rich = flameColour(await page.shot('#ates .sim-stage', 'c6-fire-rich'));
  verdict('C5', rich.frac > 0.005, `flame-lit pixel share ${(rich.frac * 100).toFixed(2)} %`);
  verdict('C6', lean.blue > 0.5 && rich.warm > 0.6,
    `lean φ=0.85: blue ${(lean.blue * 100).toFixed(0)} % of lit px; rich φ=2.6: warm ${(rich.warm * 100).toFixed(0)} %`);

  // C7 — dew point readout (source of truth: physics.dewPoint)
  await page.center('#su .sim-stage');
  await page.set('#w-tin', '22'); await page.set('#w-rh', '75'); await page.set('#w-tout', '-2');
  const td75 = await page.text('[data-out="dewpoint"]');
  await page.set('#w-rh', '45');
  const td45 = await page.text('[data-out="dewpoint"]');
  const want75 = P.dewPoint(22, 75).toFixed(1).replace('.', ','), want45 = P.dewPoint(22, 45).toFixed(1).replace('.', ',');
  verdict('C7', !!td75?.includes(want75) && !!td45?.includes(want45), `22 °C/75 % → "${td75}" (want ${want75}); 45 % → "${td45}" (want ${want45})`);

  // C8 — glazing flips the state
  await page.set('#w-rh', '75');
  await page.click('label[for="w-glz-single"]');   // users click the visible label
  const st1 = await page.attr('[data-out="state"]', 'data-state'), tx1 = await page.text('[data-out="state"]');
  await page.click('label[for="w-glz-triple"]');
  const st2 = await page.attr('[data-out="state"]', 'data-state'), tx2 = await page.text('[data-out="state"]');
  verdict('C8', st1 === 'condensing' && st2 === 'drying', `single: ${st1} "${tx1}"; triple: ${st2} "${tx2}"`);

  // C9 — the glass fogs and clears (veil lifts the darkest pixels)
  await page.waitFor('ES.sims.water && ES.sims.water.stats.simTime > 0', 30000, 'water start');
  await page.simAdvance('water', 8);
  const dry = lumaStats(await page.shot('#su .sim-stage', 'c9-water-dry'));
  await page.set('#w-rh', '90');
  await page.click('label[for="w-glz-single"]');
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

  // C12 — form stays on the page (P3: empty submit asks for the missing field)
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
    `empty → ${emptyState} "${emptyText}"; filled → ${okState} "${okText.slice(0, 60)}…"; new requests ${newReq.length}; stayed ${stayed}`);

  // C2 — everything came from our own server
  const foreign = page.requests.filter(r => !r.url.startsWith(origin) && !/^(data|blob|about):/.test(r.url));
  const media = page.requests.filter(r => ['Image', 'Font', 'Media'].includes(r.type));
  verdict('C2', foreign.length === 0 && media.length === 0,
    `${page.requests.length} requests, foreign ${foreign.length}, image/font/media ${media.length}; served ${[...served.keys()].join(' ')}`);

  const fps = await page.eval('JSON.stringify(Object.fromEntries(Object.entries(ES.sims).map(([k, s]) => [k, s && { fps: +s.stats.fps.toFixed(1), q: s.stats.quality }])))');
  console.log(`fps (headless ${br.gl}, informative only):`, fps);

  // C11 — phone width
  await page.viewport(390, 844, true);
  await page.goto(`${origin}/index.html`);
  await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready (mobile)');
  await sleep(500);
  const sw = await page.eval('({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: innerWidth })');
  await page.shot('#hava', 'c11-mobile-hero');
  verdict('C11', sw.doc <= sw.vw && sw.body <= sw.vw, `scrollWidth doc=${sw.doc} body=${sw.body} viewport=${sw.vw}`);

  // C1 — no errors anywhere in the run, also when opened from disk
  await page.viewport(1280, 800);
  await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
  await page.waitFor('window.ES && ES.ready === true', 30000, 'ES.ready (file://)');
  await sleep(1500);
  verdict('C1', page.errors.length === 0, page.errors.length ? page.errors.slice(0, 5).join(' | ') : 'no exception or console error (http and file://)');
} catch (err) {
  verdict('HARNESS', false, err.stack || String(err));
  if (page.errors.length) console.log('page errors:', page.errors.slice(0, 8).join('\n  '));
} finally {
  await shutdown(br, cdp, srv);
}

console.log('\n| Clause | Verdict | Observation |\n|---|---|---|');
for (const r of results) console.log(`| ${r.id} | ${r.v} | ${r.obs.replace(/\|/g, '/')} |`);
const failed = results.filter(r => r.v !== 'pass');
writeFileSync(join(OUT, 'e2e-results.json'), JSON.stringify({ at: new Date().toISOString(), results, served: Object.fromEntries(served) }, null, 2));
console.log(failed.length ? `\ne2e: ${failed.length} clause(s) failed` : '\ne2e: pass');
process.exit(failed.length ? 1 : 0);
