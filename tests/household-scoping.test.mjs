import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 分库纪律的闸门。
 *
 * 每一条读写租户表的 SQL 都必须带上 household_id。这是将来能把数据按住户
 * 拆开的唯一前提，也是最容易在某次「临时查一下」时被破坏的约定。
 *
 * 改造期间这里是一个棘轮，未作用域的语句数从 111 逐批降到 0。
 * 现在已经归零，换成严格断言：一条都不许再出现。
 *
 * 见 docs/multi-household-design.md。
 */

const TENANT_TABLES = [
  "inventory_items",
  "inventory_attachments",
  "purchase_records",
  "household_settings",
  "household_members",
  "recipe_preferences",
  "recipe_catalog",
  "recipe_attachments",
  "recipe_cook_history",
  "recipe_ratings",
  "recipe_activity_log",
  "meal_requests",
  "shopping_items",
  "flyer_match_rules",
  "flyer_recommendation_feedback",
  "household_stores",
];

const API_DIR = new URL("../app/api/", import.meta.url);

async function collectSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await collectSources(url)));
    else if (entry.name.endsWith(".ts"))
      out.push({ name: url.pathname.split("/api/")[1], code: await readFile(url, "utf8") });
  }
  return out;
}

/** 抽出 prepare() 里的 SQL 字面量，模板串和普通字符串都要。 */
function statements(code) {
  const found = [];
  const pattern = /\.prepare\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
  for (const [, literal] of code.matchAll(pattern)) found.push(literal.slice(1, -1));
  return found;
}

async function unscoped() {
  const out = [];
  for (const file of await collectSources(API_DIR)) {
    // 建表模块负责定义结构与一次性迁移，本身不属于业务查询
    if (file.name.startsWith("_shared/schema")) continue;
    for (const sql of statements(file.code)) {
      const tables = TENANT_TABLES.filter((table) => new RegExp(`\\b${table}\\b`).test(sql));
      if (!tables.length || /household_id/.test(sql)) continue;
      out.push(`${file.name}: ${tables.join(", ")} — ${sql.replace(/\s+/g, " ").trim().slice(0, 70)}`);
    }
  }
  return out;
}

test("每一条读写租户表的查询都带 household_id", async () => {
  const found = await unscoped();
  assert.deepEqual(
    found,
    [],
    `跨住户的查询会让数据无法按住户拆开，也可能读到别人家的东西：\n${found.join("\n")}`,
  );
});

test("住户解析器只有一处实现", async () => {
  const sources = await collectSources(API_DIR);
  const owner = sources.find((file) => file.name === "_shared/household.ts");
  assert.ok(owner, "找不到 _shared/household.ts");
  assert.match(owner.code, /export async function resolveHousehold/);

  // 住户 id 不能在别处凭空构造，否则「接鉴权只改一个函数」这个前提就不成立。
  // 常量单独放在 householdId.ts：建表语句和解析器都要用它，而解析器依赖建表模块，
  // 放在任何一边都会形成循环引用。
  const offenders = sources
    .filter((file) => file.name !== "_shared/householdId.ts")
    .filter((file) => /["'`]household-default["'`]/.test(file.code))
    .map((file) => file.name);
  assert.deepEqual(offenders, [], `默认住户 id 只应出现在 _shared/householdId.ts：\n${offenders}`);
});
