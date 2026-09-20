/**
 * Emits models/callouts.json — leader-line anchors for the systems page.
 *
 *   node --max-old-space-size=8192 callouts.mjs list    # dump candidate subtrees per group
 *   node --max-old-space-size=8192 callouts.mjs         # write models/callouts.json
 *
 * Positions are world-space bbox centres of NAMED subtrees in the DRAFT GLB (the final's
 * join/flatten collapses part names, but world positions are identical between the two — verified
 * in pipeline.mjs). Model is read un-exploded, so these are the rest-pose anchors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DRAFT = path.join(ROOT, 'models', 'luna-rover.draft.glb');
const MANIFEST = path.join(ROOT, 'models', 'subsystems.json');
const OUT = path.join(ROOT, 'models', 'callouts.json');

/**
 * Callout picks. `match` selects the representative subtree (first match wins, shallowest first);
 * `family` counts sibling instances to produce the "xN" suffix. Labels are human CAD names:
 * instance suffixes (<1>, :10) and McMaster part-number prefixes (6261K294_) stripped, terse
 * names expanded.
 */
const PICKS = {
  // REV 3: the chassis REMAINDER folds in here, so the frame rail joins the drivetrain picks.
  sys_locomotion: [
    { label: 'Wheel Assembly',        match: /^Wheel Assembly <\d+>:/ },
    { label: 'MAX Planetary Gearbox', match: /^MAX Planetary Configurable <\d+>:/ },
    // ~130 individual chain-link strips; a representative one sits on a real chain run, whereas
    // their union centre would land in mid-air at the middle of the rover. Count suppressed.
    { label: 'Roller Chain Drive',    match: /^6261K294_Roller Chain/, count: 'none' },
    { label: 'Frame Rail',            match: /Aluminum Rectangular Tube \(1\):/ },
  ],
  // REV 3: perception folds in here (the mast rides the ladder frame). The camera is the
  // storytelling pick and sits at the top of the group, well clear of the three ladder anchors.
  sys_excavation: [
    { label: 'Bucket Ladder',          match: /^Excav 1\.4 <\d+>:/ },
    { label: 'Excavation Chain',       match: /^#35 Excav Chain 1\.4 assembly <\d+>:/ },
    { label: 'Horizontal Support',     match: /^Excav Horizontal Support/ },
    { label: 'Intel RealSense Camera', match: /^Intel Realsense <\d+>:/ },
  ],
  sys_deposition: [
    { label: 'Conveyor Chain',        match: /^Chain Assembly <\d+>:/ },
    { label: 'Deposition Frame',      match: /^Depo Frame Proposal <\d+>:/ },
    { label: 'Load Cell',             match: /^Load Cell \(1\):/ },
    // NOTE: "MAX Planetary Configurable <n> (1)" also lives here, but the source CAD duplicates it
    // at the EXACT world position of the locomotion gearbox ([-0.186, 0.134, -0.083]). Two leader
    // lines on one pixel in two different groups would read as a bug, so it is deliberately omitted.
  ],
  sys_ee_box: [
    { label: 'EE Box',                match: /^EE Box <\d+>:/ },
    { label: 'EE Box Cover',          match: /^EE Box Cover:/ },
    { label: 'Deposition Connector',  match: /^EE Box Depo connector \d+:/ },
  ],
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read(DRAFT);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];

// locate the sys_* group nodes
const groups = new Map();
for (const s of manifest.subsystems) groups.set(s.group, null);
const findGroups = (n) => {
  if (groups.has(n.getName())) groups.set(n.getName(), n);
  for (const c of n.listChildren()) findGroups(c);
};
for (const n of scene.listChildren()) findGroups(n);
for (const [k, v] of groups) if (!v) throw new Error(`group ${k} not found in draft`);

const hasGeometry = (n) => {
  let found = false;
  const w = (x) => { if (x.getMesh()) found = true; else x.listChildren().forEach(w); };
  w(n);
  return found;
};

/** Breadth-first list of named descendants of a group (shallowest first). */
function descendants(group) {
  const out = [];
  let level = group.listChildren();
  let depth = 1;
  while (level.length && depth <= 6) {
    for (const n of level) out.push({ node: n, depth, name: n.getName() || '' });
    level = level.flatMap((n) => n.listChildren());
    depth++;
  }
  return out;
}

const centreOf = (n) => {
  const b = getBounds(n);
  if (!b.min.every(Number.isFinite) || !b.max.every(Number.isFinite)) return null;
  return b.min.map((v, i) => +((v + b.max[i]) / 2).toFixed(4));
};

if (process.argv[2] === 'find') {
  const re = new RegExp(process.argv[3], 'i');
  for (const [gname, g] of groups) {
    const hits = descendants(g).filter(({ name }) => re.test(name));
    if (!hits.length) continue;
    console.log(`\n=== ${gname} — ${hits.length} node(s) matching /${process.argv[3]}/i ===`);
    for (const { node, name, depth } of hits.slice(0, 14)) {
      const p = node.getParentNode();
      console.log(`  d${depth} geom=${hasGeometry(node) ? 'Y' : 'n'} centre=${JSON.stringify(centreOf(node))} parent="${p?.getName() ?? ''}"  "${name}"`);
    }
    if (hits.length > 14) console.log(`  ...+${hits.length - 14} more`);
  }
  process.exit(0);
}

if (process.argv[2] === 'list') {
  for (const [gname, g] of groups) {
    console.log(`\n=== ${gname} ===`);
    const seen = new Map();
    for (const { name, node, depth } of descendants(g)) {
      if (!name || /^Body\d/.test(name)) continue;
      const key = name.replace(/[:.]\d+$/, '');
      if (!seen.has(key)) seen.set(key, { n: 0, depth, node });
      seen.get(key).n++;
    }
    const rows = [...seen].filter(([, v]) => hasGeometry(v.node)).slice(0, 400);
    for (const [k, v] of rows.sort((a, b) => a[1].depth - b[1].depth).slice(0, 28)) {
      console.log(`  d${v.depth} x${String(v.n).padStart(3)}  centre=${JSON.stringify(centreOf(v.node))}  "${k}"`);
    }
    if (rows.length > 28) console.log(`  ...+${rows.length - 28} more distinct names`);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ build ----
const inside = (p, b, tol = 1e-3) => p.every((v, i) => v >= b.min[i] - tol && v <= b.max[i] + tol);
const callouts = {};
let total = 0, failures = 0;

for (const [gname, g] of groups) {
  const gBounds = getBounds(g);
  const all = descendants(g);
  const entries = [];

  for (const pick of PICKS[gname] || []) {
    const matches = all.filter(({ name, node }) => pick.match.test(name) && hasGeometry(node));
    if (!matches.length) { console.warn(`  SKIP ${gname} / "${pick.label}" — no matching subtree with geometry`); continue; }
    const hit = matches[0]; // descendants() is breadth-first, so this is the shallowest match

    // Count real instances. The export wraps each assembly in a same-named child ("X:1" -> "X"),
    // so a node whose parent also matches is a wrapper duplicate, not a second instance.
    const instances = matches.filter(({ node }) => !pick.match.test(node.getParentNode()?.getName() || '')).length;
    const position = centreOf(hit.node);
    if (!position) { console.warn(`  SKIP ${gname} / "${pick.label}" — degenerate bounds`); continue; }

    if (!inside(position, gBounds)) {
      console.error(`  ASSERT FAIL ${gname} / "${pick.label}" @ ${JSON.stringify(position)} outside ${JSON.stringify(gBounds)}`);
      failures++;
      continue;
    }
    const showCount = pick.count !== 'none' && instances > 1 && instances <= 8;
    entries.push({ label: showCount ? `${pick.label} ×${instances}` : pick.label, position });
    total++;
  }

  if (entries.length < 2) console.warn(`  WARNING: ${gname} has only ${entries.length} callout(s)`);
  if (entries.length > 4) entries.length = 4;
  callouts[gname] = entries;
}

if (failures) throw new Error(`${failures} callout anchor(s) fell outside their group bbox`);

fs.writeFileSync(OUT, JSON.stringify(callouts, null, 2) + '\n');

// ----------------------------------------------------------------- verify ----
const reread = JSON.parse(fs.readFileSync(OUT, 'utf8'));
console.log(`\n=== models/callouts.json — ${total} anchors, ${Object.keys(reread).length} groups ===`);
for (const [gname, g] of groups) {
  const b = getBounds(g);
  console.log(`\n${gname}  bbox min [${b.min.map((v) => v.toFixed(3)).join(', ')}] max [${b.max.map((v) => v.toFixed(3)).join(', ')}]`);
  for (const e of reread[gname]) {
    console.log(`   ${inside(e.position, b) ? 'IN ' : 'OUT'}  [${e.position.map((v) => v.toFixed(3).padStart(7)).join(', ')}]  ${e.label}`);
  }
}
const groupsMissing = manifest.subsystems.filter((s) => !reread[s.group]?.length);
console.log(`\nparse check: OK. groups with no anchors: ${groupsMissing.length ? groupsMissing.map((s) => s.group).join(', ') : 'none'}`);
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
