"""Cut a video down to a few random one second moments, same format out.

Drop a video on this file (or pass it on the command line) and it picks a
handful of random, non overlapping moments, glues them together in the order
they appear in the source and writes the result next to the original:

    party.mp4  (3 min)  ->  party_cut.mp4  (4 s: four random seconds)

Each moment is one second by default and the whole output never runs longer
than four seconds, so the number of moments is total / length.  Short sources
get fewer moments - a 2.5 s clip only has room for two.

The output keeps the container of the input (mp4 stays mp4, webm stays webm),
so it drops straight back into wherever the original came from.  Audio is
carried over when the source has any.  The original is never touched.

Usage:
    python random_cut.py clip.mp4                 # 4 x 1 s -> clip_cut.mp4
    python random_cut.py a.mp4 b.webm             # several at once
    python random_cut.py clip.mp4 --total 3       # 3 x 1 s
    python random_cut.py clip.mp4 --length 0.5    # 8 x 0.5 s
    python random_cut.py clip.mp4 --seed 7        # same cut every run
    python random_cut.py clip.mp4 -o out.mp4      # explicit output path

Needs ffmpeg and ffprobe on PATH, same as the other scripts here.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path


DEFAULT_LENGTH = 1.0
DEFAULT_TOTAL = 4.0

VIDEO_EXTENSIONS = {".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".ogg", ".webm"}

# Container -> (video encoder args, audio encoder args, extra muxer args).
ENCODERS = {
    ".webm": (
        ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1"],
        ["-c:a", "libopus", "-b:a", "128k"],
        [],
    ),
    ".mkv": (
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
        ["-c:a", "aac", "-b:a", "160k"],
        [],
    ),
}
DEFAULT_ENCODER = (
    ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
    ["-c:a", "aac", "-b:a", "160k"],
    ["-movflags", "+faststart"],
)


def require_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def probe(source: Path) -> tuple[float, bool]:
    """Return (duration in seconds, source has an audio stream)."""
    command = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_entries", "format=duration:stream=codec_type",
        str(source),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe failed")

    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    if not any(stream.get("codec_type") == "video" for stream in streams):
        raise RuntimeError("no video stream")

    duration = float(data.get("format", {}).get("duration") or 0.0)
    if duration <= 0:
        raise RuntimeError("could not read a duration")

    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    return duration, has_audio


def pick_starts(duration: float, length: float, count: int,
                rng: random.Random) -> list[float]:
    """Random, non overlapping start times in chronological order.

    Whatever is left over after the moments themselves is handed out to the
    gaps between them at random, which spreads the moments uniformly over the
    source without ever letting two of them touch.
    """
    count = min(count, int(duration // length))
    if count < 1:
        return [0.0]

    slack = duration - count * length
    offsets = sorted(rng.random() for _ in range(count))
    return [offset * slack + index * length
            for index, offset in enumerate(offsets)]


def build_filter(starts: list[float], length: float,
                 with_audio: bool) -> tuple[str, list[str]]:
    """filter_complex that trims every moment and concatenates them."""
    parts = []
    for index, start in enumerate(starts):
        end = start + length
        parts.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},"
            f"setpts=PTS-STARTPTS[v{index}]"
        )
        if with_audio:
            parts.append(
                f"[0:a]atrim=start={start:.3f}:end={end:.3f},"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )

    if with_audio:
        # concat wants the streams interleaved: [v0][a0][v1][a1]...
        streams = "".join(f"[v{i}][a{i}]" for i in range(len(starts)))
        parts.append(f"{streams}concat=n={len(starts)}:v=1:a=1[vout][aout]")
        return ";".join(parts), ["-map", "[vout]", "-map", "[aout]"]

    streams = "".join(f"[v{i}]" for i in range(len(starts)))
    parts.append(f"{streams}concat=n={len(starts)}:v=1:a=0[vout]")
    return ";".join(parts), ["-map", "[vout]"]


def output_path(source: Path, requested: Path | None) -> Path:
    if requested is not None:
        return requested
    candidate = source.with_name(f"{source.stem}_cut{source.suffix}")
    counter = 2
    while candidate.exists():
        candidate = source.with_name(
            f"{source.stem}_cut{counter}{source.suffix}")
        counter += 1
    return candidate


def cut(source: Path, args: argparse.Namespace, rng: random.Random) -> Path:
    duration, has_audio = probe(source)
    count = max(1, int(round(args.total / args.length)))
    length = min(args.length, duration)
    starts = pick_starts(duration, length, count, rng)

    filter_complex, maps = build_filter(starts, length, has_audio)
    video_args, audio_args, muxer_args = ENCODERS.get(
        source.suffix.lower(), DEFAULT_ENCODER
    )

    destination = output_path(source, args.output)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-filter_complex", filter_complex,
        *maps,
        *video_args, "-pix_fmt", "yuv420p",
        *(audio_args if has_audio else ["-an"]),
        *muxer_args,
        str(destination),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed")

    moments = ", ".join(f"{start:.1f}s" for start in starts)
    print(f"{source.name} ({duration:.1f}s) -> {destination.name}  "
          f"[{len(starts)} x {length:g}s @ {moments}]")
    return destination


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Cut random one second moments out of a video.")
    parser.add_argument("sources", nargs="*", type=Path,
                        help="video files (drag and drop works too)")
    parser.add_argument("--length", type=float, default=DEFAULT_LENGTH,
                        help=f"length of one moment (default: {DEFAULT_LENGTH})")
    parser.add_argument("--total", type=float, default=DEFAULT_TOTAL,
                        help=f"total output length (default: {DEFAULT_TOTAL})")
    parser.add_argument("-o", "--output", type=Path,
                        help="output path (only with a single input)")
    parser.add_argument("--seed", type=int,
                        help="seed the picker to reproduce a cut")
    parser.add_argument("--no-pause", action="store_true",
                        help="do not wait for a keypress when finished")
    args = parser.parse_args(argv)

    def finish(code: int) -> int:
        # Dropping a file on the script opens a console that closes the moment
        # the run ends, taking the report with it.
        if os.name == "nt" and args.sources and not args.no_pause:
            try:
                input("\nPress Enter to close...")
            except (EOFError, KeyboardInterrupt):
                pass
        return code

    if not args.sources:
        parser.print_help()
        return finish(2)
    if args.length <= 0 or args.total <= 0:
        print("--length and --total must be positive.", file=sys.stderr)
        return finish(2)
    if args.total < args.length:
        print("--total is shorter than --length, nothing to cut.",
              file=sys.stderr)
        return finish(2)
    if args.output is not None and len(args.sources) > 1:
        print("--output only works with a single input file.", file=sys.stderr)
        return finish(2)
    if not require_ffmpeg():
        print("ffmpeg/ffprobe not found on PATH.", file=sys.stderr)
        return finish(1)

    rng = random.Random(args.seed)
    failures = 0
    for source in args.sources:
        if not source.is_file():
            print(f"{source}: not a file", file=sys.stderr)
            failures += 1
            continue
        if source.suffix.lower() not in VIDEO_EXTENSIONS:
            print(f"{source.name}: not a video container, skipped",
                  file=sys.stderr)
            failures += 1
            continue
        try:
            cut(source, args, rng)
        except (RuntimeError, ValueError) as error:
            print(f"{source.name}: {error}", file=sys.stderr)
            failures += 1

    return finish(1 if failures else 0)


if __name__ == "__main__":
    raise SystemExit(main())
