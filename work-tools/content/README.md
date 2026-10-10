# コンテンツ制作ツール

Python 3.10 以上と `python-pptx`、`python-docx` が必要（`pip install python-pptx python-docx`）。

| ツール | 用途 |
|---|---|
| `narration.py` | 原稿（md / txt / html / docx）を、1枚1文・読み上げ表記の pptx に変換。系列違い（定型文の差し込み）も同時に作る |
| `readings.py` | 数字を漢字の読みに（2027 → 二千二十七）、英字略語をカタカナに（AI → エーアイ） |
| `readings_dict.json` | 一般的な読み辞書。**人名・地名・社名など非公開の読みは別ファイルにして `--dict` で渡す** |
| `manuscript_lint.py` | 字数・必要な要素・禁止語・出典のない数字を点検 |

```
python3 work-tools/content/narration.py 原稿.md --series ABC --out-dir out/
python3 work-tools/content/manuscript_lint.py --spec 仕様.json 第1章.docx
python3 -m unittest discover -s work-tools/content    # テスト
```
