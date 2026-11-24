# dsh-model-catalog-refresh

DeepSeek Harness（DSH）の ACP プロファイルで、API プロバイダーのモデル一覧を自動更新するプラグインです。登録済みのプロバイダーからモデル一覧を取得し、ACP のモデル選択肢に反映します。

## 主な機能

- ACP 起動時と 4 時間ごとの自動更新
- CLI からの手動更新
- プロバイダー名に依存しない自動検出
- 新規モデルの追加と提供終了モデルの削除
- 引き続き提供されているモデルの設定の保持
- DSH を再起動せずにモデル選択肢を更新
- 取得に失敗したプロバイダーの既存一覧を保持

## インストール

### 動作環境

| 項目 | 要件 |
| --- | --- |
| DSH | `>=0.2.2-0 <0.3.0`（動作確認済み: `0.2.2-rc.5`） |
| Node.js | パッケージの指定は `>=20` |
| プロファイル | `@deepseek-ai/dsh-acp-app` を含む ACP プロファイル |

GitHub からプラグインを追加します。ビルド済みの `lib/` が含まれています。

```sh
dsh plugin --profile acp add github:kaaariyaaa/dsh-model-catalog-refresh
```

ローカルのチェックアウトからインストールする場合:

```sh
cd /path/to/dsh-model-catalog-refresh
npm ci
npm run build
dsh plugin --profile acp add /path/to/dsh-model-catalog-refresh
```

追加の設定は不要です。インストール時にバンドルパッチが適用されます。

## 使い方

### 自動更新

通常どおり ACP を起動します。

```sh
dsh --profile acp
```

起動完了後に非同期で初回更新を実行し、その後は 4 時間ごとに更新します。更新間隔は固定です。DSH プロセスの停止中は更新されません。

### 手動更新

```sh
dsh --profile acp model-refresh
```

対象となる全プロバイダーを更新し、結果を表示して終了します。ACP の stdio は使用しません。

出力例:

```text
model-catalog-refresh: manual refresh
  opencode-go: updated — 30 models, +1, -4
  commandcode-goat: updated — 105 models, +8, -1
model-catalog-refresh: 2 updated, 0 unchanged, 0 failed in 362ms (saved)
```

| 終了コード | 意味 |
| --- | --- |
| `0` | 更新処理が成功（変更なし、対象なしを含む） |
| `1` | 1 つ以上のプロバイダーが失敗、または更新処理全体でエラーが発生 |

## 対応プロバイダー

OpenCode Go や CommandCode GOAT など、DSH に登録済みの API プロバイダーを自動検出します。特定のサービス専用のプラグインではありません。

### 対応 API

| `api` | モデル一覧 API |
| --- | --- |
| `openai-completions` | OpenAI 互換 |
| `openai-responses` | OpenAI 互換 |
| `anthropic-messages` | Anthropic |
| `google-generative-ai` | Google Gemini |

### 更新対象の条件

DSH の設定可能なプロバイダー一覧に登録されているルート（`llm-pi-ai` など）が、次の条件を満たす必要があります。

- 対応する `api` が明示されている。
- `models` 配列が明示されている。
- `baseURL` またはアダプターの既定エンドポイントが利用できる。
- 書き込み可能なプロファイル層（通常は `cordis.patch.yml`）に設定されている。

`models` を省略し、アダプターのカタログをそのまま使用するルートは対象外です。

### 認証

`apiKeyEnv` が指定されている場合は、DSH の Credentials サービス、起動環境の環境変数の順に認証情報を取得します。

`apiKeyEnv` がない場合は、設定済みの `headers` を使用します。認証ヘッダーもない場合は未認証で取得を試みます。

## 更新仕様

### モデル一覧の変更

| 状態 | 処理 |
| --- | --- |
| API の一覧にのみ存在するモデル | 追加 |
| 既存設定と API の一覧の両方に存在するモデル | 既存設定を保持 |
| 既存設定にのみ存在するモデル | 削除 |

新規モデルには、API が公開している表示名、コンテキスト長、出力上限、入力モダリティを設定します。既存モデルのメタデータや reasoning 設定は上書きしません。

変更するのは各プロバイダーの `models` 配列のみです。`api`、`baseURL`、`apiKeyEnv`、`headers` などの設定は変更しません。プロファイルの生の設定を更新するため、スキーマの既定値（`input: []` など）が既存モデルに追加されることもありません。

### ACP への反映

保存に成功した変更は、`llm/models-updated` と `llm/adapters-updated` イベントで通知します。ACP は `config_option_update` を接続中のセッションに送信するため、DSH を再起動せずにモデル選択肢を更新できます。新規セッションにも更新後の一覧が反映されます。

### 非チャットモデル

会話用モデルの選択肢に含めないよう、次のエントリを除外します。

- embedding、rerank、decision、moderation、image、audio、video などの非チャット系 `type`
- `type` がない場合に、ID から非チャット系と判定できるモデル（`text-embedding-*`、`gpt-image-*`、`dall-e-*`、`whisper-*` など）
- `object: embedding` や embedding 用と明示されたモデル
- 出力モダリティが明示されていてテキスト出力を含まないモデル
- Gemini で `supportedGenerationMethods` が明示されていて `generateContent` を含まないモデル

