/**
 * scene.js — renderer, lighting, the proxy rover, the GLB loader, and the
 * "prepare" step that turns any root (proxy or real model) into the same
 * group contract the rest of the page drives.
 *
 * Nothing downstream knows whether it is looking at the proxy or the real CAD:
 * everything keys off the sys_* group names from models/subsystems.json.
 *
 * A manifest group binds to one OR MORE scene nodes, all driven by one shared
 * explosion offset — that is what lets a four-group manifest drive a scene that
 * still ships six nodes (see GROUP_ALIASES).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const INK = 0x0a0a0a;
export const VIOLET = 0x57068c;

/** Hard ceiling on device pixel ratio — DESIGN.md REV 3 perf budget. */
export const MAX_DPR = 1.5;

/* ============================== renderer ================================== */

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });

  // The stage owns its pixel ratio so the adaptive step-down survives a resize.
  let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // flat + technical, not cinematic
  renderer.setClearColor(0xffffff, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);

  // Soft, shadowless studio light. Hemisphere carries the ambient, one key for
  // form, one fill to keep the dark side off the paper white.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xcfcfcf, 2.05);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2.4, 3.4, 2.0);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.62);
  fill.position.set(-2.6, 1.4, -1.8);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.34);
  rim.position.set(-0.4, 1.0, -3.0);
  scene.add(rim);

  // Static gradient blob, not a shadow map: the renderer never runs a shadow
  // pass, so the contact shading costs one transparent quad per frame.
  const shadow = createContactShadow();
  scene.add(shadow);

  let sizeW = 1;
  let sizeH = 1;

  function resize(w, h) {
    sizeW = w;
    sizeH = h;
    renderer.setPixelRatio(dpr); // never re-derived from devicePixelRatio
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  /** Adaptive quality: downward only, and it sticks across resizes. */
  function setDpr(next) {
    if (next >= dpr) return false;
    dpr = next;
    renderer.setPixelRatio(dpr);
    renderer.setSize(sizeW, sizeH, false);
    return true;
  }

  return {
    renderer, scene, camera, lights: { hemi, key, fill, rim }, shadow, resize, setDpr,
    get dpr() { return dpr; },
  };
}

function createContactShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 126);
  grd.addColorStop(0.00, 'rgba(10,10,10,0.40)');
  grd.addColorStop(0.38, 'rgba(10,10,10,0.17)');
  grd.addColorStop(0.72, 'rgba(10,10,10,0.045)');
  grd.addColorStop(1.00, 'rgba(10,10,10,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  mesh.name = '__contactShadow';
  return mesh;
}

/* ============================ proxy rover ================================= */

const proxyBody = () =>
  new THREE.MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.62, metalness: 0.06 });
const proxyDark = () =>
  new THREE.MeshStandardMaterial({ color: 0x8f8f8f, roughness: 0.72, metalness: 0.08 });
const proxyAccent = () =>
  new THREE.MeshStandardMaterial({ color: 0xb9b9b9, roughness: 0.5, metalness: 0.22 });

function part(geo, mat, [x, y, z], name, opts = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.name = name;
  if (opts.rot) m.rotation.set(opts.rot[0] || 0, opts.rot[1] || 0, opts.rot[2] || 0);
  if (opts.anchor) m.userData.anchor = true;
  return m;
}

/**
 * A plausible rover in proxy form: wheels at the corners, bucket-ladder at
 * front-centre, deposition bin at the rear, perception mast up top, frame in
 * the middle. Part names mirror the manifest's matchPatterns so the callout
 * labels read like the real thing from day one.
 */
