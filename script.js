/* ============================================================
   Miracle Dev's Archive - gallery runtime

   PERFORMANCE MODEL

   Grid cards paint a still poster first, attach a clip only inside a warm
   band around the viewport, and play only while they are meaningfully on
   screen.  Clips that drift out are released - decoder, buffer and GPU
   texture all go away.  A fast flick parks playback until the scroll
   settles, and the whole grid is parked while the viewer modal is open.

   The heavy lifting happens before this file runs: cut_previews.py caps a
   card preview at a few seconds and generate-gallery.py encodes it to a
   small 15 fps H.264 proxy.  The originals are never served to the grid -
   they are what the modal opens on click.
   ============================================================ */

const worksContainer = document.getElementById("works");
const selected = new Set();

const VIDEO_PATTERN = /\.(mp4|webm|ogg|mov|m4v)$/i;
const VIDEO_MIME = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  mov: "video/quicktime",
};

/**
 * Cards loop their preview on their own.  Flip to false to make the grid a
 * wall of still posters that only animate under the cursor - steady-state
 * cost drops to zero, at the price of a motionless page at rest.
 */
const GRID_AUTOPLAY = true;

// Attach sources this far outside the viewport, release beyond it.
const WARM_MARGIN = "400px 0px";
// A card has to be at least this visible to earn a playback slot.  Without
// it a card peeking in by 5% competes with the one in the middle of the screen.
const PLAY_THRESHOLD = 0.5;
// Above this scroll speed (px per ms) playback is parked until the flick ends.
const FAST_SCROLL = 1.1;
const SCROLL_SETTLE = 140;
// Hovered cards jump the queue so the thing under the cursor always animates.
const HOVER_PRIORITY = 2;
const HOVER_CYCLE_MS = 2500;
/**
 * A looping preview reads as motion, not as detail, so there is no reason to
 * pull the 2x tier for it: at 480 CSS px that would be 960x540 per frame
 * instead of 640x360 - 2.25x the pixels to decode and composite.  Full
 * resolution is what the modal is for.
 */
const MAX_GRID_DENSITY = 1.5;
// Sort sentinel for a card the view observer has not reported on yet.
const FAR_AWAY = Number.MAX_SAFE_INTEGER;


/* ============================================================
   DEVICE PROFILE

   How many clips may run at once.  Deliberately small: a three column grid
   shows about six cards, and playing all six was the load.  Three is more
   than enough to read as a live page.
   ============================================================ */

const device = (() => {
  const connection = navigator.connection || {};
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  const thrifty = connection.saveData === true
    || /^([23]g|slow-2g)$/i.test(connection.effectiveType || "");

  let cap = 3;
  if (cores <= 2 || memory <= 2) cap = 1;
  else if (cores <= 4 || memory <= 4) cap = 2;
  if (thrifty) cap = 1;

  return { thrifty, cap };
})();


/* ============================================================
   ASSET RESOLUTION

   generate-gallery.py emits, per source file:
     { src, kind, width, height, wide, narrow, poster, thumb }
   Everything falls back to the original path when a proxy is missing, so
   the page still works if the media step has not been run.
   ============================================================ */

function resolveAsset(asset, fallbackSrc) {
  if (!asset) {
    const src = fallbackSrc || "";
    return {
      src,
      kind: VIDEO_PATTERN.test(src) ? "video" : "image",
      tiers: src ? [{ url: src, width: Infinity }] : [],
      poster: "",
      thumb: src,
      naturalWidth: 0,
      naturalHeight: 0,
    };
  }

  const tiers = [];
  if (asset.narrow) tiers.push({ url: asset.narrow, width: asset.narrowW || 0 });
  if (asset.wide) tiers.push({ url: asset.wide, width: asset.wideW || 0 });
  if (!tiers.length && asset.src) tiers.push({ url: asset.src, width: asset.width || Infinity });
  tiers.sort((a, b) => a.width - b.width);

  return {
    src: asset.src || fallbackSrc || "",
    kind: asset.kind === "video" ? "video" : "image",
    tiers,
    poster: asset.poster || "",
    thumb: asset.thumb || asset.src || fallbackSrc || "",
    // Pixel size of the original, straight from ffprobe.  The modal sizes
    // itself off this; 0 means "unknown", and the modal keeps its default box.
    naturalWidth: Number(asset.width) || 0,
    naturalHeight: Number(asset.height) || 0,
  };
}

