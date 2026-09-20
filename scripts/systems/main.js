/**
 * main.js — the homepage exploded view.
 *
 * Wiring: manifest + team data → proxy scene → timeline → (async) real model.
 * Every frame is rendered as a pure function of the smoothed scroll progress,
 * so the whole thing scrubs backwards perfectly.
 *
 *   intro       assembled, title, slow orbit drift          E = 0
 *   explosion   ONE gesture: every group lifts clear of     E: 0 → 1
 *               the anchor along its manifest explodeDir
 *   <group>…    one camera stop per group, anchor included. E = 1
 *               Parts hold their exploded positions; the
 *               camera sweeps to a per-part viewing angle
 *               and the other groups fade toward paper —
 *               an opaque color lerp, never transparency.
 *   operations  reassembly + Mission Operations             E: 1 → 0
 *
 * Add ?perf=1 for a frame-time / draw-call / triangle / DPR readout.
 */

import * as THREE from 'three';
import {
  createTimeline, createScrollEngine, clamp, clamp01, lerp, easeInOut, smoothstep,
} from './scrollEngine.js';
import {
  createStage, buildProxy, prepareModel, loadModel, modelExists, measureFraming,
  setGroupExplode, addEdgeOverlay, applyGroupState, disposeRoot, neutralizeMaterials,
} from './scene.js';
import { createCallouts } from './callouts.js';
import { createPanel, renderTimelineChrome } from './panels.js';

const MANIFEST_URL = './models/subsystems.json';
const LEADS_URL = './scripts/lead_info.json';
const CALLOUTS_URL = './models/callouts.json';

/* ---------------------------------- tuning -------------------------------- */

/**
 * How far every non-anchor group travels at full explosion, × model radius.
 * Opened up twice by request: parts must read as fully separated bodies with
 * daylight between them, not a loosened assembly.
 */
const EXPLODE_SCALE = 0.85;
const TINT = 0.13;              // violet emissive on the group being explained
const DIM = 0.78;               // how far inactive groups fade toward paper during a stop
const REASSEMBLE_SPAN = 0.62;   // fraction of the closing phase spent coming home
const TRACK_VH_PER_PHASE = 88;  // → ~616svh at seven phases

/* Camera. The wide shots share one bearing; each tour stop instead gets the
   angle that actually shows its part off — wheel-level for the drivetrain,
   the ladder in profile, down into the bin and the electronics box. Stops are
   still lerped, so the camera sweeps an arc rather than cutting. */
const AZ_BASE = 0.62;
const MIN_DIST_R = 0.86;        // never dolly closer than this × model radius

/** Per-stop viewing angles, keyed by manifest group id. az 0 looks down +Z;
    positive az walks toward +X. Fallback keeps unknown groups presentable. */
const STOP_ANGLES = {
  sys_locomotion: { az: 0.95, el: 0.12 },  // low three-quarter: wheels at eye level
  sys_excavation: { az: 0.14, el: 0.17 },  // near-profile: the whole ladder run
  sys_deposition: { az: 0.42, el: 0.52 },  // high rear quarter: into the bin
  sys_ee_box:     { az: 1.15, el: 0.55 },  // above and beside: down at the lid
};
const STOP_FALLBACK = { az: AZ_BASE, el: 0.3 };

/* -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  scroll: $('sys-scroll'),
  stage: $('sys-stage'),
  canvas: $('sys-canvas'),
  svg: $('sys-callouts'),
  sections: $('sys-sections'),
  rail: $('sys-rail'),
  panel: $('sys-panel'),
  intro: $('sys-intro'),
  hero: $('sys-hero'),
  heroVideo: $('sys-hero-video'),
  progressFill: $('sys-progress-fill'),
  sheet: $('sys-readout-sheet'),
  explode: $('sys-readout-explode'),
  noWebgl: $('sys-nowebgl'),
  header: document.querySelector('.site-header'),
};

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PERF = new URLSearchParams(location.search).get('perf') === '1';

/* ================================= app ==================================== */

const app = {
  stage: null,
  model: null,      // { root, groups, center, radius, explodedCenter, ... }
  manifest: null,
  leads: [],
  timeline: null,
  engine: null,
  callouts: null,
  panel: null,
  camKeys: [],
  size: { w: 1, h: 1 },
  lastProgress: -1,
  needsRender: true,
  running: false,
  activePhase: -1,
  isNarrow: false,
  calloutOverrides: null,
  videoPlaying: false,
};

