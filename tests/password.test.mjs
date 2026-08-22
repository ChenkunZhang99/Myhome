import assert from "node:assert/strict";
import test from "node:test";
import { assertPasswordAllowed, hashPassword, verifyPassword } from "../app/api/_shared/passwordHash.ts";

/**
 * 密码哈希是那种「写错了也照样跑通」的代码：verifyPassword 只要无脑返回 true，
 * 登录一样成功，界面上看不出任何区别。所以这里逐条钉死它该拒绝的情况。
 *
 * 轮数用 10000——够验证逻辑，又不至于让整个测试套件慢下来。
 */
const ROUNDS = 10_000;

test("对的密码验得过，错的验不过", async () => {
  const stored = await hashPassword("correct horse battery", ROUNDS);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batter", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  // 只差最后一个字符也必须失败，说明比较的是全部而不是前缀
  assert.equal(await verifyPassword("correct horse batteryX", stored), false);
});

test("同一个密码每次哈希都不同——盐是随机的", async () => {
  const [a, b] = await Promise.all([hashPassword("same", ROUNDS), hashPassword("same", ROUNDS)]);
  assert.notEqual(a, b, "两次结果相同说明没加盐，一张彩虹表就能通吃");
  assert.equal(await verifyPassword("same", a), true);
  assert.equal(await verifyPassword("same", b), true);
});

test("存的字符串带着算法和轮数，以后换算法才有得可依", async () => {
  const stored = await hashPassword("whatever you like", ROUNDS);
  const [scheme, rounds] = stored.split("$");
  assert.equal(scheme, "pbkdf2-sha256");
  assert.equal(Number(rounds), ROUNDS);
  assert.equal(stored.split("$").length, 4, "格式应为 算法$轮数$盐$哈希");
});

test("被改坏的哈希是验不过，不是抛异常", async () => {
  const stored = await hashPassword("original", ROUNDS);
  for (const broken of [
    "",
    "$$$",
    "bcrypt$10$abc$def",
    stored.slice(0, stored.length - 4),
    stored.replace("pbkdf2-sha256", "plaintext"),
    "pbkdf2-sha256$0$c2FsdA==$aGFzaA==",
    "pbkdf2-sha256$abc$c2FsdA==$aGFzaA==",
  ]) {
    assert.equal(await verifyPassword("original", broken), false, `应当拒绝：${broken}`);
  }
});

test("轮数被人改小，老哈希仍按它自己记着的轮数验证", async () => {
  // 这是「自带参数」的意义：调整默认轮数不会把已有的密码全部作废。
  const stored = await hashPassword("portable", 20_000);
  assert.equal(await verifyPassword("portable", stored), true);
});

test("太短和太长的密码都进不来", () => {
  assert.throws(() => assertPasswordAllowed("short"), /至少 8 位/);
  assert.throws(() => assertPasswordAllowed(""), /至少 8 位/);
  assert.throws(() => assertPasswordAllowed(undefined), /至少 8 位/);
  assert.throws(() => assertPasswordAllowed("x".repeat(201)), /最多 200 位/);
  // 上限不是刁难人，是不让一个 10MB 的字符串把 CPU 打满
  assert.equal(assertPasswordAllowed("just long enough"), "just long enough");
  assert.equal(assertPasswordAllowed("x".repeat(200)).length, 200);
});
