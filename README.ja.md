# simplecov-mcp

SimpleCov のカバレッジレポートを Claude から直接扱える MCP サーバー。

`coverage/.resultset.json`（数十 MB になりがち）を丸ごと読む必要なし。必要なデータだけをツール経由で取得できる。

## セットアップ

```bash
git clone https://github.com/yourname/simplecov-mcp.git
cd simplecov-mcp
pnpm install && pnpm build
```

ビルド後、Rails プロジェクトのルートで MCP サーバーを登録：

```bash
claude mcp add simplecov node /path/to/simplecov-mcp/build/index.js
```

プロジェクトの `.mcp.json` に MCP サーバーが追加される。`coverage/` ディレクトリはワーキングディレクトリから自動検出される。

カバレッジのパスを明示指定する場合：

```bash
claude mcp add simplecov -e SIMPLECOV_COVERAGE_PATH=/path/to/coverage node /path/to/simplecov-mcp/build/index.js
```

追加後、Claude Code を再起動して `/mcp` で確認。

## ツール一覧

### `get_summary`

全体のカバレッジサマリーを返す。

```
> get_summary

{
  "lastRun": { "line": 100, "branch": 100 },
  "totalFiles": 1669,
  "computed": { "lineCoverage": 53.56, "branchCoverage": 48.07 }
}
```

### `list_files`

ファイル一覧とカバレッジ率。ソート・フィルタ対応。

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `sort_by` | `path` \| `line_coverage` \| `branch_coverage` \| `missed_lines` | `path` | ソートキー |
| `order` | `asc` \| `desc` | `asc` | ソート順 |
| `min_coverage` | number | - | 最小カバレッジ率 |
| `max_coverage` | number | - | 最大カバレッジ率 |
| `path_pattern` | string | - | パスの部分一致フィルタ |

```
> list_files sort_by=missed_lines order=desc max_coverage=50

[
  { "file": ".../inquiries_controller.rb", "line": "8.96% (37/413)", "missed": 376 },
  ...
]
```

### `get_file_coverage`

特定ファイルの詳細。行ごとのヒット数、未カバー行番号、ブランチカバレッジ。

| パラメータ | 型 | 説明 |
|---|---|---|
| `file_path` | string (必須) | ファイルパス。末尾一致で検索される |

```
> get_file_coverage file_path=app/models/user.rb

{
  "filePath": "/usr/src/app/app/models/user.rb",
  "lineCoverage": "85.71% (12/14)",
  "uncoveredLineNumbers": [42, 43],
  "lines": [...],
  "branches": [...]
}
```

### `get_uncovered_lines`

未カバー行とブランチだけを抽出。テスト追加時に便利。

```
> get_uncovered_lines file_path=app/services/order_service.rb

{
  "filePath": "/usr/src/app/app/services/order_service.rb",
  "lineCoverage": "72.5%",
  "uncoveredLineNumbers": [15, 16, 42, 43, 44],
  "uncoveredBranches": [
    { "condition": "[:if, 3, 15, 6, 15, 40]", "branch": "[:else, 5, 15, 6, 15, 40]" }
  ]
}
```

### `estimate_file_coverage`

テスト再実行なしでコード変更後のカバレッジを推定する。サーバー起動時に保存したベースラインと現在のファイルを行レベルで差分比較し、旧カバレッジデータをマッピングする。

| パラメータ | 型 | 説明 |
|---|---|---|
| `file_path` | string (必須) | ファイルパス。末尾一致で検索される |

```
> estimate_file_coverage file_path=app/models/user.rb

{
  "filePath": "/usr/src/app/app/models/user.rb",
  "fileChanged": true,
  "originalCoverage": "85.71% (12/14)",
  "estimatedCoverage": "82.35% (14/17)",
  "changeSummary": { "unchanged": 45, "added": 5, "removed": 2, "modified": 3 },
  "estimatedNewLines": [
    { "line": 15, "type": "modified", "status": "covered", "confidence": "medium" },
    { "line": 22, "type": "added", "status": "likely_covered", "confidence": "low" }
  ],
  "estimatedUncoveredLineNumbers": [30, 42, 43],
  "note": "..."
}
```

**推定ロジック:**

| 行の種別 | 推定方法 | 信頼度 |
|---|---|---|
| unchanged | 旧カバレッジをそのまま使用 | high |
| modified | 旧カバレッジを引き継ぐ（テストが同じパスを通る可能性が高い） | medium |
| added | 周囲ブロックのカバレッジ状態から推定 | low |

agentic coding のワークフロー向け：テストを1回実行 → コード改善 → カバレッジ影響を推定 → 次の作業へ。

## Claude での使い方の例

```
「カバレッジが低いファイルを教えて」
「app/models/user.rb のカバレッジされていない行を見せて」
「カバレッジが50%以下の controllers を一覧して」
「このファイルの未カバー行に対するテストを書いて」
「user.rb の変更後のカバレッジを推定して」
```

## 仕組み

```
Rails プロジェクト
├── coverage/
│   ├── .resultset.json  ← SimpleCov が生成（数十MB）
│   └── .last_run.json   ← サマリー
└── .mcp.json            ← MCP 設定（claude mcp add で生成）

simplecov-mcp は起動時に cwd → 親 の順で coverage/ を探索し、
.resultset.json をパースしてメモリに保持する。
Claude はツール経由で必要な部分だけを取得する。

起動時にカバレッジ対象のソースファイルも読み込みキャッシュする。
このベースラインを estimate_file_coverage が使い、
行レベル差分（LCSベース）を通じてカバレッジをマッピングする。
```
