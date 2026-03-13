import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDiff } from "./diff.js";

// SimpleCov .resultset.json の型定義
interface BranchData {
  [branchKey: string]: number;
}

interface FileCoverage {
  lines: (number | null)[];
  branches?: {
    [conditionKey: string]: BranchData;
  };
}

interface ResultSet {
  [suiteName: string]: {
    coverage: {
      [filePath: string]: FileCoverage;
    };
  };
}

interface LastRun {
  result: {
    line: number;
    branch?: number;
  };
}

export interface FileCoverageStats {
  filePath: string;
  lineCoverage: number;
  branchCoverage: number | null;
  totalLines: number;
  coveredLines: number;
  missedLines: number;
  totalBranches: number;
  coveredBranches: number;
}

export interface FileCoverageDetail extends FileCoverageStats {
  lines: { lineNumber: number; hits: number | null }[];
  uncoveredLineNumbers: number[];
  branches: {
    condition: string;
    branches: { label: string; hits: number }[];
  }[];
}

export interface EstimatedLine {
  line: number;
  type: "modified" | "added";
  status: "covered" | "uncovered" | "likely_covered" | "likely_uncovered" | "uncertain";
  confidence: "high" | "medium" | "low";
}

export interface CoverageEstimation {
  filePath: string;
  fileChanged: boolean;
  originalCoverage: string;
  estimatedCoverage: string;
  changeSummary: { unchanged: number; added: number; removed: number; modified: number };
  estimatedNewLines: EstimatedLine[];
  estimatedUncoveredLineNumbers: number[];
  note: string;
}

export class CoverageData {
  private mergedCoverage: Map<string, FileCoverage> = new Map();
  private originalSources: Map<string, string[]> = new Map();
  private lastRun: LastRun | null = null;
  private coverageDir: string;

  constructor(coverageDir: string) {
    this.coverageDir = coverageDir;
    this.load();
  }

  reload(): void {
    this.mergedCoverage.clear();
    this.originalSources.clear();
    this.lastRun = null;
    this.load();
  }

  private load(): void {
    const resultSetPath = join(this.coverageDir, ".resultset.json");
    const raw: ResultSet = JSON.parse(readFileSync(resultSetPath, "utf-8"));

    // 複数スイート（RSpec, Minitest等）のカバレッジをマージ
    for (const suite of Object.values(raw)) {
      for (const [filePath, fileCov] of Object.entries(suite.coverage)) {
        const existing = this.mergedCoverage.get(filePath);
        if (existing) {
          this.mergedCoverage.set(filePath, this.mergeFileCoverage(existing, fileCov));
        } else {
          this.mergedCoverage.set(filePath, fileCov);
        }
      }
    }

    try {
      const lastRunPath = join(this.coverageDir, ".last_run.json");
      this.lastRun = JSON.parse(readFileSync(lastRunPath, "utf-8"));
    } catch {
      // .last_run.json is optional
    }

    // カバレッジ計測時点のソースファイルを保存（推定機能のベースライン）
    for (const filePath of this.mergedCoverage.keys()) {
      try {
        const content = readFileSync(filePath, "utf-8");
        this.originalSources.set(filePath, content.split("\n"));
      } catch {
        // ファイルが読めない場合はスキップ（推定不可）
      }
    }
  }

  private mergeFileCoverage(a: FileCoverage, b: FileCoverage): FileCoverage {
    const lines = a.lines.map((aHits, i) => {
      const bHits = b.lines[i] ?? null;
      if (aHits === null) return bHits;
      if (bHits === null) return aHits;
      return aHits + bHits;
    });
    return { lines, branches: a.branches ?? b.branches };
  }

