"""Build gallery-data.js from gallery/g* directories.

Besides collecting metadata, this script renders lightweight *proxy* assets for
everything shown inside the grid.  The originals are never touched: grid cards
get small, uniformly encoded H.264 clips plus a still poster, while the full
size originals stay reserved for the modal viewer.

Why: a card in the grid is ~490 CSS px wide, but the source previews reach
1920x1080@60 VP9.  Decoding half a dozen of those at once is what makes the
page stutter while scrolling on weak hardware.  H.264 at card resolution is
hardware decoded practically everywhere and costs a fraction of the CPU.

Usage:
    python generate-gallery.py                # data + proxies (incremental)
    python generate-gallery.py --no-media     # data only, skip ffmpeg
    python generate-gallery.py --force        # re-encode everything
    python generate-gallery.py --fps 0        # keep the source frame rate
    python generate-gallery.py --max-seconds 12   # trim long card previews
    python generate-gallery.py --jobs 4       # parallel encodes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parent
GALLERY = ROOT / "gallery"
OUTPUT = ROOT / "gallery-data.js"
OPT_DIRNAME = "opt"
MANIFEST_NAME = "manifest.json"

VIDEO_EXTENSIONS = {".m4v", ".mov", ".mp4", ".ogg", ".webm"}
IMAGE_EXTENSIONS = {".avif", ".bmp", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
ANIMATED_IMAGE_EXTENSIONS = {".gif"}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS | ANIMATED_IMAGE_EXTENSIONS

# Proxy tiers, in device pixels.  "wide" serves HiDPI screens, "narrow" serves
# 1x desktops where a card is ~490px across.  Sources smaller than a tier are
# never upscaled, and collapsed tiers are emitted only once.
TIER_WIDE = 960
TIER_NARROW = 640
POSTER_WIDTH = 960
THUMB_WIDTH = 192

DEFAULT_FPS_CAP = 30
VIDEO_CRF = {TIER_WIDE: 24, TIER_NARROW: 25}
WEBP_QUALITY = 82
POSTER_QUALITY = 78
WEBP_EFFORT = 6          # libwebp compression_level: slower encode, smaller files

# Bumping this invalidates every cached proxy.
ENCODER_REVISION = "1"


# ============================================================
# SHELL HELPERS
# ============================================================

def require_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-6:]
        raise RuntimeError(" ".join(command[:3]) + " failed:\n" + "\n".join(tail))


def probe(path: Path) -> dict[str, object]:
    """Return width/height/fps/duration for a media file (best effort)."""
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        return {}
    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams") or [{}]
    stream = streams[0]
    fmt = payload.get("format") or {}

    def rate(value):
        if not value or "/" not in str(value):
            return 0.0
        num, den = str(value).split("/", 1)
        try:
            return float(num) / float(den) if float(den) else 0.0
        except ValueError:
            return 0.0

    fps = rate(stream.get("avg_frame_rate")) or rate(stream.get("r_frame_rate"))
    try:
        duration = float(fmt.get("duration") or 0.0)
    except ValueError:
        duration = 0.0

    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": round(fps, 3),
        "duration": round(duration, 3),
    }


def scale_filter(box: int) -> str:
    """Fit inside a box*box square without ever upscaling, keeping even dims."""
    return (
        "scale=w='min(" + str(box) + ",iw)':h='min(" + str(box) + ",ih)'"
        ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos"
    )


# ============================================================
# PROXY ENCODING
# ============================================================

def encode_video_proxy(source: Path, target: Path, box: int, fps_cap: int,
                       source_fps: float, max_seconds: int) -> None:
    filters = []
    if fps_cap and source_fps and source_fps > fps_cap + 0.01:
        filters.append("fps=" + str(fps_cap))
    filters.append(scale_filter(box))

    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if max_seconds:
        # Grid previews loop; past a point nobody watches a card that long.
        # Off by default because it does change what the card shows.
        command += ["-t", str(max_seconds)]

    run(command + [
        "-an",                                  # previews are muted; drop the audio decoder entirely
        "-vf", ",".join(filters),
        "-c:v", "libx264",
        "-profile:v", "main",                   # widest hardware-decode coverage
        "-pix_fmt", "yuv420p",
        "-preset", "slow",
        "-crf", str(VIDEO_CRF.get(box, 24)),
        "-refs", "2", "-bf", "2",               # small DPB: cheaper when many clips decode at once
        "-g", "48",
        "-movflags", "+faststart",
        str(target),
    ])


def encode_still(source: Path, target: Path, box: int, quality: int, from_video: bool) -> None:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if from_video:
        # First frame, so the poster matches exactly what the clip shows at rest.
        command += ["-frames:v", "1", "-update", "1"]
    command += [
        "-vf", scale_filter(box),
        # ffmpeg's libwebp wrapper takes the quality through -qscale;
        # the -quality private option is silently ignored.
        "-c:v", "libwebp", "-lossless", "0",
        "-compression_level", str(WEBP_EFFORT),
        "-qscale", str(quality),
        str(target),
    ]
    run(command)


def encode_image_proxy(source: Path, target: Path, box: int) -> None:
    encode_still(source, target, box, WEBP_QUALITY, from_video=False)


# ============================================================
# PER-FILE PROXY PLAN
# ============================================================

def kind_of(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in ANIMATED_IMAGE_EXTENSIONS:
        return "animated"
    return "image"


def signature(path: Path, params: str) -> str:
    stat = path.stat()
    raw = "{}:{}:{}:{}".format(stat.st_size, stat.st_mtime_ns, params, ENCODER_REVISION)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def video_params(box: int, fps_cap: int, max_seconds: int) -> str:
    return "v{}c{}f{}t{}".format(box, VIDEO_CRF.get(box, 24), fps_cap, max_seconds)


def plan_proxies(source: Path, opt_dir: Path, slug: str, fps_cap: int,
                 max_seconds: int, want_thumb: bool):
    """Describe every derived file for one source as {role, path, encode, params}."""
    info = probe(source)
    width = int(info.get("width") or 0)
    fps = float(info.get("fps") or 0.0)
    kind = kind_of(source)

    def tier_box(box: int) -> int:
        return min(box, width) if width else box

    wide_box = tier_box(TIER_WIDE)
    narrow_box = tier_box(TIER_NARROW)
    jobs = []

    if kind in ("video", "animated"):
        jobs.append({
            "role": "wide",
            "box": wide_box,
            "path": opt_dir / "{}-{}.mp4".format(slug, wide_box),
            "encode": (lambda s, t, b=wide_box: encode_video_proxy(s, t, b, fps_cap, fps, max_seconds)),
            "params": video_params(wide_box, fps_cap, max_seconds),
        })
        if narrow_box < wide_box:
            jobs.append({
                "role": "narrow",
                "box": narrow_box,
                "path": opt_dir / "{}-{}.mp4".format(slug, narrow_box),
                "encode": (lambda s, t, b=narrow_box: encode_video_proxy(s, t, b, fps_cap, fps, max_seconds)),
                "params": video_params(narrow_box, fps_cap, max_seconds),
            })
        jobs.append({
            "role": "poster",
            "path": opt_dir / "{}-poster.webp".format(slug),
            "encode": (lambda s, t: encode_still(s, t, POSTER_WIDTH, POSTER_QUALITY, True)),
            "params": "p{}qs{}e{}".format(POSTER_WIDTH, POSTER_QUALITY, WEBP_EFFORT),
        })
    else:
        jobs.append({
            "role": "wide",
            "box": wide_box,
            "path": opt_dir / "{}-{}.webp".format(slug, wide_box),
            "encode": (lambda s, t, b=wide_box: encode_image_proxy(s, t, b)),
            "params": "i{}qs{}e{}".format(wide_box, WEBP_QUALITY, WEBP_EFFORT),
        })
        if narrow_box < wide_box:
            jobs.append({
                "role": "narrow",
                "box": narrow_box,
                "path": opt_dir / "{}-{}.webp".format(slug, narrow_box),
                "encode": (lambda s, t, b=narrow_box: encode_image_proxy(s, t, b)),
                "params": "i{}qs{}e{}".format(narrow_box, WEBP_QUALITY, WEBP_EFFORT),
            })

    if want_thumb:
        from_video = kind != "image"
        jobs.append({
            "role": "thumb",
            "path": opt_dir / "{}-thumb.webp".format(slug),
            "encode": (lambda s, t, fv=from_video: encode_still(s, t, THUMB_WIDTH, POSTER_QUALITY, fv)),
            "params": "t{}qs{}e{}".format(THUMB_WIDTH, POSTER_QUALITY, WEBP_EFFORT),
        })

    return jobs, info, kind


# ============================================================
# BUILD
# ============================================================

def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def read_metadata(folder: Path) -> tuple[list[str], str, str, str]:
    metadata = folder / "description.txt"
    if not metadata.is_file():
        return [], "", "", ""
    lines = metadata.read_text(encoding="utf-8-sig").splitlines()
    tag_line = lines[0] if lines else ""
    title = lines[1].strip() if len(lines) > 1 else ""
    short_description = lines[2].strip() if len(lines) > 2 else ""
    long_description = "\n".join(lines[3:]).strip() if len(lines) > 3 else ""
    tags = [tag.lstrip("#").lower() for tag in re.split(r"[\s,]+", tag_line) if tag.lstrip("#")]
    return tags, title, short_description, long_description


def _safe(function):
    def wrapper(task):
        try:
            return function(task)
        except Exception as error:  # noqa: BLE001 - reported per task
            return error
    return wrapper


class ProxyBuilder:
    """Renders and caches proxies; a no-op when media generation is disabled."""

    def __init__(self, enabled: bool, force: bool, fps_cap: int, max_seconds: int) -> None:
        self.enabled = enabled
        self.force = force
        self.fps_cap = fps_cap
        self.max_seconds = max_seconds
        self.tasks = []
        self.manifests = {}
        self.reused = 0

    def _manifest(self, opt_dir: Path) -> dict:
        if opt_dir not in self.manifests:
            path = opt_dir / MANIFEST_NAME
            try:
                self.manifests[opt_dir] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.manifests[opt_dir] = {}
        return self.manifests[opt_dir]

    def request(self, source: Path, slug: str, want_thumb: bool) -> dict[str, object]:
        """Queue proxies for `source` and return the resulting asset record."""
        opt_dir = source.parent / OPT_DIRNAME
        jobs, info, kind = plan_proxies(source, opt_dir, slug, self.fps_cap,
                                       self.max_seconds, want_thumb)

        record = {
            "src": source.relative_to(ROOT).as_posix(),
            "kind": "video" if kind in ("video", "animated") else "image",
            "width": info.get("width") or 0,
            "height": info.get("height") or 0,
        }
        if not self.enabled:
            return record

        opt_dir.mkdir(parents=True, exist_ok=True)
        manifest = self._manifest(opt_dir)

        for job in jobs:
            target = job["path"]
            key = "{}:{}".format(slug, job["role"])
            want = signature(source, job["params"])
            fresh = (
                not self.force
                and manifest.get(key) == want
                and target.is_file()
                and target.stat().st_size > 0
            )
            if fresh:
                self.reused += 1
            else:
                self.tasks.append((source, target, job["encode"], opt_dir, key, want))
            record[job["role"]] = target.relative_to(ROOT).as_posix()
            if "box" in job:
                record[job["role"] + "W"] = job["box"]

        return record

    def flush(self, jobs: int) -> None:
        if not self.tasks:
            self._write_manifests()
            return

        total = len(self.tasks)
        done = 0
        failures = []

        def work(task):
            source, target, encode, opt_dir, key, want = task
            encode(source, target)
            return opt_dir, key, want, target

        with ThreadPoolExecutor(max_workers=jobs) as pool:
            for task, result in zip(self.tasks, pool.map(_safe(work), self.tasks)):
                done += 1
                if isinstance(result, Exception):
                    failures.append("{}: {}".format(task[1].name, result))
                    print("  [{}/{}] FAILED {}".format(done, total, task[1].name), flush=True)
                    continue
                opt_dir, key, want, target = result
                self._manifest(opt_dir)[key] = want
                size = target.stat().st_size / 1024
                print("  [{}/{}] {}  {:.0f} KB".format(
                    done, total, target.relative_to(ROOT).as_posix(), size), flush=True)

        self._write_manifests()
        if failures:
            print("\nSome proxies could not be built:", file=sys.stderr)
            for line in failures:
                print("  " + line, file=sys.stderr)

    def _write_manifests(self) -> None:
        for opt_dir, manifest in self.manifests.items():
            opt_dir.mkdir(parents=True, exist_ok=True)
            (opt_dir / MANIFEST_NAME).write_text(
                json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
            )


# The avatar is the only non-gallery image index.html loads, and it ships as a
# 640px PNG for a 28px slot.  Same treatment, no reason to leave it out.
SITE_IMAGES = [("icon.png", "icon-128.webp", 128)]


def build_site_assets() -> None:
    for source_name, target_name, box in SITE_IMAGES:
        source = ROOT / source_name
        target = ROOT / target_name
        if not source.is_file():
            continue
        if target.is_file() and target.stat().st_mtime_ns >= source.stat().st_mtime_ns:
            continue
        encode_still(source, target, box, WEBP_QUALITY, from_video=False)
        print("  {}  {:.0f} KB".format(target_name, target.stat().st_size / 1024))


def build_items(builder: ProxyBuilder) -> list[dict[str, object]]:
    items = []
    folders = sorted((path for path in GALLERY.glob("g*") if path.is_dir()), key=natural_key)

    for folder in folders:
        preview_files = sorted(
            path for path in folder.iterdir()
            if path.is_file() and path.stem.lower() == "preview" and path.suffix.lower() in MEDIA_EXTENSIONS
        )
        if not preview_files:
            continue
        preview = preview_files[0]
        media = sorted(
            (
                path for path in folder.iterdir()
                if path.is_file() and path.stem.isdigit() and path.suffix.lower() in MEDIA_EXTENSIONS
            ),
            key=lambda path: (int(path.stem), path.suffix.lower()),
        )
        tags, title, short_description, long_description = read_metadata(folder)

        preview_asset = builder.request(preview, "preview", want_thumb=True)
        media_assets = [
            builder.request(path, "m{}".format(index + 1), want_thumb=True)
            for index, path in enumerate(media)
        ]

        items.append({
            "title": title,
            "tags": tags,
            "shortDescription": short_description,
            "longDescription": long_description,
            "preview": preview.relative_to(ROOT).as_posix(),
            "media": [path.relative_to(ROOT).as_posix() for path in media],
            "hidePreview": (folder / "hide_preview").is_file(),
            "previewAsset": preview_asset,
            "mediaAssets": media_assets,
        })

    return items


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build gallery-data.js and the grid proxy assets.",
    )
    parser.add_argument("--no-media", action="store_true",
                        help="skip proxy rendering, only rebuild gallery-data.js")
    parser.add_argument("--force", action="store_true",
                        help="re-encode proxies even if they look up to date")
    parser.add_argument("--jobs", type=int, default=3,
                        help="parallel ffmpeg processes (default: 3)")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS_CAP,
                        help="frame-rate cap for grid proxies, 0 keeps the source rate "
                             "(default: {})".format(DEFAULT_FPS_CAP))
    parser.add_argument("--max-seconds", type=int, default=0,
                        help="trim grid previews to this many seconds, 0 keeps them whole "
                             "(default: 0; the only flag here that changes what a card shows)")
    args = parser.parse_args()

    media_enabled = not args.no_media
    if media_enabled and not require_ffmpeg():
        print("ffmpeg/ffprobe not found on PATH - writing data only.", file=sys.stderr)
        media_enabled = False

    builder = ProxyBuilder(enabled=media_enabled, force=args.force,
                           fps_cap=max(0, args.fps), max_seconds=max(0, args.max_seconds))
    items = build_items(builder)

    if media_enabled:
        print("Proxies: {} up to date, {} to render".format(builder.reused, len(builder.tasks)))
        builder.flush(max(1, args.jobs))
        build_site_assets()

    payload = json.dumps(items, ensure_ascii=False, indent=2)
    OUTPUT.write_text(
        "// Generated by generate-gallery.py. Do not edit by hand.\n"
        "window.galleryItems = " + payload + ";\n",
        encoding="utf-8",
    )
    print("Wrote {} with {} items".format(OUTPUT.name, len(items)))


if __name__ == "__main__":
    main()
