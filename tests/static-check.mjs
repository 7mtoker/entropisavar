// Static acceptance: the page ships no ready-made asset and needs no network.
// Run: node tests/static-check.mjs   (exit 0 = pass)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (m) => failures.push(m);

const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov', '.glb', '.gltf', '.hdr', '.exr']);
const SVG_NS = 'http://www.w3.org/2000/svg';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'out' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// 1. No asset files anywhere in the project.
for (const f of walk(ROOT)) {
  if (ASSET_EXT.has(extname(f).toLowerCase())) fail(`asset file present: ${relative(ROOT, f)}`);
}

const htmlPath = join(ROOT, 'index.html');
if (!existsSync(htmlPath)) {
  console.log('FAIL index.html missing');
  process.exit(1);
}
const html = readFileSync(htmlPath, 'utf8');

// 2. Title inside the first 8 KB, non-empty.
const t = html.indexOf('<title>');
if (t < 0 || t > 8192) fail('<title> missing or not in the first 8 KB');
else if (!/<title>\s*\S[^<]*<\/title>/.test(html)) fail('<title> is empty');

// 3. Forbidden elements.
for (const tag of ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'track']) {
  if (new RegExp(`<${tag}[\\s>/]`, 'i').test(html)) fail(`forbidden element <${tag}>`);
}

// 4. Every src/href is local (or an in-page anchor / tel / mailto), and exists.
const attrRe = /\s(src|href|xlink:href|poster|srcset)\s*=\s*"([^"]*)"/gi;
for (const m of html.matchAll(attrRe)) {
  const v = m[2];
  if (/^(#|tel:|mailto:)/.test(v)) continue;
  if (m[1] === 'href' && v.startsWith('data:image/svg+xml,')) continue; // hand-written inline SVG favicon
  if (/^[a-z]+:/i.test(v) || v.startsWith('//')) { fail(`non-local ${m[1]}="${v}"`); continue; }
  if (!existsSync(join(ROOT, v.split(/[?#]/)[0]))) fail(`${m[1]}="${v}" points at a missing file`);
}
for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
  if (!/rel="(stylesheet|icon)"/.test(m[0])) fail(`unexpected <link>: ${m[0]}`);
}
for (const m of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
  if (m[0] !== SVG_NS) fail(`absolute URL in HTML: ${m[0]}`);
}

// 5. Scripts are classic (file:// safe) and never reach the network.
const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(m => m[1]);
for (const a of scripts) if (/type="module"/.test(a)) fail('module script breaks file://');
const jsFiles = walk(join(ROOT, 'js')).filter(f => f.endsWith('.js'));
for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  for (const [re, what] of [
    [/\bfetch\s*\(/, 'fetch()'], [/XMLHttpRequest/, 'XMLHttpRequest'], [/new\s+WebSocket/, 'WebSocket'],
    [/sendBeacon/, 'sendBeacon'], [/new\s+Image\s*\(/, 'new Image()'], [/\bimport\s*\(/, 'dynamic import'],
    [/^\s*(import|export)\s/m, 'ES module syntax'], [/data:(image|audio|video|font)/, 'data: media URI'],
    [/https?:\/\//, 'absolute URL'],
  ]) if (re.test(src.replace(SVG_NS, ''))) fail(`${rel}: ${what}`);
}

// 6. CSS: no url(), @import or @font-face.
for (const f of walk(join(ROOT, 'css')).filter(f => f.endsWith('.css'))) {
  const css = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  if (/url\s*\(/i.test(css)) fail(`${rel}: url() reference`);
  if (/@import/i.test(css)) fail(`${rel}: @import`);
  if (/@font-face/i.test(css)) fail(`${rel}: @font-face`);
}
if (/<style[^>]*>[\s\S]*?url\s*\(/i.test(html)) fail('inline <style> uses url()');

// 7. Every form control has an id and a label.
for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
  const id = /\bid="([^"]+)"/.exec(m[2]);
  if (!id) { fail(`<${m[1]}> without id`); continue; }
  const labelled = new RegExp(`for="${id[1]}"`).test(html) || /aria-label="/.test(m[2]);
  if (!labelled) fail(`#${id[1]} has no <label for> or aria-label`);
}

if (failures.length) {
  for (const f of failures) console.log('FAIL', f);
  console.log(`static-check: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('static-check: pass');
