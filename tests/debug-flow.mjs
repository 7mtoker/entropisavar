// Debug: velocity (m/s) and temperature (K) samples above the burner after a few seconds.
import { startServer, launch, CDP, openPage, shutdown, watchdog } from './harness.mjs';

const srv = await startServer();
const br = await launch({ width: 1280, height: 800 });
const cdp = new CDP(br.ws);
watchdog(110000, () => shutdown(br, cdp, srv));
const t0 = Date.now(), at = (w) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${w}`);
await cdp.open();
const page = await openPage(cdp);
await page.viewport(1280, 800);
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html${process.argv[2] || ''}`);
  await page.waitFor('window.ES && ES.ready', 20000, 'ready');
  at('ready');
  await page.center('#ates .sim-stage');
  if (process.argv[3]) await page.set('#fire-phi', process.argv[3]);
  await page.waitFor('ES.sims.fire && ES.sims.fire.stats.simTime > 0', 30000, 'fire start');
  at('fire started');
  await page.simAdvance('fire', 4, 60000);
  at('advanced');
  const rows = await page.eval(`(() => {
    const f = ES.sims.fire, fl = f.fluid, gl = f.ctx.gl, nx = fl.nx, ny = fl.ny;
    const v = new Float32Array(nx * ny * 4), s = new Float32Array(nx * ny * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fl.vel.read.fbo); gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fl.scal.read.fbo); gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, s);
    const out = ['domain ' + fl.width.toFixed(3) + 'x' + fl.height + ' m, grid ' + nx + 'x' + ny + ', burner x0=' + f.burner[0].toFixed(3)];
    for (const ym of [0.035, 0.05, 0.08, 0.15, 0.3]) {
      const j = Math.min(ny - 1, Math.floor(ym / fl.h));
      const cells = [];
      for (let k = 0; k <= 8; k++) {
        const i = Math.min(nx - 1, Math.floor(k / 8 * (nx - 1))), o = (j * nx + i) * 4;
        cells.push(v[o].toFixed(2) + ',' + v[o + 1].toFixed(2) + '/' + Math.round(s[o + 1]));
      }
      out.push('y=' + ym + ': ' + cells.join('  '));
    }
    // column profiles across port 3: centre and rim, F/T/soot/Z by height
    const pc = f.burner[0] + 3 * f.burner[1];
    for (const [name, xm] of [['centre', pc], ['rim', pc + f.burner[2]], ['gap', pc + f.burner[1] / 2]]) {
      const i = Math.floor(xm / fl.h), prof = [];
      for (const ym of [0.03, 0.035, 0.045, 0.06, 0.09, 0.14]) {
        const o = (Math.floor(ym / fl.h) * nx + i) * 4;
        prof.push(ym + ':' + s[o].toFixed(2) + '/' + Math.round(s[o + 1]) + '/' + s[o + 2].toFixed(2) + '/' + s[o + 3].toFixed(2) + '/v' + v[o + 1].toFixed(2));
      }
      out.push(name + ' F/T/S/Z/vy  ' + prof.join('  '));
    }
    return out.join('\\n');
  })()`);
  console.log(rows);
  console.log('errors:', page.errors.length ? page.errors.slice(0, 4).join('\n  ') : 'none');
} catch (e) { console.log('debug failed:', e.message); }
finally { await shutdown(br, cdp, srv); }
process.exit(0);
