#!/usr/bin/env python3
"""Report which cssnext-transpiled features a stylesheet uses.

Usage: python audit.py FILE [FILE ...]

Prints a single JSON object to stdout:

    {"files": [...], "features": [{"feature", "file", "line", "match"}, ...]}
"""

import json
import re
import sys

PATTERNS = [
    ("custom-properties", re.compile(r"--[\w-]+\s*:")),
    ("var-function", re.compile(r"\bvar\(\s*--[\w-]+")),
    ("custom-media", re.compile(r"@custom-media\b")),
    ("custom-selectors", re.compile(r"@custom-selector\b")),
    ("apply-rule", re.compile(r"@apply\b")),
    ("nesting", re.compile(r"^\s*&[\s>+~.:\[]")),
    ("color-function", re.compile(r"\bcolor\(")),
    ("hwb-color", re.compile(r"\bhwb\(")),
    ("gray-color", re.compile(r"\bgray\(")),
    ("rgba-hex", re.compile(r"#[0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?\b")),
    ("rebeccapurple", re.compile(r"\brebeccapurple\b")),
    ("font-variant", re.compile(r"\bfont-variant\s*:")),
    ("filter", re.compile(r"\bfilter\s*:")),
    ("initial-value", re.compile(r":\s*initial\b")),
    ("rem-unit", re.compile(r"\d(?:\.\d+)?rem\b")),
    ("pseudo-element-double-colon", re.compile(r"::(before|after|first-line|first-letter)\b")),
    ("matches-pseudo", re.compile(r":matches\(")),
    ("not-pseudo-list", re.compile(r":not\([^)]*,")),
    ("any-link-pseudo", re.compile(r":any-link\b")),
    ("attribute-case-insensitive", re.compile(r"\[[^\]]+\si\]")),
    ("media-range", re.compile(r"@media[^{]*[<>]=?")),
    ("overflow-wrap", re.compile(r"\boverflow-wrap\s*:")),
    ("system-ui-font", re.compile(r"\bsystem-ui\b")),
]


def audit(path):
    findings = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for number, line in enumerate(handle, start=1):
            for feature, pattern in PATTERNS:
                found = pattern.search(line)
                if found:
                    findings.append(
                        {
                            "feature": feature,
                            "file": path,
                            "line": number,
                            "match": found.group(0).strip(),
                        }
                    )
    return findings


def main(argv):
    paths = argv[1:]
    if not paths:
        print("usage: audit.py FILE [FILE ...]", file=sys.stderr)
        return 2

    features = []
    for path in paths:
        try:
            features.extend(audit(path))
        except OSError as error:
            print(f"skipped {path}: {error}", file=sys.stderr)

    json.dump({"files": paths, "features": features}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
