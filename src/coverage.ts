import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export class CoverageData {
  private mergedCoverage: Map<string, FileCoverage> = new Map();
  private lastRun: LastRun | null = null;
  private coverageDir: string;

  constructor(coverageDir: string) {
    this.coverageDir = coverageDir;
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

  getFileDetail(filePath: string): FileCoverageDetail | null {
    // 完全一致を試行、なければ部分一致
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
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
