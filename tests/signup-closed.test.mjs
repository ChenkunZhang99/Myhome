import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 对外部署上不能有自助注册。
 *
 * 请求登录链接的那一刻账号就建出来了（findOrCreateAccount），所以只要这个接口
 * 敞着，任何人输个邮箱就能在你的站点上有一个账号——然后用掉你配在服务端的
 * OpenAI 额度。今天之前挡住陌生人的其实只是「没配发信服务、链接发不出去」，
 * 那是意外，不是设计。
 *
 * 现在的规则：已有账号、第一个账号、手里有邀请，三者之一才放行。
 */

const route = await readFile(new URL("../app/api/auth/route.ts", import.meta.url), "utf8");

test("建账号之前先问过能不能注册", () => {
  const body = route.slice(route.indexOf("export const POST"));
  const gate = body.indexOf("await assertMayRegister(email)");
  const create = body.indexOf("await findOrCreateAccount(email)");
  assert.ok(gate !== -1, "缺少注册闸门");
  assert.ok(create !== -1, "找不到建账号的调用");
  assert.ok(gate < create, "闸门必须排在建账号之前，否则拦下来的时候人已经进去了");
});

test("三条放行路径一条都不能少", () => {
  const fn = route.slice(route.indexOf("async function assertMayRegister"));
  assert.match(fn, /if \(!loginRequired\(\)\) return;/, "单机自用模式不该被拦");
  assert.match(fn, /accountByEmail\(email\)/, "已有账号是登录，不是注册");
  assert.match(fn, /accountCount\(\)\) === 0/, "第一个人得进得来，否则部署完没人开得了门");
  assert.match(fn, /hasUsableInvite\(email\)/, "拿着邀请的家人要能注册");
});

test("拒绝的话不透露这个邮箱是否注册过", () => {
  const fn = route.slice(route.indexOf("async function assertMayRegister"));
  const thrown = fn.slice(fn.indexOf("throw new UserFacingError"));
  assert.doesNotMatch(thrown.slice(0, 120), /没注册|不存在|未找到/, "错误文案会变成邮箱枚举器");
});

test("只看不作废：注册时的邀请查询不能把邀请用掉", async () => {
  const invites = await readFile(new URL("../app/api/_shared/invites.ts", import.meta.url), "utf8");
  const fn = invites.slice(invites.indexOf("export async function hasUsableInvite"));
  const end = fn.indexOf("\n}");
  const body = fn.slice(0, end);
  assert.doesNotMatch(body, /UPDATE|DELETE/, "这里只该查询——真正的兑换发生在登录之后");
});