  getSummary(): {
    lastRun: LastRun["result"] | null;
    totalFiles: number;
    computed: { lineCoverage: number; branchCoverage: number | null };
  } {
    let totalRelevant = 0;
    let totalCovered = 0;
    let totalBranches = 0;
    let totalCoveredBranches = 0;

    for (const fileCov of this.mergedCoverage.values()) {
      const { relevant, covered } = this.countLines(fileCov);
      totalRelevant += relevant;
      totalCovered += covered;
      const br = this.countBranches(fileCov);
      totalBranches += br.total;
      totalCoveredBranches += br.covered;
    }

    return {
      lastRun: this.lastRun?.result ?? null,
      totalFiles: this.mergedCoverage.size,
      computed: {
        lineCoverage: totalRelevant > 0 ? round((totalCovered / totalRelevant) * 100) : 100,
        branchCoverage:
          totalBranches > 0 ? round((totalCoveredBranches / totalBranches) * 100) : null,
      },
    };
  }

  listFiles(): FileCoverageStats[] {
    const result: FileCoverageStats[] = [];
    for (const [filePath, fileCov] of this.mergedCoverage) {
      result.push(this.computeFileStats(filePath, fileCov));
    }
    return result;
  }

  private resolveFilePath(filePath: string): { resolvedPath: string; coverage: FileCoverage } | null {
    let entry = this.mergedCoverage.get(filePath);
    let resolvedPath = filePath;
    if (!entry) {
      for (const [key, val] of this.mergedCoverage) {
        if (key.endsWith(filePath)) {
          entry = val;
          resolvedPath = key;
          break;
        }
      }
    }
    if (!entry) return null;
    return { resolvedPath, coverage: entry };
  }

  getFileDetail(filePath: string): FileCoverageDetail | null {
    const resolved = this.resolveFilePath(filePath);
    if (!resolved) return null;

    const { resolvedPath, coverage: entry } = resolved;
    const stats = this.computeFileStats(resolvedPath, entry);
    const lines = entry.lines.map((hits, i) => ({
      lineNumber: i + 1,
      hits,
    }));

    const branches: FileCoverageDetail["branches"] = [];
    if (entry.branches) {
      for (const [condition, branchData] of Object.entries(entry.branches)) {
        branches.push({
          condition,
          branches: Object.entries(branchData).map(([label, hits]) => ({
            label,
            hits,
          })),
        });
      }
    }

    return {
      ...stats,
      lines,
      uncoveredLineNumbers: lines
        .filter((l) => l.hits === 0)
        .map((l) => l.lineNumber),
      branches,
    };
  }

  private computeFileStats(filePath: string, fileCov: FileCoverage): FileCoverageStats {
    const { relevant, covered, missed } = this.countLines(fileCov);
    const br = this.countBranches(fileCov);
    return {
      filePath,
      lineCoverage: relevant > 0 ? round((covered / relevant) * 100) : 100,
      branchCoverage: br.total > 0 ? round((br.covered / br.total) * 100) : null,
      totalLines: relevant,
      coveredLines: covered,
      missedLines: missed,
      totalBranches: br.total,
      coveredBranches: br.covered,
    };
  }

  private countLines(fileCov: FileCoverage): {
    relevant: number;
    covered: number;
    missed: number;
  } {
    let relevant = 0;
    let covered = 0;
    let missed = 0;
    for (const hits of fileCov.lines) {
      if (hits === null) continue;
      relevant++;
      if (hits > 0) covered++;
      else missed++;
    }
    return { relevant, covered, missed };
  }

  private countBranches(fileCov: FileCoverage): {
    total: number;
    covered: number;
  } {
    let total = 0;
    let covered = 0;
    if (!fileCov.branches) return { total, covered };
    for (const branchData of Object.values(fileCov.branches)) {
      for (const hits of Object.values(branchData)) {
        total++;
        if (hits > 0) covered++;
      }
    }
    return { total, covered };
  }