const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _offset = new THREE.Vector3();

init();

async function init() {
  const [manifest, leads, callouts] = await Promise.all([
    fetchJson(MANIFEST_URL, { subsystems: [], closing: null }),
    fetchJson(LEADS_URL, []),
    // Optional: the pipeline emits this when the optimised export can't keep
    // real node names. Absent is normal, so miss quietly.
    fetchJson(CALLOUTS_URL, null, { quiet: true }),
  ]);
  app.manifest = manifest;
  app.leads = leads;
  app.calloutOverrides = callouts;

  try {
    app.stage = createStage(dom.canvas);
  } catch (err) {
    console.warn('[systems] WebGL unavailable — falling back to text.', err);
    dom.body.classList.add('no-webgl');
    if (dom.noWebgl) dom.noWebgl.hidden = false;
    return;
  }

  app.callouts = createCallouts(dom.svg);
  if (PERF) perf.mount();

  // 1. Proxy first: the whole experience works before any model exists. The
  //    timeline is built from whatever groups the scene actually has, so it can
  //    never contain a stop the camera has nothing to frame.
  installRoot(buildProxy(), { edges: true });

  app.engine = createScrollEngine({
    trackEl: dom.scroll,
    getStickyTop: () => headerHeight(),
    getStageHeight: () => dom.stage.getBoundingClientRect().height,
    reduced,
    factor: 0.1,
  });

  bindEvents();
  measure();
  app.engine.snap();
  start();

  window.__sysDebug = {
    get timeline() { return app.timeline; },
    get model() { return app.model; },
    get camera() { return app.stage.camera; },
    get stage() { return app.stage; },
    get keys() { return app.camKeys; },
    get progress() { return app.engine ? app.engine.progress : 0; },
    scrollForProgress: (p) => app.engine.scrollForProgress(p),
    /** Document Y that lands mid-phase — the verification hook. */
    scrollForPhase(i, at = 0.55) {
      const ph = app.timeline.phases[i];
      return ph ? app.engine.scrollForProgress(ph.start + ph.span * at) : 0;
    },
    get perf() { return perf.read(); },
  };

  // 2. Then the real thing, best available first.
  loadBestModel();
}

/* ------------------------------- model ----------------------------------- */

async function loadBestModel() {
  const candidates = ['./models/luna-rover.glb', './models/luna-rover.draft.glb'];
  for (const url of candidates) {
    if (!(await modelExists(url))) continue;
    try {
      const root = await loadModel(url);
      if (installRoot(root, { edges: false, neutralize: true, source: url })) {
        console.info(`[systems] model: ${url}`);
        return;
      }
      disposeRoot(root);
    } catch (err) {
      console.warn(`[systems] failed to load ${url}`, err);
    }
  }
  console.info('[systems] no GLB available — running on the proxy.');
}

/**
 * Swap in a root and rebuild the driveable group contract from it. Returns
 * false (and changes nothing) if the root has none of the manifest groups.
 */
function installRoot(root, { edges = false, neutralize = false, source = 'proxy' } = {}) {
  const subsystems = app.manifest.subsystems || [];
  if (neutralize) neutralizeMaterials(root); // must precede the per-group material clone
  const prepared = prepareModel(root, subsystems, app.calloutOverrides);
  if (!prepared) {
    console.warn(`[systems] ${source}: no sys_* groups found — keeping current scene.`);
    return false;
  }
  if (edges) addEdgeOverlay(root);

  if (app.model) {
    app.stage.scene.remove(app.model.root);
    disposeRoot(app.model.root);
  }

  // Sit the model on the origin so the contact shadow always lands right.
  const before = root.position.clone();
  root.position.sub(new THREE.Vector3(prepared.center.x, prepared.box.min.y, prepared.center.z));
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root, true);
  prepared.center = box.getCenter(new THREE.Vector3());
  prepared.size = box.getSize(new THREE.Vector3());
  prepared.box = box;
  // Group boxes were measured before the root moved; re-seat them on the shift.
  const shift = root.position.clone().sub(before);
  for (const g of prepared.groups) g.homeCenter.add(shift);

  app.stage.scene.add(root);
  app.model = prepared;

  if (prepared.missing.length) {
    console.info(`[systems] ${source}: manifest groups absent from model → ${prepared.missing.join(', ')} (tour stops skipped)`);
  }

  // Everything the camera needs, measured once: where each group ends up at
  // E = 1 and how big a frame it wants. Per-frame work is then pure lerping.
  measureFraming(prepared, prepared.radius * EXPLODE_SCALE);

  // Contact shadow sized to the real footprint.
  const size = box.getSize(new THREE.Vector3());
  app.stage.shadow.position.set(prepared.center.x, box.min.y + prepared.radius * 0.002, prepared.center.z);
  app.stage.shadow.scale.set(size.x * 2.15, size.z * 2.35, 1);

  const r = prepared.radius;
  app.stage.camera.near = Math.max(r * 0.01, 0.001);
  app.stage.camera.far = r * 60;
  app.stage.camera.updateProjectionMatrix();
  app.stage.lights.key.position.set(r * 2.4, r * 3.4, r * 2.0).add(prepared.center);
  app.stage.lights.fill.position.set(-r * 2.6, r * 1.4, -r * 1.8).add(prepared.center);
  app.stage.lights.rim.position.set(-r * 0.4, r * 1.0, -r * 3.0).add(prepared.center);

  syncTimeline(prepared);
  app.camKeys = buildCameraKeys(prepared, app.timeline);

  app.lastProgress = -1; // force a re-render at the current scroll position
  app.needsRender = true;
  return true;
}

