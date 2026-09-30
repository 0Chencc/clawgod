# ClawGod

[English](README.md) | [中文](README_ZH.md) | [日本語](README_JP.md)

[![Latest](https://img.shields.io/github/v/release/0chencc/clawgod?style=flat&label=Latest)](https://github.com/0Chencc/clawgod/releases/latest)
[![Released](https://img.shields.io/github/release-date/0chencc/clawgod?style=flat&label=Released)](https://github.com/0Chencc/clawgod/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/0chencc/clawgod/total?style=flat&label=Downloads)](https://github.com/0Chencc/clawgod/releases)
[![Compat](https://img.shields.io/github/actions/workflow/status/0chencc/clawgod/compat-daily.yml?branch=main&style=flat&label=Compat)](https://github.com/0Chencc/clawgod/actions/workflows/compat-daily.yml)
[![Claude tested](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/0Chencc/clawgod/badges/claude-version.json&style=flat)](https://github.com/0Chencc/clawgod/actions/workflows/compat-daily.yml)

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ゴッドモード。

**これはサードパーティ製の Claude Code クライアントではありません。** ClawGod は公式 Claude Code の上に適用されるランタイムパッチです。どのバージョンにも対応し、Claude Code が更新されると次回起動時に自動的に新バージョンから再抽出・再パッチを行います。

## 必要条件

ClawGod インストーラ実行**前**に揃えておくもの：

| ツール | 用途 | インストール |
|--------|------|-------------|
| **Claude Code**（ネイティブバイナリ） | ClawGod は既に入っている公式 Bun standalone バイナリにパッチを当てる | [`claude.ai/install.sh`](https://claude.ai/install.sh)（macOS/Linux）または [`claude.ai/install.ps1`](https://claude.ai/install.ps1)（Windows） |
| **ripgrep** | Claude Code の Grep ツールが必須 | `brew install ripgrep` / `apt install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` |
| **Node.js >= 18** | パッチャが利用 | [nodejs.org](https://nodejs.org) |
| **Bun** | パッチ済み cli.js の実行ランタイム、未検出時は自動インストール | [bun.sh](https://bun.sh)、`npm install -g bun`、`scoop install bun`、または `choco install bun` |

## インストール

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

緑のロゴ = パッチ適用済み。オレンジのロゴ = オリジナル。

![ClawGod 適用結果](bypass.png)

## 機能一覧

### 機能アンロック

| パッチ | 内容 |
|--------|------|
| **内部ユーザーモード** | 24以上の隠しコマンド（`/share`、`/teleport`、`/issue`、`/bughunter`...）、デバッグログ、APIリクエストダンプ |
| **GrowthBook オーバーライド** | 設定ファイルで任意のフィーチャーフラグを上書き |
| **Agent Teams** | マルチエージェント協調、フラグ不要 |
| **Computer Use** | Max/Proサブスク不要で画面操作（macOS） |
| **Auto-mode** | サードパーティ API ユーザー向け auto-mode のロック解除（firstParty 制限を撤去） |
| **Classifier チューニング** | auto-mode 分類器の調整：タイムアウト / モデル / リトライ回数（`CLAWGOD_CLASSIFIER_TIMEOUT_MS`、`CLAWGOD_CLASSIFIER_MODEL`、`CLAWGOD_CLASSIFIER_RETRIES`） |
| **Ultraplan** | Claude Code Remote 経由のマルチエージェント計画 |
| **Ultrareview** | Claude Code Remote 経由の自動バグ検出 |

### 制限の解除

| パッチ | 解除内容 |
|--------|---------|
| **CYBER_RISK_INSTRUCTION** | セキュリティテスト拒否プロンプト（ペネトレーション、C2、エクスプロイト） |
| **URL制限** | 「URLを生成・推測してはならない」指示 |
| **慎重操作** | 破壊的操作前の強制確認 |
| **ログイン通知** | 起動時の「未ログイン」リマインダー |

### 地域ステガノグラフィー無効化

| パッチ | 無効化される内容 |
|--------|-----------------|
| **日付文字列 (qla)** | システムプロンプトが Unicode アポストロフィ変体（U+0027 / U+2019 / U+02BC / U+02B9）と日付区切り文字（CN タイムゾーンでは `-` → `/`）でユーザーの地理情報をエンコード。パッチにより常に ASCII `'` と元の日付形式を使用 |
| **地域検出プローブ (rdp)** | クライアント側の3軸検出：タイムゾーン（`Asia/Shanghai` / `Asia/Urumqi`）、プロキシホスト名の XOR 難読化 100+ ドメインブロックリスト照合、ベース URL 内の中国 LLM ベンダーキーワード。パッチにより常に null を返却 |
| **アポストロフィセレクター (odp)** | 検出結果に基づき4種の Unicode アポストロフィから1つを選択。パッチにより常に ASCII `'` を返却（多層防御） |

### ビジュアル

| パッチ | 効果 |
|--------|------|
| **グリーンテーマ** | ブランドカラー → 緑。パッチ適用を一目で確認 |
| **メッセージフィルター** | Anthropic 社外ユーザーに非表示のコンテンツを表示 |

### 信頼性

| 機能 | 効果 |
|------|------|
| **Glob/Grep 復元** | Bun コンパイル時に `EMBEDDED_SEARCH_TOOLS=true` がリテラルとしてインライン化され、内蔵の Glob/Grep ツールが非表示になります。パッチにより env チェックを復元し、bfs/ugrep バイナリの可用性検出を追加 — Bun ランタイム実行時にツールが自動復元されます |
| **1h Prompt Cache** | 1h TTL allowlist を強制有効化（デフォルトは実質 5m → アイドル後の cache_creation トークン浪費を防止） |
| **サードパーティ Cache 修正** | `baseURL` が Anthropic 以外を指す場合、`x-anthropic-billing-header` を自動的に無効化します。このヘッダーの `cch` フィールドはリクエストごとに変化するため、DeepSeek / OneAPI / Bedrock / vLLM など Anthropic 互換プロキシでは prompt-cache ヒット率がゼロになります。`CLAUDE_CODE_ATTRIBUTION_HEADER=0` を自分で設定する必要はもうありません。 |
| **自動再パッチ** | ユーザーがネイティブ Claude バイナリをアップグレードすると、次回起動時に自動的に再抽出・再パッチ |
| **アップデート通知** | 24時間ごとに GitHub releases を非同期チェック（ノンブロッキング）。新バージョンが利用可能な場合、起動前に1行の通知を表示 |
| **リーン設定** | `~/.claude/settings.json` の3段階トークン最適化。**on**（デフォルト）：未使用ツール定義の削除 + Workflows/Artifact 無効化（Remote Control は利用可能）。**max**：Remote Control を無効化し、Plan mode、Agent Teams、内蔵スキルも追加削除。**off**：全ツール復元 |

> **リーン設定**は既存の設定を壊さず、アップデート後も選択が維持されます。いつでも切替：`claude --lean-on`（デフォルト）/ `claude --lean-max`（アグレッシブ）/ `claude --lean-off`（全復元）。個別設定の解除は自分で値を設定（例：`"disableArtifact": false`）。

Remote Control（`/remote-control`、`/rc`）は **on/off** で利用可能、**max** のみデフォルトで無効です。on モードでの更新または `claude --lean-on` で旧 Lean の無効化設定を解除します。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` のデフォルト設定も **max** のみ適用し、ユーザーが明示した環境変数は維持します。アカウント、認証、接続先、組織ポリシーの利用条件は引き続き適用されます。

## コマンド

```bash
claude              # パッチ済み Claude Code（公式 launcher を置き換え）
clawgod             # `claude` と同じ、明示的かつ常に動作するエントリポイント
claude.orig         # オリジナル未修正版（自動バックアップ） 
```

`clawgod` は曖昧さのないエントリポイントです：Windows で `claude.exe` が `claude.cmd` を覆い隠す場合でも `clawgod.cmd` は常に動作し、公式自動更新で `claude` が上書きされても `clawgod` はパッチ済みビルドを実行し続けます。

## 設定

初回起動時に `~/.clawgod/provider.json` が自動生成されます。`apiKey` を設定すれば **OAuth ログイン不要**で、Anthropic 互換エンドポイントに接続できます。

```json
{
  "apiKey": "sk-ant-...",
  "baseURL": "https://api.anthropic.com",
  "model": "",
  "smallModel": "",
  "effort": "",
  "timeoutMs": 3000000
}
```

- **`apiKey` を設定**：ClawGod が `ANTHROPIC_API_KEY` として注入し、`~/.claude/settings.json` から隔離します。既定では Anthropic Messages 互換のエンドポイントが必要です。Chat Completions ゲートウェイには以下の設定を使用します。`baseURL` が Anthropic 以外を指す場合、ゲートウェイ認証用に `ANTHROPIC_AUTH_TOKEN` のみが設定されます。
- **`apiKey` 未設定**：OAuth パス。一度 `claude auth login` を実行すれば、`~/.claude` 配下の subagents / skills / MCP はそのまま使えます。
- **`effort`**：推論の強度を設定します。既存の `CLAUDE_CODE_EFFORT_LEVEL` が優先されます。`protocol: "openai-chat"`、`type: "grok"` または `"openai-compat"` では、Claude がカスタムモデルの effort を送信しなくても、プロキシが設定値を `reasoning_effort` として送信します。`low`、`medium`、`high`、`xhigh` はそのまま、`max` は `xhigh` に変換し、`auto` はパラメーターを省略して上流の既定値を使います。上流モデルが対応する値を選んでください。設定が空または未設定ならリクエストの effort を使い、リクエストにもなければ追加しません。

### OpenAI Chat Completions エンドポイント

上流が `/v1/chat/completions` を提供する場合は、次のように設定します。

```json
{
  "protocol": "openai-chat",
  "apiKey": "sk-...",
  "baseURL": "https://example.com/v1",
  "model": "上流のモデル名",
  "smallModel": "上流のモデル名"
}
```

`baseURL` は API のベース URL（必要なら `/v1` を含む）です。完全な `/chat/completions` パスは指定しません。モデル名には上流が受け付ける ID を指定してください。変換プロキシはランチャーと同じプロセスで動作し、外部ゲートウェイや別サービスは不要です。`timeoutMs` は上流リクエストとストリームにも適用され、既存の `API_TIMEOUT_MS` が優先されます。

- `protocol` を省略すると従来の動作を維持します。`type: "openai-compat"` と `type: "grok"` も引き続き利用でき、明示した `protocol` が優先されます。`protocol: "anthropic"` は Messages を直接使用します。Grok は `https://api.x.ai/v1` が既定で、設定ファイル・環境変数からのキー取得も維持します。他の Chat プロバイダーには API ベース URL とキーが必要です。
- テキスト、system、ツール呼び出しと結果、ツール選択・並列実行の制御、ストリーミング、usage、base64/URL 画像に対応します。並列ツール引数は組み立て・検証後に内容ブロックを送信し、テキストは即時に配信します。上流から usage が届かない場合はゼロのままです。
- base64 PDF は Chat Completions の `file` に変換するため、上流モデル/API のファイル対応が必要です。テキスト文書はテキストへ変換します。PDF URL、文書の引用、非テキストのツール結果、サーバーツール、構造化出力形式には明示的なエラーを返します。過去の Anthropic thinking/signature ブロックは省略され、モデル固有の推論機能は完全には変換できません。
- `/v1/messages/count_tokens` はローカル推定で、課金される生成リクエストを追加しません。応答ヘッダー `x-clawgod-token-count: estimate` で推定と示します。テキストの UTF-8 バイト数 / 3 とメッセージ分の加算、画像ごとに 1600 token、PDF は復号後バイト数 / 3 を使います。モデルの tokenizer ではなく、PDF のバイト数もページ数とは異なるため、コンテキスト上限内に収まる保証はありません。
- Chat の `stop` は自然終了と停止シーケンスを区別しないため、`end_turn` に変換します（ツール呼び出しを含む応答では `tool_use`）。`length`、`tool_calls`、`content_filter` はそれぞれ `max_tokens`、`tool_use`、`refusal` です。HTTP エラーの状態コードと `Retry-After` を保持し、壊れた・途中で切れたストリームはエラーになります。
- `/v1/responses` と自動プロトコル検出は未対応です。`openai-chat` は Chat Completions エンドポイントにのみ使用してください。

### 機能トグル

`~/.clawgod/patches.json`（初回インストール時に自動生成）で機能を恒久的にオフにできます。設定はアップデート・再インストール後も保持されます。記載のない key はデフォルトでオンです。

```json
{ "theme": false, "geo-neutralize": false }
```

| Feature id | 対象 |
|------------|------|
| `agent-teams` | Agent Teams 常時有効 |
| `computer-use` | Computer Use アンロック |
| `ultraplan` | Ultraplan コマンド |
| `ultrareview` | Ultrareview コマンド |
| `voice-mode` | Voice Mode |
| `auto-mode` | サードパーティ API での auto-mode モデル選択 |
| `classifier-tuning` | auto-mode 分類器の上書き：`CLAWGOD_CLASSIFIER_TIMEOUT_MS`（deadline の下限；未設定=コンテキストにより 60-120s、v2.1.251+ 必要）、`CLAWGOD_CLASSIFIER_MODEL`、`CLAWGOD_CLASSIFIER_RETRIES`（未設定=4） |
| `theme` | 緑色ブランド/ロゴ配色 |
| `geo-neutralize` | system prompt の地域/プロキシステガノグラフィ中和 |
| `cyber-risk` | system prompt から CYBER_RISK_INSTRUCTION を削除 |
| `url-restriction` | URL 生成制限を削除 |
| `cautious-actions` | "Executing actions with care" セクションを削除 |
| `not-logged-in` | "Not logged in" 通知を削除 |
| `message-filter` | 非 ant ユーザ向けメッセージ/添付フィルタを回避 |

単一起動のみの指定は環境変数で — feature id を大文字化、ハイフンはアンダースコアに：

```bash
CLAWGOD_FEATURE_THEME=false claude          # この起動のみ緑テーマをオフ
CLAWGOD_FEATURE_GEO_NEUTRALIZE=true claude  # patches.json でオフにした機能を一時的に戻す
```

## 仕組み

`@anthropic-ai/claude-code` v2.1.113 以降、npm パッケージは `cli.js` を同梱せず、プラットフォーム固有の Bun standalone バイナリへ転送する thin loader だけになりました。ClawGod は次のように対応しています：

1. `~/.local/share/claude/versions/` からユーザの Bun ネイティブバイナリを検出
2. `__BUN` セグメント（Mach-O / ELF / PE）から埋め込まれた `cli.js` ソースを抽出
3. 埋め込まれた `.node` ネイティブモジュール（audio-capture、image-processor、computer-use-*、url-handler）を `~/.clawgod/vendor/` に抽出
4. `/$bunfs/...` 仮想パスをローカル vendor パスに書き換え
5. 29 個の正規表現パッチを適用（バージョン横断的——同じ regex 群で複数リリースをカバー）
6. `claude` / `clawgod` ランチャが Bun ランタイムでパッチ済み cli.js を実行

`~/.clawgod/.source-version` がパッチ時のバージョンを記録します。起動毎に wrapper がそれと `versions/` の最新バイナリを比較し、ユーザが公式手段で Claude Code をアップグレードした場合は次回起動時に自動再パッチが走ります。

## アップデート

**そのまま `claude update` を実行するだけで OK です。** ClawGod はこのコマンドを自身のインストーラへ流すようパッチしており、npm から Anthropic の現行リリース（`@anthropic-ai/claude-code-<plat>@latest`）を取得し、cli.js を再抽出、パッチを再適用、launcher を書き直します。そのため上流の `claude update` コマンドは期待通りに動作します——1 コマンドで最新の Claude を取得し、パッチも適用された状態を保てます。

追加オプション：

```bash
claude update --version 2.1.180   # 特定の Claude Code バージョンに固定
claude update --no-upgrade        # インストール済みの Claude バージョンに再パッチ
```

`--version` は新リリースに問題がある場合、動作確認済みバージョンに留まりたいときに便利です。`--no-upgrade` はインストール済みバージョンの未変更ソース全体のバックアップから最新のパッチを再適用します。バックアップのない旧インストールでは、同じ Claude バージョンを一度だけダウンロードして復元します。以降はローカルのバックアップを再利用します。

直接インストーラを実行したい場合（効果は同じで、どちらも同じ上流リリースを取得してパッチを当て直します）：

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

ClawGod を外して Anthropic 本来の `claude update`（独自に管理されたパスへ書き込み、私たちの launcher を上書きします）を使いたい場合は、先にアンインストールしてください：

```bash
bash ~/.clawgod/install.sh --uninstall
```

## アンインストール

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash -s -- --uninstall
hash -r  # シェルキャッシュをリフレッシュ
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 -OutFile install.ps1; .\install.ps1 -Uninstall
```

アンインストールは `claude.orig` を `claude` に戻し、`clawgod` エイリアスを削除します。

> インストール・アンインストール後、コマンドがすぐに反映されない場合はターミナルを再起動するか `hash -r` を実行してください。

## ライセンス

GPL-3.0 — Anthropic とは無関係です。自己責任でご使用ください。

## Star History

<a href="https://www.star-history.com/?repos=0chencc%2Fclawgod&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&theme=dark&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
 </picture>
</a>