/**
 * Smallest tier that still covers the box the card actually renders at.
 *
 * Deliberately not decided once at startup from devicePixelRatio: that value
 * is wrong if the page loads before the real DPR settles, and it changes when
 * a window moves between monitors or the user zooms.  The card's measured
 * width covers every layout - three up, two up or single column - for free.
 */
function tierFor(asset, cssWidth) {
  const tiers = asset.tiers;
  if (!tiers.length) return asset.src;
  if (device.thrifty) return tiers[0].url;

  const density = Math.min(window.devicePixelRatio || 1, MAX_GRID_DENSITY);
  const needed = (cssWidth || 0) * density;
  // Not measured yet: start small rather than committing to the heavy tier.
  if (!needed) return tiers[0].url;

  // 8% slack, so a 645px need does not jump a whole tier for nothing.
  const fit = tiers.find((tier) => tier.width >= needed * 0.92);
  return (fit || tiers[tiers.length - 1]).url;
}

/** Assets for [preview, ...media]: what a card shows and cycles through. */
function assetsFor(item) {
  const media = Array.isArray(item.media) ? item.media : [];
  const mediaAssets = Array.isArray(item.mediaAssets) ? item.mediaAssets : [];
  return [
    resolveAsset(item.previewAsset, item.preview),
    ...media.map((src, index) => resolveAsset(mediaAssets[index], src)),
  ];
}

/**
 * Same list the modal walks, except slot 0 is the full size cut when the
 * folder ships one (fullsize_preview.*).  That way a card loops a short,
 * cheap preview while opening it still lands on the whole thing - and the
 * heavy cut never shows up as an extra entry anywhere.
 */
function viewerAssetsFor(item) {
  const entries = assetsFor(item);
  if (item.fullsizeAsset || item.fullsizePreview) {
    entries[0] = resolveAsset(item.fullsizeAsset, item.fullsizePreview);
  }
  return entries;
}

/** Natural size of a resolved asset, or null when the data does not say. */
function naturalSize(asset) {
  const width = asset.naturalWidth || 0;
  const height = asset.naturalHeight || 0;
  return width && height ? { width, height } : null;
}

/**
 * The box that has to hold every entry of one item.  Taken per item rather
 * than per entry so that stepping through the strip never resizes the modal
 * under the cursor.  Null when nothing in the item has known dimensions.
 */
function itemSize(entries) {
  let width = 0;
  let height = 0;
  entries.forEach((asset) => {
    const size = naturalSize(asset);
    if (!size) return;
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  });
  return width && height ? { width, height } : null;
}


/* ============================================================
   VIDEO ELEMENT PLUMBING

   Sources live in <source> children rather than the src attribute, so a
   release is just "drop the children and reload" - which frees the
   decoder without the empty-src console error that src removal causes.
   ============================================================ */

function makeVideo({ controls = false, loop = true } = {}) {
  const video = document.createElement("video");
  video.controls = controls;
  video.autoplay = false;
  video.loop = loop;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "none";
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  return video;
}

function attachSource(video, url) {
  if (!url || video.dataset.attached === url) return;
  detachSource(video);

  const source = document.createElement("source");
  source.src = url;
  const type = VIDEO_MIME[url.split(".").pop().toLowerCase()];
  if (type) source.type = type;

  video.appendChild(source);
  video.dataset.attached = url;
  video.preload = "metadata";
  video.load();
}

function detachSource(video) {
  if (!video.dataset.attached) return;
  video.pause();
  video.replaceChildren();
  delete video.dataset.attached;
  video.load(); // releases the decoder, the buffer and the video texture
}

function startVideo(video) {
  if (!video.dataset.attached) return;
  const attempt = video.play();
  if (attempt && attempt.catch) attempt.catch(() => {});
}


/* ============================================================
   PLAYBACK SCHEDULER

   Observes cards, not the video elements inside them: a card is a
   content-visibility:auto container, so observing it directly avoids the
   skipped-subtree blind spot and survives the hover swap that changes
   which clip is active.

   Each card registers a controller with warm/cool/play/pause hooks; the
   scheduler decides who gets to run.
   ============================================================ */

