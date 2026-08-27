TODO:
- Синее превью снизу при full скрине галереи
- hide_preview не работает в meow
- ship the font as WOFF2 instead of a 745 KB TTF (pip install fonttools brotli, then
  `fonttools ttLib.woff2 compress "fonts/Montserrat[wght].ttf"` and point style.css at it)

DONE:
- lazy release + preload offset (clips are now released once they leave the warm band,
  and playback is limited to what is actually on screen)
- web profiler / optimization / gifs (gifs are transcoded to H.264 like everything else)

BUILD:
    python generate-gallery.py          # gallery-data.js + grid proxies (incremental)
    python generate-gallery.py --force  # re-encode everything
    python generate-gallery.py --help   # --fps / --max-seconds / --jobs / --no-media

Originals stay untouched in gallery/gN/; the grid is served from gallery/gN/opt/.
The modal always loads the original.
