/* ============================================================
   Miracle Dev's Archive - decoration runtime

   Two effects, both opt-out on coarse pointers and reduced motion, both
   idle at zero cost:

     1. The iris follows the cursor and drifts with the scroll.  The pupil
        moves through two custom properties; the CSS transition does the
        easing, so there is no per-frame work here at all.

     2. A paint trail.  The cursor drags a gold stroke across the backdrop
        canvas that fades over a couple of seconds.  The render loop runs
        only while there is wet paint on the canvas and stops on its own.

   script.js is untouched; this file only ever touches its own elements.
   ============================================================ */

(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (reducedMotion) return;

  /* ---------------- The iris ---------------- */

  const eye = document.querySelector(".eye");
  if (eye) {
    // How far (in px) the pupil may wander from the centre.
    const REACH = Math.min(window.innerWidth, window.innerHeight) * 0.09;
    let scrollTicking = false;

    if (finePointer) {
      window.addEventListener("pointermove", (event) => {
        const box = eye.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        // Direction to the cursor, softened so it never looks glued to it.
        const dx = event.clientX - cx;
        const dy = event.clientY - cy;
        const distance = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, distance / 900);
        eye.style.setProperty("--px", `${(dx / distance) * REACH * pull}px`);
        eye.style.setProperty("--py", `${(dy / distance) * REACH * pull}px`);
      }, { passive: true });
    }

    window.addEventListener("scroll", () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        eye.style.setProperty("--scroll", `${window.scrollY}px`);
        // Unitless twin, so the stylesheet can fade the iris as the page goes by.
        eye.style.setProperty("--scroll-ratio", (window.scrollY / window.innerHeight).toFixed(3));
      });
    }, { passive: true });
  }

  /* ---------------- The paint trail ---------------- */

  const canvas = document.querySelector(".paint");
  if (!canvas || !finePointer) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  // 1x is plenty for a soft stroke that fades in two seconds, and it keeps the
  // fade fill cheap on 4k screens.
  const SCALE = 1;
  const FADE = 0.045;         // alpha removed per frame; ~1.5s to vanish
  const IDLE_FRAMES = 70;     // frames without input before the loop stops
  const MAX_WIDTH = 26;
  const MIN_WIDTH = 3;

  let width = 0;
  let height = 0;
  let running = false;
  let idle = 0;
  let last = null;            // { x, y, t }
  const pending = [];         // segments queued since the last frame

  function resize() {
    width = Math.floor(window.innerWidth * SCALE);
    height = Math.floor(window.innerHeight * SCALE);
    canvas.width = width;
    canvas.height = height;
    context.lineCap = "round";
    context.lineJoin = "round";
  }
  resize();
  window.addEventListener("resize", resize, { passive: true });

  function frame() {
    // Fade what is there.
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = `rgba(0,0,0,${FADE})`;
    context.fillRect(0, 0, width, height);

    // Lay down the new paint.
    context.globalCompositeOperation = "source-over";
    while (pending.length) {
      const segment = pending.shift();
      const speed = Math.min(1, segment.speed / 2.2);
      // Fast strokes are thin and dry; slow ones pool.
      const lineWidth = MIN_WIDTH + (1 - speed) * (MAX_WIDTH - MIN_WIDTH);
      const alpha = 0.10 + (1 - speed) * 0.22;
      const gradient = context.createLinearGradient(segment.x0, segment.y0, segment.x1, segment.y1);
      gradient.addColorStop(0, `rgba(217,177,87,${alpha})`);
      gradient.addColorStop(1, `rgba(216,66,31,${alpha * 0.85})`);
      context.strokeStyle = gradient;
      context.lineWidth = lineWidth * SCALE;
      context.beginPath();
      context.moveTo(segment.x0, segment.y0);
      context.quadraticCurveTo(segment.cx, segment.cy, segment.x1, segment.y1);
      context.stroke();
      idle = 0;
    }

    idle += 1;
    if (idle > IDLE_FRAMES) {
      context.clearRect(0, 0, width, height);
      running = false;
      last = null;
      return;
    }
    requestAnimationFrame(frame);
  }

  function wake() {
    if (running) return;
    running = true;
    idle = 0;
    requestAnimationFrame(frame);
  }

  window.addEventListener("pointermove", (event) => {
    // Only the primary pointer, and never while a modal has the page.
    if (!event.isPrimary || document.body.classList.contains("gallery-modal-open")) return;

    const x = event.clientX * SCALE;
    const y = event.clientY * SCALE;
    const t = event.timeStamp;

    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      const dt = Math.max(1, t - last.t);
      const length = Math.hypot(dx, dy);
      // Skip sub-pixel jitter: it produces dots, not strokes.
      if (length < 2) return;
      pending.push({
        x0: last.x, y0: last.y,
        cx: (last.x + x) / 2, cy: (last.y + y) / 2,
        x1: x, y1: y,
        speed: length / dt,
      });
    }
    last = { x, y, t };
    wake();
  }, { passive: true });

  window.addEventListener("pointerleave", () => { last = null; });
  document.addEventListener("visibilitychange", () => { if (document.hidden) last = null; });
})();
