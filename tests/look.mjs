// Development look: one screenshot per simulation plus errors and stats.
// Run: node tests/look.mjs [query]   → tests/out/look-*.png
import { startServer, launch, CDP, openPage, shutdown, watchdog, sleep } from './harness.mjs';

const query = process.argv[2] || '';
const srv = await startServer();
const br = await launch({ width: 1280, height: 800 });
const cdp = new CDP(br.ws);
watchdog(120000, () => shutdown(br, cdp, srv));
await cdp.open();
const page = await openPage(cdp);
await page.viewport(1280, 800);
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html${query}`);
  await page.waitFor('window.ES && ES.ready', 20000, 'ready');
  const t0 = Date.now(), at = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
  const only = (process.argv[3] || 'air,fire,water').split(',');
  for (const [sim, sel, secs] of [['air', '#hava .sim-stage', 4], ['fire', '#ates .sim-stage', 4], ['water', '#su .sim-stage', 4]]) {
    if (!only.includes(sim)) continue;
    await page.center(sel);
    if (sim === 'fire' && process.argv[4]) await page.set('#fire-phi', process.argv[4]);
    at(`${sim} scrolled`);
    await page.waitFor(`ES.sims.${sim} && ES.sims.${sim}.stats.simTime > 0`, 30000, `${sim} start`);
    at(`${sim} started`);
    await page.simAdvance(sim, secs, 40000);
    at(`${sim} advanced ${secs}s`);
    await page.shot(sel, `look-${sim}${sim === 'fire' && process.argv[4] ? '-' + process.argv[4] : ''}`);
    at(`${sim} screenshot`);
    const st = await page.eval(`JSON.stringify(ES.sims.${sim}.stats, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)`);
    console.log(sim, st);
  }
  await page.center('#hesap');
  await sleep(300);
  await page.shot('#hesap', 'look-calc');
  console.log('errors:', page.errors.length ? page.errors.slice(0, 6).join('\n  ') : 'none');
} catch (e) {
  console.log('look failed:', e.message);
  console.log('errors:', page.errors.slice(0, 6).join('\n  '));
} finally {
  await shutdown(br, cdp, srv);
}
process.exit(0);
