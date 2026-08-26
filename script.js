const worksContainer = document.getElementById('works');

const selected = new Set();

const VIDEO_PATTERN = /\.(mp4|webm|ogg|mov|m4v)$/i;

const RENDER_BATCH_SIZE = 8;
const VIDEO_PRELOAD_MARGIN = '500px 0px';

/*
 * --------------------------------------------------------------------------
 * Idle scheduling
 * --------------------------------------------------------------------------
 */

const scheduleIdle = window.requestIdleCallback
  ? callback => {
      window.requestIdleCallback(callback, {
        timeout: 500,
      });
    }
  : callback => {
      setTimeout(() => {
        callback({
          timeRemaining: () => 8,
          didTimeout: true,
        });
      }, 1);
    };

/*
 * --------------------------------------------------------------------------
 * Main-page video observer
 * --------------------------------------------------------------------------
 *
 * Only MAIN work-preview videos are registered here.
 *
 * Mini thumbnails are deliberately NOT registered.
 *
 * A main preview:
 *
 *   near viewport -> load
 *   visible       -> play
 *   leaves        -> pause
 *
 * We do NOT remove src when it leaves the viewport.
 */

const lazyVideos = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      const video = entry.target;

      if (entry.isIntersecting) {
        loadVideo(video);

        if (
          video.dataset.playOnVisible === 'true'
        ) {
          playVideo(video);
        }

        return;
      }

      video.pause();
    });
  },
  {
    rootMargin: VIDEO_PRELOAD_MARGIN,
    threshold: 0,
  },
);

function loadVideo(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  if (
    video.hasAttribute('src') ||
    !video.dataset.src
  ) {
    return;
  }

  video.src = video.dataset.src;
  video.load();
}

function playVideo(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  loadVideo(video);

  video.play().catch(() => {});
}

/*
 * --------------------------------------------------------------------------
 * Main visual creation
 * --------------------------------------------------------------------------
 */

function createVisual(
  source,
  {
    alt = '',
    controls = false,
    autoplay = false,
    lazy = !controls,
    poster = '',
  } = {},
) {
  const isVideo = VIDEO_PATTERN.test(source);

  const visual = document.createElement(
    isVideo ? 'video' : 'img',
  );

  if (visual instanceof HTMLVideoElement) {
    visual.controls = controls;

    /*
     * Playback is controlled explicitly by our code.
     */
    visual.autoplay = false;

    visual.loop = !controls;
    visual.muted = !controls;
    visual.playsInline = true;

    visual.preload = lazy
      ? 'none'
      : 'metadata';

    if (
      poster &&
      !VIDEO_PATTERN.test(poster)
    ) {
      visual.poster = poster;
    }

    visual.dataset.playOnVisible =
      String(autoplay);

    if (lazy) {
      visual.dataset.src = source;

      /*
       * IMPORTANT:
       * Only main gallery videos are observed.
       */
      lazyVideos.observe(visual);
    } else {
      visual.src = source;
    }
  } else {
    visual.src = source;
    visual.alt = alt;

    visual.loading = lazy
      ? 'lazy'
      : 'eager';

    visual.decoding = 'async';
  }

  return visual;
}

/*
 * --------------------------------------------------------------------------
 * Mini thumbnails
 * --------------------------------------------------------------------------
 *
 * Video mini thumbnails remain actual <video> elements.
 *
 * But unlike main previews:
 *
 * - they are NOT observed by lazyVideos
 * - they do NOT autoplay
 * - they use metadata preload
 * - they stay paused
 *
 * This lets the browser display the video's first available frame
 * without turning every mini into an actively playing video.
 */

function createThumbnail(
  source,
  className,
  poster = '',
) {
  const button =
    document.createElement('button');

  button.className =
    className;

  button.type =
    'button';

  button.setAttribute(
    'aria-label',
    'Open media',
  );

  let visual;

  if (VIDEO_PATTERN.test(source)) {
    visual =
      document.createElement(
        'video',
      );

    visual.muted = true;
    visual.playsInline = true;
    visual.loop = false;

    /*
     * Metadata is enough for the browser to discover
     * the first frame/dimensions.
     */
    visual.preload = 'metadata';

    /*
     * If a real poster exists, use it immediately.
     */
    if (
      poster &&
      !VIDEO_PATTERN.test(poster)
    ) {
      visual.poster = poster;
    }

    /*
     * IMPORTANT:
     *
     * This is a thumbnail, so it gets its own src.
     * It does NOT use createVisual(), because createVisual()
     * registers videos with the main playback observer.
     */
    visual.src = source;

    /*
     * Explicitly keep it paused.
     */
    visual.pause();
  } else {
    visual =
      document.createElement(
        'img',
      );

    visual.src = source;
    visual.alt = '';
    visual.loading = 'lazy';
    visual.decoding = 'async';
  }

  visual.tabIndex = -1;

  button.appendChild(
    visual,
  );

  return button;
}