const scheduler = (() => {
  const cards = new Map(); // element -> { controller, score, distance, warm, playing, width }
  const suspended = new Set();
  let pendingReconcile = 0;

  const warmObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = cards.get(entry.target);
      if (!card || card.warm === entry.isIntersecting) continue;
      card.warm = entry.isIntersecting;
      card.width = entry.boundingClientRect.width || card.width;
      if (card.warm) {
        // Do not spend bandwidth mid-flick; resume() flushes the backlog.
        if (!suspended.has("scroll")) card.controller.warm(card.width);
      } else {
        card.controller.cool();
      }
    }
    schedule();
  }, { rootMargin: WARM_MARGIN, threshold: 0 });

  const viewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = cards.get(entry.target);
      if (!card) continue;
      card.score = entry.isIntersecting ? entry.intersectionRatio : 0;

      const bounds = entry.boundingClientRect;
      const root = entry.rootBounds;
      // Read straight off the observer entry - no forced layout.
      card.distance = root
        ? Math.abs((bounds.top + bounds.bottom) / 2 - (root.top + root.bottom) / 2)
        : 0;
    }
    schedule();
  }, { rootMargin: "0px", threshold: [0, 0.25, 0.5, 0.75, 1] });

  function schedule() {
    if (pendingReconcile) return;
    pendingReconcile = requestAnimationFrame(() => {
      pendingReconcile = 0;
      reconcile();
    });
  }

  /** Hard stop. Never a diff against bookkeeping something else may have moved. */
  function parkAll() {
    for (const card of cards.values()) {
      card.playing = false;
      card.controller.park();
    }
  }

  function reconcile() {
    if (suspended.size) {
      parkAll();
      return;
    }

    const candidates = [];
    for (const card of cards.values()) {
      // A hovered card plays even when barely in view: it is what the cursor
      // is pointing at, and there is exactly one of it.
      const visible = card.score >= PLAY_THRESHOLD || card.controller.priority > 0;
      if (!card.warm || !visible || !card.controller.wantsPlayback()) {
        setPlaying(card, false);
        continue;
      }
      candidates.push(card);
    }

    candidates.sort((a, b) => {
      const weight = (b.score + b.controller.priority) - (a.score + a.controller.priority);
      return weight !== 0 ? weight : a.distance - b.distance;
    });

    for (let index = 0; index < candidates.length; index += 1) {
      setPlaying(candidates[index], index < device.cap);
    }
  }

  function setPlaying(card, next) {
    if (card.playing === next) return;
    card.playing = next;
    if (next) card.controller.play();
    else card.controller.pause();
  }

  return {
    register(element, controller) {
      cards.set(element, { controller, score: 0, distance: FAR_AWAY, warm: false, playing: false, width: 0 });
      warmObserver.observe(element);
      viewObserver.observe(element);
    },
    /**
     * Park playback for a named reason; every reason must be lifted to resume.
     * With `release`, the cards hand their decoders back as well - worth it
     * behind a modal, which covers the grid completely and wants a full-size
     * decoder of its own (weak iGPUs cap concurrent hardware decoders, and
     * losing that race drops the modal to software decoding).  Not worth it
     * for a scroll flick, which would re-fetch everything the moment it ends.
     */
    suspend(reason, { release = false } = {}) {
      if (suspended.has(reason)) return;
      suspended.add(reason);
      // Synchronously, not on the next frame: the point of parking during a
      // flick is to be out of the way of that very frame.
      parkAll();
      if (release) {
        for (const card of cards.values()) card.controller.cool();
      }
    },
    resume(reason) {
      if (!suspended.delete(reason)) return;
      if (!suspended.size) {
        // Flush warm work that was held back while parked.
        for (const card of cards.values()) {
          if (card.warm) card.controller.warm(card.width);
        }
      }
      schedule();
    },
    refresh: schedule,
  };
})();


/* ============================================================
   GLOBAL PARKING TRIGGERS
   ============================================================ */

(() => {
  let lastY = window.scrollY;
  let lastT = 0;
  let settle = 0;

  window.addEventListener("scroll", () => {
    const now = performance.now();
    const y = window.scrollY;
    const elapsed = now - lastT;

    if (lastT && elapsed > 0 && Math.abs(y - lastY) / elapsed > FAST_SCROLL) {
      scheduler.suspend("scroll");
    }
    lastY = y;
    lastT = now;

    clearTimeout(settle);
    settle = setTimeout(() => scheduler.resume("scroll"), SCROLL_SETTLE);
  }, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) scheduler.suspend("hidden");
    else scheduler.resume("hidden");
  });
})();