/**
 * Build (or rebuild) the timeline from the groups the scene actually carries.
 * A manifest group the model does not ship gets no stop at all, which is the
 * whole 6→4 safety net: the page never frames something that isn't there.
 */
function syncTimeline(model) {
  const present = (app.manifest.subsystems || []).filter((s) =>
    model.groups.some((g) => g.id === s.group)
  );
  const key = present.map((s) => s.group).join('|');
  if (app.timeline && app.timeline.key === key) return;

  app.timeline = createTimeline(present, app.manifest.closing);
  renderTimelineChrome({ sectionsEl: dom.sections, railEl: dom.rail, timeline: app.timeline });
  app.panel = createPanel(dom.panel, { leads: app.leads, timeline: app.timeline });
  writeSubsystemCount(present.length);

  // Track height scales with the phase count so no phase gets squeezed.
  setVar(dom.body, '--sys-track-h', `${TRACK_VH_PER_PHASE * app.timeline.phases.length}svh`);
  app.activePhase = -1;
  if (app.engine) { app.engine.measure(); app.engine.snap(); }
}

/* ------------------------------ camera keys ------------------------------- */

/**
 * One framing per phase. `target` is a world point measured at install; `fitH`
 * and `fitW` are the half-extents the shot must hold. Distance is solved per
 * frame from the live aspect ratio, so the camera never crops on a resize.
 *
 * `pan` is expressed in units of the *visible* half-extent at the target depth,
 * not in model radii — a close-up stop and a wide shot then offset the subject
 * by the same fraction of the frame.
 */
function buildCameraKeys(model, timeline) {
  const exploded = model.explodedBox.getSize(new THREE.Vector3());
  return timeline.phases.map((p) => {
    // Margins are deliberately modest: the pan headroom is solved for above, so
    // this is breathing room around the subject, not a crop guard.
    if (p.kind === 'intro') {
      return key(AZ_BASE, 0.22, model.center, model.size, 1.28, [-0.34, -0.02]);
    }
    if (p.kind === 'explosion') {
      return key(AZ_BASE + 0.05, 0.27, model.explodedCenter, exploded, 1.10, [-0.06, 0]);
    }
    if (p.kind === 'closing') {
      return key(AZ_BASE, 0.26, model.center, model.size, 1.30, [0, -0.03]);
    }
    const g = model.groups.find((x) => x.id === p.group);
    const a = STOP_ANGLES[p.group] || STOP_FALLBACK;
    return key(
      a.az,
      clamp(a.el, 0.06, 0.62),
      g ? g.center : model.explodedCenter,
      g ? g.size : exploded,
      1.22,
      [0.32, 0]
    );
  });

  function key(az, el, target, size, margin, pan) {
    const { fitH, fitW } = projectedExtent(size, az, el);
    return { az, el, target: target.clone(), fitH, fitW, margin, pan };
  }
}

const _vd = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _vu = new THREE.Vector3();

