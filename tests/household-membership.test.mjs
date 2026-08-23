import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 「一个人可以有多个家，但只能进自己的家」这条约定的闸门。
 *
 * 数据隔离靠的是每条查询都带 household_id（household-scoping.test.mjs 盯着那件事）。
 * 但那只保证「查的是某一家的数据」，不保证「这个人有资格看那一家」。
 * 那一半在这里：household_id 现在是请求里带上来的参数，凡是用到它的动作，
 * 第一步都必须是 membershipRole()。
 *
 * 少一处，household_id 就成了任填的字段，隔离就只剩下一个形式。
 *
 * 一律用 includes 而不是正则：这些断言里全是括号和点号。
 */

const route = await readFile(new URL("../app/api/household/route.ts", import.meta.url), "utf8");
const accounts = await readFile(new URL("../app/api/_shared/accounts.ts", import.meta.url), "utf8");
const household = await readFile(new URL("../app/api/_shared/household.ts", import.meta.url), "utf8");

const NEWLINE = String.fromCharCode(10);

/** 从函数签名切到第一个顶格的右花括号，也就是这个函数的函数体。 */
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, "找不到 " + signature);
  const rest = source.slice(at + signature.length);
  const end = rest.indexOf(NEWLINE + "}");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("换家之前先验有没有资格，顺序不能反", () => {
  const fn = functionBody(route, "async function switchTo");
  const check = fn.indexOf("membershipRole(account.id, householdId)");
  const apply = fn.indexOf("setActiveHousehold(account.id, householdId)");
  assert.notEqual(check, -1, "切换家庭没有验 membership——填谁家的 id 就能看谁家的数据");
  assert.notEqual(apply, -1, "找不到切换指针的调用");
  assert.ok(check < apply, "验证必须排在切换之前");
});

test("改设置、发邀请、动别人，都要是这个家的管理者", () => {
  for (const signature of [
    "async function rename",
    "async function invite",
    "async function revoke",
    "async function promote",
    "async function remove",
  ]) {
    const fn = functionBody(route, signature);
    assert.ok(fn.includes("requireOwner(request)"), signature + " 没有要求管理者身份");
  }
  const owner = functionBody(route, "async function requireOwner");
  assert.ok(
    owner.includes("membershipRole(account.id, account.householdId)"),
    "管理者判断必须查当前这个家的 membership，不能读 users.role——同一个人在不同的家里角色不同",
  );
});

test("被请出去的人，指针也要跟着挪走", () => {
  const fn = functionBody(route, "async function remove");
  const drop = fn.indexOf("removeMembership(userId");
  const repoint = fn.indexOf("repointToAnyHousehold(userId");
  assert.notEqual(drop, -1, "没有删掉 membership");
  assert.notEqual(repoint, -1, "资格没了但指针还指着这里，被踢的人照样读得到");
  assert.ok(drop < repoint, "先撤资格再挪指针");
});

test("加入一个家不会把人从原来的家里拿掉", () => {
  const fn = functionBody(route, "async function accept");
  assert.ok(fn.includes("addMembership(account.id, householdId"), "接受邀请要加一条 membership");
  assert.ok(!fn.includes("removeMembership"), "加入是「多一个家」，不该顺手退掉原来那个");
});

test("没有资格的指针会被自愈，不能靠每条路径自己记得挪", () => {
  const fn = functionBody(household, "export async function currentAccount");
  assert.ok(fn.includes("account.memberRole"), "没有检查当前这个家还进不进得去");
  assert.ok(fn.includes("repointToAnyHousehold"), "进不去的时候没有把指针挪开");
});

test("accountById 不能把「没有 membership」糊成默认角色", () => {
  const fn = functionBody(accounts, "export async function accountById");
  assert.ok(fn.includes("m.role AS memberRole"), "要能区分「不在这个家」和「角色是 member」");
  assert.ok(
    !fn.includes("COALESCE(m.role"),
    "COALESCE 会把「没有资格」变成一个看起来正常的角色，资格没了照样读得到数据",
  );
});

test("membership 的读写都同时带上人和家", () => {
  for (const signature of [
    "export async function membershipRole",
    "export async function addMembership",
    "export async function removeMembership",
    "export async function setMembershipRole",
  ]) {
    const fn = functionBody(accounts, signature);
    assert.ok(fn.includes("user_id"), signature + " 的 SQL 没带 user_id");
    assert.ok(fn.includes("household_id"), signature + " 的 SQL 没带 household_id");
  }
});

test("建账号时顺带把家和成员关系一起建出来", () => {
  const fn = functionBody(accounts, "export async function findOrCreateAccount");
  assert.ok(fn.includes("INSERT OR IGNORE INTO households"), "新账号没有对应的家");
  assert.ok(fn.includes("INSERT OR IGNORE INTO household_memberships"), "新账号进不了自己的家");
});

test("迁移语句是幂等的，每个请求都会跑一遍", async () => {
  const schema = await readFile(new URL("../app/api/_shared/schema.ts", import.meta.url), "utf8");
  const at = schema.indexOf("const SEEDS = [");
  assert.notEqual(at, -1, "找不到 SEEDS");
  const seeds = schema.slice(at, schema.indexOf("];", at));
  assert.ok(seeds.includes("INSERT OR IGNORE INTO households"), "老库里的家没有被补出名字行");
  assert.ok(
    seeds.includes("INSERT OR IGNORE INTO household_memberships"),
    "老库里「一人一家」的关系没有被补成 membership——升级之后老用户会进不去自己的家",
  );
  for (const line of seeds.split(NEWLINE)) {
    // 只看真正的语句行——SEEDS 里的说明文字也提到这两张表。
    const sql = line.trim();
    if (!sql.startsWith('"INSERT')) continue;
    if (!sql.includes("household_memberships") && !sql.includes("INTO households")) continue;
    assert.ok(sql.includes("OR IGNORE"), "迁移语句每个请求都会跑，必须幂等：" + sql);
  }
});
