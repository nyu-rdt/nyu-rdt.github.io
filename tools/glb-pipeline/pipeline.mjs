/**
 * NYU RDT — LunaRover GLB web pipeline.
 *
 *   node --max-old-space-size=8192 pipeline.mjs stageA     # group + strip + prune (cached)
 *   node --max-old-space-size=8192 pipeline.mjs draft      # -> models/luna-rover.draft.glb
 *   node --max-old-space-size=8192 pipeline.mjs calibrate  # measure achievable simplify ratios
 *   node --max-old-space-size=8192 pipeline.mjs final      # -> models/luna-rover.glb
 *   node --max-old-space-size=8192 pipeline.mjs verify [path]
 *
 * Re-runnable. Stage A result is cached at .cache/stageA.glb; delete it to force a rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, join, meshopt, getBounds,
  simplifyPrimitive, textureCompress, getSceneVertexCount, VertexCountMethod,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'models', 'source', 'LunaRover_ae_fixed.glb');
const MANIFEST = path.join(ROOT, 'models', 'subsystems.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const STAGE_A = path.join(CACHE_DIR, 'stageA.glb');
const DRAFT_OUT = path.join(ROOT, 'models', 'luna-rover.draft.glb');
const FINAL_OUT = path.join(ROOT, 'models', 'luna-rover.glb');

const STRIP_EXTENSIONS = [
  'KHR_materials_transmission',
  'KHR_materials_specular',
  'KHR_materials_ior',
];

// ---------------------------------------------------------------- tuning ----
// Per-category simplification. Tuned from `calibrate`.
// REV 3 perf pass (user reported lag). Budgets tightened to 12 MB / 60 draws / 900k tris.
const CATEGORIES = {
  chain:      { ratio: 0.02, error: 0.12 },
  fastener:   { ratio: 0.10, error: 0.05 },
  structural: { ratio: 0.22, error: 0.008 },
};
// Draw calls after join = sum over groups of DISTINCT materials, so collapsing the ~30 flat greys
// is the main lever for the 60-draw budget. Fastener pruning is a fallback if triangles overshoot.
const PERF = {
  mergeMaterials: true,
  colorLevels: 6,          // quantization steps per colour channel
  pruneFastenersBelow: 0.02, // metres; 0 disables. Drops sub-2cm hardware (sub-pixel at page scale)
};
// Best-to-worst: when the same geometry sits at the same world position in two groups, the copy in
// the earlier group survives. Drivetrain parts belong to locomotion, and "Integration Assembly"
// (-> sys_deposition) is the wrapper that re-contains copies of everything, so it ranks last.
const DUPLICATE_KEEP_PRIORITY = ['sys_locomotion', 'sys_excavation', 'sys_ee_box', 'sys_deposition'];
// Verified from the source tree: every mesh under "Chain Assembly", "#35 Excav Chain 1.4
// assembly" and "25 Chain Assembly v1.3" is a chain link ("35 Chain (n)" / "6261K2xx_Roller
// Chain (n)") — no sprockets or motors are mixed in, so decimating those subtrees hard is safe.
// Dust covers / sprockets / tensioners carry "chain" in their names but are real parts.
const RE_CHAIN = /chain/i;
const RE_NOT_CHAIN = /dust\s*cover|dustcover|sprocket|tensioner/i;
// NOTE: 6546K / 9056K deliberately absent — those are the 6061 aluminium rectangular/round TUBES
// that form the frame rails (a callout anchor), not hardware. Including them decimated visible
// structural members at the fastener ratio.
const RE_FASTENER =
  /screw|\bnut\b|washer|grommet|\bbolt\b|dowel|rivet|standoff|spacer|retaining ring|hex bearing|bearing|snap ring|locknut|91864|90044|93181|4946A|98164|92196|91290|94639/i;

// ------------------------------------------------------------------ util ----
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
const fsize = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

/** Column-major 4x4 multiply (glTF convention): returns a*b. */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Read just the JSON chunk of a GLB on disk (no buffer decode). */
function readGlbJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    const len = head.readUInt32LE(12);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 20);
    return JSON.parse(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function newIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/**
 * First-match-wins classifier across subsystems, in manifest order. A subsystem may BOTH carry real
 * patterns and declare REMAINDER (rev 3: sys_locomotion does), so the literal "REMAINDER" token is
 * stripped from the pattern list rather than dropping that subsystem from the ordered rules.
 */
function makeClassifier(manifest) {
  const remainder = manifest.subsystems.find((s) => (s.matchPatterns || []).includes('REMAINDER'));
  if (!remainder) throw new Error('manifest declares no REMAINDER subsystem');
  const rules = manifest.subsystems.map((s) => ({
    group: s.group,
    res: (s.matchPatterns || []).filter((p) => p !== 'REMAINDER').map((p) => new RegExp(p)),
  }));
  return (name) => {
    for (const r of rules) for (const re of r.res) if (re.test(name || '')) return r.group;
    return remainder.group;
  };
}

/**
 * Collapses materials that differ only below perceptual threshold. The export carries ~30 flat
 * "Opaque(r,g,b)" greys; after join every distinct material costs one draw call PER GROUP, so
 * snapping them to a coarse palette is the cheapest way to buy draw calls. Textured materials keep
 * their identity because texture identity is part of the key.
 */
function mergeMaterials(doc, levels) {
  const texId = new Map();
  doc.getRoot().listTextures().forEach((t, i) => texId.set(t, i));
  const q = (v, n) => Math.round(v * n) / n;
  const key = (m) => JSON.stringify([
    m.getBaseColorFactor().slice(0, 3).map((v) => q(v, levels)),
    q(m.getMetallicFactor(), 4), q(m.getRoughnessFactor(), 4),
    m.getEmissiveFactor().map((v) => q(v, 4)),
    m.getAlphaMode(), m.getDoubleSided(),
    texId.get(m.getBaseColorTexture()) ?? null,
    texId.get(m.getNormalTexture()) ?? null,
    texId.get(m.getMetallicRoughnessTexture()) ?? null,
  ]);

  const materials = doc.getRoot().listMaterials();
  const canonical = new Map();
  for (const m of materials) if (!canonical.has(key(m))) canonical.set(key(m), m);
  const remap = new Map(materials.map((m) => [m, canonical.get(key(m))]));

  let repointed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const cur = prim.getMaterial();
      const to = cur && remap.get(cur);
      if (to && to !== cur) { prim.setMaterial(to); repointed++; }
    }
  }
  let disposed = 0;
  for (const m of materials) if (remap.get(m) !== m) { m.dispose(); disposed++; }
  return { before: materials.length, after: canonical.size, repointed, disposed };
}

