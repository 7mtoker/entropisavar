// Acceptance entry point (radar task --accept): unit, static, black-box.
// Writes the combined log to tests/out/run-all.log. Exit 0 only if all pass.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['unit', ['--test', 'tests/physics.test.js']],
  ['static', ['tests/static-check.mjs']],
  ['e2e', ['tests/e2e.mjs']],
];
let log = `run-all ${new Date().toISOString()}\n`;
let ok = true;
for (const [name, args] of steps) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  log += `\n===== ${name} (exit ${r.status}) =====\n${out}`;
  console.log(`${name}: ${r.status === 0 ? 'pass' : 'FAIL'}`);
  if (r.status !== 0) { ok = false; console.log(out.split('\n').filter(l => /FAIL|fail|✖|Error/.test(l)).slice(0, 20).join('\n')); }
}
mkdirSync(join(ROOT, 'tests', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'tests', 'out', 'run-all.log'), log);
console.log(ok ? 'ALL PASS' : 'FAILED');
process.exit(ok ? 0 : 1);
