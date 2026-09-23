// Shader compile check: queue every program, draw nothing, report timings.
// Run before any rendering test so a pathological shader is a number, not a hang.
// Run: node tests/compile-check.mjs   (exit 0 = all compiled, none slower than 15 s)
import { startServer, launch, CDP, openPage, shutdown, watchdog } from './harness.mjs';

const LIMIT_MS = 15000;
const srv = await startServer();
const br = await launch({ width: 640, height: 480 });
const cdp = new CDP(br.ws);
watchdog(150000, () => shutdown(br, cdp, srv));
await cdp.open();
const page = await openPage(cdp);
let code = 1;
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/tests/compile.html`);
  await page.waitFor('window.RESULT', 140000, 'compile results');
  const res = await page.eval('window.RESULT');
  console.log(`renderer: ${res.renderer}  (mode ${br.gl})`);
  let ok = true;
  for (const [name, r] of Object.entries(res.sims)) {
    if (r.error) { console.log(`${name}: FAIL ${r.error}`); ok = false; continue; }
    const slow = r.compiledMs > LIMIT_MS;
    console.log(`${name}: ${r.programs} programs, parallel=${r.parallel}, compiled in ${r.compiledMs} ms${slow ? '  <-- TOO SLOW' : ''}`);
    for (const e of r.errors) console.log(`  ERROR ${e.split('\n').slice(0, 3).join(' | ')}`);
    if (slow || r.errors.length) ok = false;
  }
  if (page.errors.length) { console.log('page errors:', page.errors.slice(0, 5).join(' | ')); ok = false; }
  code = ok ? 0 : 1;
  console.log(ok ? 'compile-check: pass' : 'compile-check: FAIL');
} catch (e) {
  console.log('compile-check: FAIL', e.message);
  if (page.errors.length) console.log('page errors:', page.errors.slice(0, 5).join(' | '));
} finally {
  await shutdown(br, cdp, srv);
}
process.exit(code);
