# Claude Agent Toolkit — 4つのGA機能の実装例

2026-08-21 に Claude Platform で GA になった 4 つの機能を、実際に動く
TypeScript コードにしたものです。

| 機能 | このリポジトリでの実装 |
| --- | --- |
| パソコン操作 (`computer_toolset_20260801`) | `src/toolsets/computer.ts` |
| ブラウザ操作 (`browser_toolset_20260801`) | `src/toolsets/browser.ts` |
| Skills API (`/v1/skills`) | `src/skills.ts` |
| Files API (`/v1/files`) | `src/files.ts` |

4 つを繋ぐエージェントループが `src/toolsets/loop.ts` です。

いずれも **beta ヘッダーは不要**になったので、`client.beta.*` ではなく
`client.messages` / `client.files` / `client.skills` を直接呼んでいます。

## セットアップ

```bash
cd examples/claude-agent-toolkit
npm install

# 認証は環境変数か ant CLI のプロファイルのどちらでも良い
export ANTHROPIC_API_KEY=sk-ant-...
# もしくは: ant auth login
```

Node 22.6 以上が必要です（`--experimental-strip-types` を使っているため）。

## 動かす

```bash
npm run typecheck   # 型チェック
npm run smoke       # API を呼ばないオフライン検証（後述）

npm run files       # 01: Files API
npm run skills      # 02: Skills API
DISPLAY=:1 npm run computer   # 03: パソコン操作
npm run browser     # 04: ブラウザ操作
```

---

## Files API — 1度上げれば使い回せる

`examples/01-files.ts`

アップロードすると `file_id` が返り、以後はバイト列ではなく ID を送ります。
同じスタイルシートに 2 つの質問をしても、アップロードは 1 回だけです。

```ts
const uploaded = await uploadFileOnce(source, indexPath, { mimeType: "text/plain" })

await client.messages.create({
  model: MODEL,
  max_tokens: 16000,
  messages: [{ role: "user", content: [
    { type: "text", text: question },
    fileBlock(uploaded),          // → { type: "document", source: { type: "file", file_id } }
  ]}],
})
```

実装で押さえている点:

- **content block の型は MIME で決まる。** PDF・テキストは `document`、画像は
  `image`、code execution に渡すものは `container_upload`。取り違えると 400
  になるので `fileBlock()` が MIME から自動で選びます。
- **ダウンロードできるのは生成物だけ。** 自分で上げたファイルは
  `downloadable: false` で、ダウンロードすると 400。skill や code execution が
  作ったファイルだけが取得できます（`generatedFileIds()` で `file_id` を拾う）。
- **重複アップロードを防ぐ。** API 側に dedupe は無いので、スクリプトを回すたびに
  1 TB の枠を消費します。`uploadFileOnce()` は SHA-256 でローカル索引を持ち、
  記録済みの ID は API 側に実在するか・期限切れでないかを毎回確認します。
- **file は workspace スコープ。** 同じ workspace の API キーなら誰でも読めます。
  エンドユーザーから受け取った `file_id` を信用してはいけません。マルチテナントに
  するならテナントごとに workspace を分けます。

上限は 1 ファイル 500 MB、組織あたり 1 TB。アップロード・ダウンロード・一覧・
削除は無料で、課金されるのはリクエストに入ったトークンだけです。

## Skills API — 1度上げて版で固定する

`examples/02-skills.ts`、サンプル skill は `skills/css-modernizer/`

`SKILL.md` を含むフォルダをアップロードすると `skill_id` が返り、以降の
アップロードはすべて **不変のバージョン**（`skver_...`）になります。

```ts
const { skill, versionId } = await upsertSkill(SKILL_DIR, "CSS modernizer")

await client.messages.create({
  model: MODEL,
  max_tokens: 16000,
  container: {
    skills: containerSkills([
      { id: skill.id, version: versionId },        // 自チームの手順書（版を固定）
      { id: "docx", version: "latest", anthropic: true },
    ]),
  },
  tools: [CODE_EXECUTION_TOOL],   // これが無いと skill は何もできない
  messages: [...],
})
```

実装で押さえている点:

- **`"latest"` は開発中だけ。** レビュー済みの手順書はレビューしたとおりに
  動いてほしいので、本番では `skver_...` を固定します。例では固定する側を
  デフォルトにしました。
- **アップロード時のファイル名がパスを兼ねる。** 全ファイルが同じトップレベル
  ディレクトリ配下で、その直下に `SKILL.md` が必要です。`skillFiles()` が
  ローカルの絶対パスではなく `css-modernizer/audit.py` 形式の名前を付けます。
- **frontmatter はローカルで検証する。** `name` は小文字英数字とハイフンのみ 64
  文字以内、`description` は 1024 文字以内。multipart を送り切ってから 400 を
  受けるより、送る前に落とすほうが速い。
- **`upsertSkill()` は冪等。** 初回は skill を作り、2 回目以降はバージョンを
  足すので、デプロイスクリプトとしてそのまま回せます。
- 1 リクエストにつき skill は最大 20 個。

## ブラウザ操作 — 座標ではなく構造で掴む

`examples/04-browser.ts`、実装は `src/toolsets/browser.ts`（Playwright ベース）

これがこの release の要点です。`read_page` / `find` がページの構造から
`[ref_N]` というハンドルを返し、`left_click` や `form_input` はそのハンドルを
受け取ります。レイアウトがズレてもピクセルが動くだけで ref は動かないので、
実行が壊れません。

