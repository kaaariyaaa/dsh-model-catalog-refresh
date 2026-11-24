# dsh-model-catalog-refresh

DeepSeek Harness（DSH）の **ACP プロファイル**で使う API 系プロバイダーのモデル一覧を、起動時と 4 時間ごと、および CLI から更新するプラグインです。

特定のプロバイダー名には依存しません。ACP プロファイルに登録済みの `llm-pi-ai` ルートのうち、モデル一覧を明示している API ルートを自動で検出し、各プロバイダーのモデル一覧 API から最新の情報を取得します。

## 動作環境

| 項目 | 内容 |
| --- | --- |
| DSH | `0.2.2-rc.5` 系（`engines.dsh: >=0.2.2-0 <0.3.0`） |
| プロファイル | ACP（`@deepseek-ai/dsh-acp-app` を含むプロファイル） |
| 対象プロバイダー | `llm-pi-ai` に `api`・エンドポイント・`models` を明示したルート |
| 更新間隔 | 4 時間（固定） |
| 手動更新 | `dsh --profile acp model-refresh` |

## インストール

ローカルのチェックアウトを ACP プロファイルへ追加します。チェックアウトから入れる場合は、先にビルドしてください。

```sh
cd /path/to/dsh-model-catalog-refresh
npm ci
npm run build
dsh plugin --profile acp add /path/to/dsh-model-catalog-refresh
```

`package.json` の `dsh.bundle.patch` により、プラグインのバンドルパッチが自動で適用されます。パッチは次の 2 つを行います。

1. 更新サービス `model-catalog-refresh` をプロファイルへ追加する。
2. ACP バンドルを含むプロファイルでは、`acp-app-startup` を本プラグインの起動プラグインへ置き換え、`model-refresh` サブコマンドを追加する。

ACP 以外のプロファイルへ入れた場合、`acp-app-startup` が存在しない旨の警告が出ますが、更新サービス自体はマウントされ、起動プラグインは無効のままです。

## 使い方

### 自動更新

通常どおり ACP を起動します。

```sh
dsh --profile acp
```

ACP の起動完了後、最初の更新を非同期で実行し、その後 4 時間ごとに更新します。DSH プロセスが停止すればタイマーも停止するため、停止中に更新されることはありません。

### 手動更新

```sh
dsh --profile acp model-refresh
```

全対象プロバイダーを更新して終了します。ACP の stdio は使用しません。出力例:

```text
model-catalog-refresh: manual refresh
  opencode-go: updated — 30 models, +1, -4
  commandcode-goat: updated — 105 models, +8, -1
model-catalog-refresh: 2 updated, 0 unchanged, 0 failed in 362ms (saved)
```

- 全プロバイダーが成功または変更なし: 終了コード `0`
- 1 つ以上のプロバイダーが失敗、または設定全体の読み込みに失敗: 終了コード `1`

失敗したプロバイダーの既存一覧はそのまま残ります。

## 更新対象になるプロバイダー

`llm-pi-ai` のプロファイルが次の条件を満たす場合に対象になります。

- `api` が次のいずれか
  - `openai-completions`
  - `openai-responses`
  - `anthropic-messages`
  - `google-generative-ai`
- `models` 配列が明示されている
- `baseURL` がある。なければアダプターの既定エンドポイントを使う
- プロファイルが書き込み可能なプロファイル層（通常は `cordis.patch.yml`）にある

`apiKeyEnv` が指定されている場合は、Credentials サービス、次に起動環境の環境変数から解決します。`apiKeyEnv` がない場合は、設定済みの `headers` に認証ヘッダーがあればそれを使い、なければ未認証で取得を試みます。

`models` を省略したカタログルート（インストール済みカタログをそのまま使うルート）は、置き換えるべき保存一覧がないため対象外です。

## 更新の仕様

- 取得した一覧に**新規モデルがあれば追加**します。
- 取得した一覧に**存在しないモデルは削除**します。
- 既存モデルのエントリは**そのまま保持**します。表示名、コンテキスト長、出力上限、入力モダリティ、reasoning 設定などのユーザー設定を上書きしません。
- 新規モデルだけ、API が開示した名前・コンテキスト長・出力上限・入力モダリティを設定します。
- 書き込むのは各プロバイダーの `models` 配列だけです。`api`、`baseURL`、`apiKeyEnv`、`headers`、その他の設定は変更しません。
- プロファイルの生の設定にパスを追加して書き込むため、スキーマの既定値（`input: []` など）が既存モデルへ勝手に追加されることはありません。
- 更新後は `llm/models-updated` と `llm/adapters-updated` を発行します。ACP は `llm/adapters-updated` を受けて接続中のセッションへ `config_option_update` を送るため、DSH の再起動なしでモデル選択肢が更新されます。次に作成するセッションも新しい一覧を読みます。

