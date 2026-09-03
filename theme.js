/* ============================================================
   Miracle Dev's Archive - the ransom note

   The name in the title bar is cut into single letters, each on its own
   scrap of paper with a fixed rotation, lift and size.  The numbers come
   from a seeded generator, so the note looks the same on every visit.
   The text itself is untouched: the letters stay in one element, in
   order, spaces included.  Without this file the name simply renders in
   the display face.
   ============================================================ */

(() => {
  const name = document.querySelector(".name");
  if (!name || name.children.length) return;

  const text = name.textContent.replace(/\s+/g, " ").trim();
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const fragment = document.createDocumentFragment();
  text.split(" ").forEach((word, position) => {
    if (position) fragment.appendChild(document.createTextNode(" "));
    // Letters are inline blocks, so a word is kept whole on its own line.
    const group = document.createElement("span");
    group.className = "rw";
    for (const char of word) {
      const scrap = document.createElement("span");
      scrap.className = random() < 0.22 ? "rl inv" : "rl";
      scrap.textContent = char;
      scrap.style.setProperty("--r", `${(random() * 9 - 4.5).toFixed(2)}deg`);
      scrap.style.setProperty("--y", `${Math.round(random() * 6 - 3)}px`);
      scrap.style.setProperty("--s", (0.86 + random() * 0.32).toFixed(3));
      scrap.style.setProperty("--d", `${(random() * -11).toFixed(2)}s`);
      group.appendChild(scrap);
    }
    fragment.appendChild(group);
  });
  name.setAttribute("aria-label", text);
  name.replaceChildren(fragment);
})();