/* ============================================================
   CARD MEDIA

   One controller per card.  It owns the preview visual plus any clips
   the hover cycle brings in, and exposes the small surface the
   scheduler drives.
   ============================================================ */

function createMedia(item) {
  const container = document.createElement("div");
  container.className = "media";

  const assets = assetsFor(item);
  const preview = assets[0];
  const extras = assets.slice(1);

  const visuals = new Map(); // asset -> element
  let active = null;
  let warm = false;
  let running = false;
  let hovered = false;
  let cycleTimer = 0;
  let cycleIndex = 0;
  let paintHandle = 0;
  // Measured card width, handed over by the scheduler's observer entry.
  let boxWidth = 0;

  function build(asset) {
    const existing = visuals.get(asset);
    if (existing) return existing;

    let element;
    if (asset.kind === "video") {
      element = makeVideo();
      if (asset.poster) element.dataset.poster = asset.poster;
    } else {
      element = document.createElement("img");
      element.alt = "";
      element.decoding = "async";
    }
    element.asset = asset;
    visuals.set(asset, element);
    return element;
  }

  function warmVisual(element) {
    if (element instanceof HTMLVideoElement) {
      // Poster first: the card has something to show before a single frame
      // has been decoded, and again after the clip is released.
      if (element.dataset.poster && !element.poster) element.poster = element.dataset.poster;
      // Without grid autoplay a card stays a poster until the cursor arrives,
      // so there is nothing to fetch or demux at rest.
      if (!GRID_AUTOPLAY && !hovered) return;
      attachSource(element, tierFor(element.asset, boxWidth));
      return;
    }
    const url = tierFor(element.asset, boxWidth);
    if (url && element.getAttribute("src") !== url) element.src = url;
  }

  function coolVisual(element) {
    // Stills are cheap to keep; only clips hold a decoder worth reclaiming.
    if (element instanceof HTMLVideoElement) detachSource(element);
  }

  /**
   * Reconcile every visual against `active` rather than toggling the two ends
   * of a swap.  Deferred by a frame so a freshly appended element gets one
   * paint at opacity 0 and the fade actually runs - but derived from the
   * current truth, so two swaps inside one frame cannot strand the class on a
   * hidden element, and a tab that comes back from the background repaints
   * correctly on the first frame it gets.
   */
  function paint() {
    paintHandle = 0;
    for (const element of visuals.values()) {
      element.classList.toggle("is-active", element === active);
    }
  }

  /**
   * Swap the visible visual.  Elements built for the hover cycle stay in the
   * DOM once created - they are absolutely positioned at opacity 0, and
   * rebuilding them every cycle cost a fresh request and a fresh decoder.
   * Their sources are released together on mouseleave.
   */
  function show(asset) {
    const next = build(asset);
    if (next.parentNode !== container) container.appendChild(next);
    if (warm) warmVisual(next);

    if (next !== active) {
      active = next;
      if (!paintHandle) paintHandle = requestAnimationFrame(paint);
      scheduler.refresh();
    }

    if (running) startVideo(next);
  }

  function stopCycle() {
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = 0;
  }

  function beginCycle() {
    if (cycleTimer || !extras.length) return;
    const step = () => {
      show(extras[cycleIndex]);
      cycleIndex = (cycleIndex + 1) % extras.length;
    };
    step();
    cycleTimer = setInterval(step, HOVER_CYCLE_MS);
  }

  function restorePreview() {
    stopCycle();
    cycleIndex = 0;
    show(preview);
    // The extras are only worth a decoder while the cursor is on the card.
    for (const [asset, element] of visuals) {
      if (asset !== preview) coolVisual(element);
    }
  }

  const primary = build(preview);
  primary.classList.add("is-active");
  if (primary instanceof HTMLImageElement) primary.alt = item.title || "";
  container.appendChild(primary);
  active = primary;

  const controller = {
    get priority() {
      return hovered ? HOVER_PRIORITY : 0;
    },
    wantsPlayback() {
      if (!(active instanceof HTMLVideoElement)) return false;
      return GRID_AUTOPLAY || hovered;
    },
    warm(width) {
      warm = true;
      if (width) boxWidth = width;
      warmVisual(active);
    },
    cool() {
      warm = false;
      running = false;
      hovered = false;
      stopCycle();
      cycleIndex = 0;
      for (const element of visuals.values()) coolVisual(element);
      if (active !== primary) show(preview);
    },
    play() {
      running = true;
      if (active instanceof HTMLVideoElement) startVideo(active);
    },
    pause() {
      running = false;
      if (active instanceof HTMLVideoElement) active.pause();
    },
    /** Global park: stop the swapping too, so a flick sees no DOM churn. */
    park() {
      running = false;
      stopCycle();
      if (active instanceof HTMLVideoElement) active.pause();
    },
    showTemporary(index) {
      stopCycle();
      if (extras[index]) show(extras[index]);
    },
    restorePreview,
  };

  container.addEventListener("mouseenter", () => {
    hovered = true;
    if (warm) warmVisual(active);
    beginCycle();
    scheduler.refresh();
  });

  container.addEventListener("mouseleave", () => {
    hovered = false;
    restorePreview();
    scheduler.refresh();
  });

  container.controller = controller;
  return container;
}


