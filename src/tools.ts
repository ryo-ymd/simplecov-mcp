import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoverageData } from "./coverage.js";

export function registerTools(server: McpServer, coverage: CoverageData): void {
  server.tool(
    "get_summary",
    "SimpleCovのカバレッジサマリーを取得する。全体のline/branchカバレッジ率とファイル数を返す。",
    {},
    async () => {
      const summary = coverage.getSummary();
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  server.tool(
    "list_files",
    "カバレッジ対象ファイルの一覧とカバレッジ率を返す。ソートやフィルタが可能。",
    {
      sort_by: z
        .enum(["path", "line_coverage", "branch_coverage", "missed_lines"])
        .default("path")
        .describe("ソートキー"),
      order: z.enum(["asc", "desc"]).default("asc").describe("ソート順"),
      min_coverage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("最小ラインカバレッジ率でフィルタ"),
      max_coverage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("最大ラインカバレッジ率でフィルタ"),
      path_pattern: z
        .string()
        .optional()
        .describe("ファイルパスのフィルタ（部分一致）"),
    },
    async ({ sort_by, order, min_coverage, max_coverage, path_pattern }) => {
      let files = coverage.listFiles();

      if (path_pattern) {
        files = files.filter((f) => f.filePath.includes(path_pattern));
      }
      if (min_coverage !== undefined) {
        files = files.filter((f) => f.lineCoverage >= min_coverage);
      }
      if (max_coverage !== undefined) {
        files = files.filter((f) => f.lineCoverage <= max_coverage);
      }

      files.sort((a, b) => {
        let cmp: number;
        switch (sort_by) {
          case "line_coverage":
            cmp = a.lineCoverage - b.lineCoverage;
            break;
          case "branch_coverage":
            cmp = (a.branchCoverage ?? 0) - (b.branchCoverage ?? 0);
            break;
          case "missed_lines":
            cmp = a.missedLines - b.missedLines;
            break;
          default:
            cmp = a.filePath.localeCompare(b.filePath);
        }
        return order === "desc" ? -cmp : cmp;
      });

      const result = files.map((f) => ({
        file: f.filePath,
        line: `${f.lineCoverage}% (${f.coveredLines}/${f.totalLines})`,
        branch: f.branchCoverage !== null ? `${f.branchCoverage}% (${f.coveredBranches}/${f.totalBranches})` : null,
        missed: f.missedLines,
      }));

      return {
        content: [
          {
            type: "text",
            text: `${files.length} files\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_file_coverage",
    "特定ファイルの詳細なカバレッジ情報を取得する。行ごとのヒット数、未カバー行、ブランチカバレッジを含む。",
    {
      file_path: z
        .string()
        .describe("ファイルパス（完全一致または末尾一致）"),
    },
    async ({ file_path }) => {
      const detail = coverage.getFileDetail(file_path);
      if (!detail) {
        return {
          content: [
            {
              type: "text",
              text: `ファイルが見つかりません: ${file_path}`,
            },
          ],
          isError: true,
        };
      }

      // 行データは量が多いので、関連行（null以外）だけ返す
      const relevantLines = detail.lines.filter((l) => l.hits !== null);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                filePath: detail.filePath,
                lineCoverage: `${detail.lineCoverage}% (${detail.coveredLines}/${detail.totalLines})`,
                branchCoverage:
                  detail.branchCoverage !== null
                    ? `${detail.branchCoverage}% (${detail.coveredBranches}/${detail.totalBranches})`
                    : null,
                uncoveredLineNumbers: detail.uncoveredLineNumbers,
                lines: relevantLines,
                branches: detail.branches,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_uncovered_lines",
    "特定ファイルの未カバー行番号のリストを取得する。テスト追加の参考に。",
    {
      file_path: z
        .string()
        .describe("ファイルパス（完全一致または末尾一致）"),
    },
    async ({ file_path }) => {
      const detail = coverage.getFileDetail(file_path);
      if (!detail) {
        return {
          content: [
            {
              type: "text",
              text: `ファイルが見つかりません: ${file_path}`,
            },
          ],
          isError: true,
        };
      }

      const uncoveredBranches = detail.branches
        .flatMap((b) =>
          b.branches.filter((br) => br.hits === 0).map((br) => ({
            condition: b.condition,
            branch: br.label,
          }))
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                filePath: detail.filePath,
                lineCoverage: `${detail.lineCoverage}%`,
                uncoveredLineNumbers: detail.uncoveredLineNumbers,
                uncoveredBranches,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