/**
 * Half-extents of an axis-aligned box as the camera at (az, el) actually sees
 * it. max|corner · axis| over the eight corners collapses to the sum of the
 * absolute per-axis projections, so this is exact and costs no loop.
 *
 * Framing off max(x, z) instead — which is what this used to do — understates a
 * box viewed at 35° by ~30%, and the camera dollies in until the nearest
 * neighbouring part fills the shot.
 */
function projectedExtent(size, az, el) {
  _vd.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).negate();
  _vr.crossVectors(_vd, WORLD_UP).normalize();
  _vu.crossVectors(_vr, _vd).normalize();
  const hx = size.x * 0.5;
  const hy = size.y * 0.5;
  const hz = size.z * 0.5;
  return {
    fitW: Math.abs(hx * _vr.x) + Math.abs(hy * _vr.y) + Math.abs(hz * _vr.z),
    fitH: Math.abs(hx * _vu.x) + Math.abs(hy * _vu.y) + Math.abs(hz * _vu.z),
  };
}

/* ------------------------------ per-frame -------------------------------- */

/**
 * The explosion is a single scalar for the whole model: 0 assembled, 1 fully
 * separated. Every group rides the same number, which is what makes it read as
 * one physical gesture instead of six independent animations.
 */
function explodeAmount(p) {
  const { phases, explosionIndex, closingIndex } = app.timeline;
  const ex = phases[explosionIndex];
  const cl = phases[closingIndex];

  if (p <= ex.start) return 0;
  if (p < ex.end) {
    const local = (p - ex.start) / ex.span;
    if (reduced) return local > 0.5 ? 1 : 0;
    return easeInOut(clamp01((local - 0.04) / 0.90));
  }
  if (p < cl.start) return 1;

  const t = clamp01((p - cl.start) / (cl.end - cl.start));
  if (reduced) return t > 0.5 ? 0 : 1;
  return 1 - easeInOut(clamp01(t / REASSEMBLE_SPAN));
}

