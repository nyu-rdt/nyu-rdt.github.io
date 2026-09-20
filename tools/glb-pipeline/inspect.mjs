// Fast inspection of the source GLB: reads only the JSON chunk (no binary buffer load).
// Usage: node inspect.mjs [pathToGlb]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = process.argv[2] || path.join(ROOT, 'models', 'source', 'LunaRover_ae_fixed.glb');

function readJsonChunk(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(20);
  fs.readSync(fd, head, 0, 20, 0);
  const magic = head.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB');
  const version = head.readUInt32LE(4);
  const total = head.readUInt32LE(8);
  const chunkLen = head.readUInt32LE(12);
  const chunkType = head.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const buf = Buffer.alloc(chunkLen);
  fs.readSync(fd, buf, 0, chunkLen, 20);
  fs.closeSync(fd);
  return { json: JSON.parse(buf.toString('utf8')), version, total, chunkLen };
}

const { json: g, total, chunkLen } = readJsonChunk(SRC);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'subsystems.json'), 'utf8'));

console.log('=== FILE ===');
console.log('path', SRC);
console.log('bytes', fs.statSync(SRC).size, 'glbTotal', total, 'jsonChunk', chunkLen);
console.log('extensionsUsed', g.extensionsUsed);
console.log('extensionsRequired', g.extensionsRequired);
console.log('counts: nodes', g.nodes?.length, 'meshes', g.meshes?.length, 'materials', g.materials?.length,
  'accessors', g.accessors?.length, 'bufferViews', g.bufferViews?.length, 'images', g.images?.length,
  'textures', g.textures?.length, 'scenes', g.scenes?.length, 'animations', g.animations?.length,
  'skins', g.skins?.length, 'cameras', g.cameras?.length);

// primitive / triangle counts
let prims = 0, tris = 0;
for (const m of g.meshes || []) {
  for (const p of m.primitives || []) {
    prims++;
    if (p.indices != null) tris += Math.floor((g.accessors[p.indices].count) / 3);
    else if (p.attributes?.POSITION != null) tris += Math.floor(g.accessors[p.attributes.POSITION].count / 3);
  }
}
console.log('primitives', prims, 'triangles', tris);

const scene = g.scenes[g.scene ?? 0];
console.log('scene roots', scene.nodes.length, scene.nodes.map((i) => g.nodes[i].name));

// L1 = children of the single root
const rootIdx = scene.nodes[0];
const root = g.nodes[rootIdx];
const L1 = (root.children || []).map((i) => ({ i, name: g.nodes[i].name || `<unnamed ${i}>` }));
console.log('\n=== L1 CHILDREN ===', L1.length);

// count descendant meshes/tris per node
const meshTris = (g.meshes || []).map((m) =>
  (m.primitives || []).reduce((a, p) => a + (p.indices != null ? Math.floor(g.accessors[p.indices].count / 3)
    : p.attributes?.POSITION != null ? Math.floor(g.accessors[p.attributes.POSITION].count / 3) : 0), 0));
const meshPrims = (g.meshes || []).map((m) => (m.primitives || []).length);

const memo = new Map();
function stats(i) {
  if (memo.has(i)) return memo.get(i);
  const n = g.nodes[i];
  let t = 0, p = 0, c = 1;
  if (n.mesh != null) { t += meshTris[n.mesh]; p += meshPrims[n.mesh]; }
  for (const ch of n.children || []) { const s = stats(ch); t += s.t; p += s.p; c += s.c; }
  const s = { t, p, c };
  memo.set(i, s);
  return s;
}

// bucket L1 by manifest patterns (first-match-wins in manifest order)
const buckets = new Map();
for (const s of manifest.subsystems) buckets.set(s.group, []);
const REMAINDER = manifest.subsystems.find((s) => s.matchPatterns.includes('REMAINDER'))?.group;
const rules = manifest.subsystems
  .filter((s) => !s.matchPatterns.includes('REMAINDER'))
  .map((s) => ({ group: s.group, res: s.matchPatterns.map((p) => new RegExp(p)) }));

function classify(name) {
  for (const r of rules) for (const re of r.res) if (re.test(name)) return r.group;
  return REMAINDER;
}

for (const { i, name } of L1) buckets.get(classify(name)).push({ i, name, ...stats(i) });

console.log('\n=== BUCKETS ===');
for (const [grp, arr] of buckets) {
  const t = arr.reduce((a, b) => a + b.t, 0), p = arr.reduce((a, b) => a + b.p, 0);
  console.log(`${grp.padEnd(16)} L1nodes=${String(arr.length).padStart(4)}  tris=${String(t).padStart(9)}  prims=${String(p).padStart(6)}`);
}

console.log('\n=== NON-REMAINDER MEMBERS ===');
for (const [grp, arr] of buckets) {
  if (grp === REMAINDER) continue;
  for (const a of arr) console.log(`  ${grp}  <- "${a.name}"  tris=${a.t} prims=${a.p} nodes=${a.c}`);
}

console.log('\n=== REMAINDER: top 40 by tris ===');
const rem = buckets.get(REMAINDER).slice().sort((a, b) => b.t - a.t);
for (const a of rem.slice(0, 40)) console.log(`  tris=${String(a.t).padStart(8)} prims=${String(a.p).padStart(5)} nodes=${String(a.c).padStart(5)}  "${a.name}"`);

console.log('\n=== REMAINDER: name-prefix histogram (top 40) ===');
const hist = new Map();
for (const a of buckets.get(REMAINDER)) {
  const key = (a.name || '').replace(/\s*<\d+>\s*$/, '').replace(/\s+\d+$/, '').trim();
  const e = hist.get(key) || { n: 0, t: 0, p: 0 };
  e.n++; e.t += a.t; e.p += a.p;
  hist.set(key, e);
}
for (const [k, v] of [...hist].sort((a, b) => b[1].t - a[1].t).slice(0, 40))
  console.log(`  x${String(v.n).padStart(4)} tris=${String(v.t).padStart(8)} prims=${String(v.p).padStart(5)}  "${k}"`);

console.log('\n=== MATERIALS w/ transmission-ish extensions ===');
let tm = 0, sp = 0, ior = 0, blend = 0;
for (const m of g.materials || []) {
  if (m.extensions?.KHR_materials_transmission) tm++;
  if (m.extensions?.KHR_materials_specular) sp++;
  if (m.extensions?.KHR_materials_ior) ior++;
  if (m.alphaMode === 'BLEND' || m.alphaMode === 'MASK') blend++;
}
console.log('transmission', tm, 'specular', sp, 'ior', ior, 'alphaMode BLEND/MASK', blend, 'of', g.materials?.length);

console.log('\n=== IMAGES ===');
for (const [i, im] of (g.images || []).entries()) {
  const bv = g.bufferViews[im.bufferView];
  console.log(`  #${i} ${im.mimeType} name=${im.name ?? ''} bytes=${bv?.byteLength}`);
}

console.log('\n=== ROOT NODE TRS ===');
console.log(JSON.stringify({ name: root.name, translation: root.translation, rotation: root.rotation, scale: root.scale, matrix: root.matrix }));
console.log('L1 nodes using matrix (not TRS):', L1.filter(({ i }) => g.nodes[i].matrix).length);
