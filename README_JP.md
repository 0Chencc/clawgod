# ClawGod

[English](README.md) | [中文](README_ZH.md) | [日本語](README_JP.md)

[![Latest](https://img.shields.io/github/v/release/0chencc/clawgod?style=flat&label=Latest)](https://github.com/0Chencc/clawgod/releases/latest)
[![Released](https://img.shields.io/github/release-date/0chencc/clawgod?style=flat&label=Released)](https://github.com/0Chencc/clawgod/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/0chencc/clawgod/total?style=flat&label=Downloads)](https://github.com/0Chencc/clawgod/releases)

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ゴッドモード。

**これはサードパーティ製の Claude Code クライアントではありません。** ClawGod は公式 Claude Code の上に適用されるランタイムパッチです。どのバージョンにも対応し、Claude Code が更新されると次回起動時に自動的に新バージョンから再抽出・再パッチを行います。

## 必要条件

ClawGod インストーラ実行**前**に揃えておくもの：

| ツール | 用途 | インストール |
|--------|------|-------------|
| **Claude Code**（ネイティブバイナリ） | ClawGod は既に入っている公式 Bun standalone バイナリにパッチを当てる | [`claude.ai/install.sh`](https://claude.ai/install.sh)（macOS/Linux）または [`claude.ai/install.ps1`](https://claude.ai/install.ps1)（Windows） |
| **ripgrep** | Claude Code の Grep ツールが必須 | `brew install ripgrep` / `apt install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` |
| **Node.js >= 18** | パッチャが利用 | [nodejs.org](https://nodejs.org) |

[Bun](https://bun.sh) はパッチ済み cli.js を実行するランタイム——インストーラが見つからない場合は自動でインストールします。

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
| **Ultraplan** | Claude Code Remote 経由のマルチエージェント計画 |
| **Ultrareview** | Claude Code Remote 経由の自動バグ検出 |

### 制限の解除

| パッチ | 解除内容 |
|--------|---------|
| **CYBER_RISK_INSTRUCTION** | セキュリティテスト拒否プロンプト（ペネトレーション、C2、エクスプロイト） |
| **URL制限** | 「URLを生成・推測してはならない」指示 |
| **慎重操作** | 破壊的操作前の強制確認 |
| **ログイン通知** | 起動時の「未ログイン」リマインダー |

### ビジュアル

| パッチ | 効果 |
|--------|------|
| **グリーンテーマ** | ブランドカラー → 緑。パッチ適用を一目で確認 |
| **メッセージフィルター** | Anthropic 社外ユーザーに非表示のコンテンツを表示 |

### 信頼性

| 機能 | 効果 |
|------|------|
| **1h Prompt Cache** | 1h TTL allowlist を強制有効化（デフォルトは実質 5m → アイドル後の cache_creation トークン浪費を防止） |
| **自動再パッチ** | ユーザーがネイティブ Claude バイナリをアップグレードすると、次回起動時に自動的に再抽出・再パッチ |

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
  "timeoutMs": 3000000
}
```

- **`apiKey` を設定**：ClawGod が `ANTHROPIC_API_KEY` として注入し、`~/.claude/settings.json` から隔離します。Anthropic / DeepSeek など OpenAI 互換ゲートウェイでも動作。`baseURL` が Anthropic 以外を指す場合、ゲートウェイ認証用に `ANTHROPIC_AUTH_TOKEN` も自動設定されます。
- **`apiKey` 未設定**：OAuth パス。一度 `claude auth login` を実行すれば、`~/.claude` 配下の subagents / skills / MCP はそのまま使えます。

## 仕組み

`@anthropic-ai/claude-code` v2.1.113 以降、npm パッケージは `cli.js` を同梱せず、プラットフォーム固有の Bun standalone バイナリへ転送する thin loader だけになりました。ClawGod は次のように対応しています：

1. `~/.local/share/claude/versions/` からユーザの Bun ネイティブバイナリを検出
2. `__BUN` セグメント（Mach-O / ELF / PE）から埋め込まれた `cli.js` ソースを抽出
3. 埋め込まれた `.node` ネイティブモジュール（audio-capture、image-processor、computer-use-*、url-handler）を `~/.clawgod/vendor/` に抽出
4. `/$bunfs/...` 仮想パスをローカル vendor パスに書き換え
5. 23 個の正規表現パッチを適用（バージョン横断的——同じ regex 群で複数リリースをカバー）
6. `claude` / `clawgod` ランチャが Bun ランタイムでパッチ済み cli.js を実行

`~/.clawgod/.source-version` がパッチ時のバージョンを記録します。起動毎に wrapper がそれと `versions/` の最新バイナリを比較し、ユーザが公式手段で Claude Code をアップグレードした場合は次回起動時に自動再パッチが走ります。

## アップデート

インストーラは冪等です——再実行するだけでパッチ済みコピーが更新されます：

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

通常は手動再実行は**不要**です——Claude Code が自動アップデートされた後、ClawGod の自動再パッチが次回 `claude` / `clawgod` 起動時に処理します。

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