function renderFrame(p) {
  const { timeline, model, stage } = app;
  if (!model || !timeline) return;

  const kc = timeline.phaseCoord(p);
  const phaseIdx = timeline.phaseIndexAt(p);
  const phase = timeline.phases[phaseIdx];
  const local = timeline.phaseLocal(p, phaseIdx);
  const r = model.radius;
  const E = explodeAmount(p);
  const dist = r * EXPLODE_SCALE * E;

  // Hero crossfade, on the continuous phase coordinate so it reads the same
  // scrubbing either way: the video holds through the intro, the (opaque) canvas
  // fades up over it as the explosion starts, then the drawing sheet arrives.
  const canvasT = smoothstep(0.72, 1.12, kc);
  const heroT = 1 - canvasT;
  const introT = 1 - smoothstep(0.50, 1.00, kc);
  const sheetT = smoothstep(0.86, 1.30, kc);
  applyHero(heroT, canvasT, introT, sheetT);

  // While the video covers the stage there is nothing to see through the canvas,
  // so the whole 3D pass is skipped — the top of the page renders no frames at
  // all until the first scroll.
  if (canvasT <= 0.004) {
    app.callouts.clear();
    writeReadouts(p, timeline, phaseIdx, E, phase, local);
    return;
  }

  // Focus window: 0 outside the tour, 1 while the camera is at the stops. The
  // inactive groups fade toward paper INSIDE it — an opaque color lerp, so the
  // ghosting look is back without a single transparent material.
  const { explosionIndex, closingIndex } = timeline;
  const tourT =
    smoothstep(explosionIndex + 0.72, explosionIndex + 1.08, kc) *
    (1 - smoothstep(closingIndex - 0.18, closingIndex + 0.30, kc));

  for (const g of model.groups) {
    setGroupExplode(g, dist);

    // w: how much this group is "the one being explained" right now.
    const gPhase = timeline.phases.find((ph) => ph.group === g.id);
    const gi = gPhase ? gPhase.index : -99;
    const w = smoothstep(gi - 0.32, gi + 0.16, kc) * (1 - smoothstep(gi + 0.84, gi + 1.28, kc));
    applyGroupState(g, TINT * w, DIM * tourT * (1 - w));
  }
  // No updateMatrixWorld() here: render() walks the graph itself a few lines
  // down, and the callout overlay projects afterwards off those same matrices.

  /* --- camera: dolly + track between two precomputed framings ------------- */
  const keys = app.camKeys;
  const from = keys[Math.max(0, phaseIdx - 1)] || keys[0];
  const to = keys[phaseIdx] || from;

  // The explosion and the reassembly move the camera in lockstep with E, so the
  // pull-back and the parts flying apart are one motion. Everything else
  // arrives in the first half of its phase — the easing the design already had.
  let ct;
  if (phase.kind === 'explosion') ct = E;
  else if (phase.kind === 'closing') ct = 1 - E;
  else if (reduced) ct = local > 0.5 ? 1 : 0;
  else ct = easeInOut(clamp01(local / 0.55));

  const narrow = app.isNarrow;
  const az = lerp(from.az, to.az, ct);
  const el = lerp(from.el, to.el, ct);
  const fitH = lerp(from.fitH, to.fitH, ct);
  const fitW = lerp(from.fitW, to.fitW, ct);
  const margin = lerp(from.margin, to.margin, ct) * (narrow ? 1.14 : 1);
  const panX = lerp(from.pan[0], to.pan[0], ct) * (narrow ? 0 : 1);
  const panY = lerp(from.pan[1], to.pan[1], ct) + (narrow && phase.kind === 'subsystem' ? -0.30 : 0);

  const halfV = (stage.camera.fov * Math.PI) / 360;
  const tanV = Math.tan(halfV);
  const tanH = tanV * stage.camera.aspect;
  // The pan slides the subject off-centre, so the frame has to hold the subject
  // PLUS the pan. Solving distance without this term is what let the deposition
  // bin run off the left edge on desktop and off the top on narrow screens.
  const needH = fitH / Math.max(0.25, 1 - Math.abs(panY));
  const needW = fitW / Math.max(0.25, 1 - Math.abs(panX));
  const d = Math.max(Math.max(needH / tanV, needW / tanH) * margin, r * MIN_DIST_R);

  _camTarget.lerpVectors(from.target, to.target, ct);
  _camPos.set(
    _camTarget.x + Math.cos(el) * Math.sin(az) * d,
    _camTarget.y + Math.sin(el) * d,
    _camTarget.z + Math.cos(el) * Math.cos(az) * d
  );

  // Pan in camera-local space: shift eye and target together so the subject
  // sits off to one side (desktop leaves room for the panel; narrow lifts it
  // above the bottom sheet). Scaled by what is actually visible at this depth.
  _dir.subVectors(_camTarget, _camPos).normalize();
  _right.crossVectors(_dir, WORLD_UP).normalize();
  _up.crossVectors(_right, _dir).normalize();
  _offset.copy(_right).multiplyScalar(panX * d * tanH).addScaledVector(_up, panY * d * tanV);
  _camPos.add(_offset);
  _camTarget.add(_offset);

  stage.camera.position.copy(_camPos);
  stage.camera.lookAt(_camTarget);
  stage.camera.updateMatrixWorld();

  const t0 = PERF ? performance.now() : 0;
  stage.renderer.render(stage.scene, stage.camera);
  perf.sample(stage, PERF ? performance.now() - t0 : 0);

  /* --- overlay: leader lines for the active stop only --------------------- */
  const activeGroup =
    phase.kind === 'subsystem' ? model.groups.find((g) => g.id === phase.group) : null;
  app.callouts.update({
    anchors: activeGroup ? activeGroup.anchors : [],
    camera: stage.camera,
    width: app.size.w,
    height: app.size.h,
    local,
    gutter: narrow ? 18 : 52,
    reduced,
    // keep the label column clear of the mobile bottom-sheet panel
    bottomInset: narrow && activeGroup ? dom.panel.offsetHeight : 0,
  });

  writeReadouts(p, timeline, phaseIdx, E, phase, local);
}

/**
 * Hero ↔ breakdown crossfade. All four values are pure functions of scroll, and
 * the video element is driven off the same numbers: it plays only while it is
 * actually visible, and stops the moment it isn't.
 */
function applyHero(heroT, canvasT, introT, sheetT) {
  setVar(dom.hero, '--sys-hero-t', heroT.toFixed(3));
  setVar(dom.canvas, '--sys-canvas-t', canvasT.toFixed(3));
  setVar(dom.intro, '--sys-intro-t', introT.toFixed(3));
  setVar(dom.stage, '--sys-sheet-t', sheetT.toFixed(3));

  setStyle(dom.intro, 'visibility', introT < 0.005 ? 'hidden' : '');
  setStyle(dom.hero, 'visibility', heroT < 0.004 ? 'hidden' : '');
  // Takes the drawing chrome out of the tab order while it is invisible.
  const heroing = sheetT < 0.02 ? '1' : '0';
  if (dom.stage.dataset.hero !== heroing) dom.stage.dataset.hero = heroing;

  setVideoPlaying(heroT > 0.02 && !document.hidden);
}

