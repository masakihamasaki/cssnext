#!/usr/bin/env python3
"""Check manuscripts against a writing spec and print a Markdown table.

    python3 manuscript_lint.py --spec spec.json chapter01.docx chapter02.md

spec.json (every key is optional):
    {
      "min_chars": 4500, "max_chars": 6000,
      "required": ["反論", "明日やる一つ", "出典"],
      "banned": ["必ず", "絶対に儲かる"],
      "numbers_need_source": true
    }

Keep a spec with private rules outside the repository and pass its path.
"""

import argparse
import json
import re
import sys

NUMBER_FACT = re.compile(r"\d[\d,.]*\s*(?:万|億|兆)?\s*(?:円|%|％|人|社|件|倍|世帯|年間|ドル)")
SOURCE_HINT = re.compile(r"出典|によると|調べ|調査|発表|統計|白書|報告書|https?://")


def read_text(path):
    if path.endswith(".docx"):
        import docx
        return "\n".join(p.text for p in docx.Document(path).paragraphs)
    with open(path, encoding="utf-8") as f:
        return f.read()


def check(text, spec):
    body = re.sub(r"\s", "", text)
    issues = []
    n = len(body)
    if "min_chars" in spec and n < spec["min_chars"]:
        issues.append("字数不足 %d（下限 %d）" % (n, spec["min_chars"]))
    if "max_chars" in spec and n > spec["max_chars"]:
        issues.append("字数超過 %d（上限 %d）" % (n, spec["max_chars"]))
    for word in spec.get("required", []):
        if word not in text:
            issues.append("必要な要素なし: %s" % word)
    for word in spec.get("banned", []):
        for m in re.finditer(re.escape(word), text):
            issues.append("禁止表現「%s」: …%s…" % (word, text[max(0, m.start() - 15):m.end() + 15].replace("\n", " ")))
    if spec.get("numbers_need_source"):
        for sentence in re.split(r"(?<=[。！？])", text):
            if NUMBER_FACT.search(sentence) and not SOURCE_HINT.search(sentence):
                issues.append("数字の出典なし: %s" % sentence.strip()[:60])
    return n, issues


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--spec", help="JSON spec (see module docstring)")
    args = ap.parse_args(argv)
    spec = {}
    if args.spec:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)

    failed = 0
    print("| ファイル | 字数 | 指摘 |\n|---|---|---|")
    for path in args.files:
        n, issues = check(read_text(path), spec)
        failed += bool(issues)
        print("| %s | %d | %s |" % (path, n, "<br>".join(issues).replace("|", "｜") or "なし"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