export function buildProxy() {
  const root = new THREE.Group();
  root.name = 'LunaProxy';

  /* ---- chassis ---------------------------------------------------------- */
  const chassis = new THREE.Group();
  chassis.name = 'sys_chassis';
  const railGeo = new THREE.BoxGeometry(1.44, 0.07, 0.075);
  chassis.add(part(railGeo, proxyBody(), [0, 0.31, 0.36], 'Chassis Rail Left', { anchor: true }));
  chassis.add(part(railGeo.clone(), proxyBody(), [0, 0.31, -0.36], 'Chassis Rail Right'));

  const crossGeo = new THREE.BoxGeometry(0.075, 0.055, 0.72);
  [-0.58, 0, 0.58].forEach((x, i) =>
    chassis.add(part(crossGeo.clone(), proxyBody(), [x, 0.31, 0], `Cross Member ${i + 1}`, { anchor: i === 2 }))
  );
  chassis.add(part(new THREE.BoxGeometry(0.86, 0.018, 0.64), proxyAccent(), [-0.08, 0.35, 0], 'Deck Plate', { anchor: true }));
  // uprights down to the axles
  const postGeo = new THREE.BoxGeometry(0.055, 0.135, 0.055);
  for (const x of [-0.58, 0.58]) for (const z of [-0.40, 0.40])
    chassis.add(part(postGeo.clone(), proxyBody(), [x, 0.245, z], 'Axle Upright'));
  root.add(chassis);

  /* ---- mobility --------------------------------------------------------- */
  const mobility = new THREE.Group();
  mobility.name = 'sys_mobility';
  const wheelGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.135, 30);
  const gearGeo = new THREE.BoxGeometry(0.125, 0.125, 0.10);
  const coverGeo = new THREE.BoxGeometry(0.30, 0.16, 0.018);
  const shaftGeo = new THREE.CylinderGeometry(0.019, 0.019, 0.20, 12);
  let n = 0;
  for (const x of [0.58, -0.58]) {
    for (const z of [0.40, -0.40]) {
      n++;
      const inner = z > 0 ? -1 : 1;
      const first = n === 1;
      mobility.add(part(wheelGeo.clone(), proxyDark(), [x, 0.20, z], `Wheel Assembly ${n}`,
        { rot: [Math.PI / 2, 0, 0], anchor: first }));
      mobility.add(part(gearGeo.clone(), proxyBody(), [x, 0.20, z + inner * 0.13],
        `MAX Planetary Gearbox ${n}`, { anchor: first }));
      mobility.add(part(shaftGeo.clone(), proxyAccent(), [x, 0.20, z + inner * 0.06],
        `Hex Shaft ${n}`, { rot: [Math.PI / 2, 0, 0], anchor: first }));
      mobility.add(part(coverGeo.clone(), proxyAccent(), [x - 0.02, 0.255, z + inner * 0.185],
        `Chain Dust Cover ${n}`, { anchor: first }));
    }
  }
  root.add(mobility);

  /* ---- excavation ------------------------------------------------------- */
  const excavation = new THREE.Group();
  excavation.name = 'sys_excavation';
  const ladder = new THREE.Group();
  ladder.name = 'Excav 1.4 Ladder';
  ladder.position.set(0.60, 0.44, 0);
  ladder.rotation.z = -0.60;
  const ladRail = new THREE.BoxGeometry(0.74, 0.035, 0.025);
  ladder.add(part(ladRail, proxyBody(), [0, 0, 0.185], 'Excav 1.4 Ladder Rail', { anchor: true }));
  ladder.add(part(ladRail.clone(), proxyBody(), [0, 0, -0.185], 'Excav 1.4 Ladder Rail B'));
  const bucketGeo = new THREE.BoxGeometry(0.075, 0.065, 0.30);
  for (let i = 0; i < 6; i++)
    ladder.add(part(bucketGeo.clone(), proxyDark(), [-0.30 + i * 0.12, -0.055, 0],
      `Excav 1.4 Bucket ${i + 1}`, { anchor: i === 4 }));
  ladder.add(part(new THREE.CylinderGeometry(0.068, 0.068, 0.35, 20), proxyAccent(), [-0.35, 0, 0],
    'Excav Horizontal Support', { rot: [Math.PI / 2, 0, 0], anchor: true }));
  excavation.add(ladder);
  excavation.add(part(new THREE.BoxGeometry(0.07, 0.07, 0.07), proxyAccent(), [0.86, 0.66, 0],
    'Load Cell Top Assembly', { anchor: true }));
  root.add(excavation);

  /* ---- deposition ------------------------------------------------------- */
  const deposition = new THREE.Group();
  deposition.name = 'sys_deposition';
  const bin = new THREE.Group();
  bin.name = 'Integration Assembly Bin';
  bin.position.set(-0.44, 0.56, 0);
  bin.rotation.z = 0.06;
  bin.add(part(new THREE.BoxGeometry(0.46, 0.02, 0.60), proxyBody(), [0, -0.14, 0], 'Bin Floor', { anchor: true }));
  bin.add(part(new THREE.BoxGeometry(0.02, 0.27, 0.60), proxyBody(), [0.22, 0, 0], 'Bin Front Wall'));
  bin.add(part(new THREE.BoxGeometry(0.02, 0.27, 0.60), proxyBody(), [-0.22, 0, 0], 'Bin Rear Wall', { anchor: true }));
  bin.add(part(new THREE.BoxGeometry(0.46, 0.27, 0.02), proxyBody(), [0, 0, 0.29], 'Bin Side Wall'));
  bin.add(part(new THREE.BoxGeometry(0.46, 0.27, 0.02), proxyBody(), [0, 0, -0.29], 'Bin Side Wall B'));
  deposition.add(bin);
  const actGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.30, 12);
  deposition.add(part(actGeo, proxyAccent(), [-0.20, 0.44, 0.26], 'Integration Assembly Actuator',
    { rot: [0, 0, 0.9], anchor: true }));
  deposition.add(part(actGeo.clone(), proxyAccent(), [-0.20, 0.44, -0.26], 'Integration Assembly Actuator B',
    { rot: [0, 0, 0.9] }));
  deposition.add(part(new THREE.BoxGeometry(0.10, 0.10, 0.66), proxyDark(), [-0.66, 0.40, 0],
    'Integration Assembly Pivot', { anchor: true }));
  root.add(deposition);

  /* ---- electronics ------------------------------------------------------ */
  const electronics = new THREE.Group();
  electronics.name = 'sys_electronics';
  electronics.add(part(new THREE.BoxGeometry(0.30, 0.17, 0.33), proxyBody(), [-0.20, 0.445, 0.04],
    'EE Box Main Enclosure', { anchor: true }));
  electronics.add(part(new THREE.BoxGeometry(0.20, 0.10, 0.17), proxyDark(), [0.08, 0.415, -0.19],
    'EE Box Battery Pack', { anchor: true }));
  electronics.add(part(new THREE.BoxGeometry(0.13, 0.055, 0.15), proxyAccent(), [0.10, 0.39, 0.19],
    'EE Box Motor Controller', { anchor: true }));
  electronics.add(part(new THREE.BoxGeometry(0.52, 0.022, 0.032), proxyAccent(), [0.02, 0.375, -0.30],
    'EE Box Cable Chain', { anchor: true }));
  root.add(electronics);

  /* ---- perception ------------------------------------------------------- */
  const perception = new THREE.Group();
  perception.name = 'sys_perception';
  perception.add(part(new THREE.BoxGeometry(0.05, 0.44, 0.05), proxyBody(), [0.10, 0.60, 0.22],
    'Realsense Mount Mast', { anchor: true }));
  perception.add(part(new THREE.BoxGeometry(0.075, 0.05, 0.17), proxyDark(), [0.12, 0.845, 0.22],
    'Realsense Holder D435i', { rot: [0, 0, -0.12], anchor: true }));
  perception.add(part(new THREE.BoxGeometry(0.06, 0.045, 0.145), proxyDark(), [0.72, 0.40, -0.22],
    'Realsense Holder D455', { rot: [0, 0, 0.22], anchor: true }));
  perception.add(part(new THREE.BoxGeometry(0.05, 0.05, 0.05), proxyAccent(), [0.66, 0.40, -0.22],
    'Realsense Mount Bracket'));
  root.add(perception);

  return root;
}