/**
 * Removes geometry that exists twice in DIFFERENT groups at the same place.
 *
 * The source CAD nests copies of drivetrain parts (MAX Planetary gearboxes, hex shafts/bearings,
 * roller chain, front connectors) inside "Integration Assembly", which the manifest routes to
 * sys_deposition — while the originals sit at L1 and route to sys_locomotion. The copies are
 * coincident at rest, so the doubling stays invisible until the explosion pulls the groups apart
 * and the user sees two of every axle and gearbox.
 *
 * Detection runs AFTER dedup(), so geometrically identical meshes are literally the same Mesh
 * object; a duplicate is then (same Mesh) + (same world matrix, rounded to 10 microns). Legitimate
 * instancing shares the Mesh but never the world transform, so it is left alone.
 *
 * `priority` lists groups best-to-worst; the copy in the best-ranked group survives.
 */
function pruneCrossGroupDuplicates(groups, priority, dryRun = false) {
  const rank = new Map(priority.map((g, i) => [g, i]));
  const meshId = new Map();
  const idOf = (m) => {
    if (!meshId.has(m)) meshId.set(m, meshId.size);
    return meshId.get(m);
  };
  const meshTris = (mesh) => mesh.listPrimitives().reduce((a, p) => {
    const i = p.getIndices();
    return a + Math.floor((i ? i.getCount() : p.getAttribute('POSITION')?.getCount() || 0) / 3);
  }, 0);

  const buckets = new Map();
  for (const [gname, g] of groups) {
    const walk = (n, lastNamed) => {
      const nm = n.getName() || '';
      const named = /^Body\d|^$/.test(nm) ? lastNamed : nm;
      const mesh = n.getMesh();
      if (mesh) {
        const wm = n.getWorldMatrix().map((v) => Math.round(v * 1e5) / 1e5).join(',');
        const key = `${idOf(mesh)}|${wm}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ node: n, group: gname, mesh, label: named || nm });
      }
      for (const c of n.listChildren()) walk(c, named);
    };
    for (const c of g.listChildren()) walk(c, '');
  }

  const pruned = new Map();
  let nodes = 0, tris = 0, sameGroupDupes = 0;
  for (const entries of buckets.values()) {
    if (entries.length < 2) continue;
    if (new Set(entries.map((e) => e.group)).size < 2) { sameGroupDupes += entries.length - 1; continue; }
    const best = Math.min(...entries.map((e) => rank.get(e.group) ?? 1e9));
    for (const e of entries) {
      if ((rank.get(e.group) ?? 1e9) === best) continue; // survivor
      const t = meshTris(e.mesh);
      // collapse Blender's ".001/.002" copy suffixes so the log reads by part family
      const k = `${e.label.replace(/\.\d+$/, '')}  [${e.group}]`;
      const prev = pruned.get(k) || { n: 0, tris: 0 };
      pruned.set(k, { n: prev.n + 1, tris: prev.tris + t });
      if (!dryRun) e.node.getParentNode()?.removeChild(e.node); // orphaned; prune() collects it
      nodes++; tris += t;
    }
  }
  return { pruned, nodes, tris, sameGroupDupes };
}

/**
 * Drops fastener-ish subtrees whose largest bbox dimension is under `maxSize` metres — sub-pixel at
 * page scale, but each still costs triangles. Returns a per-family log of exactly what was removed.
 */
function pruneSmallFasteners(groups, maxSize) {
  const dropped = new Map();
  let tris = 0, nodes = 0;
  const countTris = (n) => {
    let t = 0;
    const w = (x) => {
      const m = x.getMesh();
      if (m) for (const p of m.listPrimitives()) {
        const i = p.getIndices();
        t += Math.floor((i ? i.getCount() : p.getAttribute('POSITION')?.getCount() || 0) / 3);
      }
      x.listChildren().forEach(w);
    };
    w(n);
    return t;
  };
  for (const [, g] of groups) {
    const victims = [];
    const walk = (n) => {
      if (RE_FASTENER.test(n.getName() || '')) {
        const b = getBounds(n);
        if (b.min.every(Number.isFinite)) {
          const size = Math.max(...b.max.map((v, i) => v - b.min[i]));
          if (size < maxSize) { victims.push([n, n.getName() || '']); return; } // don't descend
        }
      }
      for (const c of n.listChildren()) walk(c);
    };
    for (const c of g.listChildren()) walk(c);
    for (const [n, name] of victims) {
      tris += countTris(n);
      nodes++;
      const family = name.replace(/[:.]\d+$/, '').replace(/\s*\(\d+\)\s*$/, '').trim();
      dropped.set(family, (dropped.get(family) || 0) + 1);
      n.getParentNode()?.removeChild(n); // orphaned; prune() collects it
    }
  }
  return { dropped, tris, nodes };
}

/**
 * Second-level matching: pull named sub-assemblies out of the L1 bucket their parent landed in
 * and reparent them under their own group, taking precedence over the L1 match.
 *
 * The source tree wraps every assembly in a same-named node ("Integration Assembly <1>:1" ->
 * "Integration Assembly <1>" -> "EE Box <1>:1"), so a literal depth-2 search would miss real
 * sub-assemblies. We search all descendants, take the shallowest match, and never descend into a
 * subtree that already matched. Group nodes are identity children of the model root, so a node's
 * matrix relative to its old group is also its matrix relative to the new one: baking the product
 * of the local matrices along the chain preserves the world transform exactly.
 */
function applyL2Matching(manifest, groups) {
  const rules = manifest.subsystems
    .filter((s) => Array.isArray(s.matchPatternsL2) && s.matchPatternsL2.length)
    .map((s) => ({ group: s.group, res: s.matchPatternsL2.map((p) => new RegExp(p)) }));
  if (!rules.length) return [];

  const moves = [];
  for (const [gname, g] of groups) {
    const walk = (node, parentMat) => {
      const m = mul(parentMat, node.getMatrix());
      const name = node.getName() || '';
      const hit = rules.find((r) => r.res.some((re) => re.test(name)));
      if (hit) {
        if (hit.group !== gname) moves.push({ node, mat: m, from: gname, to: hit.group, name });
        return; // never descend into a matched subtree
      }
      for (const c of node.listChildren()) walk(c, m);
    };
    for (const c of g.listChildren()) walk(c, IDENTITY);
  }

  for (const mv of moves) {
    const before = mv.node.getWorldMatrix();
    const parent = mv.node.getParentNode();
    if (parent) parent.removeChild(mv.node);
    mv.node.setMatrix(mv.mat);
    groups.get(mv.to).addChild(mv.node);
    const after = mv.node.getWorldMatrix();
    mv.delta = Math.max(...after.map((v, i) => Math.abs(v - before[i])));
  }
  return moves;
}

/** Triangle count of the whole scene, counting node instances (= what the GPU draws). */
function sceneStats(doc) {
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  let tris = 0, drawCalls = 0, nodes = 0;
  const walk = (n) => {
    nodes++;
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        drawCalls++;
        const idx = prim.getIndices();
        const pos = prim.getAttribute('POSITION');
        tris += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
      }
    }
    for (const c of n.listChildren()) walk(c);
  };
  for (const n of scene.listChildren()) walk(n);
  return { tris, drawCalls, nodes };
}

function groupNodes(doc, manifest) {
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const out = new Map();
  const findIn = (parent) => {
    for (const c of parent.listChildren()) if (out.has(c.getName())) out.set(c.getName(), c);
  };
  for (const s of manifest.subsystems) out.set(s.group, null);
  for (const rootNode of scene.listChildren()) findIn(rootNode);
  findIn(scene);
  return out;
}

// --------------------------------------------------------------- stage A ----
async function buildStageA() {
  const manifest = loadManifest();
  const classify = makeClassifier(manifest);
  const io = newIO();

  log('reading source', SRC, mb(fsize(SRC)));
  const doc = await io.read(SRC);
  log('read ok.', JSON.stringify(sceneStats(doc)));

  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const roots = scene.listChildren();
  if (roots.length !== 1) log('WARNING: expected 1 scene root, found', roots.length);
  const modelRoot = roots[0];
  log('model root:', JSON.stringify(modelRoot.getName()));

  // --- sample deep leaf nodes for the world-matrix invariance check ---
  const samples = [];
  const collect = (n, depth) => {
    if (n.getMesh() && samples.length < 4000) samples.push(n);
    for (const c of n.listChildren()) collect(c, depth + 1);
  };
  collect(modelRoot, 0);
  const step = Math.max(1, Math.floor(samples.length / 24));
  const probes = samples.filter((_, i) => i % step === 0).slice(0, 24)
    .map((n) => ({ node: n, name: n.getName(), before: n.getWorldMatrix() }));
  log('captured', probes.length, 'world-matrix probes');

  // --- grouping: reparent L1 children into 5 sys_* group nodes ---
  const l1 = modelRoot.listChildren();
  log('L1 children:', l1.length);
  const groups = new Map();
  for (const s of manifest.subsystems) {
    const g = doc.createNode(s.group); // identity TRS
    modelRoot.addChild(g);
    groups.set(s.group, g);
  }
  const counts = new Map([...groups.keys()].map((k) => [k, 0]));
  for (const child of l1) {
    const g = classify(child.getName());
    modelRoot.removeChild(child);
    groups.get(g).addChild(child);
    counts.set(g, counts.get(g) + 1);
  }
  for (const [k, v] of counts) log(`  ${k}: ${v} L1 nodes`);

  // --- L2 matching: sub-assemblies that override their parent's L1 bucket ---
  const moves = applyL2Matching(manifest, groups);
  for (const mv of moves) {
    log(`  L2: "${mv.name}" ${mv.from} -> ${mv.to} (world-matrix delta ${mv.delta.toExponential(2)})`);
    if (mv.delta > 1e-9) throw new Error(`L2 move of "${mv.name}" changed its world matrix by ${mv.delta}`);
  }
  const l2Expected = manifest.subsystems.filter((s) => s.matchPatternsL2?.length).length;
  if (l2Expected && !moves.length) throw new Error('manifest declares matchPatternsL2 but nothing matched');
  log(`L2 moves: ${moves.length}`);

  // --- verify world transforms unchanged (must run BEFORE quantize) ---
  let maxDelta = 0, worst = '';
  for (const p of probes) {
    const after = p.node.getWorldMatrix();
    for (let i = 0; i < 16; i++) {
      const d = Math.abs(after[i] - p.before[i]);
      if (d > maxDelta) { maxDelta = d; worst = p.name; }
    }
  }
  log(`world-matrix invariance: max delta ${maxDelta} (worst: ${worst})`);
  if (maxDelta > 1e-9) throw new Error(`grouping moved geometry! max delta ${maxDelta}`);

  // --- strip transmission/specular/ior, force opaque where safe ---
  // REV 3: force EVERYTHING opaque. Parts are never ghosted in the new design, so there is no
  // depth-sort concern, and this removes the transparent render pass entirely.
  let forcedOpaque = 0;
  for (const mat of doc.getRoot().listMaterials()) {
    if (mat.getAlphaMode() !== 'OPAQUE') {
      log(`  forcing OPAQUE: "${mat.getName()}" (was ${mat.getAlphaMode()}, alpha ${mat.getAlpha().toFixed(3)})`);
      mat.setAlphaMode('OPAQUE');
      forcedOpaque++;
    }
    const c = mat.getBaseColorFactor();
    if (c[3] !== 1) mat.setBaseColorFactor([c[0], c[1], c[2], 1]);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (STRIP_EXTENSIONS.includes(ext.extensionName)) {
      log('  disposing extension', ext.extensionName);
      ext.dispose();
    }
  }
  log(`materials: forced OPAQUE ${forcedOpaque}`);

  // --- drop vertex attributes no material uses (TANGENT / TEXCOORD) ---
  const before = sceneStats(doc);
  await doc.transform(
    prune({ keepAttributes: false, keepSolidTextures: false, keepLeaves: false }),
    dedup(),
  );
  log('after prune+dedup:', JSON.stringify(sceneStats(doc)), 'was', JSON.stringify(before));

  // --- cross-group duplicate prune (fixes the doubled axles/gearboxes in the explosion) ---
  const groupsForDupes = groupNodes(doc, manifest);
  const dup = pruneCrossGroupDuplicates(groupsForDupes, DUPLICATE_KEEP_PRIORITY);
  log(`cross-group duplicates: pruned ${dup.nodes} nodes / ${dup.tris} instanced tris` +
      ` (${dup.sameGroupDupes} coincident pairs left alone inside a single group)`);
  for (const [k, v] of [...dup.pruned].sort((a, b) => b[1].tris - a[1].tris)) {
    log(`    x${String(v.n).padStart(4)}  ${String(v.tris).padStart(8)} tris  ${k}`);
  }
  if (dup.nodes) {
    await doc.transform(prune({ keepAttributes: false, keepLeaves: false }));
    log('after duplicate prune:', JSON.stringify(sceneStats(doc)));
  }

  // groups must have survived prune
  const survived = groupNodes(doc, manifest);
  for (const [k, v] of survived) if (!v) throw new Error(`group node ${k} was pruned away!`);
  log(`all ${survived.size} group nodes intact after prune`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  await io.write(STAGE_A, doc);
  log('wrote stage A cache', STAGE_A, mb(fsize(STAGE_A)));
  return doc;
}

async function loadStageA() {
  if (!fs.existsSync(STAGE_A)) return buildStageA();
  log('loading cached stage A', mb(fsize(STAGE_A)));
  const doc = await newIO().read(STAGE_A);
  log('stage A loaded:', JSON.stringify(sceneStats(doc)));
  return doc;
}

// ----------------------------------------------------------------- draft ----
async function buildDraft() {
  const doc = await loadStageA();
  const manifest = loadManifest();

  await doc.transform(weld());
  log('welded:', JSON.stringify(sceneStats(doc)));

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 12 }));
  log('meshopt done');

  await newIO().write(DRAFT_OUT, doc);
  log('WROTE', DRAFT_OUT, mb(fsize(DRAFT_OUT)));

  ensureGitignore('models/luna-rover.draft.glb');
  await report(DRAFT_OUT, manifest);
}

// ------------------------------------------------------------- calibrate ----
async function calibrate() {
  const doc = await loadStageA();
  await doc.transform(weld());

  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  // pick representative meshes by name
  const wanted = [
    ['chain', RE_CHAIN],
    ['planetary', /MAX Planetary/i],
    ['integration', /Integration Assembly/i],
    ['excav', /Excav/i],
    ['screw', /screw/i],
  ];
  const picks = new Map();
  const walk = (n, chain) => {
    const name = n.getName() || '';
    const trail = chain.concat(name);
    const mesh = n.getMesh();
    if (mesh) {
      for (const [label, re] of wanted) {
        if (picks.has(label)) continue;
        if (trail.some((s) => re.test(s))) {
          const prim = mesh.listPrimitives()[0];
          const idx = prim?.getIndices();
          if (idx && idx.getCount() / 3 > 800) picks.set(label, { node: n, prim, trail });
        }
      }
    }
    for (const c of n.listChildren()) walk(c, trail);
  };
  for (const n of scene.listChildren()) walk(n, []);

  await MeshoptSimplifier.ready;
  console.log('\n=== CALIBRATION (requested vs achieved) ===');
  for (const [label, { prim, trail }] of picks) {
    const srcTris = prim.getIndices().getCount() / 3;
    const srcVerts = prim.getAttribute('POSITION').getCount();
    console.log(`\n--- ${label}: ${srcTris} tris / ${srcVerts} verts  «${trail.slice(-2).join(' / ')}»`);
    for (const [ratio, error] of [[0.5, 0.005], [0.35, 0.001], [0.2, 0.02], [0.1, 0.05], [0.06, 0.05], [0.02, 0.1]]) {
      const clone = prim.clone();
      try {
        const out = simplifyPrimitive(clone, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
        const got = out.getIndices().getCount() / 3;
        console.log(`   ratio=${String(ratio).padEnd(5)} error=${String(error).padEnd(6)} -> ${String(got).padStart(7)} tris  (achieved ${(got / srcTris).toFixed(3)})`);
      } catch (e) {
        console.log(`   ratio=${ratio} error=${error} -> FAILED: ${e.message}`);
      }
      clone.dispose();
    }
  }
}

// ----------------------------------------------------------------- final ----
/** Reparent every mesh-bearing descendant to be a direct child of its sys_* group. */
function flattenIntoGroup(group) {
  const found = [];
  const walk = (node, parentMat) => {
    const m = mul(parentMat, node.getMatrix());
    if (node.getMesh()) found.push([node, m]);
    for (const c of node.listChildren()) walk(c, m);
  };
  for (const c of group.listChildren()) walk(c, IDENTITY);

  const topLevel = [...group.listChildren()];
  for (const [node, m] of found) {
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node);
    node.setMatrix(m);
    group.addChild(node);
  }
  // orphan the now-empty intermediate subtrees; prune() will collect them
  for (const c of topLevel) if (c.getParentNode() === group && !c.getMesh() && !found.some(([n]) => n === c)) group.removeChild(c);
  return found.length;
}

function categoryOf(trail) {
  if (trail.some((s) => RE_CHAIN.test(s)) && !trail.some((s) => RE_NOT_CHAIN.test(s))) return 'chain';
  if (trail.some((s) => RE_FASTENER.test(s))) return 'fastener';
  return 'structural';
}

async function buildFinal(opts = {}) {
  const manifest = loadManifest();
  const doc = await loadStageA();
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const statsBefore = sceneStats(doc);

  await doc.transform(weld());
  log('welded:', JSON.stringify(sceneStats(doc)));

  const groupsEarly = groupNodes(doc, manifest);

  // --- 0a. optional: drop sub-threshold fasteners (needs names, so before join) ---
  if (PERF.pruneFastenersBelow > 0) {
    const p = pruneSmallFasteners(groupsEarly, PERF.pruneFastenersBelow);
    log(`pruned ${p.nodes} fastener subtrees under ${PERF.pruneFastenersBelow * 100}cm: -${p.tris} tris`);
    for (const [family, n] of [...p.dropped].sort((a, b) => b[1] - a[1])) log(`    x${String(n).padStart(4)}  ${family}`);
    await doc.transform(prune({ keepAttributes: false, keepLeaves: false }));
    log('after fastener prune:', JSON.stringify(sceneStats(doc)));
  }

  // --- 0b. optional: collapse near-identical materials to buy draw calls ---
  if (PERF.mergeMaterials) {
    const m = mergeMaterials(doc, PERF.colorLevels);
    log(`materials merged: ${m.before} -> ${m.after} (repointed ${m.repointed} prims, disposed ${m.disposed})`);
  }

  // --- 1. categorize every unique mesh (least-aggressive wins if shared) ---
  const RANK = { chain: 0, fastener: 1, structural: 2 };
  const meshCat = new Map();
  const walk = (n, chain) => {
    const trail = chain.concat(n.getName() || '');
    const mesh = n.getMesh();
    if (mesh) {
      const cat = categoryOf(trail);
      const prev = meshCat.get(mesh);
      if (prev === undefined || RANK[cat] > RANK[prev]) meshCat.set(mesh, cat);
    }
    for (const c of n.listChildren()) walk(c, trail);
  };
  for (const n of scene.listChildren()) walk(n, []);
  const catCount = { chain: 0, fastener: 0, structural: 0 };
  for (const c of meshCat.values()) catCount[c]++;
  log('unique meshes by category:', JSON.stringify(catCount));

  // --- 2. simplify per unique mesh (BEFORE join, so it propagates to instances) ---
  await MeshoptSimplifier.ready;
  const tune = opts.categories || CATEGORIES;
  let simplified = 0, srcT = 0, dstT = 0, failed = 0;
  for (const [mesh, cat] of meshCat) {
    const { ratio, error } = tune[cat];
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (!idx) continue;
      const n = idx.getCount() / 3;
      srcT += n;
      if (n < 24) { dstT += n; continue; }
      try {
        simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
        dstT += prim.getIndices().getCount() / 3;
        simplified++;
      } catch (e) {
        dstT += n; failed++;
        if (failed < 5) log('  simplify failed:', e.message);
      }
    }
  }
  log(`simplified ${simplified} prims (${failed} failed): unique tris ${srcT} -> ${dstT} (${(dstT / srcT).toFixed(3)})`);
  await doc.transform(prune({ keepAttributes: false, keepLeaves: false }), dedup());
  log('after simplify:', JSON.stringify(sceneStats(doc)));

  // --- 3. flatten each group, then join siblings by material within the group ---
  const groups = groupNodes(doc, manifest);
  for (const [name, g] of groups) {
    if (!g) throw new Error(`missing group ${name}`);
    const boundsBefore = getBounds(g);
    const n = flattenIntoGroup(g);
    const boundsAfter = getBounds(g);
    const drift = Math.max(
      ...boundsBefore.min.map((v, i) => Math.abs(v - boundsAfter.min[i])),
      ...boundsBefore.max.map((v, i) => Math.abs(v - boundsAfter.max[i])),
    );
    log(`  ${name}: flattened ${n} mesh nodes, bbox drift ${drift.toExponential(2)}`);
    if (drift > 1e-6) throw new Error(`${name}: flatten moved geometry (drift ${drift})`);
  }
  await doc.transform(prune({ keepAttributes: false, keepLeaves: false }));
  log('after flatten:', JSON.stringify(sceneStats(doc)));

  for (const [name, g] of groups) {
    const members = new Set(g.listChildren());
    await doc.transform(join({ filter: (node) => members.has(node), keepNamed: false, cleanup: false }));
    log(`  joined ${name}: now ${g.listChildren().length} children`);
  }
  await doc.transform(prune({ keepAttributes: false, keepLeaves: false }), dedup());
  log('after join:', JSON.stringify(sceneStats(doc)));

  // --- 4. textures ---
  if (opts.textureMax !== 0) {
    try {
      const sharp = (await import('sharp')).default;
      await doc.transform(textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [opts.textureMax || 1024, opts.textureMax || 1024],
      }));
      log('textures compressed to webp');
    } catch (e) {
      log('texture compression skipped:', e.message);
    }
  }

  // --- 5. weld + meshopt ---
  await doc.transform(weld());
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 11 }));
  log('meshopt done');

  await newIO().write(FINAL_OUT, doc);
  log('WROTE', FINAL_OUT, mb(fsize(FINAL_OUT)));
  log('BEFORE (source, instanced):', JSON.stringify(statsBefore));
  await report(FINAL_OUT, manifest);
}

// ---------------------------------------------------------------- verify ----
async function report(file, manifest = loadManifest()) {
  console.log(`\n=== VERIFY (fresh reload) ${file} ===`);
  const doc = await newIO().read(file);
  const raw = readGlbJson(file); // read what is actually on disk, not a re-serialization
  const size = fsize(file);
  console.log('file size          :', mb(size), `(${size} bytes)`);
  console.log('extensionsUsed     :', raw.extensionsUsed || []);
  console.log('extensionsRequired :', raw.extensionsRequired || []);
  const bad = STRIP_EXTENSIONS.filter((e) => (raw.extensionsUsed || []).includes(e));
  console.log('stripped-ext check :', bad.length ? `FAIL — still present: ${bad}` : 'PASS (no transmission/specular/ior)');

  const s = sceneStats(doc);
  const T = manifest.pipeline?.targets || {};
  const check = (v, max) => (max ? (v <= max ? `PASS (<= ${max})` : `FAIL (> ${max})`) : '');
  console.log('draw calls (prims) :', s.drawCalls, file === FINAL_OUT ? check(s.drawCalls, T.maxDrawCalls) : '(draft: unjoined)');
  console.log('triangles (drawn)  :', s.tris, file === FINAL_OUT ? check(s.tris, T.maxTriangles) : '');
  console.log('nodes              :', s.nodes);
  console.log('materials          :', doc.getRoot().listMaterials().length);
  console.log('textures           :', doc.getRoot().listTextures().length,
    doc.getRoot().listTextures().map((t) => `${t.getMimeType()}:${(t.getImage()?.byteLength / 1024).toFixed(0)}KB`).join(' '));
  const target = manifest.pipeline?.targets?.finalMaxBytes;
  if (file === FINAL_OUT && target) {
    console.log('size budget        :', size <= target ? `PASS (${mb(size)} <= ${mb(target)})` : `FAIL (${mb(size)} > ${mb(target)})`);
  }

  const groups = groupNodes(doc, manifest);
  const overall = getBounds(doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0]);
  console.log('\ngroup                 status  drawCalls   triangles   bbox center (x,y,z)            bbox size');
  const out = { groups: {}, overall };
  for (const [name, g] of groups) {
    if (!g) { console.log(`${name.padEnd(20)}  MISSING`); out.groups[name] = null; continue; }
    let tris = 0, dc = 0;
    const w = (n) => {
      const m = n.getMesh();
      if (m) for (const p of m.listPrimitives()) { dc++; const i = p.getIndices(); tris += Math.floor((i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3); }
      for (const c of n.listChildren()) w(c);
    };
    w(g);
    const b = getBounds(g);
    const ctr = b.min.map((v, i) => (v + b.max[i]) / 2);
    const sz = b.min.map((v, i) => b.max[i] - v);
    const f = (a) => '[' + a.map((v) => v.toFixed(3).padStart(7)).join(', ') + ']';
    console.log(`${name.padEnd(20)}  OK     ${String(dc).padStart(8)}   ${String(tris).padStart(9)}   ${f(ctr)}  ${f(sz)}`);
    out.groups[name] = { drawCalls: dc, tris, center: ctr, size: sz, min: b.min, max: b.max };
  }
  const f = (a) => '[' + a.map((v) => v.toFixed(3)).join(', ') + ']';
  console.log(`\noverall bbox min ${f(overall.min)}  max ${f(overall.max)}`);
  console.log(`overall center   ${f(overall.min.map((v, i) => (v + overall.max[i]) / 2))}  size ${f(overall.min.map((v, i) => overall.max[i] - v))}`);
  fs.writeFileSync(path.join(CACHE_DIR, path.basename(file) + '.report.json'), JSON.stringify(out, null, 2));
  return out;
}

function ensureGitignore(line) {
  const gi = path.join(ROOT, '.gitignore');
  const txt = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = txt.split(/\r?\n/);
  let changed = false;
  for (const l of [line, 'tools/glb-pipeline/.cache/']) {
    if (!lines.some((x) => x.trim() === l)) {
      lines.push(l);
      changed = true;
      log('gitignore += ' + l);
    }
  }
  if (changed) fs.writeFileSync(gi, lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n').replace(/\n*$/, '\n'));
}

// ------------------------------------------------------------------ main ----
const cmd = process.argv[2] || 'draft';
const arg = process.argv[3];
try {
  if (cmd === 'stageA') await buildStageA();
  else if (cmd === 'draft') await buildDraft();
  else if (cmd === 'calibrate') await calibrate();
  else if (cmd === 'final') await buildFinal();
  else if (cmd === 'verify') await report(arg ? path.resolve(arg) : FINAL_OUT);
  else if (cmd === 'dupecheck') {
    // Regression test: assert no cross-group coincident geometry survives in a built file.
    const file = arg ? path.resolve(arg) : DRAFT_OUT;
    const doc = await newIO().read(file);
    const d = pruneCrossGroupDuplicates(groupNodes(doc, loadManifest()), DUPLICATE_KEEP_PRIORITY, true);
    console.log(`dupecheck ${file}`);
    console.log(`  cross-group duplicate nodes remaining: ${d.nodes} (${d.tris} tris)`);
    console.log(`  coincident pairs within a single group: ${d.sameGroupDupes}`);
    for (const [k, v] of [...d.pruned].sort((a, b) => b[1].tris - a[1].tris).slice(0, 20)) {
      console.log(`    x${String(v.n).padStart(4)} ${String(v.tris).padStart(8)} tris  ${k}`);
    }
    console.log(d.nodes === 0 ? '  PASS — no doubled geometry across groups' : '  FAIL — duplicates remain');
    if (d.nodes !== 0) process.exitCode = 1;
  }
  else throw new Error(`unknown command: ${cmd}`);
  log('done.');
} catch (e) {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
}
