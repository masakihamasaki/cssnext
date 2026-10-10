"""Rewrite Japanese text so that text-to-speech reads it correctly.

Numbers become kanji readings (2027 -> 二千二十七), and English words or
abbreviations become katakana (AI -> エーアイ). Anything that cannot be
converted safely is left as is and reported, so a person can decide.
"""

import json
import os
import re

DIGITS = "〇一二三四五六七八九"
SMALL_UNITS = [(1000, "千"), (100, "百"), (10, "十")]
LARGE_UNITS = ["", "万", "億", "兆", "京"]

LETTERS = {
    "A": "エー", "B": "ビー", "C": "シー", "D": "ディー", "E": "イー",
    "F": "エフ", "G": "ジー", "H": "エイチ", "I": "アイ", "J": "ジェー",
    "K": "ケー", "L": "エル", "M": "エム", "N": "エヌ", "O": "オー",
    "P": "ピー", "Q": "キュー", "R": "アール", "S": "エス", "T": "ティー",
    "U": "ユー", "V": "ブイ", "W": "ダブリュー", "X": "エックス",
    "Y": "ワイ", "Z": "ゼット",
}

DEFAULT_DICT = os.path.join(os.path.dirname(__file__), "readings_dict.json")

# Spelling out an unknown all-caps word is only safe for short abbreviations.
MAX_SPELLED_LETTERS = 5


def _four_digits(n):
    out = ""
    for value, unit in SMALL_UNITS:
        q, n = divmod(n, value)
        if q:
            out += ("" if q == 1 else DIGITS[q]) + unit
    if n:
        out += DIGITS[n]
    return out


def number_to_kanji(n):
    """Read a non-negative integer the way it is spoken: 1873 -> 千八百七十三."""
    if n == 0:
        return "ゼロ"
    groups = []
    while n:
        n, rest = divmod(n, 10000)
        groups.append(rest)
    if len(groups) > len(LARGE_UNITS):
        raise ValueError("number too large")
    out = ""
    for i in range(len(groups) - 1, -1, -1):
        g = groups[i]
        if not g:
            continue
        # 一万 / 一億 keep their 一; only 千百十 drop it.
        text = "一" if (i and g == 1) else _four_digits(g)
        out += text + LARGE_UNITS[i]
    return out


def _decimal_to_kanji(text):
    whole, _, frac = text.partition(".")
    out = number_to_kanji(int(whole))
    if frac:
        out += "点" + "".join(DIGITS[int(d)] if d != "0" else "ゼロ" for d in frac)
    return out


def load_dictionaries(extra_paths=()):
    """Load the bundled dictionary plus optional private ones (later wins).

    Returns (words, phrases): "words" are English words matched whole and
    case-insensitively; "phrases" are exact substrings replaced first, for
    Japanese terms that text-to-speech misreads (事業承継 -> 事業しょうけい).
    """
    words, phrases = {}, {}
    for path in [DEFAULT_DICT, *extra_paths]:
        if not path:
            continue
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        words.update({k.lower(): v for k, v in data.get("words", {}).items()})
        phrases.update(data.get("phrases", {}))
    return words, phrases


def load_dictionary(extra_paths=()):
    return load_dictionaries(extra_paths)[0]


NUMBER_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9&.'+\-]*[A-Za-z0-9+]|[A-Za-z]")


class Converter:
    def __init__(self, dictionary=None, phrases=None):
        if dictionary is None:
            dictionary, default_phrases = load_dictionaries()
            phrases = default_phrases if phrases is None else phrases
        self.words = dictionary
        self.phrases = sorted((phrases or {}).items(), key=lambda kv: -len(kv[0]))
        self.replaced = {}
        self.unknown = set()

    def _record(self, before, after):
        self.replaced[before] = after

    def _word(self, match):
        word = match.group(0)
        hit = self.words.get(word.lower())
        if hit is not None:
            self._record(word, hit)
            return hit
        # Split letters from digits (GPT4 -> GPT + 4) and try each part.
        parts = re.findall(r"[A-Za-z]+|\d+|[^A-Za-z\d]+", word)
        out = []
        for part in parts:
            if part.isdigit():
                out.append(number_to_kanji(int(part)))
            elif part.isalpha():
                hit = self.words.get(part.lower())
                if hit is not None:
                    out.append(hit)
                elif part.isupper() and len(part) <= MAX_SPELLED_LETTERS:
                    out.append("".join(LETTERS[c] for c in part))
                else:
                    self.unknown.add(word)
                    return word
            elif part == "&":
                out.append("アンド")
            elif part in "-.":
                continue
            else:
                self.unknown.add(word)
                return word
        result = "".join(out)
        self._record(word, result)
        return result

    def _number(self, match):
        raw = match.group(0)
        result = _decimal_to_kanji(raw.replace(",", ""))
        self._record(raw, result)
        return result

    def convert(self, text):
        for before, after in self.phrases:
            if before in text:
                text = text.replace(before, after)
                self._record(before, after)
        text = text.replace("%", "パーセント").replace("％", "パーセント")
        text = re.sub(r"(?<=\d)\s*[〜~～]\s*(?=\d)", "から", text)
        # Full-width digits and letters behave like half-width ones.
        text = text.translate(str.maketrans(
            "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
            "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ",
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"))
        text = WORD_RE.sub(self._word, text)
        text = NUMBER_RE.sub(self._number, text)
        return text
