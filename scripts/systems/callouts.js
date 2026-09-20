/**
 * callouts.js — live engineering-drawing leader lines.
 *
 * Each frame, the active subsystem's anchor points are projected from 3D into
 * screen space and drawn as: a dot on the part, a thin elbow polyline out to a
 * label gutter, and a monospace part name. The polyline literally draws itself
 * as the phase enters (normalized stroke-dashoffset), staggered per line, and
 * un-draws on the way out — all a pure function of phase-local progress, so
 * scrubbing backwards reverses it exactly.
 *
 * Anchors that project behind the camera or off-screen are skipped for that
 * frame rather than clamped, which keeps the drawing honest.
 */

import * as THREE from 'three';
import { clamp01, smoothstep } from './scrollEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_LINES = 4;

const CHAR_W = 6.55;   // fallback advance width, 11px mono at 0.13em tracking
const LABEL_PAD = 10;  // gap between label text and the start of the leader
// Minimum vertical separation between label rows. A row stacks an index number
// above the label and a rule under it, so anything tighter than this and the
// next row's "02" lands on the previous row's text.
const ROW_H = 34;

/** Real text width, cached per string — the estimate is only a pre-font-load fallback. */
const _widths = new Map();
function measure(textEl, text) {
  const hit = _widths.get(text);
  if (hit !== undefined) return hit;
  let w = 0;
  try { w = textEl.getComputedTextLength(); } catch { /* not laid out yet */ }
  if (!w) return Math.max(28, text.length * CHAR_W); // don't cache a bad read
  _widths.set(text, w);
  return w;
}

