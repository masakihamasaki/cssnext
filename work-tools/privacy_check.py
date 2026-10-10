#!/usr/bin/env python3
"""Refuse to publish personal or client details from this public repository.

    python3 work-tools/privacy_check.py --diff            # added lines vs origin/master
    python3 work-tools/privacy_check.py --diff --cached   # staged lines only
    python3 work-tools/privacy_check.py FILE...           # whole files

Flags e-mail addresses, phone numbers, yen amounts, links to private Google
Docs / Drive / Gmail / Slack, and long Drive file ids. Terms that must never
appear (people, clients, campaigns) go in a private block list that lives
outside the repository: $WORK_PRIVATE_BLOCKLIST, or
~/.config/work-automation/blocklist.txt (one term per line).

A line containing "privacy-check: allow" is skipped.
Exit status 1 when anything is found.
"""

import argparse
import os
import re
import subprocess
import sys

ALLOWED_EMAILS = re.compile(r"noreply@anthropic\.com|@example\.(com|org|net|jp)$|^user@", re.I)
PATTERNS = [
    ("メールアドレス", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("電話番号", re.compile(r"(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)")),
    ("金額", re.compile(r"\d[\d,]*(?:\.\d+)?\s*(?:万|億)?\s*円")),
    ("非公開リンク", re.compile(r"(docs|drive|mail)\.google\.com/|\.slack\.com/archives|hennge|secure-transfer", re.I)),  # privacy-check: allow
    ("DriveのファイルID", re.compile(r"(?<![\w-])1[A-Za-z0-9_-]{32,}(?![\w-])")),
]
ALLOW_MARK = "privacy-check: allow"


def blocklist():
    path = os.environ.get("WORK_PRIVATE_BLOCKLIST") or os.path.expanduser("~/.config/work-automation/blocklist.txt")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [t.strip() for t in f if t.strip() and not t.startswith("#")]


def added_lines(base, cached):
    merge_base = subprocess.run(["git", "merge-base", "HEAD", base], capture_output=True, text=True).stdout.strip() or base
    cmd = ["git", "diff", "--unified=0", "--no-color"] + (["--cached"] if cached else []) + [merge_base]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    path, num = None, 0
    for line in out.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            num = int(re.search(r"\+(\d+)", line).group(1))
        elif line.startswith("+") and path:
            yield path, num, line[1:]
            num += 1
    if not cached:
        # New files that are not staged yet are not in `git diff`.
        untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"],
                                   capture_output=True, text=True).stdout.split()
        yield from file_lines(p for p in untracked if os.path.isfile(p))


def file_lines(paths):
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as f:
            for num, line in enumerate(f, 1):
                yield path, num, line.rstrip("\n")


def scan(lines, terms):
    found = []
    for path, num, text in lines:
        if ALLOW_MARK in text:
            continue
        for label, pat in PATTERNS:
            for m in pat.finditer(text):
                if label == "メールアドレス" and ALLOWED_EMAILS.search(m.group(0)):
                    continue
                found.append((path, num, label, m.group(0)))
        for term in terms:
            if term in text:
                found.append((path, num, "非公開リストの語", term))
    return found


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--diff", action="store_true", help="scan lines added since the base branch")
    ap.add_argument("--cached", action="store_true", help="with --diff: staged changes only")
    ap.add_argument("--base", default="origin/master")
    args = ap.parse_args(argv)
    lines = added_lines(args.base, args.cached) if args.diff else file_lines(args.files)
    found = scan(lines, blocklist())
    for path, num, label, hit in found:
        print("%s:%d: %s: %s" % (path, num, label, hit), file=sys.stderr)
    if found:
        print("公開リポジトリに載せてはいけない情報があります。消すか伏せてください。"
              "（誤検出なら行に「privacy-check: allow」と書く）", file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