/*
 * --------------------------------------------------------------------------
 * Main work media
 * --------------------------------------------------------------------------
 */

function createMedia(item) {
  const media =
    document.createElement('div');

  media.className =
    'media';

  const previewPoster =
    !VIDEO_PATTERN.test(item.preview)
      ? item.preview
      : item.poster || '';

  /*
   * MAIN PREVIEW
   *
   * This remains an animated video when visible.
   */
  const base =
    createVisual(
      item.preview,
      {
        alt:
          item.title || '',
        autoplay: true,
        poster:
          previewPoster,
      },
    );

  base.className =
    'is-active';

  media.appendChild(
    base,
  );

  const sources =
    Array.isArray(item.media)
      ? item.media
      : [];

  let index = 0;
  let timer;
  let active = base;

  /*
   * Cache temporary preview visuals.
   *
   * These are main-preview videos/images, not mini thumbnails.
   */
  const visualCache =
    new Map();

  const getPoster = source => {
    if (!VIDEO_PATTERN.test(source)) {
      return '';
    }

    if (
      item.poster &&
      !VIDEO_PATTERN.test(item.poster)
    ) {
      return item.poster;
    }

    if (
      item.preview &&
      !VIDEO_PATTERN.test(item.preview)
    ) {
      return item.preview;
    }

    return '';
  };

  const getVisual = source => {
    if (
      visualCache.has(source)
    ) {
      return visualCache.get(
        source,
      );
    }

    const visual =
      createVisual(
        source,
        {
          autoplay: true,
          poster:
            getPoster(source),
        },
      );

    visualCache.set(
      source,
      visual,
    );

    return visual;
  };

  const display = source => {
    const next =
      getVisual(source);

    if (
      active === next
    ) {
      if (
        next instanceof HTMLVideoElement
      ) {
        playVideo(next);
      }

      return;
    }

    active.classList.remove(
      'is-active',
    );

    if (
      next.parentNode !== media
    ) {
      media.appendChild(
        next,
      );
    }

    requestAnimationFrame(() => {
      next.classList.add(
        'is-active',
      );
    });

    /*
     * Remove the previous temporary visual.
     *
     * Keep the base preview.
     */
    if (
      active !== base &&
      active.parentNode === media
    ) {
      active.remove();
    }

    active = next;

    if (
      next instanceof HTMLVideoElement
    ) {
      loadVideo(next);
      playVideo(next);
    }
  };

  const show = () => {
    if (!sources.length) {
      return;
    }

    display(
      sources[index],
    );

    index =
      (index + 1) %
      sources.length;
  };

  const reset = () => {
    clearInterval(timer);

    timer = undefined;
    index = 0;

    if (
      active !== base &&
      active.parentNode === media
    ) {
      active.remove();
    }

    active = base;

    base.classList.add(
      'is-active',
    );

    /*
     * Restore the animated base preview.
     */
    if (
      base instanceof HTMLVideoElement
    ) {
      loadVideo(base);
      playVideo(base);
    }
  };

  /*
   * Used by mini-thumbnail hover.
   */
  media.showTemporary =
    source => {
      clearInterval(timer);

      timer = undefined;

      display(source);
    };

  media.restorePreview =
    reset;

  /*
   * Main preview hover slideshow.
   */
  if (sources.length) {
    media.addEventListener(
      'mouseenter',
      () => {
        if (!timer) {
          show();

          timer =
            setInterval(
              show,
              1200,
            );
        }
      },
    );

    media.addEventListener(
      'mouseleave',
      reset,
    );
  }

  return media;
}

/*
 * --------------------------------------------------------------------------
 * Rich text
 * --------------------------------------------------------------------------
 */

