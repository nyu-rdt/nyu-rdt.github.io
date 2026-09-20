document.documentElement.dataset.js = '';

// The still loads first. Footage loops continuously when playback is permitted.
// The hero media has no clickable controls or scroll-triggered pausing.
const film = document.querySelector('#hero-video');
if (film) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  let autoplayBlocked = false;
  film.muted = true;

  function syncFilm() {
    const permitted = !reducedMotion.matches && !connection?.saveData;
    if (permitted && !autoplayBlocked) {
      if (!film.hasAttribute('src')) film.src = film.dataset.src;
      film.play().catch(error => {
        if (error.name === 'AbortError') return;
        autoplayBlocked = true;
      });
    } else {
      film.pause();
    }
  }

  film.addEventListener('playing', () => {
    film.parentElement.classList.add('has-frame');
  });
  film.addEventListener('error', () => {
    autoplayBlocked = true;
    film.parentElement.classList.remove('has-frame');
  });
  reducedMotion.addEventListener('change', syncFilm);
  connection?.addEventListener('change', syncFilm);
  document.addEventListener('visibilitychange', syncFilm);
  syncFilm();
}

const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#primary-nav');
if (toggle && nav) {
  toggle.hidden = false;
  const small = matchMedia('(max-width: 520px)');
  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  }
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', event => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  small.addEventListener('change', () => setOpen(false));
}

// Native links work without JavaScript. This only indicates the current section.
const links = [...document.querySelectorAll('#primary-nav [data-nav-target]')];
const sections = links.map(link => document.getElementById(link.dataset.navTarget)).filter(Boolean);
if (sections.length) {
  let queued = false;
  function update() {
    const headerBottom = document.querySelector('.site-header').getBoundingClientRect().bottom + 40;
    const active = sections.find(section => {
      const rect = section.getBoundingClientRect();
      return rect.top <= headerBottom && rect.bottom > headerBottom;
    });
    links.forEach(link => {
      if (link.dataset.navTarget === active?.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    queued = false;
  }
  window.addEventListener('scroll', () => {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  }, {passive: true});
  update();
}

// Keep old incoming links useful after consolidating the homepage.
const oldTargets = {'#news': './news.html', '#sponsors': '#contact', '#breakdown': '#robot'};
if (location.hash.startsWith('#phase-')) location.replace('#robot');
else if (oldTargets[location.hash]) location.replace(oldTargets[location.hash]);
