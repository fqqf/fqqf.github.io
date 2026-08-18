const worksContainer = document.getElementById('works');
const selected = new Set();
const VIDEO_PATTERN = /\.(mp4|webm|ogg|mov|m4v)$/i;

function createVisual(source, { alt = '', controls = false, autoplay = false } = {}) {
  const visual = document.createElement(VIDEO_PATTERN.test(source) ? 'video' : 'img');
  visual.src = source;
  if (visual instanceof HTMLVideoElement) {
    visual.controls = controls;
    visual.autoplay = autoplay;
    visual.loop = !controls;
    visual.muted = !controls;
    visual.playsInline = true;
    visual.preload = 'metadata';
  } else {
    visual.alt = alt;
    visual.loading = 'lazy';
  }
  return visual;
}

function createThumbnail(source, className) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.setAttribute('aria-label', 'Open media');
  const visual = createVisual(source);
  visual.removeAttribute('loading');
  visual.tabIndex = -1;
  button.appendChild(visual);
  return button;
}

function createMedia(item) {
  const media = document.createElement('div');
  media.className = 'media';
  const base = createVisual(item.preview, { alt: item.title || '', autoplay: true });
  base.className = 'is-active';
  media.appendChild(base);
  const sources = Array.isArray(item.media) ? item.media : [];
  let index = 0;
  let timer;
  let active = base;
  const display = source => {
    const next = createVisual(source, { autoplay: true });
    media.appendChild(next);
    requestAnimationFrame(() => next.classList.add('is-active'));
    active.classList.remove('is-active');
    if (active !== base) active.remove();
    active = next;
  };
  const show = () => {
    display(sources[index]);
    index = (index + 1) % sources.length;
  };
  const reset = () => {
    clearInterval(timer);
    timer = undefined;
    index = 0;
    if (active !== base) active.remove();
    active = base;
    base.classList.add('is-active');
    if (base instanceof HTMLVideoElement) base.play().catch(() => {});
  };
  media.showTemporary = source => {
    clearInterval(timer);
    timer = undefined;
    display(source);
  };
  media.restorePreview = reset;
  if (sources.length) {
    media.addEventListener('mouseenter', () => {
      if (!timer) {
        show();
        timer = setInterval(show, 1200);
      }
    });
    media.addEventListener('mouseleave', reset);
  }
  return media;
}

function renderRichText(container, text) {
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  text.split(urlPattern).forEach(part => {
    if (urlPattern.test(part)) {
      const link = document.createElement('a');
      link.href = part;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = part;
      container.appendChild(link);
    } else {
      container.appendChild(document.createTextNode(part));
    }
    urlPattern.lastIndex = 0;
  });
}