/**
 * prefers-reduced-motion never autoplays — the poster frame stands in, which is
 * why the markup carries no `autoplay` attribute.
 */
function setVideoPlaying(want) {
  const v = dom.heroVideo;
  if (!v || reduced) return;
  if (want === app.videoPlaying) return;
  app.videoPlaying = want;
  if (want) v.play().catch(() => { app.videoPlaying = false; });
  else v.pause();
}

function writeReadouts(p, timeline, phaseIdx, E, phase, local) {
  let panelT = 0;
  if (phase.kind === 'subsystem') {
    panelT = smoothstep(0.10, 0.32, local) * (1 - smoothstep(0.88, 0.99, local));
  } else if (phase.kind === 'closing') {
    panelT = smoothstep(0.20, 0.48, local);
  }
  if (reduced) panelT = panelT > 0.5 ? 1 : 0;

  // Scoped to the elements that read them: writing these on <body> made every
  // scrub frame invalidate style for the whole document.
  setVar(dom.panel, '--sys-panel-t', panelT.toFixed(3));
  if (dom.progressFill) dom.progressFill.style.transform = `scaleX(${p.toFixed(4)})`;

  const n = timeline.phases.length;
  if (dom.sheet) {
    const s = `${String(phaseIdx + 1).padStart(2, '0')}/${String(n).padStart(2, '0')}`;
    if (dom.sheet.textContent !== s) dom.sheet.textContent = s;
  }
  if (dom.explode) {
    const s = `${String(Math.round(E * 100)).padStart(3, '0')}%`;
    if (dom.explode.textContent !== s) dom.explode.textContent = s;
  }

  if (phaseIdx !== app.activePhase) {
    app.activePhase = phaseIdx;
    app.panel.render(phaseIdx);
    markRail(phaseIdx);
  }
}

function markRail(idx) {
  if (!dom.rail) return;
  dom.rail.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('is-active', Number(a.dataset.phase) === idx);
  });
}

/* CSS custom properties and inline styles are only touched when they actually
   change — during a scrub these are called 60×/s and every write costs a style
   invalidation on the element's subtree. */
const _varCache = new WeakMap();
function setVar(el, name, value) {
  if (!el) return;
  let m = _varCache.get(el);
  if (!m) { m = new Map(); _varCache.set(el, m); }
  if (m.get(name) === value) return;
  m.set(name, value);
  el.style.setProperty(name, value);
}
function setStyle(el, prop, value) {
  if (el && el.style[prop] !== value) el.style[prop] = value;
}

/* ------------------------------ performance ------------------------------- */

/**
 * Rolling frame cost over *rendered* frames only — idle frames would otherwise
 * average the number down to a comfortable lie. When the page cannot hold 24ms
 * for a sustained second and a half of real rendering, the pixel ratio steps
 * down once and never comes back up in this session.
 */
