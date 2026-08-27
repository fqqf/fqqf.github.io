/* ============================================================
   Miracle Dev's Archive - gallery runtime

   PERFORMANCE MODEL

   The grid used to mount every preview as a full resolution <video> with
   src set, autoplay on and a 500px preload margin, so a dozen 1080p60
   clips were demuxing and decoding at the same time.  That is what made
   scrolling stutter on weak hardware.

   What happens now:

     * cards paint a still poster first, so first paint costs no decode
     * a clip is only attached (source added) inside the warm band
     * a clip only plays while it is actually on screen
     * clips that drift far off screen are released - the decoder, the
       buffered data and the GPU texture all go away
     * a fast flick parks playback until the scroll settles
     * a frame governor lowers the concurrent playback cap on hardware
       that cannot keep up, and raises it back when it can
     * the grid is fully parked while the viewer modal is open

   Card visuals are unchanged: what plays, plays; what is paused keeps
   showing its current frame; what is released falls back to a poster of
   its own first frame.
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

const RENDER_BATCH_SIZE = 6;

// Attach sources this far outside the viewport, release beyond it.
// Wide enough that a normal scroll never reaches an unfilled card.
const WARM_MARGIN = "600px 0px";
// Above this scroll speed (px per ms) playback is parked until the flick ends.
const FAST_SCROLL = 1.1;
const SCROLL_SETTLE = 140;
// Hovered cards jump the queue so the thing under the cursor always animates.
const HOVER_PRIORITY = 2;
const HOVER_CYCLE_MS = 1200;
// Sort sentinel for a card the view observer has not reported on yet.
const FAR_AWAY = Number.MAX_SAFE_INTEGER;

const scheduleIdle = window.requestIdleCallback
  ? (callback) => window.requestIdleCallback(callback, { timeout: 500 })
  : (callback) => setTimeout(callback, 1);


/* ============================================================
   DEVICE PROFILE

   Picks the proxy tier and the starting playback budget.  Both are only
   opening guesses - the frame governor below corrects the budget from
   measured frame timing.
   ============================================================ */

