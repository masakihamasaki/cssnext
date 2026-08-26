# liver-support — ライバー支援 × TikTok 投稿ワークフロー

「AI に動画を1本作らせる」話ではなく、**投稿までの工程をつなげる**ための仕組み。
元ネタ（Hermes × Codex でアプリのデモ動画を TikTok に自動投稿する流れ）を、
ライバー事務所の支援業務にそのまま読み替えたもの。

| 元ネタ | ライバー支援での読み替え |
| --- | --- |
| アプリのデモ画面録画 10本 | ライバーの**配信切り抜き** 10〜30本（本人同意済み） |
| AI が作る冒頭フック文 | ジャンル・ペルソナ別の**フック型**（`config/hooks.ja.json`） |
| フック動画 + デモ動画を結合 | フックカード + 切り抜きを結合し、テロップを焼き込む |
| 複数アカウントへ展開 | **所属ライバーごと**の本人認可アカウントへ展開 |
| 広告を複数作ってテストする | 同じ素材に型の違うフックを当てる**切り口テスト**（`--experiment`） |
| AI UGC で映像そのものを作る | 本人が映らない補助映像だけの**AI生成素材レーン**（開示必須） |
| 毎日の編集作業を削る | マネージャーは**フック改善と素材選び**に時間を使う |

複数アカウント展開の意味が元ネタと決定的に違う点に注意。
同じ動画を複数アカウントへ撒くのではなく、**ライバーごとに別素材・別フック**を割り当てる。
同一文面の横流しはスパム判定と信頼の毀損に直結するため、計画段階で禁止している（`lib/plan.js`）。

## 5分で流れを見る

```sh
# ダミー素材付きのデモ設定を作る
node liver-support/test-utils/make-demo.js

# 設定と環境の点検
node liver-support/bin/lsw.js doctor --config liver-support/build/demo/livers.json

# 1週間分の投稿計画（素材 × フック × 投稿枠の割り当て）
node liver-support/bin/lsw.js plan --config liver-support/build/demo/livers.json --days 7

# 動画の組み立て（ffmpeg が無ければコマンドを build.sh に書き出すだけ）
node liver-support/bin/lsw.js build

# 投稿キュー → 投稿（既定は dry-run、既定の投稿先は本人の下書き）
node liver-support/bin/lsw.js queue
node liver-support/bin/lsw.js publish
```

## パイプライン

```
素材(切り抜き) ─┐
                ├─ plan ── build ── queue ── publish ── report ─┐
フック型 ───────┘   計画     動画     予約     投稿      集計    │
     ↑                                                          │
     └───────────── 人が判断して型を足す/削る ───────────────────┘
```

- **plan** 同意・認可・クールダウンを満たす組み合わせだけを割り当てる。シード固定で再現する
- **prompts** AI生成素材レーンのプロンプト表を出す（生成待ちの素材が対象）
- **build** フックカード + 切り抜き + テロップを ffmpeg 1コマンドで 1080×1920 の動画に
- **queue** 1行1投稿の JSONL。以降の工程はこのファイルだけを見る
- **publish** TikTok Content Posting API。既定は本人の下書き（inbox）へ送る
- **report** 結果 CSV をフック型別に集計し、次にどの型を増やすかの材料にする

## 切り口テストとAI生成素材

```sh
# 同じ素材に型の違うフックを3日間隔で当てて、どの切り口が刺さるかを測る
node liver-support/bin/lsw.js plan --experiment --days 21

# 生成待ちのAI素材のプロンプトを出す（生成後、prompt と file を登録して pending を外す）
node liver-support/bin/lsw.js prompts --liver ren
```

テストの単位はフックの**型**であって言い回しではない。素材に `segments` があれば
見せどころも変えるので、視聴者から見て別の動画になる。判定は `report` が出すが、
各切り口が2本・1000再生に届くまでは「判定保留」のまま先行だけを示す。

AI生成素材は本人が映らない補助映像（グッズカット・背景・b-roll）が対象。
`prompt` と `model` の記録が無いものは使えず、キャプションには開示が自動で入り、
直接公開はできない。本人の姿を生成する場合は `likenessConsent` が別途要る。

詳細は [docs/workflow.md](docs/workflow.md)、
フックの作り方は [docs/hook-playbook.md](docs/hook-playbook.md)、
事務所としての運用は [docs/operations.md](docs/operations.md)。

## 安全側に倒している既定値

| 項目 | 既定 | 理由 |
| --- | --- | --- |
| 投稿先 | `inbox`（本人の下書き） | 公開の最終判断はライバー本人が持つ |
| 公開実行 | `LSW_ALLOW_PUBLISH=1` が無ければ拒否 | 事故での即時公開を止める |
| 素材 | `consent: true` のみ | 切り抜き利用の同意が無いものは計画に乗らない |
| アカウント | `authorizedAt` があるもののみ | 本人が OAuth 認可したアカウントに限る |
| 素材の再利用 | 14日クールダウン | 使い回しはスパム判定と視聴者の飽きの両方に効く |
| 素材不足時 | 投稿枠を空ける | 埋めるために使い回すことはしない |
| AI生成素材 | キャプションに開示を強制 | 生成物であることを隠さない |
| AI素材を含む投稿 | 直接公開を禁止（下書き固定） | 開示が要る投稿ほど本人の確認を挟む |
| 本人の姿のAI生成 | 肖像の明示同意が無ければ除外 | 顔は同意の重さが違う |
| 切り口テストの判定 | 各切り口2本・1000再生から | 1本の当たりを勝ちパターンと誤認しない |

## 前提

- Node.js 18 以降（依存パッケージなし、`node:test` で検証）
- 動画を実際に出力するなら ffmpeg、日本語テロップには日本語フォント（`video.fontFile`）
- 投稿するならアカウントごとの TikTok アクセストークン（設定の `tokenEnv` が指す環境変数）

## テスト

```sh
node --test "liver-support/test/*.test.js"
```