  estimateFileCoverage(filePath: string): CoverageEstimation | { error: string } {
    const resolved = this.resolveFilePath(filePath);
    if (!resolved) {
      return { error: `ファイルが見つかりません: ${filePath}` };
    }

    const { resolvedPath, coverage: fileCov } = resolved;
    const originalLines = this.originalSources.get(resolvedPath);
    if (!originalLines) {
      return { error: `元ソースが保存されていないため推定できません: ${resolvedPath}` };
    }

    // 現在のファイルを読み込み
    let currentLines: string[];
    try {
      currentLines = readFileSync(resolvedPath, "utf-8").split("\n");
    } catch {
      return { error: `現在のファイルを読み取れません: ${resolvedPath}` };
    }

    // 元のカバレッジ統計
    const originalStats = this.computeFileStats(resolvedPath, fileCov);

    // 未変更の場合は元のカバレッジをそのまま返す
    if (linesEqual(originalLines, currentLines)) {
      return {
        filePath: resolvedPath,
        fileChanged: false,
        originalCoverage: `${originalStats.lineCoverage}% (${originalStats.coveredLines}/${originalStats.totalLines})`,
        estimatedCoverage: `${originalStats.lineCoverage}% (${originalStats.coveredLines}/${originalStats.totalLines})`,
        changeSummary: { unchanged: originalLines.length, added: 0, removed: 0, modified: 0 },
        estimatedNewLines: [],
        estimatedUncoveredLineNumbers: originalStats.missedLines > 0
          ? fileCov.lines
              .map((hits, i) => (hits === 0 ? i + 1 : -1))
              .filter((n) => n > 0)
          : [],
        note: "ファイルは変更されていません。元のカバレッジデータがそのまま有効です。",
      };
    }

    // diff計算
    let diff;
    try {
      diff = computeDiff(originalLines, currentLines);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }

    const oldCov = fileCov.lines;

    // Phase 1: unchanged/modifiedの行にカバレッジをマッピング
    // newLineNumber → { value, confidence, type }
    const mappedCoverage = new Map<number, { value: number | null; confidence: "high" | "medium" | "low"; type: "unchanged" | "modified" | "added" }>();

    for (const line of diff.lines) {
      if (line.type === "unchanged" && line.oldLineNumber !== null && line.newLineNumber !== null) {
        const oldValue = oldCov[line.oldLineNumber - 1] ?? null;
        mappedCoverage.set(line.newLineNumber, { value: oldValue, confidence: "high", type: "unchanged" });
      } else if (line.type === "modified" && line.oldLineNumber !== null && line.newLineNumber !== null) {
        const oldValue = oldCov[line.oldLineNumber - 1] ?? null;
        mappedCoverage.set(line.newLineNumber, { value: oldValue, confidence: "medium", type: "modified" });
      }
    }

    // Phase 2: added行をブロック単位で推定
    const addedLines = diff.lines.filter((l) => l.type === "added" && l.newLineNumber !== null);
    const addedBlocks = groupConsecutiveAdded(addedLines.map((l) => l.newLineNumber!));

    for (const block of addedBlocks) {
      const status = this.estimateAddedBlock(block, mappedCoverage);
      for (const lineNum of block) {
        mappedCoverage.set(lineNum, { value: status.value, confidence: "low", type: "added" });
      }
    }

    // Phase 3: 推定カバレッジを計算
    let estimatedRelevant = 0;
    let estimatedCovered = 0;
    const estimatedUncovered: number[] = [];
    const estimatedNewLines: EstimatedLine[] = [];

    for (const [lineNum, info] of mappedCoverage) {
      if (info.value === null) continue; // 非実行行（コメント等）
      estimatedRelevant++;
      if (info.value > 0) {
        estimatedCovered++;
      } else {
        estimatedUncovered.push(lineNum);
      }
    }

    // added/modified行の推定結果を出力用に整理
    for (const line of diff.lines) {
      if ((line.type === "modified" || line.type === "added") && line.newLineNumber !== null) {
        const info = mappedCoverage.get(line.newLineNumber);
        if (!info || info.value === null) continue;
        estimatedNewLines.push({
          line: line.newLineNumber,
          type: line.type,
          status: this.toEstimatedStatus(info.value, info.confidence, line.type),
          confidence: info.confidence,
        });
      }
    }

    // added行でvalueがnullだったものも uncertain として含める
    for (const line of diff.lines) {
      if (line.type === "added" && line.newLineNumber !== null) {
        const info = mappedCoverage.get(line.newLineNumber);
        if (info && info.value === null) {
          // 周囲がすべてnullの場合はスキップ（非実行行の可能性大）
          // ただし、修正された行は表示しない
        }
      }
    }

    const estimatedLineCov = estimatedRelevant > 0 ? round((estimatedCovered / estimatedRelevant) * 100) : 100;
    estimatedUncovered.sort((a, b) => a - b);

    return {
      filePath: resolvedPath,
      fileChanged: true,
      originalCoverage: `${originalStats.lineCoverage}% (${originalStats.coveredLines}/${originalStats.totalLines})`,
      estimatedCoverage: `${estimatedLineCov}% (${estimatedCovered}/${estimatedRelevant})`,
      changeSummary: diff.stats,
      estimatedNewLines,
      estimatedUncoveredLineNumbers: estimatedUncovered,
      note: "行レベルdiff分析に基づく推定です。正確なカバレッジはテスト再実行で確認してください。",
    };
  }

