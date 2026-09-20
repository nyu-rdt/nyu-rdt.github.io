/**
 * nav.js — shared chrome behaviour.
 *
 * Owns the mobile navigation panel (open/close, aria-expanded, scroll lock,
 * Escape-to-close, focus return) and, on the one-pager, the active-section
 * highlight in both navs. No dependencies.
 */

const toggle = document.querySelector('.nav-toggle');
const panel = document.getElementById('mobile-nav');

/* Fixed masthead: transparent at the very top (over the hero video), solid
   translucent band once scrolled. Passive + change-gated so it costs nothing. */
const header = document.querySelector('.site-header');
if (header) {
  let scrolled = null;
  const paintHeader = () => {
    const s = window.scrollY > 24;
    if (s !== scrolled) {
      scrolled = s;
      header.classList.toggle('is-scrolled', s);
    }
  };
  paintHeader();
  window.addEventListener('scroll', paintHeader, { passive: true });
}

if (toggle && panel) {
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('is-open', open);
    document.body.classList.toggle('is-nav-open', open);

    // Keep the closed panel out of the tab order and the a11y tree.
    if (open) {
      panel.removeAttribute('inert');
    } else {
      panel.setAttribute('inert', '');
    }
  };

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  setOpen(false);

  toggle.addEventListener('click', () => {
    const next = !isOpen();
    setOpen(next);
    if (next) {
      const first = panel.querySelector('a');
      if (first) first.focus();
    }
  });

  // Following a link inside the panel should leave it closed.
  panel.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Growing past the mobile breakpoint must not leave the panel latched open.
  const desktop = window.matchMedia('(min-width: 801px)');
  desktop.addEventListener('change', (event) => {
    if (event.matches && isOpen()) setOpen(false);
  });
}

/* ---------------------------------------------------------------------------
   Active-section highlight (one-pager)

   Each section is observed through a 1px band sitting just under the sticky
   header, so the observer fires exactly when a section boundary crosses that
   line — not on every scroll frame. The callback then picks the section the
   line is actually inside, which stays unambiguous when two sections are in
   view at once. Above the first section (the 3D stage) the HOME link wins.
   ------------------------------------------------------------------------ */

const navLinks = [...document.querySelectorAll('[data-nav-target]')];
const sections = ['team', 'projects', 'news', 'sponsors']
  .map((id) => document.getElementById(id))
  .filter(Boolean);

if (navLinks.length && sections.length && 'IntersectionObserver' in window) {
  const header = document.querySelector('.site-header');
  let observer = null;
  let current = null;

  const lineOffset = () =>
    (header ? header.getBoundingClientRect().height : 0) + 12;

  const activeId = () => {
    const line = lineOffset();
    let id = 'top';
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.top <= line && rect.bottom > line) id = section.id;
    }
    return id;
  };

  const paint = () => {
    const id = activeId();
    if (id === current) return;
    current = id;

    navLinks.forEach((link) => {
      if (link.dataset.navTarget === id) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  };

  const observe = () => {
    if (observer) observer.disconnect();
    const line = lineOffset();
    const below = Math.max(0, window.innerHeight - line - 1);
    observer = new IntersectionObserver(paint, {
      rootMargin: `-${line}px 0px -${below}px 0px`,
      threshold: 0
    });
    sections.forEach((section) => observer.observe(section));
  };

  // Clicking a link should read as active immediately, not after the smooth
  // scroll lands.
  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      const id = link.dataset.navTarget;
      current = id;
      navLinks.forEach((other) => {
        if (other.dataset.navTarget === id) other.setAttribute('aria-current', 'true');
        else other.removeAttribute('aria-current');
      });
    });
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      observe();
      paint();
    }, 150);
  });

  observe();
  paint();
}