function renderRichText(
  container,
  text,
) {
  const urlPattern =
    /(https?:\/\/[^\s]+)/g;

  const urlTestPattern =
    /^https?:\/\/[^\s]+$/;

  text
    .split(urlPattern)
    .forEach(part => {
      if (
        urlTestPattern.test(part)
      ) {
        const link =
          document.createElement(
            'a',
          );

        link.href = part;
        link.target = '_blank';
        link.rel =
          'noopener noreferrer';
        link.textContent =
          part;

        container.appendChild(
          link,
        );
      } else {
        container.appendChild(
          document.createTextNode(
            part,
          ),
        );
      }
    });
}

/*
 * --------------------------------------------------------------------------
 * Gallery viewer
 * --------------------------------------------------------------------------
 */

function createViewer() {
  const modal =
    document.createElement(
      'div',
    );

  modal.className =
    'gallery-modal';

  modal.setAttribute(
    'aria-hidden',
    'true',
  );

  modal.innerHTML = `
    <div
      class="gallery-backdrop"
      data-gallery-close
    ></div>

    <section
      class="gallery-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Archive item"
    >
      <header class="gallery-header">
        <div>
          <div class="gallery-kicker">
            Archive item
          </div>

          <h2 id="gallery-viewer-title"></h2>
        </div>

        <div class="gallery-header-actions">
          <span
            class="gallery-counter"
            aria-live="polite"
          ></span>

          <button
            class="gallery-close"
            type="button"
            data-gallery-close
            aria-label="Close gallery"
          >
            &times;
          </button>
        </div>
      </header>

      <div class="gallery-stage"></div>

      <div class="gallery-long-description"></div>

      <div class="gallery-controls">
        <button
          type="button"
          data-gallery-previous
          aria-label="Previous media"
        >
          Previous
        </button>

        <div
          class="gallery-thumbnails"
          aria-label="Item media"
        ></div>

        <button
          type="button"
          data-gallery-next
          aria-label="Next media"
        >
          Next
        </button>
      </div>
    </section>
  `;

  document.body.appendChild(
    modal,
  );

  const stage =
    modal.querySelector(
      '.gallery-stage',
    );

  const title =
    modal.querySelector('h2');

  const longDescription =
    modal.querySelector(
      '.gallery-long-description',
    );

  const counter =
    modal.querySelector(
      '.gallery-counter',
    );

  const controls =
    modal.querySelector(
      '.gallery-controls',
    );

  const thumbnails =
    modal.querySelector(
      '.gallery-thumbnails',
    );

  let sources = [];
  let position = 0;
  let returnFocus = null;

  const getPoster = source => {
    if (!VIDEO_PATTERN.test(source)) {
      return '';
    }

    const itemPreview =
      sources[0];

    if (
      itemPreview &&
      !VIDEO_PATTERN.test(
        itemPreview,
      )
    ) {
      return itemPreview;
    }

    return '';
  };

  const show = nextPosition => {
    if (!sources.length) {
      return;
    }

    position =
      (
        nextPosition +
        sources.length
      ) %
      sources.length;

    const source =
      sources[position];

    const visual =
      createVisual(
        source,
        {
          alt:
            title.textContent,
          controls: true,
          autoplay: true,
          lazy: false,
          poster:
            getPoster(source),
        },
      );

    visual.className =
      'gallery-visual';

    stage.replaceChildren(
      visual,
    );

    counter.textContent =
      `${position + 1} / ${sources.length}`;

    [...thumbnails.children]
      .forEach(
        (
          thumbnail,
          index,
        ) => {
          thumbnail.classList.toggle(
            'is-active',
            index === position,
          );
        },
      );

    /*
     * Only scroll if selected thumbnail
     * is actually outside the strip.
     */
    const selectedThumbnail =
      thumbnails.children[position];

    if (selectedThumbnail) {
      const stripRect =
        thumbnails.getBoundingClientRect();

      const thumbnailRect =
        selectedThumbnail.getBoundingClientRect();

      const outside =
        thumbnailRect.left <
          stripRect.left ||
        thumbnailRect.right >
          stripRect.right;

      if (outside) {
        selectedThumbnail.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        });
      }
    }

    if (
      visual instanceof HTMLVideoElement
    ) {
      visual.play().catch(
        () => {},
      );
    }
  };

  const close = () => {
    modal.classList.remove(
      'is-open',
    );

    modal.setAttribute(
      'aria-hidden',
      'true',
    );

    document.body.classList.remove(
      'gallery-modal-open',
    );

    /*
     * Remove viewer media completely.
     */
    stage.replaceChildren();

    returnFocus?.focus();
  };

  const open = (
    item,
    trigger,
    initialPosition = 0,
  ) => {
    const itemMedia =
      Array.isArray(item.media)
        ? item.media
        : [];

    sources =
      item.hidePreview
        ? itemMedia
        : [
            item.preview,
            ...itemMedia,
          ];

    if (!sources.length) {
      return;
    }

    returnFocus = trigger;

    title.textContent =
      item.title || '';

    title.hidden =
      !item.title;

    longDescription.replaceChildren();

    if (item.longDescription) {
      renderRichText(
        longDescription,
        item.longDescription,
      );
    }

    longDescription.hidden =
      !item.longDescription;

    /*
     * Viewer thumbnails are lightweight.
     *
     * Video thumbnails remain video elements so they
     * can display their first frame, but they don't autoplay.
     */
    const thumbnailFragment =
      document.createDocumentFragment();

    sources.forEach(
      (
        source,
        index,
      ) => {
        const poster =
          VIDEO_PATTERN.test(source)
            ? (
                item.poster ||
                sources.find(
                  value =>
                    !VIDEO_PATTERN.test(
                      value,
                    ),
                ) ||
                ''
              )
            : '';

        const thumbnail =
          createThumbnail(
            source,
            'gallery-thumbnail',
            poster,
          );

        thumbnail.setAttribute(
          'aria-label',
          `Open media ${index + 1}`,
        );

        thumbnail.addEventListener(
          'click',
          () => {
            show(index);
          },
        );

        thumbnailFragment.appendChild(
          thumbnail,
        );
      },
    );

    thumbnails.replaceChildren(
      thumbnailFragment,
    );

    controls.classList.toggle(
      'is-single',
      sources.length === 1,
    );

    show(initialPosition);

    modal.classList.add(
      'is-open',
    );

    modal.setAttribute(
      'aria-hidden',
      'false',
    );

    document.body.classList.add(
      'gallery-modal-open',
    );

    modal
      .querySelector(
        '.gallery-close',
      )
      .focus();
  };

  modal
    .querySelectorAll(
      '[data-gallery-close]',
    )
    .forEach(
      button => {
        button.addEventListener(
          'click',
          close,
        );
      },
    );

  modal
    .querySelector(
      '[data-gallery-previous]',
    )
    .addEventListener(
      'click',
      () => {
        show(position - 1);
      },
    );

  modal
    .querySelector(
      '[data-gallery-next]',
    )
    .addEventListener(
      'click',
      () => {
        show(position + 1);
      },
    );

  document.addEventListener(
    'keydown',
    event => {
      if (
        !modal.classList.contains(
          'is-open',
        )
      ) {
        return;
      }

      if (event.key === 'Escape') {
        close();
      }

      if (
        event.key === 'ArrowLeft' &&
        sources.length > 1
      ) {
        show(position - 1);
      }

      if (
        event.key === 'ArrowRight' &&
        sources.length > 1
      ) {
        show(position + 1);
      }
    },
  );

  return {
    open,
  };
}