  private estimateAddedBlock(
    block: number[],
    mappedCoverage: Map<number, { value: number | null; confidence: string; type: string }>
  ): { value: number | null } {
    // ブロックの上下の最近接マッピング済み行を探す
    const firstLine = block[0];
    const lastLine = block[block.length - 1];

    let aboveValue: number | null | undefined;
    for (let i = firstLine - 1; i >= 1; i--) {
      const info = mappedCoverage.get(i);
      if (info && info.value !== null) {
        aboveValue = info.value;
        break;
      }
      if (info) continue; // null値の行はスキップして探索継続
      break; // マッピングされていない行に到達（removed等）
    }

    let belowValue: number | null | undefined;
    for (let i = lastLine + 1; ; i++) {
      const info = mappedCoverage.get(i);
      if (info && info.value !== null) {
        belowValue = info.value;
        break;
      }
      if (info) continue;
      break;
    }

    // 上下のカバレッジ状態から推定
    const aboveCovered = aboveValue != null && aboveValue > 0;
    const aboveUncovered = aboveValue != null && aboveValue === 0;
    const belowCovered = belowValue != null && belowValue > 0;
    const belowUncovered = belowValue != null && belowValue === 0;
    const aboveKnown = aboveValue != null;
    const belowKnown = belowValue != null;

    if ((aboveCovered && belowCovered) || (aboveCovered && !belowKnown) || (!aboveKnown && belowCovered)) {
      return { value: 1 }; // likely covered
    }
    if ((aboveUncovered && belowUncovered) || (aboveUncovered && !belowKnown) || (!aboveKnown && belowUncovered)) {
      return { value: 0 }; // likely uncovered
    }
    if (!aboveKnown && !belowKnown) {
      return { value: null }; // 周囲の情報なし
    }
    // 混合の場合はuncoveredとして保守的に推定
    return { value: 0 };
  }

  private toEstimatedStatus(
    value: number,
    confidence: "high" | "medium" | "low",
    type: "modified" | "added"
  ): EstimatedLine["status"] {
    if (type === "added") {
      if (value > 0) return "likely_covered";
      if (value === 0) return "likely_uncovered";
      return "uncertain";
    }
    // modified
    if (confidence === "high") {
      return value > 0 ? "covered" : "uncovered";
    }
    if (value > 0) return "covered";
    return "uncovered";
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function groupConsecutiveAdded(lineNumbers: number[]): number[][] {
  if (lineNumbers.length === 0) return [];
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const blocks: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      blocks[blocks.length - 1].push(sorted[i]);
    } else {
      blocks.push([sorted[i]]);
    }
  }
  return blocks;
}
