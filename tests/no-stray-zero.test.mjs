import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * SQLite 的布尔列取出来是数字 0/1。写成 `{row.flag && <em/>}` 时，
 * flag 为 0 会让 React 把「0」直接渲染到页面上。
 * 这类字段在 JSX 短路里必须先转成布尔值。
 */
const NUMERIC_FLAGS =
  /\{\s*[\w.?]*\b(isSaved|hidden|checked|stocked|isFavorite|enabled|active|isCustom)\b[\w.?]*\s*&&/g;

test("numeric flags are never short-circuited straight into JSX", () => {
  const offenders = [];
  for (const file of ["app/page.tsx", "app/PlannerPanel.tsx", "app/RecipeWorkspace.tsx"]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(NUMERIC_FLAGS)) {
      if (match[0].includes("Boolean(")) continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line} ${match[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方会把 0 渲染到页面上，请用 Boolean(...) 包一层：\n${offenders.join("\n")}`,
  );
});
