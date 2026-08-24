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

/**
 * 这条规则针对的是「异常原文进响应」。
 *
 * 不构造任何 Response 的模块不在射程内——比如 schema.ts，它把失败原因写进日志，
 * 而那里的表名和列名正是排查迁移问题唯一有用的东西。
 *
 * 豁免建立在一个可验证的前提上：这些文件里确实没有 Response。前提不成立时
 * 下面那条断言会先失败，而不是让豁免悄悄扩大。
 */
// flipp.ts 同理：它是一个没有文档的外部接口的读取器，任何失败都返回空数组、
// 只把原因写进日志。而那行原因正是判断「接口是不是挂了」唯一的线索。
const NO_RESPONSE_FILES = ["_shared/schema.ts", "flyers/sync/flipp.ts", "flyers/sync/visionFlyer.ts"];

test("豁免名单里的文件确实不构造响应", async () => {
  for (const file of await collectSources(API_DIR)) {
    if (!NO_RESPONSE_FILES.includes(file.name)) continue;
    assert.doesNotMatch(
      file.code,
      /Response\.(json|redirect)|new Response\(/,
      `${file.name} 开始构造响应了，不能再享受豁免`,
    );
  }
});

test("没有接口再把异常原文返回给调用方", async () => {
  const offenders = [];
  for (const file of await collectSources(API_DIR)) {
    if (isObservability(file)) continue; // 该模块的注释里会引用这个旧写法
    if (NO_RESPONSE_FILES.includes(file.name)) continue;
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
    // 不构造 Response 的底层模块只能把异常交给路由边界统一脱敏，
    // 把 schema 版本或列名包装成 UserFacingError 反而可能泄露内部结构。
    if (isObservability(file) || NO_RESPONSE_FILES.includes(file.name)) continue;
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