/* ============================== GLB load ================================== */

let _loader = null;
function loader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.setMeshoptDecoder(MeshoptDecoder); // GLBs use EXT_meshopt_compression
  }
  return _loader;
}

/** HEAD-probe first so a missing model is a quiet miss, not a console error. */
export async function modelExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    // A dev server that 200s an HTML 404 page is still a miss.
    return !type.includes('text/html');
  } catch {
    return false;
  }
}

export async function loadModel(url, onProgress) {
  if (MeshoptDecoder.ready) await MeshoptDecoder.ready;
  const gltf = await loader().loadAsync(url, onProgress);
  return gltf.scene;
}

/* ============================== prepare =================================== */

/** Strip the usual CAD/exporter noise from a node name, conservatively. */
export function cleanPartName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/:\d+$/, '');                             // Fusion instance "…:10"
  s = s.replace(/\s*<\d+>$/, '');                         // "Excav 1.4 <1>"
  s = s.replace(/\.\d{3}$/, '');                          // Blender .001
  s = s.replace(/\s*\(\d+\)$/, '');                       // "Part (2)"
  s = s.replace(/[_-]\d+$/, '');                          // "Part_3"
  s = s.replace(/[\s_-]+(copy|mirror(ed)?|instance|default)$/i, '');
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.toUpperCase();
}

