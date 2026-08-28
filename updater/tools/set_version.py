#!/usr/bin/env python3
"""
Write updater/VERSION from a release tag.

    python3 updater/tools/set_version.py v1.2 [--version-file updater/VERSION]

CI runs this before building a tagged release, so the version baked into the
MCUboot image header — and shown by the web client and logged at boot — always
matches the tag, with nothing to remember at release time.

The trade this makes, deliberately: the artifact attached to a release is NOT
what you get by building that tag locally, because the VERSION committed to git
still says whatever it said. Ease of release was chosen over that
reproducibility. If it ever matters, the released image reports its true
version in its own header, so `strings` or the web client's slot table can
always tell you what a device is actually running.

Tags are vMAJOR.MINOR or vMAJOR.MINOR.PATCH. VERSION_TWEAK is set to 0: the
tag is the whole version, so a release reads exactly 1.2.0 rather than
1.2.0+<something the tag never mentioned>.
"""

import re
import sys

FIELDS = ("VERSION_MAJOR", "VERSION_MINOR", "PATCHLEVEL", "VERSION_TWEAK")


def parse_tag(tag):
    m = re.fullmatch(r"v(\d+)\.(\d+)(?:\.(\d+))?", tag.strip())
    if not m:
        raise SystemExit(
            f"error: tag {tag!r} is not vMAJOR.MINOR or vMAJOR.MINOR.PATCH"
        )
    return int(m[1]), int(m[2]), int(m[3] or 0)


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__.strip())
    tag = argv[1]
    path = "updater/VERSION"
    if "--version-file" in argv:
        path = argv[argv.index("--version-file") + 1]

    major, minor, patch = parse_tag(tag)
    values = {
        "VERSION_MAJOR": major,
        "VERSION_MINOR": minor,
        "PATCHLEVEL": patch,
        "VERSION_TWEAK": 0,
    }

    with open(path) as fh:
        lines = fh.read().split("\n")

    # Rewrite only the numeric assignments; the file's comment header explains
    # what it is for and is worth keeping.
    seen = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in values:
            lines[i] = f"{key} = {values[key]}"
            seen.add(key)

    missing = [f for f in FIELDS if f not in seen]
    if missing:
        raise SystemExit(f"error: {path} has no {', '.join(missing)} line(s)")

    with open(path, "w") as fh:
        fh.write("\n".join(lines))

    print(f"{path}: set to {major}.{minor}.{patch} from tag {tag}")


if __name__ == "__main__":
    main(sys.argv)
