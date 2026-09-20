/**
 * sections.js — one-pager section behaviour.
 *
 * Currently just the #team roster, rendered from scripts/lead_info.json. Folded
 * in from the retired team.js. Two deliberate differences from the old page:
 *
 *   1. No headshot directory. A member renders the shared #icon-person symbol
 *      unless the data carries an explicit `photo` path (leadership opt-in).
 *   2. No personal links. The data carries none, and nothing here would read
 *      them if it did.
 *
 * No dependencies.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Section order + the mono index printed beside each heading. */
const GROUPS = [
  'Faculty',
  'Team Leadership',
  'Project Management',
  'Mechanical Engineering',
  'Electrical Engineering',
  'Software Engineering',
  'Marketing and Public Relations',
  'Outreach',
  'Advisory'
];

const slug = (value) => String(value).trim().replace(/\s+/g, '-').toLowerCase();

/** The line-art person mark, or the member's own photo when the data has one. */
function buildAvatar(person) {
  const figure = document.createElement('div');
  figure.className = 'member__avatar';
  figure.setAttribute('aria-hidden', 'true');

  if (person && person.photo) {
    const img = document.createElement('img');
    img.src = person.photo;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    figure.append(img);
    return figure;
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('focusable', 'false');

  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#icon-person');

  svg.append(use);
  figure.append(svg);
  return figure;
}

function buildMember(person) {
  const item = document.createElement('li');
  item.className = 'member';

  const role = document.createElement('p');
  role.className = 'label member__role';
  role.textContent = person.position || '';

  const name = document.createElement('h4');
  name.className = 'member__name';
  name.textContent = `${person.first_name || ''} ${person.last_name || ''}`.trim();

  const meta = document.createElement('p');
  meta.className = 'member__meta';
  meta.textContent = [person.major, person.graduation_year]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .join('  ·  ');

  // Always four children, present or empty, so the CSS subgrid keeps every
  // card in a row aligned on the same baselines.
  item.append(buildAvatar(person), role, name, meta);
  return item;
}

function buildGroup(title, people, index) {
  const section = document.createElement('section');
  section.className = 'roster-group';

  const headingId = `group-${slug(title)}`;
  section.setAttribute('aria-labelledby', headingId);

  const head = document.createElement('div');
  head.className = 'doc-head';
  head.innerHTML =
    `<h3 class="doc-head__title" id="${headingId}"></h3>`;
  head.querySelector('.doc-head__title').textContent = title;

  const list = document.createElement('ul');
  list.className = 'roster';
  // Stable partition: systems engineers first, preserving roster order within
  // both groups. A discipline can have systems engineers without lead titles.
  const isSystemsEngineer = (person) => /\bsystems engineer\b/i.test(person.position || '');
  const orderedPeople = [
    ...people.filter(isSystemsEngineer),
    ...people.filter((person) => !isSystemsEngineer(person))
  ];
  orderedPeople.forEach((person) => list.append(buildMember(person)));

  section.append(head, list);
  return section;
}

async function renderRoster() {
  const mount = document.getElementById('roster');
  if (!mount) return;

  let people;
  try {
    const response = await fetch('./scripts/lead_info.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    people = await response.json();
  } catch (error) {
    mount.innerHTML =
      '<p class="roster__error">The roster could not be loaded. Please refresh, ' +
      'or email <a class="link" href="mailto:eng-rdt@nyu.edu">eng-rdt@nyu.edu</a>.';
    console.error('sections.js — roster fetch failed:', error);
    return;
  }

  const byGroup = new Map();
  people.forEach((person) => {
    const key = person.competency;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(person);
  });

  // Known groups first, in order; anything unexpected is appended, never dropped.
  const ordered = GROUPS.filter((name) => byGroup.has(name)).concat(
    [...byGroup.keys()].filter((name) => !GROUPS.includes(name))
  );

  const fragment = document.createDocumentFragment();
  ordered.forEach((name, position) => {
    fragment.append(buildGroup(name, byGroup.get(name), position + 1));
  });

  mount.replaceChildren(fragment);
}

renderRoster();