/**
 * Names an exporter invented rather than a part a person named: "Body1.529",
 * "BODY1529", "Mesh_12", "Object". A group made only of these gets numbered
 * drafting balloons instead of invented labels.
 */
const JUNK_NAME =
  /^(?:body|bodies|solid|part|comp(?:onent)?|feature|face|surface|shape|mesh|node|group|geom(?:etry)?|primitive|object|scene|root|untitled|instance|item)[\s._-]*\d*(?:[.:_-]\d+)*$/i;

export const isJunkName = (raw) => {
  const s = String(raw || '').trim();
  return !s || JUNK_NAME.test(s);
};

/**
 * The CAD carries its authoring colours — big magenta printed parts and so on.
 * DESIGN.md wants black ink on white paper with violet reserved for the active
 * subsystem, so a loaded model gets a technical finish: hue dropped, luminance
 * preserved and remapped into a paper-friendly range. The linework and the
 * violet highlight both read properly afterwards.
 */
/**
 * REV 3 deletes the opacity-ghosting system outright, so nothing on the model is
 * ever translucent. Forcing BLEND materials opaque restores depth-writes and
 * early-z for them and removes the per-frame transparent sort entirely.
 */
export function forceOpaque(m) {
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.depthTest = true;
  if ('alphaTest' in m) m.alphaTest = 0;
  if ('blending' in m) m.blending = THREE.NormalBlending;
}

export function neutralizeMaterials(root) {
  const seen = new Set();
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      forceOpaque(m);
      if (m.color) {
        const { r, g, b } = m.color;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        m.color.setScalar(0.24 + Math.pow(lum, 0.85) * 0.68);
      }
      if (m.emissive) m.emissive.setScalar(0);
      if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.25);
      if ('roughness' in m) m.roughness = Math.min(Math.max(m.roughness ?? 0.6, 0.34), 0.86);
    }
  });
}

/**
 * Give each mesh under `root` a hairline black edge overlay — the thing that
 * makes it read as a drawing rather than a render. Skipped automatically on
 * dense models, where the edge pass would cost more than it gives.
 */
export function addEdgeOverlay(root, maxTriangles = 60000) {
  let tris = 0;
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
      meshes.push(o);
    }
  });
  if (tris > maxTriangles) return false;

  for (const m of meshes) {
    let edges;
    try {
      edges = new THREE.EdgesGeometry(m.geometry, 26);
    } catch {
      continue;
    }
    if (!edges.attributes.position || edges.attributes.position.count === 0) continue;
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.42, depthWrite: false })
    );
    line.name = '__edges';
    line.userData.isEdge = true;
    line.renderOrder = 1;
    m.add(line);
  }
  return true;
}

/**
 * TEMPORARY: 6-group GLB bridge — delete when the 4-group file lands.
 *
 * models/subsystems.json is the REV 3 four-group contract, but the GLB on disk
 * (and the proxy) still ship the older six-node tree. A manifest group binds to
 * every node it can find, so the folds the manifest itself describes — chassis
 * into locomotion, perception into excavation — happen at runtime instead of
 * leaving four nodes unbound, unexploded and unframed. Exact manifest names are
 * always tried first, so the new file needs none of this.
 */
