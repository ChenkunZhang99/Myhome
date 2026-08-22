import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 服务端那份 OpenAI 密钥只给部署者自己的家用。
 *
 * 花的是部署者的钱。别的住户想用 AI 功能，各自在浏览器里填一个——
 * 那份只存在他们自己的 localStorage 里，和这台服务器无关。
 *
 * 这条约束最容易在「新加一个 AI 接口」时被绕过：忘了把住户传进去，
 * 那个接口就对所有人放开了服务端密钥。所以参数是必填的，
 * 忘了传编译器会报错——下面这条测试守着它不被改回可选。
 */

const openai = await readFile(new URL("../app/api/_shared/openai.ts", import.meta.url), "utf8");

test("住户是必填参数，不能写成可选", () => {
  assert.match(
    openai,
    /export function getOpenAIConfig\(\s*request: Request \| undefined,\s*householdId: string \| null,?\s*\)/,
    "写成可选的话，新增接口时忘了传不会报错，而后果只会出现在账单上",
  );
});

test("不是那一家就拿不到服务端密钥", () => {
  assert.match(
    openai,
    /const mayUseServerKey = householdId === null \|\| householdId === serverKeyHousehold\(\);/,
  );
  assert.match(
    openai,
    /apiKey: headerKey \|\| \(mayUseServerKey \? envKey\(\) : ""\)/,
    "自带的密钥永远优先；服务端那份要先过住户这一关",
  );
});

test("哪一家可以用是配置项，不是写死的", () => {
  assert.match(openai, /AI_HOUSEHOLD/, "换一家不该需要改代码");
  assert.match(openai, /configured \|\| DEFAULT_HOUSEHOLD_ID/, "不配时回落到默认住户");
});

test("模型名不受这条限制——它不花钱", () => {
  const fn = openai.slice(openai.indexOf("export function getOpenAIConfig"));
  assert.match(fn, /model: headerModel \|\| envModel\(\) \|\| DEFAULT_MODEL/);
});
