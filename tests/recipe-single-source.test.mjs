import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 菜谱曾经存在两套并行的系统。
 *
 * `/api/recipes` 生成后写进 recipe_suggestions，再在同一个请求里读回来当返回值，
 * 而菜谱库读的是 recipe_catalog。两者之间只靠建表时的一次性回填连接，
 * 那段回填每个 isolate 只跑一次，所以数据什么时候出现在菜谱库里取决于运行时回收进程的时机。
 *
 * 现在生成接口直接返回内存里的结果，写入只经过 recipe_catalog 一条路径。
 * 这两条测试防止两套系统重新长出来。
 */

const API_DIR = new URL("../app/api/", import.meta.url);
const LEGACY_TABLES = ["recipe_suggestions", "recipe_favorites"];

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

test("没有任何代码再往两张遗留菜谱表写入", async () => {
  const offenders = [];
  for (const file of await collectSources(API_DIR)) {
    for (const table of LEGACY_TABLES) {
      // 建表语句里的回填（INSERT ... SELECT FROM 遗留表）是一次性迁移，读方向不算写入
      const writes = [
        new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "gi"),
        new RegExp(`UPDATE\\s+${table}\\s+SET`, "gi"),
      ];
      for (const pattern of writes) {
        for (const [match] of file.code.matchAll(pattern)) offenders.push(`${file.name}: ${match}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `菜谱只应写进 recipe_catalog，以下位置又写回了遗留表：\n${offenders.join("\n")}`,
  );
});

test("生成菜谱的接口不再借数据库中转", async () => {
  const sources = await collectSources(API_DIR);
  const recipes = sources.find((file) => file.name === "recipes/route.ts");
  assert.ok(recipes, "找不到 recipes/route.ts");

  for (const table of LEGACY_TABLES) {
    assert.doesNotMatch(
      recipes.code,
      new RegExp(table),
      `recipes/route.ts 不应再引用 ${table}，生成结果应直接返回`,
    );
  }
});