const GROUP_ALIASES = {
  sys_locomotion: ['sys_mobility', 'sys_chassis'],
  sys_excavation: ['sys_perception'],
  sys_ee_box: ['sys_electronics'],
};
// Still load-bearing for the six-group PROXY (and any stale cached GLB); the
// shipped four-group model matches the manifest exactly and never reaches it.

/** Every scene-node name a manifest group may claim, exact match first. */
const groupNames = (id) => [id, ...(GROUP_ALIASES[id] || [])];

/**
 * Turn a loaded/built root into the driveable contract.
 *
 * @returns {null|{root, groups, center, radius, box, missing}} null if none of
 *          the sys_* groups exist (caller keeps whatever it had).
 */
export function prepareModel(root, subsystems, calloutOverrides = null) {
  // Some CAD exports land Z-up. If the model is far deeper than it is tall,
  // rotate the whole root. explodeDir is applied in WORLD space below, so this
  // rotation can never tip an "up" explosion sideways.
  const probe = new THREE.Box3().setFromObject(root);
  const pSize = probe.getSize(new THREE.Vector3());
  if (pSize.z > pSize.y * 1.35 && pSize.z > pSize.x * 0.55) {
    root.rotation.x = -Math.PI / 2;
  }
  root.updateMatrixWorld(true);

  const found = [];
  const missing = [];
  const claimed = new Set();
  for (const sub of subsystems) {
    const nodes = [];
    for (const name of groupNames(sub.group)) {
      const node = root.getObjectByName(name);
      // A node is only ever driven by one group, whatever the alias table says.
      if (node && !claimed.has(node)) { claimed.add(node); nodes.push({ node, name }); }
    }
    if (nodes.length) found.push({ sub, nodes });
    else missing.push(sub.group);
  }
  if (!found.length) return null;

  // precise=true throughout the framing maths. The default walks each geometry's
  // own AABB and transforms *that*, which inflates any rotated sub-assembly (the
  // bucket ladder measures 20% too tall that way) and would frame it too wide.
  const box = new THREE.Box3().setFromObject(root, true);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(0.5 * size.length(), 1e-3);

  const _q = new THREE.Quaternion();
  const groups = found.map(({ sub, nodes }, i) => {
    const materials = [];
    for (const { node } of nodes) materials.push(...cloneGroupMaterials(node));

    // ONE coherent radial gesture: the manifest's direction is normalized, so
    // every non-anchor group travels the same distance and only the bearing
    // differs. A zero vector (or an explicit anchor flag) means "stay put" —
    // that is how the anchor is derived from the data, not from a name.
    const dirWorld = new THREE.Vector3().fromArray(sub.explodeDir || [0, 0, 0]);
    const anchor = sub.anchor === true || dirWorld.lengthSq() < 1e-8;
    if (!anchor) dirWorld.normalize();
    else dirWorld.set(0, 0, 0);

    const gBox = new THREE.Box3();
    const members = nodes.map(({ node }) => {
      // World → this node's parent space, so a rotated root still explodes up.
      const dirLocal = dirWorld.clone();
      if (node.parent) dirLocal.applyQuaternion(node.parent.getWorldQuaternion(_q).invert());
      const nBox = new THREE.Box3().setFromObject(node, true);
      if (!nBox.isEmpty()) gBox.union(nBox);
      return { node, home: node.position.clone(), dirLocal };
    });

    const gSize = gBox.isEmpty() ? new THREE.Vector3() : gBox.getSize(new THREE.Vector3());
    const gCenter = gBox.isEmpty() ? center.clone() : gBox.getCenter(new THREE.Vector3());

    // Callouts: the fresh pipeline keys them by manifest name; the file on disk
    // still keys them by the legacy node names, so merged groups pool theirs.
    const overrides = [];
    for (const { name } of nodes) {
      const hit = calloutOverrides && calloutOverrides[name];
      if (hit) overrides.push(...hit);
    }

    return {
      id: sub.group,
      index: i,
      sub,
      anchor,
      members,
      nodes: members.map((m) => m.node),
      primary: members[0].node,
      dirWorld,
      size: gSize,
      homeCenter: gCenter,
      // filled by measureFraming() once the explosion distance is known
      center: gCenter.clone(),
      materials,
      anchors: pickAnchors(members.map((m) => m.node), members[0].node, root, radius, 4,
        overrides.length ? overrides : null),
      _tint: -1,
    };
  });

  return { root, groups, center, radius, box, size, missing };
}

