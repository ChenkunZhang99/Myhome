import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 这两条规则各自对应一个真实发生过的故障。
 *
 * 一是 planner 路由查 purchase_records，而建那张表的代码在另一个 ensure 函数里，
 * 路由没调用它，接口 500。类型检查和构建都发现不了，因为 SQL 是字符串。
 *
 * 二是 recipe-workspace 的建表逻辑里有一句 DELETE FROM recipe_favorites，
 * 而 recipe_favorites 只有 recipes 路由才会建。全新数据库上谁先被访问决定了会不会报错。
 */

const API_DIR = new URL("../app/api/", import.meta.url);

async function collectSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await collectSources(url)));
    else if (entry.name.endsWith(".ts"))
      out.push({ path: url.pathname, code: stripComments(await readFile(url, "utf8")) });
  }
  return out;
}

/** 注释里提到 CREATE TABLE 不算违规，只看真正会执行的语句。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 从 SQL 文本里抽出被读写的表名。别名和子查询不会被误抓，因为它们后面跟的是括号或关键字。 */
function referencedTables(code) {
  const found = new Set();
  const patterns = [
    /\bFROM\s+([a-z_][a-z0-9_]*)/gi,
    /\bJOIN\s+([a-z_][a-z0-9_]*)/gi,
    /\bINTO\s+([a-z_][a-z0-9_]*)/gi,
    /\bUPDATE\s+([a-z_][a-z0-9_]*)\s+SET/gi,
  ];
  for (const pattern of patterns) {
    for (const [, name] of code.matchAll(pattern)) found.add(name.toLowerCase());
  }
  return found;
}

test("每张被查询的表都由唯一的 schema 文件创建", async () => {
  const sources = await collectSources(API_DIR);
  const schema = sources.find((file) => file.path.endsWith("/_shared/schema.ts"));
  assert.ok(schema, "找不到 app/api/_shared/schema.ts");

  const declared = new Set(
    [...schema.code.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gi)].map(([, name]) =>
      name.toLowerCase(),
    ),
  );
  assert.ok(declared.size >= 20, `schema.ts 只声明了 ${declared.size} 张表`);

  const missing = [];
  for (const file of sources) {
    for (const table of referencedTables(file.code)) {
      if (!declared.has(table)) missing.push(`${file.path.split("/api/")[1]} 引用了未声明的表 ${table}`);
    }
  }
  assert.deepEqual(missing, [], `以下表在 SQL 里被使用但没有建表语句：\n${missing.join("\n")}`);
});

test("建表语句只出现在 schema.ts 一处", async () => {
  const sources = await collectSources(API_DIR);
  const offenders = sources
    .filter((file) => !file.path.endsWith("/_shared/schema.ts"))
    .filter((file) => /CREATE TABLE|ALTER TABLE .* ADD COLUMN/i.test(file.code))
    .map((file) => file.path.split("/api/")[1]);

  assert.deepEqual(offenders, [], `建表逻辑应集中在 _shared/schema.ts，但这些文件里也有：\n${offenders}`);
});

test("所有路由用同一个 ensureSchema，不再各自维护子集", async () => {
  const sources = await collectSources(API_DIR);
  const routes = sources.filter((file) => file.path.endsWith("/route.ts"));
  assert.ok(routes.length >= 9, `只找到 ${routes.length} 个路由`);

  const stale = routes
    .filter((file) =>
      /\bensure(?:Inventory|Planner|Attachment|RecipeAttachment|Recipe)Schema\b/.test(file.code),
    )
    .map((file) => file.path.split("/api/")[1]);

  assert.deepEqual(stale, [], `这些路由还在用已废弃的分散 ensure 函数：\n${stale}`);
});

test("依赖后加列的索引不能和建表放在同一个 batch", async () => {
  const schema = await readFile(new URL("../app/api/_shared/schema.ts", import.meta.url), "utf8");
  const start = schema.indexOf("const INDEXES =");
  const delayed = schema.indexOf("const INDEXES_ON_ADDED_COLUMNS");
  assert.ok(start !== -1 && delayed !== -1, "找不到 INDEXES / INDEXES_ON_ADDED_COLUMNS");
  const indexes = schema.slice(start, delayed);
  assert.doesNotMatch(
    indexes,
    /source_key/,
    "source_key 是后加列。索引如果和 CREATE TABLE 放进同一个 batch，老库上整段建表都会被 no such column 打断，登录也就跟着 500",
  );
  const afterAlter = schema.slice(delayed);
  assert.match(afterAlter, /idx_flyer_price_history_source/, "价格历史的 source_key 索引要排在补列之后");
  assert.match(afterAlter, /idx_household_stores_subscription/, "收藏门店的 source_key 索引要排在补列之后");
});
