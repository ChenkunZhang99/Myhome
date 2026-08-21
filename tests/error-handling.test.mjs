import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 曾经每个 catch 都是 `error instanceof Error ? error.message : "兜底文案"`，
 * 于是 D1 的报错原文（含表名、列名、约束名）会直接进到响应体。
 * 同时全项目没有一行日志，线上出问题只能靠用户复述。
 *
 * 现在的约定：出错时对外只给这个接口自己的安全文案，对内打结构化日志；
 * 确实该展示给用户的信息用 UserFacingError 明确标记。
 */

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

const isObservability = (file) => file.name.startsWith("_shared/observability");

test("没有接口再把异常原文返回给调用方", async () => {
  const offenders = [];
  for (const file of await collectSources(API_DIR)) {
    if (isObservability(file)) continue; // 该模块的注释里会引用这个旧写法
    if (/error instanceof Error \? error\.message/.test(file.code))
      offenders.push(`${file.name}: 直接返回了异常原文`);
  }
  assert.deepEqual(
    offenders,
    [],
    `数据库报错会带出表名与列名，应改用 failure() 或 safeMessage()：\n${offenders.join("\n")}`,
  );
});

test("每个路由处理函数都带请求日志", async () => {
  const missing = [];
  for (const file of await collectSources(API_DIR)) {
    if (!file.name.endsWith("route.ts")) continue;
    // 裸的 `export async function GET(...)` 说明没有被 withRoute 包住
    for (const [match] of file.code.matchAll(/export async function (?:GET|POST|PUT|PATCH|DELETE)\(/g))
      missing.push(`${file.name}: ${match.trim()} 未被 withRoute 包装`);
  }
  assert.deepEqual(missing, [], `没有日志就看不到线上发生了什么：\n${missing.join("\n")}`);
});

test("给用户看的错误必须显式标记", async () => {
  const offenders = [];
  for (const file of await collectSources(API_DIR)) {
    if (isObservability(file)) continue;
    for (const [match] of file.code.matchAll(/throw new Error\(/g))
      offenders.push(`${file.name}: ${match} 应改为 UserFacingError`);
  }
  assert.deepEqual(
    offenders,
    [],
    `普通 Error 会被当作未预期错误、只进日志，用户将看到兜底文案：\n${offenders.join("\n")}`,
  );
});

test("日志里不会留下密钥", async () => {
  const source = await readFile(new URL("_shared/observability.ts", API_DIR), "utf8");
  assert.match(source, /redact/, "缺少脱敏处理");
  // 直接验证脱敏规则本身
  const { redact } = await import("../app/api/_shared/observability.ts");
  assert.equal(redact("failed with sk-abcdefghijklmnop tail"), "failed with sk-*** tail");
  assert.equal(redact("no key here"), "no key here");
});
