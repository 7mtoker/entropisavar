// Debug timeline for the burner: state, max T, soot, max burn rate every 150 ms.
import { startServer, launch, CDP, openPage, shutdown, watchdog, sleep } from './harness.mjs';

const srv = await startServer();
const br = await launch({ width: 1280, height: 800 });
const cdp = new CDP(br.ws);
watchdog(60000, () => shutdown(br, cdp, srv));
await cdp.open();
const page = await openPage(cdp);
await page.viewport(1280, 800);
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  await page.waitFor('window.ES && ES.ready', 20000, 'ready');
  await page.center('#ates .sim-stage');
  await page.waitFor('ES.sims.fire && ES.sims.fire.stats.simTime > 0', 30000, 'fire start');
  await page.eval('ES.sims.fire.flame.attempts = 0, ES.sims.fire.flame.state = "igniting", ES.sims.fire.ignite(), 1');
  for (let i = 0; i < 20; i++) {
    const row = await page.eval(`(() => { const f = ES.sims.fire, d = f.readback.data, fl = f.flame;
      let mt = 0, mq = 0, ms = 0; for (let k = 0; k < d.length; k += 4) { mt = Math.max(mt, d[k]); ms = Math.max(ms, d[k+1]); mq = Math.max(mq, d[k+2]); }
      const gl = f.ctx.gl, a = new Float32Array(9 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.anchor.read.fbo); gl.readPixels(0, 0, 9, 1, gl.RGBA, gl.FLOAT, a);
      const anc = [0, 4, 8].map(i => a[i*4] + '/' + Math.round(a[i*4+1]) + '/' + a[i*4+2].toFixed(2)).join(' ');
      return [f.time.toFixed(2), fl.state, fl.attempts, Math.round(mt), ms.toFixed(3), mq.toFixed(1), f.ignition().on, '|', anc].join(' '); })()`);
    console.log(row);
    await sleep(150);
  }
  console.log('errors:', page.errors.length ? page.errors.slice(0, 4).join('\n  ') : 'none');
} catch (e) { console.log('debug failed:', e.message); }
finally { await shutdown(br, cdp, srv); }
process.exit(0);
