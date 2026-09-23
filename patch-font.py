"""Build fonts/DotGothic16Archive.woff2 from the stock DotGothic16.

DotGothic16 draws its capital T one dot short: the top bar sits at 653-726
units while every other capital reaches the 787 cap line.  This lifts the
bar one dot (61 units) so the stem grows up to meet it, then subsets the
font to what the site can show (Latin, Cyrillic, punctuation, the few
symbols in use) and renames it, as the OFL asks of modified versions.

    python patch-font.py path/to/DotGothic16-Regular.ttf

Source: https://github.com/google/fonts/tree/main/ofl/dotgothic16
Needs fonttools and brotli (python -m pip install fonttools brotli).
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FAMILY = "DotGothic16 Archive"
POSTSCRIPT = "DotGothic16Archive-Regular"
OUT = Path(__file__).parent / "fonts" / "DotGothic16Archive.woff2"
DOT = 61
BAR_BOTTOM, BAR_TOP = 653, 726

# Basic Latin + Latin-1, Latin Extended-A, Cyrillic, general punctuation,
# currency, arrows, box drawing and geometric shapes (the page's triangles).
UNICODES = "U+0000-00FF,U+0100-017F,U+0400-04FF,U+2000-206F,U+20A0-20CF,U+2190-21FF,U+2500-25FF"


def lift_t(font):
    glyphs = font["glyf"]
    t = glyphs[font.getBestCmap()[ord("T")]]
    coords = t.coordinates
    for i, (x, y) in enumerate(coords):
        if y in (BAR_BOTTOM, BAR_TOP):
            coords[i] = (x, y + DOT)
    t.recalcBounds(glyphs)


def rename(font):
    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 16):
            record.string = FAMILY
        elif record.nameID == 3:
            record.string = f"1.100;FWKS;{POSTSCRIPT};patched-T"
        elif record.nameID == 4:
            record.string = f"{FAMILY} Regular"
        elif record.nameID == 6:
            record.string = POSTSCRIPT


def main(source):
    font = TTFont(source)
    lift_t(font)
    rename(font)

    options = subset.Options()
    options.flavor = "woff2"
    options.name_IDs = ["*"]
    options.layout_features = ["*"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)

    OUT.parent.mkdir(exist_ok=True)
    font.flavor = "woff2"
    font.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1])