/**
 * Where every group ends up at full explosion, measured once at install so the
 * per-frame camera only ever lerps precomputed scalars.
 *
 * @param {object} model    prepareModel() result
 * @param {number} distance world units each non-anchor group travels at E = 1
 */
export function measureFraming(model, distance) {
  const exploded = new THREE.Box3();
  const half = new THREE.Vector3();
  for (const g of model.groups) {
    g.center.copy(g.homeCenter).addScaledVector(g.dirWorld, distance);
    half.copy(g.size).multiplyScalar(0.5);
    exploded.expandByPoint(half.clone().negate().add(g.center));
    exploded.expandByPoint(half.clone().add(g.center));
  }
  // main.js turns these boxes into per-bearing framings; the shot extents are
  // bearing-dependent, so they can't be precomputed here.
  model.explodedBox = exploded;
  model.explodedCenter = exploded.getCenter(new THREE.Vector3());
  return model;
}

/** Place one group at explosion amount E (0 = home, 1 = fully separated). */
export function setGroupExplode(group, distance) {
  for (const m of group.members) {
    m.node.position.copy(m.home).addScaledVector(m.dirLocal, distance);
  }
}

/**
 * Clone materials once per (group, source material) pair so opacity and tint
 * changes never bleed into another subsystem that happened to share a material.
 */
function cloneGroupMaterials(node) {
  const cache = new Map();
  const out = [];
  node.traverse((o) => {
    if (!o.material) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = arr.map((m) => {
      let c = cache.get(m);
      if (!c) {
        c = m.clone();
        c.userData = { ...c.userData, isEdge: !!o.userData.isEdge };
        if (!o.userData.isEdge) forceOpaque(c);
        if (c.color) c.userData.baseColor = c.color.clone();
        if (c.emissive) {
          c.userData.baseEmissive = c.emissive.clone();
          c.userData.baseEmissiveIntensity = c.emissiveIntensity ?? 1;
        }
        // Let the hairline edges sit cleanly on top of the surfaces.
        if (!o.userData.isEdge && 'polygonOffset' in c) {
          c.polygonOffset = true;
          c.polygonOffsetFactor = 1;
          c.polygonOffsetUnits = 1;
        }
        cache.set(m, c);
        out.push(c);
      }
      return c;
    });
    o.material = Array.isArray(o.material) ? cloned : cloned[0];
  });
  return out;
}

/**
 * Choose 2–4 labelled anchor points inside a group. Explicit `userData.anchor`
 * wins (the proxy uses it); otherwise the biggest, best-named, best-spread
 * descendants are taken so a real CAD tree needs no per-model tuning.
 *
 * The anchor is stored local to the group's *primary* node. Every node in a
 * group carries the same explosion offset, so one reference frame is enough:
 * the anchor rides the explosion out and back with no per-frame bookkeeping.
 *
 * @param {Array}  nodes    every scene node this group drives
 * @param {Object} refNode  the frame anchors are stored in (nodes[0])
 * @param {Object} root     model root — callout overrides are in its space
 */
