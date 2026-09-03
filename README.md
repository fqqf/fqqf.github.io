TODO:
- Синее превью снизу при full скрине галереи
- ship the font as WOFF2 instead of a 745 KB TTF (pip install fonttools brotli, then
  `fonttools ttLib.woff2 compress "fonts/Montserrat[wght].ttf"` and point style.css at it)

DONE:
- lazy release + preload offset (clips are released once they leave the warm band,
  and playback is limited to what is actually on screen)
- web profiler / optimization / gifs (gifs are transcoded to H.264 like everything else)
- card previews are capped at 4 seconds and 15 fps, and at most 3 clips play at once
  (the grid used to pull ~25 MB of 30 fps video and run 8 decoders; it is ~1.7 MB now)

BUILD:
    python cut_previews.py --dry-run    # show which previews are too long
    python cut_previews.py              # cut them to 4 s, keep the originals
    python generate-gallery.py          # gallery-data.js + grid proxies (incremental)
    python generate-gallery.py --force  # re-encode everything
    python generate-gallery.py --help   # --fps / --max-seconds / --jobs / --no-media

cut_previews.py is a one-off pass over the sources; generate-gallery.py is the build and
picks the change up on its own.  Everything under gallery/ is tracked by git, so
`git restore gallery/` undoes a cut_previews run.

Originals stay untouched in gallery/gN/; the grid is served from gallery/gN/opt/.
The modal always loads the original.

Per folder: preview.* is what the card loops, 1.*, 2.* ... are the extra media.
Add an optional fullsize_preview.* and the modal opens that instead of preview.*
(the card keeps looping the light preview, and the full size cut never appears
in the thumbnail strip under the card).  cut_previews.py creates exactly that:
the long original becomes fullsize_preview.*, and preview.* becomes the 4 s loop.
Where a folder already had its own fullsize_preview.*, the long preview is parked
in gallery/gN/originals/ instead - the builder only scans files, not subdirectories.

GRID LOAD KNOBS (script.js, top of file):
    GRID_AUTOPLAY      false makes the grid still posters that animate on hover only
    MAX_GRID_DENSITY   caps the proxy tier a card may pull on HiDPI screens
    PLAY_THRESHOLD     how visible a card must be before it earns a playback slot
