// 行レベルdiffアルゴリズム（LCSベース）

export type DiffLineType = "unchanged" | "added" | "removed" | "modified";

export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface DiffResult {
  lines: DiffLine[];
  stats: {
    unchanged: number;
    added: number;
    removed: number;
    modified: number;
  };
}

const MAX_LINES = 10000;

export function computeDiff(oldLines: string[], newLines: string[]): DiffResult {
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    throw new Error(`ファイルが大きすぎます（${MAX_LINES}行超）。推定をスキップします。`);
  }

  // 共通prefix/suffixを除外して計算量を削減
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  // 中間部分のdiffを計算
  const rawDiff = lcsBasedDiff(oldMiddle, newMiddle, prefixLen);

  // prefix部分（全てunchanged）
  const prefixLines: DiffLine[] = [];
  for (let i = 0; i < prefixLen; i++) {
    prefixLines.push({ type: "unchanged", oldLineNumber: i + 1, newLineNumber: i + 1 });
  }

  // suffix部分（全てunchanged）
  const suffixLines: DiffLine[] = [];
  const oldSuffixStart = oldLines.length - suffixLen;
  const newSuffixStart = newLines.length - suffixLen;
  for (let i = 0; i < suffixLen; i++) {
    suffixLines.push({
      type: "unchanged",
      oldLineNumber: oldSuffixStart + i + 1,
      newLineNumber: newSuffixStart + i + 1,
    });
  }

  const allLines = [...prefixLines, ...rawDiff, ...suffixLines];

  // removed+addedの隣接ブロックをmodifiedに再分類
  const classified = classifyModifiedBlocks(allLines);

  return {
    lines: classified,
    stats: countStats(classified),
  };
}

function lcsBasedDiff(oldLines: string[], newLines: string[], lineOffset: number): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0 && m === 0) return [];

  if (n === 0) {
    return newLines.map((_, i) => ({
      type: "added" as const,
      oldLineNumber: null,
      newLineNumber: lineOffset + i + 1,
    }));
  }

  if (m === 0) {
    return oldLines.map((_, i) => ({
      type: "removed" as const,
      oldLineNumber: lineOffset + i + 1,
      newLineNumber: null,
    }));
  }

  // DP-LCSテーブル構築
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // バックトラックでdiffを生成
  const result: DiffLine[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: "unchanged",
        oldLineNumber: lineOffset + i,
        newLineNumber: lineOffset + j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({
        type: "added",
        oldLineNumber: null,
        newLineNumber: lineOffset + j,
      });
      j--;
    } else {
      result.push({
        type: "removed",
        oldLineNumber: lineOffset + i,
        newLineNumber: null,
      });
      i--;
    }
  }

  return result.reverse();
}

/**
 * 連続するremoved+addedブロックをmodifiedに再分類する。
 * 例: [removed, removed, added, added] → [modified, modified]
 *     [removed, removed, removed, added, added] → [modified, modified, removed]
 */
function classifyModifiedBlocks(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type === "removed") {
      // removedブロックを収集
      const removedBlock: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "removed") {
        removedBlock.push(lines[i]);
        i++;
      }
      // 直後のaddedブロックを収集
      const addedBlock: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "added") {
        addedBlock.push(lines[i]);
        i++;
      }

      if (addedBlock.length === 0) {
        // addedが無い場合はそのままremoved
        result.push(...removedBlock);
      } else {
        // ペアリング: min(removed, added)個をmodifiedに
        const pairCount = Math.min(removedBlock.length, addedBlock.length);
        for (let k = 0; k < pairCount; k++) {
          result.push({
            type: "modified",
            oldLineNumber: removedBlock[k].oldLineNumber,
            newLineNumber: addedBlock[k].newLineNumber,
          });
        }
        // 余りをそのまま追加
        for (let k = pairCount; k < removedBlock.length; k++) {
          result.push(removedBlock[k]);
        }
        for (let k = pairCount; k < addedBlock.length; k++) {
          result.push(addedBlock[k]);
        }
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result;
}

function countStats(lines: DiffLine[]): DiffResult["stats"] {
  const stats = { unchanged: 0, added: 0, removed: 0, modified: 0 };
  for (const line of lines) {
    stats[line.type]++;
  }
  return stats;
}