const perf = (() => {
  const RING = 40;
  const SLOW_MS = 24;
  const SUSTAIN_MS = 1500;
  const STEPS = [1.25, 1.0];

  const ring = new Float32Array(RING);
  let n = 0;
  let idx = 0;
  let sum = 0;
  let last = 0;
  let slowFor = 0;
  let step = 0;
  let calls = 0;
  let tris = 0;
  let drawMs = 0;
  let el = null;
  let lastText = '';
  let nextPaint = 0;

  const avg = () => (n ? sum / n : 0);

  function mount() {
    el = document.createElement('div');
    el.className = 'sys-perf';
    el.id = 'sys-perf';
    el.setAttribute('aria-hidden', 'true');
    // The hero renders no frames at all, so without this the HUD would sit
    // there as an empty box until the first scroll.
    el.textContent = 'idle · 0 frames';
    lastText = el.textContent;
    (dom.stage || document.body).appendChild(el);
  }

  function sample(stage, renderMs) {
    const now = performance.now();
    calls = stage.renderer.info.render.calls;   // reset by the next render()
    tris = stage.renderer.info.render.triangles;
    drawMs += (renderMs - drawMs) * 0.1;        // the CPU half of a frame

    if (last) {
      const dt = Math.min(now - last, 200);
      sum += dt - ring[idx];
      ring[idx] = dt;
      idx = (idx + 1) % RING;
      if (n < RING) n++;

      const a = avg();
      if (n >= 12 && a > SLOW_MS) {
        slowFor += dt;
        if (slowFor > SUSTAIN_MS && step < STEPS.length) {
          const next = STEPS[step++];
          if (stage.setDpr(next)) {
            console.info(`[systems] frame time ${a.toFixed(1)}ms sustained — pixel ratio → ${next}`);
            app.needsRender = true;
          }
          slowFor = 0;
          n = 0; sum = 0; idx = 0; ring.fill(0);
        }
      } else {
        slowFor = 0;
      }
    }
    last = now;

    if (el && now > nextPaint) {
      nextPaint = now + 250;
      const text = `${avg().toFixed(1)}ms · draw ${drawMs.toFixed(1)} · ${calls} calls · ${
        tris > 9999 ? `${Math.round(tris / 1000)}k` : tris
      } tris · dpr ${stage.dpr.toFixed(2)}`;
      if (text !== lastText) { lastText = text; el.textContent = text; }
    }
  }

  /** Machine-readable snapshot for the verification pass. */
  const read = () => ({
    ms: +avg().toFixed(2),
    drawMs: +drawMs.toFixed(2),
    calls,
    triangles: tris,
    dpr: app.stage ? +app.stage.dpr.toFixed(2) : 0,
    frames: n,
  });

  return { mount, sample, read, reset() { n = 0; sum = 0; idx = 0; last = 0; ring.fill(0); } };
})();

/* ------------------------------- loop ------------------------------------ */

function tick() {
  if (!app.running) return;
  requestAnimationFrame(tick);

  const moved = app.engine.step();
  const p = app.engine.progress;

  // Nothing on the page animates under its own steam any more — the hero video
  // composites itself and the 3D is entirely scroll-driven, so a page that is
  // sitting still renders zero frames.
  if (!moved && !app.needsRender && Math.abs(p - app.lastProgress) < 1e-4) return;

  app.needsRender = false;
  app.lastProgress = p;
  renderFrame(p);
}

function start() {
  if (app.running) return;
  app.running = true;
  requestAnimationFrame(tick);
}

function stop() {
  app.running = false;
}

/* ------------------------------ plumbing --------------------------------- */

function headerHeight() {
  return dom.header ? Math.round(dom.header.getBoundingClientRect().height) : 64;
}

function measure() {
  setVar(dom.body, '--sys-header-h', `${headerHeight()}px`);

  const rect = dom.stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const hh = Math.max(1, Math.round(rect.height));
  setVar(dom.body, '--sys-stage-h', `${hh}px`);

  app.size.w = w;
  app.size.h = hh;
  app.isNarrow = w < 900;

  if (app.stage) app.stage.resize(w, hh);
  if (app.engine) app.engine.measure();
  app.needsRender = true;
  app.lastProgress = -1;
}

function bindEvents() {
  let raf = 0;
  const onResize = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      measure();
      app.engine.snap();
    });
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { setVideoPlaying(false); stop(); }
    else { app.needsRender = true; perf.reset(); start(); }
  });

  // Keyboard route: focusing a phase section (via the rail or a hash link)
  // should land on that phase, not just near it.
  if (dom.rail) {
    dom.rail.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-phase]');
      if (!a) return;
      const idx = Number(a.dataset.phase);
      const phase = app.timeline.phases[idx];
      if (!phase) return;
      e.preventDefault();
      const y = app.engine.scrollForProgress(phase.start + phase.span * 0.5);
      window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
      const section = document.getElementById(phase.section);
      if (section) section.focus({ preventScroll: true });
    });
  }

  // Fonts change the header height; re-measure once they land.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { measure(); app.engine.snap(); }).catch(() => {});
  }
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** Keep the prose honest when the manifest gains or loses a subsystem. */
function writeSubsystemCount(n) {
  const word = NUMBER_WORDS[n] || String(n);
  document.querySelectorAll('[data-sys-count]').forEach((el) => {
    const wasCapital = /^[A-Z]/.test(el.textContent.trim());
    el.textContent = wasCapital ? word[0].toUpperCase() + word.slice(1) : word;
  });
}

async function fetchJson(url, fallback, { quiet = false } = {}) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (!quiet) console.warn(`[systems] could not load ${url}`, err);
    return fallback;
  }
}
