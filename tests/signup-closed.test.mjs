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

/**
 * 密码注册这条路是后来加的（这个部署没配发信服务，被邀请的人收不到登录链接）。
 * 加一个入口就等于加一处可能忘掉闸门的地方，所以这几条单独钉住。
 */

const register = route.slice(route.indexOf("async function registerWithPassword"));

test("密码注册也要过同一道闸门", () => {
  assert.ok(register.startsWith("async function registerWithPassword"), "找不到密码注册");
  const gate = register.indexOf("await assertMayRegister(email)");
  const create = register.indexOf("await findOrCreateAccount(email)");
  assert.ok(gate !== -1, "密码注册绕开了闸门——换个入口就能自助注册");
  assert.ok(create !== -1, "找不到建账号的调用");
  assert.ok(gate < create, "闸门必须排在建账号之前");
});

test("密码注册不能盖掉已有账号的密码", () => {
  const existing = register.indexOf("await accountByEmail(email)");
  assert.ok(existing !== -1, "没有检查邮箱是否已注册");
  const thrown = register.slice(existing, existing + 220);
  assert.match(thrown, /409/, "已注册的邮箱必须被拒，否则拿着邀请就能给别人的邮箱设密码");
});

test("先问邀请再查邮箱，顺序反了就成了枚举器", () => {
  const gate = register.indexOf("await assertMayRegister(email)");
  const lookup = register.indexOf("await accountByEmail(email)");
  assert.ok(gate < lookup, "没有邀请的人不该问得出某个邮箱注册过没有");
});

/**
 * 密码注册把「能收到那封信」这道锁拆了——这个部署根本没有发信服务，那道锁本来就是空的。
 * 凭据只剩令牌本身，所以它必须真的被验一次。
 *
 * hasUsableInvite 顶不上：不绑邮箱的邀请对任何邮箱都成立，
 * 只要家里挂着一条开放邀请没用掉，它对陌生人也会说「可以」。
 *
 * 下面一律用 includes 而不是正则：这些断言里全是括号和点号，
 * 写成正则的话 (email, String(payload.invite 这种片段要么报错，要么静静匹配上别的东西。
 */

const NEWLINE = String.fromCharCode(10);

/** 从函数签名切到第一个顶格的右花括号，也就是这个函数的函数体。 */
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  if (at === -1) throw new Error("找不到 " + signature);
  const rest = source.slice(at + signature.length);
  const end = rest.indexOf(NEWLINE + "}");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("密码注册要验令牌本身，不能只问「有没有一条邀请」", () => {
  assert.ok(
    register.includes("assertInviteInHand(email, String(payload.invite"),
    "注册没有把令牌交给服务端验",
  );
  const fn = functionBody(route, "async function assertInviteInHand");
  assert.ok(fn.includes("inviteMatches(token, email)"), "必须按令牌查，不能退回 hasUsableInvite");
  assert.ok(fn.includes("throw new UserFacingError"), "验不过要拦下来");
});

test("按令牌查邀请也是只看不作废", async () => {
  const invites = await readFile(new URL("../app/api/_shared/invites.ts", import.meta.url), "utf8");
  const fn = functionBody(invites, "export async function inviteMatches");
  for (const word of ["UPDATE", "DELETE", "INSERT"]) {
    assert.ok(!fn.includes(word), "兑换发生在登录之后，这里只该查询，不该动 " + word);
  }
  assert.ok(fn.includes("hashToken(token)"), "令牌要哈希后再比对——明文不入库，也不该拿明文去查");
});

test("绑了邮箱的邀请不能被别的邮箱用掉", async () => {
  const invites = await readFile(new URL("../app/api/_shared/invites.ts", import.meta.url), "utf8");
  const fn = functionBody(invites, "export async function inviteMatches");
  assert.ok(fn.includes("row.email === email"), "邀请绑了邮箱，就只有那个邮箱能用");
  assert.ok(fn.includes("acceptedAt"), "用过的邀请不能再用");
  assert.ok(fn.includes("expiresAt"), "过期的邀请不能再用");
});