export function createCallouts(svgEl) {
  const rows = [];
  for (let i = 0; i < MAX_LINES; i++) rows.push(makeRow(svgEl));

  const v = new THREE.Vector3();

  /**
   * @param {object}  o
   * @param {Array}   o.anchors  [{label, local, node}]
   * @param {THREE.Camera} o.camera
   * @param {number}  o.width    css px
   * @param {number}  o.height   css px
   * @param {number}  o.local    0→1 progress within the active phase
   * @param {number}  o.gutter   x of the label column
   * @param {boolean} o.reduced  prefers-reduced-motion → no draw-on stagger
   * @param {number}  [o.bottomInset] px at the bottom the label column must
   *                  stay clear of (the mobile bottom-sheet panel)
   */
  function update({ anchors, camera, width, height, local, gutter, reduced, bottomInset = 0 }) {
    const list = (anchors || []).slice(0, MAX_LINES);

    // 1. Project. The matrices are already current — the renderer walked the
    //    graph for this frame before the overlay runs, and re-walking a group
    //    subtree per anchor was pure per-frame waste.
    const pts = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      v.copy(a.local).applyMatrix4(a.node.matrixWorld).project(camera);
      if (v.z > 1 || v.z < -1) continue;                       // behind camera / clipped
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      const margin = 14;
      if (x < margin || x > width - margin || y < margin || y > height - margin) continue;
      pts.push({ i, x, y, label: list[i].label });
    }

    // 2. Lay the labels out down the gutter, in anchor order, no overlaps.
    pts.sort((a, b) => a.y - b.y);
    const top = Math.max(96, height * 0.16);
    const bottom = height - Math.max(84, height * 0.14) - bottomInset;
    let cursor = top;
    for (const p of pts) {
      p.ly = Math.min(Math.max(p.y, cursor), Math.max(bottom, cursor));
      cursor = p.ly + ROW_H;
    }
    // If we overflowed the bottom, slide the whole column back up.
    const overflow = cursor - ROW_H - bottom;
    if (overflow > 0) for (const p of pts) p.ly -= overflow;

    // 3. Draw.
    const used = new Set();
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const row = rows[k];
      used.add(k);

      // Stagger: line k starts drawing a beat after line k-1, and the whole set
      // retracts near the end of the phase.
      const t0 = 0.06 + k * 0.075;
      const inA = reduced ? (local > t0 ? 1 : 0) : smoothstep(t0, t0 + 0.20, local);
      const outA = reduced ? (local > 0.95 ? 0 : 1) : 1 - smoothstep(0.88, 0.99, local);
      const a = clamp01(inA * outA);

      if (a <= 0.001) { hide(row); continue; }

      // Unnamed parts (an optimised export can strip every CAD name) get a
      // numbered drafting balloon keyed to the parts list further down the page,
      // rather than a label we would have to invent.
      const text = p.label;
      const balloon = !text;
      // Measure for real once per string — an estimate lets the leader start
      // inside the last character, which looks like a mistake.
      if (!balloon && row.label.textContent !== text) row.label.textContent = text;
      const textW = balloon ? 22 : measure(row.label, text);
      const lx = gutter;
      const startX = lx + textW + LABEL_PAD;

      // Elbow: horizontal run out of the label, then a diagonal to the part.
      const dx = p.x - startX;
      const run = Math.max(16, Math.min(Math.abs(dx) * 0.42, 108));
      const kneeX = startX + Math.sign(dx || 1) * run;
      const d = `M ${startX.toFixed(1)} ${p.ly.toFixed(1)} L ${kneeX.toFixed(1)} ${p.ly.toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;

      if (row.g.style.display !== '') row.g.style.display = '';
      attr(row.line, 'd', d);
      attr(row.line, 'stroke-dashoffset', (1 - a).toFixed(3));
      attr(row.line, 'opacity', a > 0.02 ? '1' : '0');

      const px = p.x.toFixed(1);
      const py = p.y.toFixed(1);
      attr(row.dot, 'cx', px);
      attr(row.dot, 'cy', py);
      attr(row.dot, 'r', (1.9 * a).toFixed(2));

      attr(row.ring, 'cx', px);
      attr(row.ring, 'cy', py);
      attr(row.ring, 'r', (6.5 * a).toFixed(2));
      attr(row.ring, 'opacity', (0.32 * a).toFixed(3));

      const textA = smoothstep(0.3, 0.85, a);

      if (balloon) {
        attr(row.balloon, 'cx', (lx + 11).toFixed(1));
        attr(row.balloon, 'cy', p.ly.toFixed(1));
        attr(row.balloon, 'r', '11');
        attr(row.balloon, 'opacity', textA.toFixed(3));
        attr(row.index, 'x', (lx + 11).toFixed(1));
        attr(row.index, 'y', (p.ly + 3.5).toFixed(1));
        attr(row.index, 'text-anchor', 'middle');
        attr(row.label, 'opacity', '0');
        attr(row.rule, 'opacity', '0');
      } else {
        attr(row.balloon, 'opacity', '0');
        attr(row.index, 'x', lx.toFixed(1));
        attr(row.index, 'y', (p.ly - 9).toFixed(1));
        attr(row.index, 'text-anchor', 'start');

        attr(row.label, 'x', lx.toFixed(1));
        attr(row.label, 'y', (p.ly + 4).toFixed(1));
        attr(row.label, 'opacity', textA.toFixed(3));

        attr(row.rule, 'x1', lx.toFixed(1));
        attr(row.rule, 'x2', (lx + textW).toFixed(1));
        attr(row.rule, 'y1', (p.ly + 9).toFixed(1));
        attr(row.rule, 'y2', (p.ly + 9).toFixed(1));
        attr(row.rule, 'opacity', (0.28 * smoothstep(0.4, 0.9, a)).toFixed(3));
      }

      const no = String(k + 1).padStart(2, '0');
      if (row.index.textContent !== no) row.index.textContent = no;
      attr(row.index, 'opacity', smoothstep(0.35, 0.8, a).toFixed(3));
    }

    for (let k = 0; k < rows.length; k++) if (!used.has(k)) hide(rows[k]);
  }

  function clear() { rows.forEach(hide); }

  return { update, clear };
}

function makeRow(svg) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.style.display = 'none';

  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'co-line');
  // pathLength normalizes the dash maths — one unit of dash for any length.
  line.setAttribute('pathLength', '1');
  line.setAttribute('stroke-dasharray', '1 1');

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('class', 'co-ring');

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'co-dot');

  const balloon = document.createElementNS(SVG_NS, 'circle');
  balloon.setAttribute('class', 'co-balloon');
  balloon.setAttribute('opacity', '0');

  const index = document.createElementNS(SVG_NS, 'text');
  index.setAttribute('class', 'co-index');

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'co-label');

  const rule = document.createElementNS(SVG_NS, 'line');
  rule.setAttribute('class', 'co-rule');

  g.append(line, ring, dot, rule, balloon, index, label);
  svg.appendChild(g);
  return { g, line, ring, dot, index, label, rule, balloon };
}

function hide(row) {
  if (row.g.style.display !== 'none') row.g.style.display = 'none';
}

/**
 * setAttribute is a parse + invalidate even when the value is unchanged, and the
 * overlay rewrites ~28 attributes per frame while scrubbing. Values are already
 * fixed-precision strings, so a last-write cache on the element skips almost all
 * of them once a leader line has settled.
 */
function attr(el, name, value) {
  const cache = el.__lastAttr || (el.__lastAttr = Object.create(null));
  if (cache[name] === value) return;
  cache[name] = value;
  el.setAttribute(name, value);
}
