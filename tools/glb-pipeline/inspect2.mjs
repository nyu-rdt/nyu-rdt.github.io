// Deeper drill: L2 breakdown of the big assemblies + instancing stats + material usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'models', 'source', 'LunaRover_ae_fixed.glb');

function readJsonChunk(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(20);
  fs.readSync(fd, head, 0, 20, 0);
  const chunkLen = head.readUInt32LE(12);
  const buf = Buffer.alloc(chunkLen);
  fs.readSync(fd, buf, 0, chunkLen, 20);
  fs.closeSync(fd);
  return JSON.parse(buf.toString('utf8'));
}
const g = readJsonChunk(SRC);

const meshTris = g.meshes.map((m) => m.primitives.reduce((a, p) =>
  a + (p.indices != null ? Math.floor(g.accessors[p.indices].count / 3) : 0), 0));
const meshPrims = g.meshes.map((m) => m.primitives.length);

const memo = new Map();
function stats(i) {
  if (memo.has(i)) return memo.get(i);
  const n = g.nodes[i];
  let t = 0, p = 0, c = 1;
  if (n.mesh != null) { t += meshTris[n.mesh]; p += meshPrims[n.mesh]; }
  for (const ch of n.children || []) { const s = stats(ch); t += s.t; p += s.p; c += s.c; }
  const s = { t, p, c }; memo.set(i, s); return s;
}

// --- instancing stats ---
const meshRefCount = new Array(g.meshes.length).fill(0);
let nodesWithMesh = 0;
for (const n of g.nodes) if (n.mesh != null) { meshRefCount[n.mesh]++; nodesWithMesh++; }
console.log('=== INSTANCING ===');
console.log('nodes total', g.nodes.length, 'nodes with mesh (= draw calls today)', nodesWithMesh);
console.log('unique meshes', g.meshes.length, 'unique primitives', meshPrims.reduce((a, b) => a + b, 0));
console.log('unique tris', meshTris.reduce((a, b) => a + b, 0));
console.log('instanced (rendered) tris', meshTris.reduce((a, t, i) => a + t * meshRefCount[i], 0));
const multi = meshRefCount.filter((c) => c > 1).length;
console.log('meshes referenced >1x:', multi, ' max refs:', Math.max(...meshRefCount));

// --- material usage across instances ---
console.log('\n=== MATERIALS (by instanced tris) ===');
const matTris = new Map();
for (const n of g.nodes) {
  if (n.mesh == null) continue;
  for (const p of g.meshes[n.mesh].primitives) {
    const key = p.material ?? -1;
    const t = p.indices != null ? Math.floor(g.accessors[p.indices].count / 3) : 0;
    const e = matTris.get(key) || { t: 0, dc: 0 };
    e.t += t; e.dc += 1; matTris.set(key, e);
  }
}
for (const [k, v] of [...matTris].sort((a, b) => b[1].t - a[1].t)) {
  const m = k >= 0 ? g.materials[k] : null;
  console.log(`  mat#${String(k).padStart(3)} tris=${String(v.t).padStart(9)} drawcalls=${String(v.dc).padStart(5)} name="${m?.name ?? 'DEFAULT'}" alpha=${m?.alphaMode ?? 'OPAQUE'} ext=${Object.keys(m?.extensions ?? {}).join(',')} tex=${m?.pbrMetallicRoughness?.baseColorTexture ? 'base' : ''}${m?.normalTexture ? '+nrm' : ''}${m?.pbrMetallicRoughness?.metallicRoughnessTexture ? '+mr' : ''}`);
}

// --- attribute inventory ---
console.log('\n=== PRIMITIVE ATTRIBUTES ===');
const attrHist = new Map();
for (const m of g.meshes) for (const p of m.primitives) {
  const k = Object.keys(p.attributes).sort().join('+');
  attrHist.set(k, (attrHist.get(k) || 0) + 1);
}
for (const [k, v] of attrHist) console.log(`  ${k}: ${v} prims`);

// --- L2 drill of the giants ---
const scene = g.scenes[g.scene ?? 0];
const root = g.nodes[scene.nodes[0]];
const giants = ['Excav 1.4 <1>:1', 'Integration Assembly <1>:1', 'MAX Planetary Configurable <1>:1'];
for (const gname of giants) {
  const idx = (root.children || []).find((i) => g.nodes[i].name === gname);
  if (idx == null) { console.log(`\n!! not found: ${gname}`); continue; }
  const n = g.nodes[idx];
  console.log(`\n=== L2 OF "${gname}" (children=${(n.children || []).length}, total tris=${stats(idx).t}) ===`);
  const rows = (n.children || []).map((i) => ({ name: g.nodes[i].name, ...stats(i) }))
    .sort((a, b) => b.t - a.t);
  for (const r of rows.slice(0, 30)) console.log(`  tris=${String(r.t).padStart(8)} dc=${String(r.p).padStart(5)} nodes=${String(r.c).padStart(5)}  "${r.name}"`);
  if (rows.length > 30) {
    const rest = rows.slice(30);
    console.log(`  ... +${rest.length} more, tris=${rest.reduce((a, b) => a + b.t, 0)} dc=${rest.reduce((a, b) => a + b.p, 0)}`);
  }
}

// --- how much of the model is fastener-ish, by instanced tris, anywhere in the tree ---
console.log('\n=== FASTENER-ISH SHARE (whole tree, own-mesh tris only) ===');
const FAST = /screw|nut\b|washer|grommet|bolt|dowel|rivet|standoff|spacer|retaining ring|set screw|thread|91864|90044|93181|4946A|98164|92196|91290|94639/i;
const CHAIN = /roller chain|chain/i;
let fastT = 0, fastDC = 0, chainT = 0, chainDC = 0, otherT = 0, otherDC = 0;
// attribute a node's own mesh tris to nearest named ancestor matching category
function walk(i, inFast, inChain) {
  const n = g.nodes[i];
  const nm = n.name || '';
  const f = inFast || FAST.test(nm);
  const c = inChain || CHAIN.test(nm);
  if (n.mesh != null) {
    const t = meshTris[n.mesh], d = meshPrims[n.mesh];
    if (c) { chainT += t; chainDC += d; }
    else if (f) { fastT += t; fastDC += d; }
    else { otherT += t; otherDC += d; }
  }
  for (const ch of n.children || []) walk(ch, f, c);
}
walk(scene.nodes[0], false, false);
console.log('chain-ish   tris', chainT, 'dc', chainDC);
console.log('fastener-ish tris', fastT, 'dc', fastDC);
console.log('everything else tris', otherT, 'dc', otherDC);