const viewer =
  createViewer();

/*
 * --------------------------------------------------------------------------
 * Filtering
 * --------------------------------------------------------------------------
 */

function toggle(tag) {
  if (tag === 'all') {
    selected.clear();
  } else if (
    selected.has(tag)
  ) {
    selected.delete(tag);
  } else {
    selected.add(tag);
  }

  update();
}

/*
 * --------------------------------------------------------------------------
 * Work creation
 * --------------------------------------------------------------------------
 */

function createWork(item) {
  const tags =
    Array.isArray(item.tags)
      ? item.tags
      : [];

  const work =
    document.createElement(
      'figure',
    );

  work.className =
    'work';

  /*
   * Browser can skip expensive rendering
   * for far-off-screen work.
   */
  work.style.contentVisibility =
    'auto';

  /*
   * Approximate intrinsic height.
   * Adjust this to your actual card height.
   */
  work.style.containIntrinsicSize =
    '400px';

  work.dataset.tags =
    tags.join(' ');

  work.tabIndex = 0;

  work.setAttribute(
    'role',
    'button',
  );

  work.setAttribute(
    'aria-label',
    item.title
      ? `Open ${item.title}`
      : 'Open archive item',
  );

  /*
   * Main preview.
   */
  const mediaElement =
    createMedia(item);

  work.appendChild(
    mediaElement,
  );

  /*
   * Caption.
   */
  const caption =
    document.createElement(
      'figcaption',
    );

  caption.className =
    'caption';

  const details =
    document.createElement(
      'div',
    );

  if (item.title) {
    const title =
      document.createElement(
        'div',
      );

    title.className =
      'title';

    title.textContent =
      item.title;

    details.appendChild(
      title,
    );
  }

  /*
   * Tags.
   */
  const tagList =
    document.createElement(
      'div',
    );

  tagList.className =
    'tags';

  tags.forEach(
    value => {
      const tag =
        document.createElement(
          'button',
        );

      tag.className =
        'tag';

      tag.type =
        'button';

      tag.dataset.tag =
        value;

      tag.textContent =
        value;

      tag.addEventListener(
        'click',
        event => {
          event.preventDefault();
          event.stopPropagation();

          toggle(value);
        },
      );

      tagList.appendChild(
        tag,
      );
    },
  );

  if (tags.length) {
    details.appendChild(
      tagList,
    );
  }

  if (details.children.length) {
    caption.appendChild(
      details,
    );
  }

  /*
   * Description.
   */
  if (item.shortDescription) {
    const description =
      document.createElement(
        'div',
      );

    description.className =
      'description';

    description.textContent =
      item.shortDescription;

    caption.appendChild(
      description,
    );
  }

  if (caption.children.length) {
    work.appendChild(
      caption,
    );
  }

  /*
   * ------------------------------------------------------------------------
   * Mini gallery
   * ------------------------------------------------------------------------
   */

  const itemMedia =
    Array.isArray(item.media)
      ? item.media
      : [];

  if (itemMedia.length) {
    const miniGallery =
      document.createElement(
        'div',
      );

    miniGallery.className =
      'item-mini-gallery';

    miniGallery.setAttribute(
      'aria-label',
      'Item media previews',
    );

    itemMedia.forEach(
      (
        source,
        index,
      ) => {
        /*
         * Video mini:
         *
         * item.poster if available
         * otherwise image preview if available
         * otherwise video's own first frame
         */
        const poster =
          VIDEO_PATTERN.test(source)
            ? (
                item.poster ||
                (
                  !VIDEO_PATTERN.test(
                    item.preview,
                  )
                    ? item.preview
                    : ''
                )
              )
            : '';

        const thumbnail =
          createThumbnail(
            source,
            'item-mini-thumbnail',
            poster,
          );

        thumbnail.setAttribute(
          'aria-label',
          `Open media ${index + 1}`,
        );

        /*
         * Click opens viewer.
         */
        thumbnail.addEventListener(
          'click',
          event => {
            event.stopPropagation();

            viewer.open(
              item,
              thumbnail,
              item.hidePreview
                ? index
                : index + 1,
            );
          },
        );

        /*
         * Hover replaces main preview
         * with actual media.
         */
        thumbnail.addEventListener(
          'mouseenter',
          () => {
            mediaElement.showTemporary(
              source,
            );
          },
        );

        /*
         * Restore animated main preview.
         */
        thumbnail.addEventListener(
          'mouseleave',
          () => {
            mediaElement.restorePreview();
          },
        );

        miniGallery.appendChild(
          thumbnail,
        );
      },
    );

    work.appendChild(
      miniGallery,
    );
  }

  /*
   * Open item viewer.
   */
  work.addEventListener(
    'click',
    () => {
      viewer.open(
        item,
        work,
      );
    },
  );

  /*
   * Keyboard accessibility.
   */
  work.addEventListener(
    'keydown',
    event => {
      if (
        event.target === work &&
        (
          event.key === 'Enter' ||
          event.key === ' '
        )
      ) {
        event.preventDefault();

        viewer.open(
          item,
          work,
        );
      }
    },
  );

  return work;
}

