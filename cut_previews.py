"""Cut long gallery card previews down to a short loop, keeping the original.

A card in the grid loops its preview forever, so a 113 second clip means 113
seconds of streaming, demuxing and decoding for something nobody watches past
the first loop.  This trims every preview that runs longer than a few seconds
and keeps the original right next to it, so clicking the card still opens the
whole thing.

    gallery/g13/preview.mp4  (113 s, 15.9 MB)

becomes

    gallery/g13/preview.mp4           (4 s - what the card loops)
    gallery/g13/fullsize_preview.mp4  (113 s - the original file, moved as is)

generate-gallery.py already understands fullsize_preview.*: the modal viewer
opens it instead of the preview, and it never shows up in the thumbnail strip
under a card.

If a folder already ships its own fullsize_preview.*, the author picked that
cut deliberately, so it is left alone and the long preview is parked in
gallery/gN/originals/ instead - the builder only looks at files, so a
subdirectory is invisible to it.

Handles video (mp4/webm/mov/m4v/ogg), animated GIF and animated WebP.  Still
images are skipped.  Nothing is ever deleted, only moved, and everything under
gallery/ is tracked by git, so `git restore gallery/` undoes a whole run.

Usage:
    python cut_previews.py --dry-run    # list what would change, touch nothing
    python cut_previews.py              # trim previews longer than 4 s
    python cut_previews.py --seconds 6
    python cut_previews.py --jobs 4

Then rebuild the grid, which picks the change up on its own:
    python generate-gallery.py
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parent
GALLERY = ROOT / "gallery"

PREVIEW_STEM = "preview"
FULLSIZE_STEM = "fullsize_preview"
ARCHIVE_DIRNAME = "originals"

VIDEO_EXTENSIONS = {".m4v", ".mov", ".mp4", ".ogg", ".webm"}
# Containers that may or may not move; probed before anything is touched.
MAYBE_ANIMATED = {".apng", ".gif", ".png", ".webp"}
MOVING = VIDEO_EXTENSIONS | MAYBE_ANIMATED
MEDIA_EXTENSIONS = MOVING | {".avif", ".bmp", ".jpeg", ".jpg", ".svg"}

DEFAULT_SECONDS = 4.0

# The trimmed cut becomes the source generate-gallery.py encodes the 640/960
# grid tiers from, so it is kept visually lossless on purpose - otherwise a
# card would show two generations of H.264 loss instead of one.
TRIM_CRF = 18


# ============================================================
# SHELL HELPERS
# ============================================================

def require_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "").strip() or " ".join(command))


def number(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def human(size: float) -> str:
    return "{:.1f} MB".format(size / 1048576) if size >= 1048576 else "{:.0f} KB".format(size / 1024)


# ============================================================
# PROBING
# ============================================================

def motion(path: Path) -> tuple[float, int]:
    """Return (seconds, frames) for a file.  frames <= 1 means it does not move."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=nb_frames,duration,avg_frame_rate",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return 0.0, 0

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return 0.0, 0

    streams = payload.get("streams") or [{}]
    stream = streams[0]

    frames = int(number(stream.get("nb_frames")))
    seconds = number((payload.get("format") or {}).get("duration")) or number(stream.get("duration"))

    fps = 0.0
    rate = str(stream.get("avg_frame_rate") or "")
    if "/" in rate:
        top, _, bottom = rate.partition("/")
        if number(bottom):
            fps = number(top) / number(bottom)

    # Animated WebP and some GIFs report no duration; derive it from the frames.
    if not seconds and frames > 1 and fps:
        seconds = frames / fps
    # The mirror case: a duration but no frame count.
    if not frames and seconds and fps:
        frames = int(seconds * fps)

    return seconds, frames


# ============================================================
# ENCODING
# ============================================================

def encode_trim(source: Path, target: Path, seconds: float) -> None:
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-t", "{:.3f}".format(seconds),
        "-an",                                       # a looping card preview is muted anyway
        # GIFs and some WebP land on odd dimensions, which yuv420p rejects.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264",
        "-profile:v", "main",
        "-pix_fmt", "yuv420p",
        "-preset", "slow",
        "-crf", str(TRIM_CRF),
        "-movflags", "+faststart",
        str(target),
    ])


# ============================================================
# PLANNING
# ============================================================

def named(folder: Path, stem: str) -> Path | None:
    matches = sorted(
        path for path in folder.iterdir()
        if path.is_file() and path.stem.lower() == stem
        and path.suffix.lower() in MEDIA_EXTENSIONS
    )
    return matches[0] if matches else None