/* ============================================================
   THUMBNAILS

   Stills, generated from the same first frame a paused <video> used to
   show.  A strip entry is 58px wide; it is not worth a demux.
   ============================================================ */

function createThumbnail(asset, className, label) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.setAttribute("aria-label", label);

  const image = document.createElement("img");
  image.src = asset.thumb || asset.src;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.tabIndex = -1;

  button.appendChild(image);
  return button;
}


/* ============================================================
   VIEWER MODAL

   The modal shows originals at full quality - that is the whole point of
   opening it.  The grid behind it is parked meanwhile.

   "Full quality" also means never blowing an original up: a 320x230 clip
   stretched across an 1180x860 dialog is a blurry clip in a big black frame.
   Items that fit inside SMALL_MEDIA_BOX get a dialog cut down to their own
   pixels instead, and no visual is ever scaled past its native size.
   ============================================================ */

// An item counts as small when both of its dimensions stay under this.
const SMALL_MEDIA_BOX = 900;
// Floors for the shrunken dialog: below these the header, the description and
// the thumbnail strip stop being readable, which costs more than the black bars.
const MIN_DIALOG_WIDTH = 520;
const MIN_STAGE_HEIGHT = 240;

function renderRichText(target, text) {
  const isUrl = /^https?:\/\/[^\s]+$/;
  text.split(/(https?:\/\/[^\s]+)/g).forEach((chunk) => {
    if (isUrl.test(chunk)) {
      const link = document.createElement("a");
      link.href = chunk;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = chunk;
      target.appendChild(link);
    } else {
      target.appendChild(document.createTextNode(chunk));
    }
  });
}

