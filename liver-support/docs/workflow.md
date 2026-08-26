# パイプライン仕様

各ステージの入出力と、そこで守っているルール。

## 0. 素材登録（人の作業）

配信アーカイブから切り抜きを書き出し、`config/livers.json` に登録する。
1人あたり最低10本、理想は「クールダウン日数 × 1日の投稿本数」以上。
14日クールダウンで1日1本なら14本が下限で、これを下回ると投稿枠が空く（`doctor` が警告する）。

```json
{
  "id": "hina-001",
  "file": "../assets/hina/001.mp4",
  "title": "コメント読み間違えて大爆笑",
  "topic": "コメントの読み間違い",
  "tags": ["雑談", "ハプニング"],
  "telop": "コメント、盛大に読み間違えた",
  "highlightAt": 4,
  "consent": true
}
```

- `topic` / `tags` はフック文の変数として使う。ここが雑だとフックも雑になる
- `highlightAt` は「面白いところが始まる秒数」。冒頭の間延びを切る
- `consent` は本人の切り抜き利用同意。`true` 以外は一切使われない
- `telop` を省くとフック文がそのままテロップになる

### segments — 1本の素材の中の見せどころ

切り口テストで「別の瞬間」を見せるために、1つの素材に複数の見せどころを登録できる。

```json
"segments": [
  { "id": "hina-001-a", "start": 4,  "telop": "コメント、盛大に読み間違えた" },
  { "id": "hina-001-b", "start": 18, "telop": "リスナーに総ツッコミされる" },
  { "id": "hina-001-c", "start": 31, "telop": "開き直って押し切る" }
]
```

省略すると `highlightAt` から始まる1つの見せどころとして扱う。
segments が無いままテストを回すとフック文だけが変わるので、`doctor` が警告する。

### AI生成素材レーン

本人が映らない補助映像（グッズカット・背景・b-roll・フック用の抽象背景）を
AI生成で補う場合は `source: "ai"` で登録する。実写の切り抜きとは検証ルールが違う。

```json
{
  "id": "ren-ai-001",
  "source": "ai",
  "file": "../assets/ren/ai-001.mp4",
  "prompt": "縦型9:16、5秒。無地の背景に置かれたアクリルスタンドを、手だけがゆっくり回して見せる。…",
  "model": "使用した動画生成モデル名",
  "depictsLiver": false
}
```

| 項目 | 実写の切り抜き | AI生成素材 |
| --- | --- | --- |
| `consent` | 必須 | 不要（本人が映らないため） |
| `prompt` / `model` | — | 必須（何を生成したかを後から辿るため） |
| `depictsLiver: true` | — | `likenessConsent: true` が無ければ除外 |
| キャプション | 通常 | 開示文と `#AI生成` が自動で入る |
| 投稿 | inbox / direct | **direct 禁止**（本人の下書きに固定） |

`pending: true` を付けると「生成待ち」として計画から外れ、`lsw prompts` の対象になる。

## 1. plan — 割り当て

```sh
lsw plan --days 7 [--start 2026-09-01] [--seed 2026w36] [--commit]
```

入力: `config/livers.json` + `config/hooks.ja.json` + `state/history.json`
出力: `build/plan.json`

1投稿ぶんのレコードに、動画生成と投稿に必要なものが全部入る（素材パス・フック文・テロップ行・
キャプション・ハッシュタグ・投稿時刻・投稿先アカウント・出力先）。

守っているルール:

1. 同意の無い素材、本人認可の無いアカウントは対象外（`lib/config.js` で除外し警告）
2. 素材は `clipCooldownDays`（既定14日）以内に再利用しない
3. フックは `hookCooldownDays`（既定7日）以内に同じライバーで再利用しない
4. 同日に同じ文面を複数アカウントへ出さない
5. 条件を満たす組み合わせが無ければ**その枠は空ける**（`skipped` に理由が残る）

乱数はシード固定。同じ `--seed` と同じ入力なら毎回同じ計画になるので、
「先週の計画を再現して1本だけ差し替える」ができる。

`--commit` で `state/history.json` に反映され、次回以降のクールダウン判定に効く。
計画を見て気に入らなければ commit せずに `--seed` を変えて引き直す。

### 切り口テスト（--experiment）

同じ素材に**型の違う**フックを当て、どの切り口が刺さるかを測る。
`config` の `experiment.enabled` か `--experiment` で有効になる。

```
2026-09-01  v1 [意外性]  hina-001 / hina-001-a
2026-09-04  v2 [問いかけ] hina-001 / hina-001-b
2026-09-07  v3 [認知獲得] hina-001 / hina-001-c
```

- 同時に走るテストは1ライバーにつき1本、バリエーションは `maxVariants`（既定3）まで
- 間隔は `intervalDays`（既定3日）。このときだけ素材のクールダウンを外す
- バリエーションごとに**フックの型**を変える。言い回し違いでは差が出ない
- `segments` があれば見せどころも変える。視聴者から見て別の動画になる
- テストで使う予定のフックは、通常枠で先に使わないよう予約される

素材のクールダウンを外すのはここだけで、代わりに間隔と本数で歯止めをかけている。
`intervalDays` を1日に縮めると、同じ素材が連日出る。ここは縮めないこと。

同じ素材を後日また回すと、前回と同じ切り口が優先して当たる。
ラウンドごとに切り口を総入れ替えすると1本ずつのデータが散らばり、
いつまでも判定に必要な本数が貯まらないため。