const device = (() => {
  const connection = navigator.connection || {};
  const saveData = connection.saveData === true;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  const slowLink = /^([23]g|slow-2g)$/i.test(connection.effectiveType || "");

  let budget = 8;
  if (cores <= 2 || memory <= 2) budget = 2;
  else if (cores <= 4 || memory <= 4) budget = 4;
  if (saveData || slowLink) budget = 1;

  return { saveData, thrifty: saveData || slowLink, budget };
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
      width: 0,
      height: 0,
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
    width: asset.width || 0,
    height: asset.height || 0,
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
  const tiers = asset.tiers || [];
  if (!tiers.length) return asset.src || "";
  if (device.thrifty) return tiers[0].url;

  const needed = (cssWidth || 0) * (window.devicePixelRatio || 1);
  if (!needed) return tiers[tiers.length - 1].url;

  // 8% slack, so a 645px need does not jump a whole tier for nothing.
  const fit = tiers.find((tier) => tier.width >= needed * 0.92);
  return (fit || tiers[tiers.length - 1]).url;
}

/** Assets for [preview, ...media], aligned with the modal's source list. */
function assetsFor(item) {
  const media = Array.isArray(item.media) ? item.media : [];
  const mediaAssets = Array.isArray(item.mediaAssets) ? item.mediaAssets : [];
  return [
    resolveAsset(item.previewAsset, item.preview),
    ...media.map((src, index) => resolveAsset(mediaAssets[index], src)),
  ];
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
   FRAME GOVERNOR

   Samples requestAnimationFrame deltas while clips are playing and
   nudges the concurrent playback cap toward whatever this machine can
   actually sustain.  Sampling only runs while something is playing, and
   pauses during scroll parking so a scroll stall is never blamed on the
   decoders.
   ============================================================ */

const governor = (() => {
  const MIN_CAP = 1;
  const MAX_CAP = 12;
  const WINDOW = 48;         // frames per verdict
  const SLOW_FRAME = 24;     // ms; roughly below 42fps
  const BAD_RATIO = 0.24;    // shrink above this share of slow frames
  const GOOD_RATIO = 0.05;   // grow below it, after enough clean windows
  const GROW_AFTER = 3;      // consecutive clean windows before growing

  let cap = device.budget;
  let frames = 0;
  let slow = 0;
  let cleanWindows = 0;
  let last = 0;
  let handle = 0;
  let active = false;
  let onChange = () => {};

  function sample(now) {
    handle = 0;
    if (!active) return;
    if (last) {
      const delta = now - last;
      // Ignore the huge deltas that follow a tab switch or a long task
      // outside our control; they are not a decode capacity signal.
      if (delta < 500) {
        frames += 1;
        if (delta > SLOW_FRAME) slow += 1;
      }
    }
    last = now;

    if (frames >= WINDOW) {
      const ratio = slow / frames;
      frames = 0;
      slow = 0;

      if (ratio > BAD_RATIO && cap > MIN_CAP) {
        cap -= 1;
        cleanWindows = 0;
        onChange();
      } else if (ratio < GOOD_RATIO) {
        cleanWindows += 1;
        if (cleanWindows >= GROW_AFTER && cap < MAX_CAP) {
          cap += 1;
          cleanWindows = 0;
          onChange();
        }
      } else {
        cleanWindows = 0;
      }
    }

    handle = requestAnimationFrame(sample);
  }

  return {
    get cap() {
      return cap;
    },
    set onChange(callback) {
      onChange = callback;
    },
    /** Called with the number of clips currently playing. */
    watch(playing) {
      if (playing > 0 && !active) {
        active = true;
        last = 0;
        frames = 0;
        slow = 0;
        if (!handle) handle = requestAnimationFrame(sample);
      } else if (playing === 0 && active) {
        active = false;
        if (handle) cancelAnimationFrame(handle);
        handle = 0;
      }
    },
  };
})();


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
  const cards = new Map(); // element -> { controller, score, distance, warm, playing }
  const suspended = new Set();
  let pendingReconcile = 0;
  let playingCount = 0;

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
  }, { rootMargin: "0px", threshold: [0, 0.05, 0.25, 0.5, 0.75, 1] });

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
      if (card.playing) playingCount -= 1;
      card.playing = false;
      card.controller.park();
    }
    governor.watch(0);
  }

  function reconcile() {
    if (suspended.size) {
      parkAll();
      return;
    }

    const candidates = [];
    for (const card of cards.values()) {
      if (!card.warm || card.score <= 0 || !card.controller.wantsPlayback()) {
        setPlaying(card, false);
        continue;
      }
      candidates.push(card);
    }

    candidates.sort((a, b) => {
      const weight = (b.score + b.controller.priority) - (a.score + a.controller.priority);
      return weight !== 0 ? weight : a.distance - b.distance;
    });

    const cap = governor.cap;
    for (let index = 0; index < candidates.length; index += 1) {
      setPlaying(candidates[index], index < cap);
    }

    governor.watch(playingCount);
  }

  function setPlaying(card, next) {
    if (card.playing === next) return;
    card.playing = next;
    playingCount += next ? 1 : -1;
    if (next) card.controller.play();
    else card.controller.pause();
  }

  governor.onChange = schedule;

  return {
    register(element, controller) {
      cards.set(element, { controller, score: 0, distance: FAR_AWAY, warm: false, playing: false, width: 0 });
      warmObserver.observe(element);
      viewObserver.observe(element);
    },
    /** Park playback for a named reason; every reason must be lifted to resume. */
    suspend(reason) {
      if (suspended.has(reason)) return;
      suspended.add(reason);
      // Synchronously, not on the next frame: the point of parking during a
      // flick is to be out of the way of that very frame.
      parkAll();
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
  let cycleTimer = 0;
  let cycleIndex = 0;
  let priority = 0;
  // Measured card width, handed over by the scheduler's observer entry.
  let boxWidth = 0;

  function build(asset) {
    if (visuals.has(asset)) return visuals.get(asset);

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
    const url = tierFor(element.asset, boxWidth);
    if (!url) return;

    if (element instanceof HTMLVideoElement) {
      // Poster first: the card has something to show before a single frame
      // has been decoded, and again after the clip is released.
      if (element.dataset.poster && !element.poster) element.poster = element.dataset.poster;
      attachSource(element, url);
    } else if (element.getAttribute("src") !== url) {
      element.src = url;
    }
  }

  function coolVisual(element) {
    // Stills are cheap to keep; only clips hold a decoder worth reclaiming.
    if (element instanceof HTMLVideoElement) detachSource(element);
  }

  function show(asset) {
    const next = build(asset);
    if (next === active) {
      if (running) startVideo(next);
      return;
    }

    const previous = active;
    active = next;

    if (next.parentNode !== container) container.appendChild(next);
    if (warm) warmVisual(next);

    if (previous) previous.classList.remove("is-active");
    requestAnimationFrame(() => next.classList.add("is-active"));

    // Keep the preview element around; transient hover clips are disposable.
    if (previous && previous !== primary) {
      coolVisual(previous);
      if (previous.parentNode === container) previous.remove();
      visuals.delete(previous.asset);
    }

    if (running) startVideo(next);
    scheduler.refresh();
  }

  function stopCycle() {
    if (!cycleTimer) return;
    clearInterval(cycleTimer);
    cycleTimer = 0;
  }

  function restorePreview() {
    stopCycle();
    cycleIndex = 0;
    show(preview);
  }

  const primary = build(preview);
  primary.className = "is-active";
  if (primary instanceof HTMLImageElement) primary.alt = item.title || "";
  container.appendChild(primary);
  active = primary;

  const controller = {
    get priority() {
      return priority;
    },
    wantsPlayback() {
      return active instanceof HTMLVideoElement;
    },
    warm(width) {
      warm = true;
      if (width) boxWidth = width;
      warmVisual(active);
    },
    cool() {
      warm = false;
      running = false;
      stopCycle();
      for (const element of visuals.values()) coolVisual(element);
      if (active !== primary) restorePreview();
    },
    play() {
      running = true;
      if (active instanceof HTMLVideoElement) startVideo(active);
      if (cycleTimer === 0 && priority > 0 && extras.length) beginCycle();
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

  function beginCycle() {
    const step = () => {
      if (!extras.length) return;
      show(extras[cycleIndex]);
      cycleIndex = (cycleIndex + 1) % extras.length;
    };
    step();
    cycleTimer = setInterval(step, HOVER_CYCLE_MS);
  }

  if (extras.length) {
    container.addEventListener("mouseenter", () => {
      priority = HOVER_PRIORITY;
      scheduler.refresh();
      if (!cycleTimer) beginCycle();
    });
    container.addEventListener("mouseleave", () => {
      priority = 0;
      restorePreview();
      scheduler.refresh();
    });
  }

  container.controller = controller;
  return container;
}


/* ============================================================
   THUMBNAILS

   Previously each video thumbnail was a paused <video preload=metadata>
   with its source already set - a network round trip and a demux per
   strip entry, for something 58px wide.  They are stills now, generated
   from the same first frame the paused element used to show.
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
   opening it.  The grid behind it is parked meanwhile, so the backdrop
   blur is not compositing a wall of live video.
   ============================================================ */

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
    </section>
  `;
  document.body.appendChild(modal);

  const stage = modal.querySelector(".gallery-stage");
  const heading = modal.querySelector("h2");
  const longDescription = modal.querySelector(".gallery-long-description");
  const counter = modal.querySelector(".gallery-counter");
  const controls = modal.querySelector(".gallery-controls");
  const strip = modal.querySelector(".gallery-thumbnails");

  let entries = [];
  let index = 0;
  let opener = null;

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
      const all = assetsFor(item);
      entries = item.hidePreview ? all.slice(1) : all;
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

      // Free the CPU for the full-size original behind the blurred backdrop.
      scheduler.suspend("modal");

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

  const assets = assetsFor(item);
  const extras = assets.slice(1);
  if (extras.length) {
    const strip = document.createElement("div");
    strip.className = "item-mini-gallery";
    strip.setAttribute("aria-label", "Item media previews");

    extras.forEach((asset, position) => {
      const thumbnail = createThumbnail(asset, "item-mini-thumbnail", `Open media ${position + 1}`);
      thumbnail.addEventListener("click", (event) => {
        event.stopPropagation();
        viewer.open(item, thumbnail, item.hidePreview ? position : position + 1);
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
   ============================================================ */

let renderedCount = 0;
let renderQueue = [];
let workElements = [];

function renderGalleryChunk() {
  if (renderedCount >= renderQueue.length) return;

  const fragment = document.createDocumentFragment();
  const end = Math.min(renderedCount + RENDER_BATCH_SIZE, renderQueue.length);
  for (let index = renderedCount; index < end; index += 1) {
    const card = createWork(renderQueue[index]);
    workElements.push(card);
    fragment.appendChild(card);
  }
  worksContainer.appendChild(fragment);
  renderedCount = end;

  if (renderedCount < renderQueue.length) scheduleIdle(renderGalleryChunk);
}

function renderGallery(items) {
  renderedCount = 0;
  renderQueue = items;
  workElements = [];
  worksContainer.replaceChildren();
  renderGalleryChunk();
}

function renderFilters(items) {
  const container = document.querySelector(".filters");
  if (!container) return;

  const tags = [...new Set(items.flatMap((item) => (Array.isArray(item.tags) ? item.tags : [])))];
  const fragment = document.createDocumentFragment();
  tags.forEach((tag) => {
    const button = document.createElement("button");
    button.className = "filter";
    button.type = "button";
    button.dataset.filter = tag;
    button.textContent = tag;
    fragment.appendChild(button);
  });
  container.appendChild(fragment);
}

const galleryItems = Array.isArray(window.galleryItems) ? window.galleryItems : [];
renderFilters(galleryItems);
renderGallery(galleryItems);

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
   CONTACT MODAL (only wires up if the markup is present)
   ============================================================ */

(() => {
  const modal = document.getElementById("contact-modal");
  const trigger = document.getElementById("contact-open");
  if (!modal || !trigger) return;

  let opener = null;
  const close = () => {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("contact-modal-open");
    if (opener) opener.focus();
  };

  trigger.addEventListener("click", () => {
    opener = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("contact-modal-open");
    const first = modal.querySelector(".contact-close");
    if (first) first.focus();
  });

  modal.querySelectorAll("[data-contact-close]").forEach((element) => {
    element.addEventListener("click", close);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) close();
  });
})();