### エラー処理

- HTTP エラー、タイムアウト、不正な JSON、空の一覧などの場合は既存のモデル一覧を維持します。空の一覧によって既存モデルを一括削除することはありません。
- 一部のプロバイダーが失敗しても、ほかのプロバイダーの取得と保存を続けます。保存に失敗した場合は、その書き込み対象を失敗として報告します。
- 同じサービスインスタンス内で更新要求が重なった場合は、実行中の更新処理に合流します。
- モデル一覧が取得後に変更されていないか、保存時に確認します。

### ページング

Anthropic の `has_more` / `last_id` と Gemini の `nextPageToken` に対応しています（最大 20 ページ）。

OpenAI 互換 API に統一されたページング仕様がないため、応答が次のページの存在を示す場合は更新を拒否します。ページングを示さずに切り詰められた応答は検出できないため、完全な一覧を返す API が必要です。

## セキュリティ

- 認証エラーに API キーの値や `apiKeyEnv` の参照名を含めません。
- HTTP エラーに含める URL は origin のみとし、path、query、fragment、userinfo を除外します。
- API キーの前後の空白を除去し、ヘッダーに使用できない制御文字を含むキーを拒否します。
- HTTP リダイレクトを拒否し、別オリジンへの認証ヘッダーの転送を防ぎます。
- モデル一覧 API のレスポンス本文はログに出力しません。
- 他サービスの例外は、設定値を含み得る元のメッセージではなく、例外の種類などに置き換えます。
- レポートやログのプロバイダー名・エラーから制御文字を除去し、長さを制限します。
- モデル ID は 256 文字、表示名は 200 文字を上限とし、`__proto__`、`constructor`、`prototype` をモデル ID として受け入れません。

## 制限事項

- Azure OpenAI、Bedrock、Vertex AI などの未対応プロトコルは対象外です。
- 更新間隔の変更、Web UI、プロバイダーの新規登録・認証、使用量の取得には対応していません。
- ホームパッチや `--patch` オーバーレイによって書き込みが拒否された場合は、該当するオーバーレイを外してください。
- バンドルの読み込み順序は `@deepseek-ai/dsh-acp-app` の後に本プラグインが来る必要があります。通常の `dsh plugin add` は末尾に追加します。
- ホームパッチや `--patch` で `acp` 行を再有効化すると、手動更新コマンドが正常に動作しません。
- ACP 以外のプロファイルで手動更新を利用するには、別途起動プラグインの差し替えが必要です。

## 開発

```sh
npm ci
npm test
```

実際の DSH を使用した統合テスト:

```sh
DSH_INTEGRATION=1 npm test
```

### 構成

| ファイル | 役割 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | DSH との接続、更新サービスの提供 |
| [`src/acp.ts`](src/acp.ts) | ACP 起動処理、手動更新コマンド |
| [`src/service.ts`](src/service.ts) | プロバイダー検出、取得、保存 |
| [`src/listing.ts`](src/listing.ts) | 一覧 URL の生成、レスポンス解析、モデルの絞り込み |
| [`src/fetch.ts`](src/fetch.ts) | HTTP リクエスト、認証、ページング、取得サイズと時間の制限 |
| [`src/merge.ts`](src/merge.ts) | モデル一覧の追加・削除と既存設定の保持 |
| [`src/report.ts`](src/report.ts) | CLI とログへの結果出力 |
| [`src/scheduler.ts`](src/scheduler.ts) | 起動時および定期更新のタイマー |
| [`cordis.patch.yml`](cordis.patch.yml) | バンドルパッチ |

### DSH との統合

`package.json` の `dsh.bundle.patch` により、更新サービスを追加します。ACP バンドルを含むプロファイルでは `acp-app-startup` を置き換え、通常起動と `model-refresh` に対応します。手動更新時は ACP ブリッジを無効にします。

ACP 以外のプロファイルでは `acp-app-startup` が存在しない旨の警告が出ますが、更新サービスはマウントされ、ACP 起動プラグインは無効のままです。

更新サービスがマウントされていなくても通常の ACP 起動は継続します。この場合は自動更新が無効になり、手動更新はエラーで終了します。

### 動作確認

2026-11-24、DSH `0.2.2-rc.5` で OpenCode Go と CommandCode GOAT の手動更新を確認しました。

| プロバイダー | 更新後のモデル数 | 確認した差分 |
| --- | ---: | --- |
| OpenCode Go | 31 | 初回 +1 / -4、その後 +1 |
| CommandCode GOAT | 105 | +8 / -1 |

既存モデルの設定保持、新規モデルへのメタデータの追加、空一覧・HTTP エラー時の既存一覧保持、プロバイダーごとの失敗分離を確認しています。統合テストでは CLI の終了、ACP の `session/new` と接続中のセッションへの反映も確認しています。

## ライセンス

[MIT](LICENSE)