/*
 * --------------------------------------------------------------------------
 * Progressive gallery rendering
 * --------------------------------------------------------------------------
 */

let renderedCount = 0;
let galleryRenderItems = [];

function renderGalleryChunk() {
  if (
    renderedCount >=
    galleryRenderItems.length
  ) {
    return;
  }

  const fragment =
    document.createDocumentFragment();

  const end =
    Math.min(
      renderedCount +
        RENDER_BATCH_SIZE,
      galleryRenderItems.length,
    );

  for (
    let index = renderedCount;
    index < end;
    index++
  ) {
    fragment.appendChild(
      createWork(
        galleryRenderItems[index],
      ),
    );
  }

  worksContainer.appendChild(
    fragment,
  );

  renderedCount = end;

  if (
    renderedCount <
    galleryRenderItems.length
  ) {
    scheduleIdle(
      renderGalleryChunk,
    );
  }
}

function renderGallery(items) {
  renderedCount = 0;

  galleryRenderItems =
    items;

  worksContainer.replaceChildren();

  renderGalleryChunk();
}

/*
 * --------------------------------------------------------------------------
 * Filters
 * --------------------------------------------------------------------------
 */

function renderFilters(items) {
  const container =
    document.querySelector(
      '.filters',
    );

  if (!container) {
    return;
  }

  const tags = [
    ...new Set(
      items.flatMap(
        item =>
          Array.isArray(item.tags)
            ? item.tags
            : [],
      ),
    ),
  ];

  const fragment =
    document.createDocumentFragment();

  tags.forEach(
    value => {
      const filter =
        document.createElement(
          'button',
        );

      filter.className =
        'filter';

      filter.type =
        'button';

      filter.dataset.filter =
        value;

      filter.textContent =
        value;

      fragment.appendChild(
        filter,
      );
    },
  );

  container.appendChild(
    fragment,
  );
}

