import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 登录链接绝不能在对外部署上回给浏览器。
 *
 * 本地开发时把链接直接显示在界面上是刻意的便利：clone 下来不用配邮件服务
 * 就能走完登录。但同一段代码部署到公网上，就变成任何人输入别人的邮箱、
 * 页面上直接给出一条能进那个家的链接——彻底的认证绕过。
 *
 * 这个洞在第一次部署前才被发现，所以钉一个测试在这里：
 * 判断依据必须是「有没有开强制登录」，而不是别的什么。
 */

const mailer = await readFile(new URL("../app/api/_shared/mailer.ts", import.meta.url), "utf8");

test("没配发信服务时，强制登录的部署不把明文链接回给前端", () => {
  assert.match(
    mailer,
    /if \(loginRequired\(\)\) return \{ delivered: "console" \};/,
    "缺少这道闸门：开了 REQUIRE_HOUSEHOLD 就不该把 link 放进响应",
  );

  // 闸门必须排在「带 link 返回」之前，否则形同虚设
  const gate = mailer.indexOf('if (loginRequired()) return { delivered: "console" };');
  const leak = mailer.indexOf('return { delivered: "console", link };');
  assert.ok(gate !== -1 && leak !== -1, "两个分支都应当存在");
  assert.ok(gate < leak, "闸门必须在带 link 的返回之前");
});

test("链接始终写进日志——否则对外部署将无法完成第一次登录", () => {
  assert.match(mailer, /loginLink: link/, "日志里要留下链接，wrangler tail 才捞得到");
});

test("发信成功的那条路不回链接", () => {
  const [, afterFetch] = mailer.split("api.resend.com");
  assert.doesNotMatch(afterFetch, /link \}/, "配了发信服务之后，链接只应出现在邮件里");
});