## 1.5 prompts — AI生成素材のプロンプト

```sh
lsw prompts [--liver <id>] [--count <n>]
```

出力: `build/prompts.md`

`pending: true` の AI素材について、`config/ai-prompts.ja.json` の型と
素材側の `spec`（場所・被写体・雰囲気・秒数）からプロンプトを組み立てる。
制約（9:16、実在人物を出さない、画面内に文字を入れない…）は必ず付く。

生成したら `file` と実際に使った `prompt`、`model` を登録して `pending` を外す。
記録の無い生成物は計画に乗らない。

## 2. build — 動画生成

```sh
lsw build [--execute]
```

入力: `build/plan.json`
出力: `build/<日付>/<ライバーid>-<n>.mp4`（`--execute` 時）または `build/build.sh`

ffmpeg 1コマンドで完結する:

```
[lavfi color] → drawtext(フック文)          ┐
                                            ├ concat → H.264/AAC → mp4
[切り抜き] → scale/pad(1080x1920) → drawtext(テロップ) ┘
```

- テキストは filter 文字列に直書きせず `textfile=` で渡す。日本語・記号・改行のエスケープ事故を防ぐため
- フック尺は既定2.5秒。本編は `maxSeconds`（既定45秒）で頭打ち
- 縦動画に合わせて `scale` + `pad`。元が横動画でも黒帯で 9:16 に収まる
- `video.fontFile` に日本語フォントを指定しないとテロップが豆腐になる
- 音声の無い素材は `clipHasAudio: false` を付ける（無音トラックを合成する）

`--execute` を付けなければ ffmpeg は実行せず、そのまま流せる `build.sh` を書き出す。
レンダリングを別マシンや CI に投げたいときはこれを渡す。

## 3. queue — 予約

```sh
lsw queue
```

出力: `build/queue.jsonl`（1行1投稿）

`status` は `pending` → `inbox` / `published` / `failed` と遷移する。
以降の工程はこのファイルだけを見るので、手で1行消せばその投稿だけ止まる。

## 4. publish — 投稿

```sh
lsw publish [--all] [--now <ISO>] [--mode inbox|direct] [--execute]
```

TikTok Content Posting API を 3ステップで叩く。

1. `POST /v2/post/publish/inbox/video/init/`（`--mode direct` なら `/v2/post/publish/video/init/`）
2. 返ってきた `upload_url` へ動画を `PUT`
3. `POST /v2/post/publish/status/fetch/` で状態確認

AI生成素材を含む投稿は `direct` を拒否する（`ai.forceInbox`）。
`ai.sendAigcFlag` を有効にすると `post_info.is_aigc` を送るが、
フィールド名は API 側で変わりうるので既定は off。
送らない場合もキャプション側の開示は必ず入っている。

既定は **inbox**（アプリ内の下書きに送り、本人が確認して公開する）。
`direct`（即時公開）は audited scope が必要なうえ、事故が取り返せないので明示指定のみ。
direct でも `privacy_level` の既定は `SELF_ONLY`。公開範囲は設定で意図的に上げること。

実行には `--execute` と環境変数 `LSW_ALLOW_PUBLISH=1` の両方が要る。
トークンはアカウントごとの環境変数（`tokenEnv`）からのみ読み、ログには出さない。
API の仕様は変わるので、本番投入前に現行ドキュメントとエンドポイント・必須スコープを突き合わせること。

## 5. report — 集計

```sh
lsw report --metrics results/2026-09.csv
```

`post_id,views,retention3s,profile_views,follows,gifts` の CSV を投稿キューと突き合わせ、
**フック型別 / フック文別 / ライバー別**に平均を出す。並び順は3秒視聴維持率の高い順。

見るべき数字:

- **3秒維持率** — フックの強さ。ここが低い型は文言ごと捨てる
- **プロフィール遷移率** — 配信への導線。切り抜きの選び方と CTA の効き
- **フォロー / ギフト** — 支援の成果そのもの

切り口テストを回していれば、`experiments` の section が素材ごとの勝ち負けを出す。

```
hina:hina-001
  [問いかけ] toi-02    本数2  3秒維持 70.0%  再生 27500
  [意外性]  igai-02   本数2  3秒維持 61.0%  再生 13650
  [認知獲得] ninchi-02 本数1  3秒維持 34.0%  再生 4200  ※判定対象外
  → 勝ち: toi-02 [問いかけ]。この型を増やし、下位の型は外す
```

判定に使うのは `minPostsPerVariant`（既定2本）と `minViewsPerVariant`（既定1000再生）を
満たした切り口だけ。届いていないものは「判定対象外」と表示し、
条件を満たす切り口が2つ未満なら**判定保留**として先行だけを示す。
1本の当たりを勝ちパターンと誤認すると、以後ずっとそれを引きずる。

集計結果を見て `config/hooks.ja.json` の型を足す・削るのが人間側の仕事で、
このワークフローで浮いた時間はここに使う。

## データの置き場所

```
liver-support/
  config/livers.json      ライバー・アカウント・素材（要作成、example をコピー）
  config/hooks.ja.json    フック型
  config/ai-prompts.ja.json  AI生成素材のプロンプト型と制約
  state/history.json      投稿履歴（クールダウン判定に使う。--commit で更新）
  build/                  計画・生成物・キュー（生成物なので git 管理外）
  assets/                 切り抜き素材（git 管理外）
```