def plan(folder: Path, seconds: float) -> dict:
    """Decide what happens to one folder.  Reads only, changes nothing."""
    skip = lambda why: {"folder": folder, "action": "skip", "why": why}

    preview = named(folder, PREVIEW_STEM)
    if preview is None:
        return skip("no preview")
    if preview.suffix.lower() not in MOVING:
        return skip("still image")

    length, frames = motion(preview)
    if frames <= 1:
        return skip("still image")
    if not length:
        return skip("unreadable length")
    if length <= seconds + 0.05:
        return skip("already {:.1f} s".format(length))

    # A folder that ships its own fullsize_preview.* has an author-picked full
    # cut already; do not overwrite it, park the long preview out of the way.
    keeps_own_fullsize = named(folder, FULLSIZE_STEM) is not None
    archive = (
        folder / ARCHIVE_DIRNAME / preview.name if keeps_own_fullsize
        else folder / (FULLSIZE_STEM + preview.suffix.lower())
    )

    return {
        "folder": folder,
        "action": "trim",
        "source": preview,
        "archive": archive,
        "length": length,
        "before": preview.stat().st_size,
    }


# ============================================================
# APPLYING
# ============================================================

def apply(task: dict, seconds: float) -> dict:
    source: Path = task["source"]
    archive: Path = task["archive"]
    target = source.parent / (PREVIEW_STEM + ".mp4")
    # Leading dot so the preview.* sweep below cannot match the staging file.
    staging = source.parent / ".preview-cut.tmp.mp4"

    # Encode first: a failed ffmpeg has to leave the folder exactly as it was.
    encode_trim(source, staging, seconds)

    try:
        archive.parent.mkdir(parents=True, exist_ok=True)
        source.replace(archive)           # moved, never copied and never deleted
    except OSError:
        staging.unlink(missing_ok=True)
        raise

    # Exactly one preview.* may remain: the builder takes whichever sorts
    # first, so a leftover preview.gif would shadow the new preview.mp4.
    for stale in source.parent.glob(PREVIEW_STEM + ".*"):
        if stale.is_file() and stale.suffix.lower() in MEDIA_EXTENSIONS:
            stale.unlink()

    staging.replace(target)
    task["after"] = target.stat().st_size
    return task


# ============================================================
# MAIN
# ============================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Trim long gallery card previews, keeping the originals.",
    )
    parser.add_argument("--seconds", type=float, default=DEFAULT_SECONDS,
                        help="target loop length (default: {:.0f})".format(DEFAULT_SECONDS))
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would change without touching anything")
    parser.add_argument("--jobs", type=int, default=3,
                        help="parallel ffmpeg processes (default: 3)")
    args = parser.parse_args()

    if not GALLERY.is_dir():
        sys.exit("no gallery/ directory next to this script")
    if not require_ffmpeg():
        sys.exit("ffmpeg/ffprobe not found on PATH")

    seconds = max(0.5, args.seconds)
    folders = sorted((path for path in GALLERY.glob("g*") if path.is_dir()), key=natural_key)
    tasks = [plan(folder, seconds) for folder in folders]

    for task in tasks:
        if task["action"] == "skip":
            print("  {:<6} skip   {}".format(task["folder"].name, task["why"]))
        else:
            print("  {:<6} trim   {:.1f} s -> {:.0f} s   {:>8}   original -> {}".format(
                task["folder"].name, task["length"], seconds,
                human(task["before"]), task["archive"].relative_to(task["folder"]).as_posix(),
            ))

    pending = [task for task in tasks if task["action"] == "trim"]
    if not pending:
        print("Nothing to trim.")
        return
    if args.dry_run:
        print("\n--dry-run: {} preview(s) would be trimmed.".format(len(pending)))
        return

    print("\nTrimming {} preview(s)...".format(len(pending)))
    failures = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for task, outcome in zip(pending, pool.map(lambda item: _safe(item, seconds), pending)):
            if isinstance(outcome, Exception):
                failures += 1
                print("  {:<6} FAILED  {}".format(task["folder"].name, outcome))
            else:
                print("  {:<6} {:>8} -> {:>8}".format(
                    task["folder"].name, human(task["before"]), human(task["after"])))

    saved = sum(t["before"] - t.get("after", t["before"]) for t in pending)
    print("\nDone: {} trimmed, {} failed, {} saved in the grid path.".format(
        len(pending) - failures, failures, human(max(0, saved))))
    print("Run `python generate-gallery.py` to rebuild the proxies and gallery-data.js.")


def _safe(task: dict, seconds: float):
    try:
        return apply(task, seconds)
    except Exception as error:  # noqa: BLE001 - reported per folder
        return error


if __name__ == "__main__":
    main()