```
tool_use  { name: "navigate", toolset_name: "browser", input: { url } }
tool_result { toolset_name: "browser", content: [ {type:"text"}, {type:"browser_state"} ] }
```

実装で押さえている点:

- **`toolset_name` を必ず返す。** `tools[]` のエントリは `name` を持たず 1 つだけ
  (`{ type: "browser_toolset_20260801" }`)。member 名は `tool_use.name` に、
  family 名は `toolset_name` に入ります。返す `tool_result` は同じ
  `toolset_name` を echo する必要があります。
- **`browser_state` は差分ではなく全量。** 開いているタブを毎回すべて列挙し、
  空でない限りちょうど 1 つが `active: true`。`state_changes` は「無し」を空配列
  ではなくフィールドごと省略で表し、エラー結果には付けません。この規則は
  smoke test で検証しています。
- **31 の member を実装。** navigate / screenshot / zoom / 各種クリック / hover /
  drag / scroll / scroll_to / type / key / hold_key / wait / read_page / find /
  get_page_text / form_input / file_upload / read_console / read_network /
  javascript_exec / タブ操作 4 種。
- **危険な member は既定で伏せる。** `read_console`・`read_network`・
  `javascript_exec`・`file_upload` は `configs` で明示的に有効化しない限り
  モデルに渡るスキーマから外れます。
- **allowlist は最低限の防御。** ページの内容はすべて untrusted input です。
  ホスト allowlist を渡さないと、ページに書かれた指示でエージェントが別の場所へ
  行ってしまいます。`http`/`https` 以外のスキームも拒否します。
- **ref が古くなったらエラーで返す。** クラッシュさせず、「read_page をやり直せ」
  と伝えるほうがモデルは回復できます。

## パソコン操作 — 1往復に何手も

`examples/03-computer.ts`、実装は `src/toolsets/computer.ts`

X11 を `xdotool` と ImageMagick で叩く参照実装です。任意のバックエンド
（VM、コンテナ、実機）に差し替えられるよう、`ComputerDisplay` インターフェース
との間で切ってあります。

実装で押さえている点:

- **旧 `computer_20251124` のパラメータは通らない。** `display_width_px` /
  `display_height_px` / `display_number` / `enable_zoom` は toolset エントリの
  フィールドではありません。zoom は `configs.zoom.enabled` で切ります。
- **座標変換を 1 箇所に閉じ込める。** モデルが見るのは縮小後のスクリーンショット
  なので、返ってくる座標も縮小後のピクセルです。実画面に送る前に scale で割る
  必要があり、ここを間違えるとクリックが微妙にズレます。`ComputerExecutor` が
  直近のキャプチャの scale を覚えていて、変換を一手に引き受けます。
- **既定は 1080p。** Opus 4.7 以降は長辺 2576px・約 3.75 メガピクセルまで受け
  ますが、コストと精度の釣り合いは 1080p 付近。細部を読む必要が無い run なら
  1366×768 や 720p でさらに安くなります。
- **`screenshot` と `zoom` だけが image を返す。** 他の member は `"OK"` などの
  テキストです。
- **zoom は座標系を変えない。** 拡大画像を返すだけで、モデルは引き続き全体
  スクリーンショットの座標で指示します。

## バッチ実行の作法（`src/toolsets/loop.ts`）

1 往復 1 操作でなくなった分、ホスト側の責任が増えています。ループが守っている
規則は 4 つです。

1. **モデルが出した順に、1 つずつ実行する。** 並列に投げない。
2. **最初の失敗でその family の残りを止める。** 止めた分は `is_error` と
   family ごとの halt テキストで返します（computer は
   `"Not executed: an earlier computer action in this turn failed."`、
   browser は `"Not executed: an earlier action in this turn failed."`）。
3. **別の family は巻き添えにしない。** browser の失敗で computer の操作まで
   キャンセルしない。
4. **全部の `tool_result` を 1 つの user メッセージで返す。** 複数のメッセージに
   分けると、モデルは「まとめて出しても意味が無い」と学習してバッチをやめます。
   削減したはずの往復がそのまま戻ってきます。

この 4 点は `executeBatch()` に切り出してあり、API を呼ばずに検証できます。

## オフライン検証

```bash
npm run smoke
```

`scripts/smoke.ts` は API キー無しで動きます。

- **バッチ規則**（上の 4 点）を偽の executor で検証
- **ブラウザ操作**をローカルの fixture ページに対して実行し、モデルが送るのと
  同じ `tool_use` 形状を投げて、返る `tool_result` の形を検査
- `SKILL.md` frontmatter のパース

Chromium はこの環境に同梱のものを使うため、ダウンロードは発生しません
(`/opt/pw-browsers/chromium`、`CHROMIUM_PATH` で上書き可)。

## セキュリティ

- 画面もページも **untrusted input** です。API はスクリーンショット内の
  prompt injection を検出しますが、隔離を用意するのは呼び出し側の仕事です。
- 使い捨ての VM / コンテナで、最小権限で動かす。egress は allowlist で絞る。
- 認証情報や API キーが載っている画面をモデルに見せない。
- 取り返しのつかない操作は人間の確認を挟む。
- エンドユーザーに computer use を有効化する前に、その旨を伝えて同意を取る。

## 参考

- [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)
- [Using Agent Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)
- [Files API](https://platform.claude.com/docs/en/build-with-claude/files)
- [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