const galleryItems =
  Array.isArray(
    window.galleryItems,
  )
    ? window.galleryItems
    : [];

renderFilters(
  galleryItems,
);

renderGallery(
  galleryItems,
);

const filters = [
  ...document.querySelectorAll(
    '.filter',
  ),
];

/*
 * --------------------------------------------------------------------------
 * Filter state
 * --------------------------------------------------------------------------
 */

function syncTags() {
  document
    .querySelectorAll('.tag')
    .forEach(
      tag => {
        tag.classList.toggle(
          'active',
          selected.has(
            tag.dataset.tag,
          ),
        );
      },
    );
}

function update() {
  const works = [
    ...document.querySelectorAll(
      '.work',
    ),
  ];

  works.forEach(
    work => {
      const tags =
        work.dataset.tags
          .split(/\s+/)
          .filter(Boolean);

      work.classList.toggle(
        'is-hidden',
        selected.size > 0 &&
          !tags.some(
            tag =>
              selected.has(tag),
          ),
      );
    },
  );

  filters.forEach(
    filter => {
      filter.classList.toggle(
        'active',
        filter.dataset.filter ===
          'all'
          ? !selected.size
          : selected.has(
              filter.dataset.filter,
            ),
      );
    },
  );

  syncTags();
}

filters.forEach(
  filter => {
    filter.addEventListener(
      'click',
      () => {
        toggle(
          filter.dataset.filter,
        );
      },
    );
  },
);

/*
 * --------------------------------------------------------------------------
 * Contact modal
 * --------------------------------------------------------------------------
 */

(() => {
  const modal =
    document.getElementById(
      'contact-modal',
    );

  const openButton =
    document.getElementById(
      'contact-open',
    );

  const closeButtons =
    modal
      ? modal.querySelectorAll(
          '[data-contact-close]',
        )
      : [];

  let lastFocusedElement =
    null;

  if (
    !modal ||
    !openButton
  ) {
    return;
  }

  const openModal = () => {
    lastFocusedElement =
      document.activeElement;

    modal.classList.add(
      'is-open',
    );

    modal.setAttribute(
      'aria-hidden',
      'false',
    );

    document.body.classList.add(
      'contact-modal-open',
    );

    modal
      .querySelector(
        '.contact-close',
      )
      ?.focus();
  };

  const closeModal = () => {
    modal.classList.remove(
      'is-open',
    );

    modal.setAttribute(
      'aria-hidden',
      'true',
    );

    document.body.classList.remove(
      'contact-modal-open',
    );

    lastFocusedElement?.focus();
  };

  openButton.addEventListener(
    'click',
    openModal,
  );

  closeButtons.forEach(
    button => {
      button.addEventListener(
        'click',
        closeModal,
      );
    },
  );

  document.addEventListener(
    'keydown',
    event => {
      if (
        event.key === 'Escape' &&
        modal.classList.contains(
          'is-open',
        )
      ) {
        closeModal();
      }
    },
  );
})();