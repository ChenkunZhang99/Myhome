import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 数据库里的分类、位置、库存等级等字段存的是中文规范值。
 * 直接 `{item.category}` 渲染出来，英文模式下就会漏出中文 —— 必须经过 tv()。
 *
 * 这条规则之前靠人眼一处处找，漏了很多次，所以固化成测试。
 *
 * 只检查**显示位置**：`value={item.category}`、`defaultValue={...}` 这类是表单值，
 * 提交回数据库的必须是中文原值，包了 tv() 反而会写坏数据。
 */
const FIELDS = "category|location|level|itemName|note";
const HOLDERS = "selectedItem|item|deal|selectedDeal|recipe|selectedRecipe|entry|ingredient";
// 排除三种非显示位置：`=` 属性值、`(` 已包在 tv() 里、`$` 模板插值（多用于 React key）
const DISPLAY_FIELD = new RegExp(`(^|[^=($\\w])\\{(?:${HOLDERS})\\.(?:${FIELDS})\\}`, "g");

const FILES = ["app/HomeApp.tsx", "app/PlannerPanel.tsx", "app/RecipeWorkspace.tsx"];

test("stored Chinese values always go through tv() before display", () => {
  const offenders = [];
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DISPLAY_FIELD)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line} ${match[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些字段会在英文模式下漏出中文，请用 tv(...) 包一层：\n${offenders.join("\n")}`,
  );
});

test("form values keep the canonical Chinese, never a translation", () => {
  // 反向护栏：表单提交值一旦被翻译，写回数据库的就成了英文，flyer 匹配引擎会失效。
  const offenders = [];
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:default)?[Vv]alue=\{tv\(/g)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `表单值不能翻译，否则会把英文写进数据库：\n${offenders.join("\n")}`);
});
