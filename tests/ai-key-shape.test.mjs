import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 保存的密钥形状不对时，不能让它走到 Headers.set()。
 *
 * HTTP 头只能装 ISO-8859-1 字符。存了一个带中文、全角标点或换行的值，
 * Headers.set() 会抛 "String contains non ISO-8859-1 code point"——
 * 用户看到的是点一下按钮就弹一个看不懂的英文报错，而界面还写着「已配置」。
 *
 * 服务端那份（envKey）已经过同样的校验；这里守着客户端不要再漏。
 */

const settings = await readFile(new URL("../app/aiSettings.ts", import.meta.url), "utf8");
const panel = await readFile(new URL("../app/SettingsPanel.tsx", import.meta.url), "utf8");

test("形状不对就当作没配置，不往请求头里塞", () => {
  assert.match(settings, /if \(!isUsableKey\(apiKey\)\) return headers;/, "必须在 new Headers 之前拦下");
  const fn = settings.slice(settings.indexOf("export function withAiHeaders"));
  const guard = fn.indexOf("isUsableKey(apiKey)");
  const set = fn.indexOf("merged.set(API_KEY_HEADER");
  assert.ok(guard !== -1 && set !== -1);
  assert.ok(guard < set, "闸门要排在 set 之前，否则异常已经抛出来了");
});

test("模型名也要过一遍——它同样会被塞进请求头", () => {
  assert.match(settings, /MODEL_SHAPE\.test\(model\.trim\(\)\)/);
});

test("客户端和服务端用同一套形状规则", async () => {
  const server = await readFile(new URL("../app/api/_shared/openai.ts", import.meta.url), "utf8");
  const pattern = /\[A-Za-z0-9\._-\]\{20,200\}/;
  assert.match(settings, pattern, "客户端的密钥规则");
  assert.match(server, pattern, "服务端的密钥规则");
});

test("界面不对坏密钥说「已配置」", () => {
  assert.match(panel, /isUsableKey/, "状态展示要按形状判断，不是按有没有值");
  assert.match(panel, /密钥格式不对/, "得告诉用户是格式问题，而不是默默失败");
});
