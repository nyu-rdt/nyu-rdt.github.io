/**
 * scrollEngine.js — the timeline.
 *
 * Owns two things:
 *   1. The phase map, built from models/subsystems.json at runtime. The
 *      subsystem count is contractually allowed to change, so nothing here
 *      hardcodes it.
 *   2. Turning window.scrollY into a smoothed scrub value.
 *
 * REV 3 shape — one explosion, then a camera tour:
 *
 *   intro       assembled, title                      E = 0
 *   explosion   ALL groups separate at once           E: 0 → 1
 *   <group>     one stop per group, camera translates E = 1
 *   …
 *   operations  reassembly + closing panel            E: 1 → 0
 *
 * Everything downstream renders as a pure function of `progress`, so scrubbing
 * backwards reverses perfectly. The only time-dependent term on the page is the
 * intro orbit drift, and that fades to zero before the explosion begins.
 */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Cubic in-out — the workhorse ease for every phase-local ramp. */
export const easeInOut = (t) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Hermite smoothstep between two edges. */
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};

const INTRO_SPAN = 0.10;
const EXPLOSION_SPAN = 0.17;
const CLOSING_SPAN = 0.16;

export const INTRO_INDEX = 0;
export const EXPLOSION_INDEX = 1;

/**
 * Build the phase table: intro, the one-gesture explosion, one camera stop per
 * subsystem in manifest order (the anchor group included — the base deserves
 * its own stop), then reassembly/closing.
 *
 * @param {Array} subsystems the subsystems actually present in the loaded scene,
 *                in manifest order. Groups the manifest declares but the model
 *                does not carry are filtered out by the caller, so a stop is
 *                never built for something the camera cannot frame.
 * @param {object} closing   models/subsystems.json → closing
 */
export function createTimeline(subsystems, closing) {
  const n = Math.max(1, subsystems.length);
  const span = (1 - INTRO_SPAN - EXPLOSION_SPAN - CLOSING_SPAN) / n;

  const phases = [
    {
      id: 'intro',
      kind: 'intro',
      title: 'Assembled view',
      short: 'Assembly',
      sub: null,
      group: null,
      span: INTRO_SPAN,
      role: 'Luna as it rolls into the regolith bin — every subsystem seated in the frame.',
    },
    {
      id: 'explosion',
      kind: 'explosion',
      title: 'Exploded view',
      short: 'Explosion',
      sub: null,
      group: null,
      span: EXPLOSION_SPAN,
      role: 'Every subsystem lifts clear of the rolling base at once — one exploded assembly, held for the rest of the tour.',
    },
    ...subsystems.map((sub) => ({
      id: sub.group,
      kind: 'subsystem',
      title: sub.title,
      short: shortTitle(sub.title),
      sub,
      group: sub.group,
      span,
      role: sub.role,
    })),
    {
      id: 'operations',
      kind: 'closing',
      title: (closing && closing.title) || 'Mission Operations',
      short: 'Operations',
      sub: closing || null,
      group: null,
      span: CLOSING_SPAN,
      role: (closing && closing.role) || '',
    },
  ];

  let acc = 0;
  phases.forEach((p, i) => {
    p.index = i;
    p.section = `phase-${slug(p.id)}`;
    p.start = acc;
    acc += p.span;
    p.end = acc;
    p.subsystemIndex = p.kind === 'subsystem' ? i - 2 : -1;
  });
  phases[phases.length - 1].end = 1; // kill float drift

  const closingIndex = phases.length - 1;

  const phaseIndexAt = (p) => {
    for (let i = closingIndex; i >= 0; i--) if (p >= phases[i].start) return i;
    return 0;
  };

  const phaseLocal = (p, i) => {
    const ph = phases[i];
    return clamp01((p - ph.start) / (ph.end - ph.start));
  };

  /**
   * Continuous phase coordinate — 0 at the start of the intro, 1 at the start
   * of the first subsystem, and so on. Camera keyframes and the per-group
   * attention weights both ride this so they cross phase boundaries smoothly
   * instead of stepping.
   */
  const phaseCoord = (p) => {
    const i = phaseIndexAt(p);
    return i + phaseLocal(p, i);
  };

  return {
    phases,
    closingIndex,
    explosionIndex: EXPLOSION_INDEX,
    subsystemCount: subsystems.length,
    firstSubsystem: EXPLOSION_INDEX + 1,
    lastSubsystem: closingIndex - 1,
    /** Stable identity for "does this timeline still match the scene?" checks. */
    key: subsystems.map((s) => s.group).join('|'),
    phaseIndexAt,
    phaseLocal,
    phaseCoord,
  };
}

/** "Mobility & Drivetrain" → "Mobility" for the narrow index rail. Short titles
 *  ("EE Box", "Locomotion") are already rail-sized and survive whole. */
function shortTitle(title) {
  const full = String(title || '').trim();
  if (full.length <= 11) return full;
  const s = full.split('&')[0].trim();
  return s.split(/\s+/)[0] || full;
}

export function slug(s) {
  return String(s).replace(/^sys_/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/* ---------------------------------------------------------------------------
 * Scrub engine
 * ------------------------------------------------------------------------ */

/**
 * @param {object}   o
 * @param {Element}  o.trackEl        the tall scroll track
 * @param {Function} o.getStickyTop   px offset the sticky stage pins to
 * @param {Function} o.getStageHeight px height of the sticky stage
 * @param {boolean}  o.reduced        prefers-reduced-motion → no smoothing
 * @param {number}   o.factor         lerp factor per frame
 */
export function createScrollEngine({
  trackEl,
  getStickyTop,
  getStageHeight,
  reduced = false,
  factor = 0.1,
}) {
  let start = 0;
  let range = 1;
  let target = 0;
  let current = 0;

  function measure() {
    const docTop = trackEl.getBoundingClientRect().top + window.scrollY;
    start = docTop - getStickyTop();
    range = Math.max(1, trackEl.offsetHeight - getStageHeight());
    readTarget();
  }

  function readTarget() {
    target = clamp01((window.scrollY - start) / range);
    return target;
  }

  /** Advance the smoothed value one frame. Returns true if it moved. */
  function step() {
    readTarget();
    if (reduced) {
      const moved = Math.abs(target - current) > 1e-6;
      current = target;
      return moved;
    }
    const d = target - current;
    if (Math.abs(d) < 1.5e-4) {
      const moved = d !== 0;
      current = target;
      return moved;
    }
    current += d * factor;
    return true;
  }

  /** Jump straight to the scroll position — used on resize and first paint. */
  function snap() {
    readTarget();
    current = target;
  }

  return {
    measure,
    step,
    snap,
    get progress() { return current; },
    get target() { return target; },
    get range() { return range; },
    scrollForProgress: (p) => start + clamp01(p) * range,
  };
}
