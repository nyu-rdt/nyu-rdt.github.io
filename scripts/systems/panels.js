/**
 * panels.js — the per-phase side panel and the scroll-track chrome.
 *
 * One panel container is reused across every phase; contents are rebuilt only
 * when the phase index actually changes, never per frame.
 *
 * People come from scripts/lead_info.json, filtered by `competency` against the
 * subsystem's `teams`. Names in that file are placeholders and personal links
 * are stripped — nobody on the page is identifiable, and a shared line-art
 * avatar stands in for every person.
 */

/* ------------------------------- helpers ---------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const fullName = (p) => `${p.first_name} ${p.last_name}`.trim();

/** The one shared person mark, defined as <symbol id="icon-person"> in index.html. */
const AVATAR =
  '<svg class="sys-person__avatar" aria-hidden="true" focusable="false" viewBox="0 0 32 32">' +
  '<use href="#icon-person"></use></svg>';

/** A member with an explicit `photo` path renders it; everyone else gets the mark. */
const figureFor = (p) =>
  p.photo
    ? `<img class="sys-person__photo" src="${esc(p.photo)}" alt="" loading="lazy" decoding="async">`
    : AVATAR;

/**
 * People whose competency is in `teams`, ordered by the team order given.
 *
 * Deduped by object identity, NOT by name: the roster is anonymized to a short
 * cycle of placeholder names, so a name-keyed set would collapse two dozen
 * distinct people into four rows.
 */
export function peopleFor(leads, teams) {
  if (!Array.isArray(leads) || !Array.isArray(teams)) return [];
  const want = new Set(teams);
  const seen = new Set();
  const out = [];
  for (const team of teams) {
    for (const p of leads) {
      if (p.competency !== team || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  // Anything matching that somehow slipped the ordered pass.
  for (const p of leads) {
    if (!want.has(p.competency) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function personHtml(p) {
  const grad = p.graduation_year ? ` &rsquo;${String(p.graduation_year).slice(-2)}` : '';

  return `<li class="sys-person">
    <span class="sys-person__fig">${figureFor(p)}</span>
    <span class="sys-person__body">
      <span class="sys-person__name">${esc(fullName(p))}</span>
      <span class="sys-person__pos">${esc(p.position || '')}</span>
      <span class="sys-person__major">${esc(p.major || '')}${grad}</span>
    </span>
  </li>`;
}

/* -------------------------------- panel ----------------------------------- */

export function createPanel(el, { leads, timeline }) {
  let currentIndex = -1;

  function render(phaseIndex) {
    if (phaseIndex === currentIndex) return;
    currentIndex = phaseIndex;

    const phase = timeline.phases[phaseIndex];
    // Intro and the explosion itself carry no roster — the model is the subject.
    if (!phase || phase.kind === 'intro' || phase.kind === 'explosion') {
      if (el.innerHTML !== '') el.innerHTML = '';
      el.dataset.empty = 'true';
      el.classList.remove('is-closing');
      return;
    }

    const isClosing = phase.kind === 'closing';
    el.classList.toggle('is-closing', isClosing);
    el.dataset.empty = 'false';

    const teams = (phase.sub && phase.sub.teams) || [];
    const people = peopleFor(leads, teams);

    // Lead with the people whose role names this subsystem (the Locomotion
    // stop opens on the Locomotion Lead), then systems engineers, then the
    // rest in team order. Stable sort keeps ties in roster order.
    if (!isClosing && phase.title) {
      const kw = phase.title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
      const score = (p) => {
        const pos = String(p.position || '').toLowerCase();
        if (kw.some((w) => pos.includes(w))) return 0;
        if (pos.includes('systems engineer')) return 1;
        return 2;
      };
      people.sort((a, b) => score(a) - score(b));
    }
    const total = timeline.subsystemCount;
    const no = isClosing
      ? 'Closing'
      : `${String(phase.subsystemIndex + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;

    el.innerHTML = `
      <p class="sys-panel__no">${esc(no)}</p>
      <h2 class="sys-panel__title">${esc(phase.title)}</h2>
      <div class="sys-panel__rule" aria-hidden="true"></div>
      <p class="sys-panel__role">${esc(phase.role || '')}</p>
      ${teams.length ? `<p class="sys-panel__teams">${teams.map(esc).join(' &nbsp;·&nbsp; ')}</p>` : ''}
      ${people.length ? `<ul class="sys-panel__people">${people.map(personHtml).join('')}</ul>` : ''}
    `;
    el.scrollTop = 0;
  }

  return { render, get index() { return currentIndex; } };
}

/* ------------------------------- sections --------------------------------- */

/**
 * Build the scroll-track sections and the phase index rail from the timeline so
 * the keyboard/AT route always matches the manifest, however many subsystems it
 * grows to. index.html ships a hand-written copy of the same list for the no-JS
 * case; this replaces it once the timeline knows what the scene really has.
 */
export function renderTimelineChrome({ sectionsEl, railEl, timeline }) {
  if (sectionsEl) {
    sectionsEl.innerHTML = timeline.phases
      .map(
        (p) => `<section id="${esc(p.section)}" tabindex="-1" data-phase="${p.index}"
                  style="height:${(p.span * 100).toFixed(4)}%">
          <h2>${esc(p.title)}</h2>
          <p>${esc(p.role || '')}</p>
        </section>`
      )
      .join('');
  }

  if (railEl) {
    railEl.innerHTML = `<ol>${timeline.phases
      .map(
        (p) => `<li><a href="#${esc(p.section)}" data-phase="${p.index}">
          <b>${String(p.index + 1).padStart(2, '0')}</b><span>${esc(p.short)}</span></a></li>`
      )
      .join('')}</ol>`;
  }
}
