import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 部署者那把密钥可以借给别人用有限次，但只能通过本站自己的功能兑现。
 *
 * 这里守的是三件事：额度不能被并发绕过、密钥不能出现在任何响应里、
 * 每一个调模型的接口都要走同一道计数。漏掉任何一条，后果都直接落在账单上。
 */

const openai = await readFile(new URL("../app/api/_shared/openai.ts", import.meta.url), "utf8");

const NEWLINE = String.fromCharCode(10);
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, "找不到 " + signature);
  return source.slice(at, source.indexOf(NEWLINE + "}", at));
}

test("判断和记账是同一条 SQL，并发挡得住", () => {
  const fn = functionBody(openai, "export async function takeSharedCall");
  assert.ok(fn.includes("ON CONFLICT"), "不是一条 upsert");
  assert.ok(
    fn.includes("WHERE ai_quota.used <"),
    "配额判断没有放进 SQL——先读再写的话，同时打进来的两个请求会读到同一个旧值，双双通过",
  );
  assert.ok(fn.includes("meta?.changes"), "没有靠影响行数判断是否放行");
  assert.ok(!fn.includes("SELECT used"), "读一次再写一次就是那个并发漏洞");
});

test("自带密钥的人不消耗额度", () => {
  const fn = functionBody(openai, "export async function getSharedOpenAIConfig");
  const own = fn.indexOf("if (own.apiKey) return");
  const take = fn.indexOf("takeSharedCall(");
  assert.notEqual(own, -1, "没有先看有没有自带密钥");
  assert.ok(own < take, "自带密钥花的是他自己的钱，没有理由计数");
});

test("部署者没配服务端密钥时不假装有免费额度", () => {
  const fn = functionBody(openai, "export async function getSharedOpenAIConfig");
  assert.ok(fn.includes("if (!envKey())"), "会告诉人「免费次数用完了」，而其实从来就没有过");
});

test("两种「没有密钥」要分得开", () => {
  const fn = functionBody(openai, "export function missingKeyMessage");
  assert.ok(fn.includes('"quota"'), "没有区分额度用完");
  const config = openai.slice(
    openai.indexOf("export type OpenAIConfig"),
    openai.indexOf("}", openai.indexOf("export type OpenAIConfig")) + 1,
  );
  assert.ok(config.includes("reason"), "配置里没有记下原因");
});

test("密钥不会出现在任何响应里", () => {
  // envKey() 的返回值只该被交给 fetch 的 Authorization 头，不该进 Response
  const uses = openai.split("envKey()").length - 1;
  assert.ok(uses >= 2, "找不到读取服务端密钥的地方");
  assert.ok(
    !/Response\.json\([^)]*apiKey/.test(openai),
    "响应里出现了 apiKey——那把密钥就不再只能通过本站功能兑现了",
  );
});

test("每一个调模型的接口都走同一道计数", async () => {
  const routes = [
    "../app/api/recipes/route.ts",
    "../app/api/recipes/draft/route.ts",
    "../app/api/receipts/analyze/route.ts",
    "../app/api/flyers/sync/route.ts",
    "../app/api/planner/route.ts",
  ];
  for (const relative of routes) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.ok(
      source.includes("getSharedOpenAIConfig("),
      relative + " 还在用不计数的那个取密钥函数——那个接口对所有人白送",
    );
  }
});

/**
 * 注销必须真的把东西删干净，否则「我删了账号」只是个说法。
 */
test("注销会清掉数据、图片和备份快照", async () => {
  const transfer = await readFile(new URL("../app/api/_shared/dataTransfer.ts", import.meta.url), "utf8");
  const fn = functionBody(transfer, "export async function purgeHousehold");
  assert.ok(fn.includes("UPLOADS.delete"), "R2 里的图片没删，既在计费也仍可按 object key 取到");
  assert.ok(fn.includes("backups/"), "自动备份没删——R2 里还躺着这个家的完整快照");
  assert.ok(fn.includes("EXPORTED_TABLES"), "没有复用「一个家拥有什么」的那份定义");
  assert.ok(fn.includes("ai_quota"), "配额行没清，同一个家庭 id 再出现时额度是用过的");
});

test("注销只碰自己的手工门店，不碰全局目录", async () => {
  const transfer = await readFile(new URL("../app/api/_shared/dataTransfer.ts", import.meta.url), "utf8");
  const fn = functionBody(transfer, "export async function purgeHousehold");
  assert.ok(
    !fn.includes("source_key LIKE 'manual-%'\")"),
    "不带住户地删 manual-% 会把所有人的手工优惠一起删掉",
  );
  assert.ok(fn.includes("household_id = ? AND source_key LIKE 'manual-%'"), "手工来源没有按住户挑出来");
});

test("最后一个管理者不能一走了之", async () => {
  const auth = await readFile(new URL("../app/api/auth/route.ts", import.meta.url), "utf8");
  const fn = functionBody(auth, "async function deleteAccount");
  assert.ok(fn.includes("ownerCount("), "没有检查还剩几个管理者");
  assert.ok(
    fn.includes("confirmEmail") || fn.includes("typed !== account.email"),
    "没有要求把邮箱打一遍——这一步不可撤销，「确定吗」挡不住手滑",
  );
});
