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

集計結果を見て `config/hooks.ja.json` の型を足す・削るのが人間側の仕事で、
このワークフローで浮いた時間はここに使う。

## データの置き場所

```
liver-support/
  config/livers.json      ライバー・アカウント・素材（要作成、example をコピー）
  config/hooks.ja.json    フック型
  state/history.json      投稿履歴（クールダウン判定に使う。--commit で更新）
  build/                  計画・生成物・キュー（生成物なので git 管理外）
  assets/                 切り抜き素材（git 管理外）
```
