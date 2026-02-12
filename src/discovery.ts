import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const RESULTSET_FILE = ".resultset.json";
const COVERAGE_DIR = "coverage";

export function discoverCoverageDir(): string {
  const envPath = process.env.SIMPLECOV_COVERAGE_PATH;
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(join(resolved, RESULTSET_FILE))) {
      return resolved;
    }
    throw new Error(
      `SIMPLECOV_COVERAGE_PATH="${envPath}" に ${RESULTSET_FILE} が見つかりません`
    );
  }

  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, COVERAGE_DIR);
    if (existsSync(join(candidate, RESULTSET_FILE))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `coverage ディレクトリが見つかりません。cwd (${process.cwd()}) から親方向に探索しましたが、${COVERAGE_DIR}/${RESULTSET_FILE} が存在しませんでした。環境変数 SIMPLECOV_COVERAGE_PATH で明示指定することもできます。`
  );
}