### エラー時の扱い

- HTTP エラー、タイムアウト、JSON 不正、空の一覧: そのプロバイダーの既存一覧を維持します。
- **空の一覧で既存モデルを削除しません。** 空配列は取得失敗として扱います。
- 一部のプロバイダーが失敗しても、残りのプロバイダーの取得・保存を継続します。
- 自動更新と手動更新が重なった場合は、実行中の 1 回に合流します（二重実行しません）。
- 設定の保存に失敗した場合は、その書き込み対象のプロバイダーだけ失敗として報告し、他のプロバイダーの保存は継続します。

### 非チャットモデルの除外

ACP のモデル選択肢に会話を処理できないモデルを出さないため、次のようなエントリは除外します。

- `type` が `embedding`、`rerank`、`decision`、`moderation`、`image`、`audio`、`video` など
- `type` がなく、ID が `text-embedding-*`、`*-embedding-*`、`gpt-image-*`、`dall-e-*`、`whisper-*` などの非チャット系
- `object: embedding`
- 出力モダリティが明示されていて `text` を含まない
- Gemini の `supportedGenerationMethods` に `generateContent` がない

## セキュリティ

- API キーの値はログ・レポート・エラーメッセージへ出力しません。出力するのは `OPENCODE_GO_API_KEY` のような**参照名**だけです。
- HTTP エラーのメッセージには URL の origin と path だけを含め、クエリ・フラグメント・userinfo は除外します。URL にキーを埋めたエンドポイントでも値は出ません。
- ヘッダーに載せられない制御文字を含むキーは、値ではなく参照名を添えて拒否します。
- 取得した一覧の本文はログへ出しません。

## 既知の制限

- 一覧 API が 1 ページで返す範囲のみを読みます（Anthropic / Gemini は 1000 件を要求）。数千件をページングするプロバイダーは、この実装では全件を取得できません。
- REST のモデル一覧 API を持たないプロトコル（Azure OpenAI、Bedrock、Vertex AI など）は対象外です。
- 更新間隔のカスタマイズ、Web UI、プロバイダーの新規登録、認証、使用量取得は実装していません。
- ホームパッチや `--patch` オーバーレイがプロファイル層の設定を上書きしている場合、設定エディターが書き込みを拒否します。その場合はプロファイル側の設定を整理してください。
- ACP 以外のプロファイルで `model-refresh` を使うには、同等の起動プラグイン差し替えが別途必要です。

## 開発

```sh
npm install
npm test
```

実 DSH を使った統合テスト（ACP プロファイルの作成、`model-refresh` の実行、保存結果の確認）:

```sh
DSH_INTEGRATION=1 npm test
```

### 構成

| ファイル | 役割 |
| --- | --- |
| `src/index.ts` | プラグイン本体。サービス提供、4 時間スケジューラー、DSH サービスとの接続 |
| `src/acp.ts` | ACP 起動プラグイン。通常起動と `model-refresh` サブコマンド |
| `src/service.ts` | プロバイダー検出、取得、マージ、保存、レポート |
| `src/listing.ts` | 一覧 URL の組み立てとレスポンス解析・非チャット除外 |
| `src/fetch.ts` | 認証ヘッダー、タイムアウト、サイズ上限付き HTTP 取得 |
| `src/merge.ts` | 既存モデルを保持した追加・削除 |
| `src/report.ts` | CLI / ログ向けの出力 |
| `src/scheduler.ts` | 起動時 1 回 + 4 時間間隔のタイマー |
| `cordis.patch.yml` | プロファイルへ自動適用されるバンドルパッチ |

### 検証例（2026-11-24、DSH 0.2.2-rc.5）

実際の OpenCode Go / CommandCode GOAT に対して手動更新を実行し、次の差分を確認しました。

- `opencode-go`: 30 モデル（+1: `longcat-2.5`、-4）
- `commandcode-goat`: 105 モデル（+8、-1）

既存モデルの設定は変更されず、新規モデルだけが API のメタデータ付きで追加されました。