function createViewer() {
  const modal = document.createElement('div');
  modal.className = 'gallery-modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="gallery-backdrop" data-gallery-close></div>
    <section class="gallery-dialog" role="dialog" aria-modal="true" aria-label="Archive item">
      <header class="gallery-header">
        <div>
          <div class="gallery-kicker">Archive item</div>
          <h2 id="gallery-viewer-title"></h2>
        </div>
        <div class="gallery-header-actions">
          <span class="gallery-counter" aria-live="polite"></span>
          <button class="gallery-close" type="button" data-gallery-close aria-label="Close gallery">&times;</button>
        </div>
      </header>
      <div class="gallery-stage"></div>
      <div class="gallery-long-description"></div>
      <div class="gallery-controls">
        <button type="button" data-gallery-previous aria-label="Previous media">Previous</button>
        <div class="gallery-thumbnails" aria-label="Item media"></div>
        <button type="button" data-gallery-next aria-label="Next media">Next</button>
      </div>
    </section>`;
  document.body.appendChild(modal);

  const stage = modal.querySelector('.gallery-stage');
  const title = modal.querySelector('h2');
  const longDescription = modal.querySelector('.gallery-long-description');
  const counter = modal.querySelector('.gallery-counter');
  const controls = modal.querySelector('.gallery-controls');
  const thumbnails = modal.querySelector('.gallery-thumbnails');
  let sources = [];
  let position = 0;
  let returnFocus = null;

  const show = nextPosition => {
    position = (nextPosition + sources.length) % sources.length;
    const visual = createVisual(sources[position], { alt: title.textContent, controls: true, autoplay: true });
    visual.className = 'gallery-visual';
    stage.replaceChildren(visual);
    counter.textContent = `${position + 1} / ${sources.length}`;
    [...thumbnails.children].forEach((thumbnail, index) => thumbnail.classList.toggle('is-active', index === position));
    thumbnails.children[position]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (visual instanceof HTMLVideoElement) visual.play().catch(() => {});
  };
  const close = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('gallery-modal-open');
    stage.replaceChildren();
    returnFocus?.focus();
  };
  const open = (item, trigger, initialPosition = 0) => {
    const itemMedia = Array.isArray(item.media) ? item.media : [];
    sources = item.hidePreview ? itemMedia : [item.preview, ...itemMedia];
    if (!sources.length) return;
    returnFocus = trigger;
    title.textContent = item.title || '';
    title.hidden = !item.title;
    longDescription.replaceChildren();
    if (item.longDescription) renderRichText(longDescription, item.longDescription);
    longDescription.hidden = !item.longDescription;
    thumbnails.replaceChildren(...sources.map((source, index) => {
      const thumbnail = createThumbnail(source, 'gallery-thumbnail');
      thumbnail.setAttribute('aria-label', `Open media ${index + 1}`);
      thumbnail.addEventListener('click', () => show(index));
      return thumbnail;
    }));
    controls.classList.toggle('is-single', sources.length === 1);
    show(initialPosition);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('gallery-modal-open');
    modal.querySelector('.gallery-close').focus();
  };

  modal.querySelectorAll('[data-gallery-close]').forEach(button => button.addEventListener('click', close));
  modal.querySelector('[data-gallery-previous]').addEventListener('click', () => show(position - 1));
  modal.querySelector('[data-gallery-next]').addEventListener('click', () => show(position + 1));
  document.addEventListener('keydown', event => {
    if (!modal.classList.contains('is-open')) return;
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft' && sources.length > 1) show(position - 1);
    if (event.key === 'ArrowRight' && sources.length > 1) show(position + 1);
  });
  return { open };
}

const viewer = createViewer();

function toggle(tag) {
  if (tag === 'all') selected.clear();
  else if (selected.has(tag)) selected.delete(tag);
  else selected.add(tag);
  update();
}

function renderGallery(items) {
  items.forEach(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const work = document.createElement('figure');
    work.className = 'work';
    work.dataset.tags = tags.join(' ');
    work.tabIndex = 0;
    work.setAttribute('role', 'button');
    work.setAttribute('aria-label', item.title ? `Open ${item.title}` : 'Open archive item');
    const mediaElement = createMedia(item);
    work.appendChild(mediaElement);
    const caption = document.createElement('figcaption');
    caption.className = 'caption';
    const details = document.createElement('div');
    if (item.title) {
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      details.appendChild(title);
    }
    const tagList = document.createElement('div');
    tagList.className = 'tags';
    tags.forEach(value => {
      const tag = document.createElement('button');
      tag.className = 'tag';
      tag.type = 'button';
      tag.dataset.tag = value;
      tag.textContent = value;
      tag.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggle(value);
      });
      tagList.appendChild(tag);
    });
    if (tags.length) details.appendChild(tagList);
    if (details.children.length) caption.appendChild(details);
    if (item.shortDescription) {
      const description = document.createElement('div');
      description.className = 'description';
      description.textContent = item.shortDescription;
      caption.appendChild(description);
    }
    if (caption.children.length) work.appendChild(caption);
    const itemMedia = Array.isArray(item.media) ? item.media : [];
    if (itemMedia.length) {
      const miniGallery = document.createElement('div');
      miniGallery.className = 'item-mini-gallery';
      miniGallery.setAttribute('aria-label', 'Item media previews');
      itemMedia.forEach((source, index) => {
        const thumbnail = createThumbnail(source, 'item-mini-thumbnail');
        thumbnail.setAttribute('aria-label', `Open media ${index + 1}`);
        thumbnail.addEventListener('click', event => {
          event.stopPropagation();
          viewer.open(item, thumbnail, item.hidePreview ? index : index + 1);
        });
        thumbnail.addEventListener('mouseenter', () => mediaElement.showTemporary(source));
        thumbnail.addEventListener('mouseleave', () => mediaElement.restorePreview());
        miniGallery.appendChild(thumbnail);
      });
      work.appendChild(miniGallery);
    }
    work.addEventListener('click', () => viewer.open(item, work));
    work.addEventListener('keydown', event => {
      if (event.target === work && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        viewer.open(item, work);
      }
    });
    worksContainer.appendChild(work);
  });
}

function renderFilters(items) {
  const container = document.querySelector('.filters');
  const tags = [...new Set(items.flatMap(item => Array.isArray(item.tags) ? item.tags : []))];
  tags.forEach(value => {
    const filter = document.createElement('button');
    filter.className = 'filter';
    filter.type = 'button';
    filter.dataset.filter = value;
    filter.textContent = value;
    container.appendChild(filter);
  });
}

const galleryItems = Array.isArray(window.galleryItems) ? window.galleryItems : [];
renderFilters(galleryItems);
renderGallery(galleryItems);
const filters = [...document.querySelectorAll('.filter')];
const works = [...document.querySelectorAll('.work')];

function syncTags() {
  document.querySelectorAll('.tag').forEach(tag => tag.classList.toggle('active', selected.has(tag.dataset.tag)));
}
function update() {
  works.forEach(work => {
    const tags = work.dataset.tags.split(/\s+/).filter(Boolean);
    work.classList.toggle('is-hidden', selected.size > 0 && !tags.some(tag => selected.has(tag)));
  });
  filters.forEach(filter => filter.classList.toggle(
    'active',
    filter.dataset.filter === 'all' ? !selected.size : selected.has(filter.dataset.filter),
  ));
  syncTags();
}
filters.forEach(filter => filter.addEventListener('click', () => toggle(filter.dataset.filter)));

/* Contact modal */
(() => {
  const modal = document.getElementById('contact-modal');
  const openButton = document.getElementById('contact-open');
  const closeButtons = modal ? modal.querySelectorAll('[data-contact-close]') : [];
  let lastFocusedElement = null;
  if (!modal || !openButton) return;
  const openModal = () => {
    lastFocusedElement = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('contact-modal-open');
    modal.querySelector('.contact-close')?.focus();
  };
  const closeModal = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('contact-modal-open');
    lastFocusedElement?.focus();
  };
  openButton.addEventListener('click', openModal);
  closeButtons.forEach(button => button.addEventListener('click', closeModal));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });
})();