function createViewer() {
  const modal = document.createElement("div");
  modal.className = "gallery-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="gallery-backdrop" data-gallery-close></div>

    <section class="gallery-dialog" role="dialog" aria-modal="true" aria-label="Archive item">
      <header class="gallery-header">
        <div>
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
    </section>
  `;
  document.body.appendChild(modal);

  const dialog = modal.querySelector(".gallery-dialog");
  const stage = modal.querySelector(".gallery-stage");
  const heading = modal.querySelector("h2");
  const longDescription = modal.querySelector(".gallery-long-description");
  const counter = modal.querySelector(".gallery-counter");
  const controls = modal.querySelector(".gallery-controls");
  const strip = modal.querySelector(".gallery-thumbnails");

  let entries = [];
  let index = 0;
  let opener = null;

  /**
   * Size the dialog around a small item.
   *
   * The chrome - header, stage margins, description, strip, padding - is
   * measured off the default layout rather than hardcoded, so it follows the
   * stylesheet and whether this item ships a long description.  The result is
   * clamped with min() so a shrunken dialog still cannot outgrow the viewport,
   * and styles are cleared first, which both restores the stylesheet defaults
   * for a normal item and makes the measurement read those defaults.
   */
  function fitDialog(size) {
    dialog.style.width = "";
    dialog.style.height = "";
    if (!size || size.width >= SMALL_MEDIA_BOX || size.height >= SMALL_MEDIA_BOX) return;

    // offset* rather than getBoundingClientRect(): the closed dialog carries a
    // scale() transform, which the rect would fold into the numbers.
    const chromeWidth = dialog.offsetWidth - stage.offsetWidth;
    const chromeHeight = dialog.offsetHeight - stage.offsetHeight;
    if (chromeWidth <= 0 || chromeHeight <= 0) return;  // not laid out yet

    const width = Math.max(MIN_DIALOG_WIDTH, size.width + chromeWidth);
    const height = Math.max(MIN_STAGE_HEIGHT, size.height) + chromeHeight;
    dialog.style.width = `min(${Math.round(width)}px, 100%)`;
    dialog.style.height = `min(${Math.round(height)}px, calc(100vh - 44px))`;
  }

  function showAt(next) {
    if (!entries.length) return;
    index = (next + entries.length) % entries.length;
    const asset = entries[index];

    // Tear the previous element down before the next one spins up, so two
    // full-size decoders never overlap.
    stage.querySelectorAll("video").forEach((video) => detachSource(video));

    let visual;
    if (asset.kind === "video") {
      visual = makeVideo({ controls: true, loop: false });
      visual.muted = false;
      visual.defaultMuted = false;
      if (asset.poster) visual.poster = asset.poster;
      attachSource(visual, asset.src);
    } else {
      visual = document.createElement("img");
      visual.src = asset.src;
      visual.alt = heading.textContent;
      visual.decoding = "async";
    }
    visual.className = "gallery-visual";

    // The stage stretches its child to fill; these caps stop that at the
    // original's own pixels, and auto margins re-centre the shortfall.
    const size = naturalSize(asset);
    if (size) {
      visual.style.maxWidth = `${size.width}px`;
      visual.style.maxHeight = `${size.height}px`;
      visual.style.margin = "auto";
    }

    stage.replaceChildren(visual);

    counter.textContent = `${index + 1} / ${entries.length}`;
    [...strip.children].forEach((child, position) => {
      child.classList.toggle("is-active", position === index);
    });

    const current = strip.children[index];
    if (current) {
      const stripBox = strip.getBoundingClientRect();
      const box = current.getBoundingClientRect();
      if (box.left < stripBox.left || box.right > stripBox.right) {
        current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    }

    if (visual instanceof HTMLVideoElement) startVideo(visual);
  }

  function close() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("gallery-modal-open");
    stage.querySelectorAll("video").forEach((video) => detachSource(video));
    stage.replaceChildren();
    strip.replaceChildren();
    scheduler.resume("modal");
    if (opener) opener.focus();
  }

  modal.querySelectorAll("[data-gallery-close]").forEach((element) => {
    element.addEventListener("click", close);
  });
  modal.querySelector("[data-gallery-previous]").addEventListener("click", () => showAt(index - 1));
  modal.querySelector("[data-gallery-next]").addEventListener("click", () => showAt(index + 1));

  document.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("is-open")) return;
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft" && entries.length > 1) showAt(index - 1);
    if (event.key === "ArrowRight" && entries.length > 1) showAt(index + 1);
  });

  return {
    open(item, source, startIndex = 0) {
      entries = viewerAssetsFor(item);
      if (!entries.length) return;

      opener = source;
      heading.textContent = item.title || "";
      heading.hidden = !item.title;

      longDescription.replaceChildren();
      if (item.longDescription) renderRichText(longDescription, item.longDescription);
      longDescription.hidden = !item.longDescription;

      const fragment = document.createDocumentFragment();
      entries.forEach((asset, position) => {
        const thumbnail = createThumbnail(asset, "gallery-thumbnail", `Open media ${position + 1}`);
        thumbnail.addEventListener("click", () => showAt(position));
        fragment.appendChild(thumbnail);
      });
      strip.replaceChildren(fragment);
      controls.classList.toggle("is-single", entries.length === 1);

      // After the description and the strip are in place, so the measurement
      // sees the chrome this item actually renders.
      fitDialog(itemSize(entries));

      // Free the CPU and the decoders for the full-size original.
      scheduler.suspend("modal", { release: true });

      showAt(startIndex);
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("gallery-modal-open");
      modal.querySelector(".gallery-close").focus();
    },
  };
}

const viewer = createViewer();


/* ============================================================
   CARDS
   ============================================================ */

function toggle(tag) {
  if (tag === "all") selected.clear();
  else if (selected.has(tag)) selected.delete(tag);
  else selected.add(tag);
  update();
}

function createWork(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];

  const card = document.createElement("figure");
  card.className = "work";
  card.dataset.tags = tags.join(" ");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", item.title ? `Open ${item.title}` : "Open archive item");

  const media = createMedia(item);
  card.appendChild(media);

  const caption = document.createElement("figcaption");
  caption.className = "caption";

  const head = document.createElement("div");
  if (item.title) {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title;
    head.appendChild(title);
  }

  if (tags.length) {
    const tagList = document.createElement("div");
    tagList.className = "tags";
    tags.forEach((tag) => {
      const button = document.createElement("button");
      button.className = "tag";
      button.type = "button";
      button.dataset.tag = tag;
      button.textContent = tag;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(tag);
      });
      tagList.appendChild(button);
    });
    head.appendChild(tagList);
  }

  if (head.children.length) caption.appendChild(head);

  if (item.shortDescription) {
    const description = document.createElement("div");
    description.className = "description";
    description.textContent = item.shortDescription;
    caption.appendChild(description);
  }

  if (caption.children.length) card.appendChild(caption);

  const extras = assetsFor(item).slice(1);
  if (extras.length) {
    const strip = document.createElement("div");
    strip.className = "item-mini-gallery";
    strip.setAttribute("aria-label", "Item media previews");

    extras.forEach((asset, position) => {
      const thumbnail = createThumbnail(asset, "item-mini-thumbnail", `Open media ${position + 1}`);
      thumbnail.addEventListener("click", (event) => {
        event.stopPropagation();
        viewer.open(item, thumbnail, position + 1);
      });
      thumbnail.addEventListener("mouseenter", () => media.controller.showTemporary(position));
      thumbnail.addEventListener("mouseleave", () => media.controller.restorePreview());
      strip.appendChild(thumbnail);
    });

    card.appendChild(strip);
  }

  card.addEventListener("click", () => viewer.open(item, card));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    viewer.open(item, card);
  });

  scheduler.register(card, media.controller);
  return card;
}


/* ============================================================
   RENDER

   One pass.  The cards are content-visibility:auto, so the ones below the
   fold cost layout and paint nothing until they are scrolled to - there is
   nothing left for a chunked render to spread out.
   ============================================================ */

const galleryItems = Array.isArray(window.galleryItems) ? window.galleryItems : [];

const workElements = galleryItems.map(createWork);
worksContainer.replaceChildren(...workElements);

const filtersContainer = document.querySelector(".filters");
const tagNames = [...new Set(galleryItems.flatMap((item) => (Array.isArray(item.tags) ? item.tags : [])))];
filtersContainer.append(...tagNames.map((tag) => {
  const button = document.createElement("button");
  button.className = "filter";
  button.type = "button";
  button.dataset.filter = tag;
  button.textContent = tag;
  return button;
}));

const filters = [...document.querySelectorAll(".filter")];

function update() {
  // Hidden cards stop intersecting, so the scheduler pauses them for free.
  workElements.forEach((card) => {
    const tags = card.dataset.tags.split(/\s+/).filter(Boolean);
    card.classList.toggle("is-hidden", selected.size > 0 && !tags.some((tag) => selected.has(tag)));
  });

  filters.forEach((button) => {
    const filter = button.dataset.filter;
    button.classList.toggle("active", filter === "all" ? selected.size === 0 : selected.has(filter));
  });

  document.querySelectorAll(".tag").forEach((button) => {
    button.classList.toggle("active", selected.has(button.dataset.tag));
  });

  scheduler.refresh();
}

filters.forEach((button) => {
  button.addEventListener("click", () => toggle(button.dataset.filter));
});


/* ============================================================
   REVEAL

   Cards settle into place the first time they are scrolled to.  Purely
   decorative, and layered on top of a stylesheet whose default is
   "already visible": without the class the grid renders exactly as it
   would have, which is also what a reduced-motion visitor gets.

   No per-card delay: a row arriving together is quieter than a cascade,
   and it keeps the last card in a row from lagging behind the cursor.
   ============================================================ */

(() => {
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // The huge top margin is what makes this safe against a jump.  A card the
  // viewport skipped over - an anchor link, a flick, or scroll restoration on
  // reload - never becomes "intersecting" again, and against a plain root it
  // would sit at opacity 0 for good.  Growing the root upwards instead means
  // anything the page has already passed counts as seen, while the bottom
  // margin still holds back the cards that are genuinely below the fold.
  const watch = { rootMargin: "100000px 0px -6% 0px", threshold: 0.04 };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
    }
  }, watch);

  workElements.forEach((card) => {
    card.classList.add("reveal");
    observer.observe(card);
  });
})();
