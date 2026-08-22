import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 导出范围必须等于租户表的全集。
 *
 * 这是最容易悄悄坏掉的地方：以后加一张带 household_id 的表，谁都会记得
 * 在查询里带上住户（那有另一个测试盯着），但很少有人会想起来「导出也要带它」。
 * 漏掉的后果是备份看起来成功了，还原之后才发现少了一整块——
 * 而那时候原始数据已经被覆盖了。
 */

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

function listFrom(code, name) {
  const start = code.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `找不到 ${name}`);
  const end = code.indexOf("]", start);
  return [...code.slice(start, end).matchAll(/"([a-z_]+)"/g)].map(([, table]) => table);
}

test("导出范围覆盖每一张租户表", async () => {
  const tenant = listFrom(await source("./household-scoping.test.mjs"), "TENANT_TABLES");
  const exported = listFrom(await source("../app/api/_shared/dataTransfer.ts"), "EXPORTED_TABLES");

  const missing = tenant.filter((table) => !exported.includes(table));
  assert.deepEqual(missing, [], `这些表带 household_id 却不会被导出，备份是残缺的：${missing.join(", ")}`);

  const extra = exported.filter((table) => !tenant.includes(table));
  assert.deepEqual(extra, [], `这些表不属于某一个家，不该进导出：${extra.join(", ")}`);
});

test("被引用的表排在导入顺序的前面", async () => {
  const exported = listFrom(await source("../app/api/_shared/dataTransfer.ts"), "EXPORTED_TABLES");
  const before = (a, b) => exported.indexOf(a) < exported.indexOf(b);

  assert.ok(before("inventory_items", "inventory_attachments"), "附件要在物品之后写入");
  assert.ok(before("recipe_catalog", "recipe_ratings"), "评分要在菜谱之后写入");
  assert.ok(before("recipe_catalog", "recipe_cook_history"), "做菜历史要在菜谱之后写入");
  assert.ok(before("household_members", "meal_requests"), "点菜要在成员之后写入");
});

test("格式版本号是整数，导出导入用同一个来源", async () => {
  const code = await source("../app/api/_shared/dataTransfer.ts");
  assert.match(code, /export const VERSION = \d+;/, "版本号要显式导出，中文规范值改名时靠它做映射");
  assert.match(code, /export const FORMAT = "home-stock-planner";/);
  // 校验函数必须挡住来自更新版本的文件，否则会用旧代码解释新格式
  assert.match(code, /snapshot\.version > VERSION/, "必须拒绝来自更新版本的备份");
});

test("自动备份不会把空家写成快照", async () => {
  const code = await source("../app/api/_shared/snapshots.ts");
  assert.match(code, /if \(rows === 0\) return/, "空快照会把有内容的旧备份挤出保留窗口");
  assert.match(
    code,
    /key\.startsWith\(`\$\{PREFIX\}\/\$\{householdId\}\//,
    "读取快照必须限定在自己家的前缀下",
  );
});