function pickAnchors(nodes, refNode, root, radius, max = 4, override = null) {
  refNode.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(refNode.matrixWorld).invert();

  // An explicit models/callouts.json wins outright. Positions are authored in
  // the model's own space, so they go through the root before the ref frame —
  // that keeps them honest if the Z-up correction rotated the root.
  if (override && override.length) {
    const toRef = new THREE.Matrix4().multiplyMatrices(inv, root.matrixWorld);
    return override.slice(0, max).map((a) => ({
      label: cleanPartName(a.label),
      local: new THREE.Vector3().fromArray(a.position || [0, 0, 0]).applyMatrix4(toRef),
      node: refNode,
    }));
  }

  // Cheap name pass first — measuring a node walks its whole subtree, so only
  // measure the ones that could actually win.
  const MAX_DEPTH = 3;
  const MAX_CANDIDATES = 80;
  const named = [];
  const unnamed = [];

  for (const groupNode of nodes) {
    groupNode.traverse((o) => {
      if (o === groupNode || o.userData.isEdge || o.name === '__edges') return;
      if (!o.isMesh && !(o.isGroup && o.children.length)) return;
      const depth = nodeDepth(o, groupNode);
      if (depth > MAX_DEPTH) return;
      const bucket = isJunkName(o.name) ? unnamed : named;
      if (bucket.length < MAX_CANDIDATES) bucket.push({ node: o, depth });
    });
  }

  const explicit = named.filter((c) => c.node.userData.anchor);
  // Optimised exports can strip every real name; then we draw balloons, not lies.
  const pool = explicit.length ? explicit : named.length ? named : unnamed;
  const labelled = pool !== unnamed;
  if (!pool.length) return [];

  const tmpBox = new THREE.Box3();
  const measured = [];
  for (const c of pool) {
    tmpBox.setFromObject(c.node);
    if (tmpBox.isEmpty()) continue;
    measured.push({
      ...c,
      world: tmpBox.getCenter(new THREE.Vector3()),
      span: tmpBox.getSize(new THREE.Vector3()).length(),
      label: labelled ? cleanPartName(c.node.name) : null,
    });
  }
  if (!measured.length) return [];

  // Prefer shallow, large parts.
  measured.sort((a, b) => b.span / (1 + b.depth * 0.35) - a.span / (1 + a.depth * 0.35));

  const minSep = radius * 0.13;
  const seenLabel = new Set();
  const picked = [];
  for (const c of measured) {
    if (picked.length >= max) break;
    if (c.label) {
      const base = c.label.replace(/\s+[A-Z]?\d*$/, '');
      if (seenLabel.has(base)) continue;
      seenLabel.add(base);
    }
    if (picked.some((p) => p.world.distanceTo(c.world) < minSep)) continue;
    picked.push(c);
  }
  // Relax the spacing rule rather than ship a lone callout.
  for (const c of measured) {
    if (picked.length >= 2) break;
    if (!picked.includes(c)) picked.push(c);
  }

  return picked
    .sort((a, b) => b.world.y - a.world.y)
    .map((c) => ({
      label: c.label ? c.label.replace(/\s+[A-Z]?\d+$/, '') : null,
      local: c.world.clone().applyMatrix4(inv),
      node: refNode,
    }));
}

function nodeDepth(node, stopAt) {
  let d = 0;
  let p = node.parent;
  while (p && p !== stopAt && d < 32) { d++; p = p.parent; }
  return d;
}

/* ========================== per-frame group state ========================== */

const _tmpColor = new THREE.Color();
const _violet = new THREE.Color(VIOLET);
const _ghost = new THREE.Color(0xf3f3f3); // near-paper: dimmed parts read as a CAD ghost

/**
 * Per-stop focus treatment for a group's cloned materials.
 *
 * `tint` puts a whisper of violet in the emissive term of the group being
 * explained. `dim` fades everything ELSE toward paper — a plain color lerp on
 * fully opaque materials, so the old ghosted look is back with none of the
 * transparent-sort cost that got the alpha version deleted.
 */
export function applyGroupState(group, tint, dim = 0) {
  if (Math.abs(tint - group._tint) < 0.006 && Math.abs(dim - (group._dim ?? -1)) < 0.006) {
    return false;
  }
  group._tint = tint;
  group._dim = dim;

  for (const m of group.materials) {
    if (m.userData.isEdge) continue;
    if (m.color && m.userData.baseColor) {
      m.color.copy(_tmpColor.copy(m.userData.baseColor).lerp(_ghost, dim));
    }
    if (m.emissive && m.userData.baseEmissive) {
      m.emissive.copy(_tmpColor.copy(m.userData.baseEmissive).lerp(_violet, tint));
    }
  }
  return true;
}

export function disposeRoot(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        m[k]?.dispose?.();
      }
      m.dispose?.();
    }
  });
}
