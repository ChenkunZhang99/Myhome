import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 按邮编找超市这件事，值钱的地方全在「什么时候不调模型」。
 *
 * 目录做成全局的唯一理由就是省 token：同一个片区的第二个人应当直接命中已有结果。
 * 缓存查询一旦排到模型调用后面，或者去重键一旦不稳，这个理由就没了——
 * 每个人都会重搜一遍，同一家店在目录里躺着好几行，同一份 flyer 被解析好几次。
 *
 * 一律用 includes：这些断言里全是括号和点号。
 */

const discovery = await readFile(new URL("../app/api/_shared/storeDiscovery.ts", import.meta.url), "utf8");
const sync = await readFile(new URL("../app/api/flyers/sync/route.ts", import.meta.url), "utf8");
const planner = await readFile(new URL("../app/api/planner/route.ts", import.meta.url), "utf8");

const NEWLINE = String.fromCharCode(10);

function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, "找不到 " + signature);
  const rest = source.slice(at + signature.length);
  const end = rest.indexOf(NEWLINE + "}");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("先查片区缓存，再考虑调模型", () => {
  const fn = functionBody(discovery, "export async function discoverStores");
  const cache = fn.indexOf("storesInArea(area)");
  const call = fn.indexOf("createOpenAIResponse(");
  assert.notEqual(cache, -1, "没有查缓存——全局目录省 token 的理由就没了");
  assert.notEqual(call, -1, "找不到模型调用");
  assert.ok(cache < call, "缓存必须查在模型调用之前，否则每个人都要重搜一遍");
  assert.ok(fn.includes("if (cached.length) return"), "命中缓存之后没有直接返回");
});

test("片区是邮编前三位，不是整串也不是省份", () => {
  const fn = functionBody(discovery, "export function areaOf");
  assert.ok(fn.includes("slice(0, 3)"), "片区粒度不对");
  assert.ok(fn.includes("length < 3"), "太短的邮编要判为无效，不能凑出一个片区");
});

test("同一家店在两个邮编下搜出来要是同一行", () => {
  const fn = functionBody(discovery, "function identityKey");
  assert.ok(fn.includes("toLowerCase()"), "大小写不同就成了两家店");
  assert.ok(fn.includes("streetNumber"), "光靠名字去重，同一连锁的两家分店会被并成一家");
  const key = functionBody(discovery, "function sourceKeyFor");
  assert.ok(key.includes("identityKey("), "sourceKey 没有建立在这个稳定键上");
});

test("入库一律 OR IGNORE / DO NOTHING，重复搜不会写坏已有的行", () => {
  const fn = functionBody(discovery, "export async function discoverStores");
  assert.ok(fn.includes("ON CONFLICT(source_key) DO NOTHING"), "重复搜会覆盖目录里已有的门店信息");
  assert.ok(fn.includes("ON CONFLICT(area, source_key) DO NOTHING"), "片区索引没有做成幂等");
});

test("每一条搜索结果都要过 validate", () => {
  const fn = functionBody(discovery, "export async function discoverStores");
  assert.ok(fn.includes("validate(raw)"), "模型返回的结果被直接入库了");
  const check = functionBody(discovery, "function validate");
  assert.ok(check.includes('url.protocol !== "https:"'), "没有挡住非 https 的网址");
  assert.ok(check.includes("url.username"), "带凭据的网址不是一个公开的 flyer 页面");
});

test("搜索结果只是候选，要用户自己挑", () => {
  assert.ok(planner.includes('if (type === "discoverStores")'), "planner 没有接上这个动作");
  const at = planner.indexOf('if (type === "discoverStores")');
  const body = planner.slice(at, at + 400);
  assert.ok(!body.includes("household_stores"), "搜完就直接塞进这户的收藏——模型编的店也一起进去了");
});

/**
 * 目录能长大之后，同步那边有两处会随用户数膨胀。
 */

test("同步只读真的有人收藏的门店", () => {
  assert.ok(
    sync.includes("EXISTS (SELECT 1 FROM household_stores"),
    "读遍整个目录：一个多伦多用户搜出来、没人订阅的店，也要在每次同步时花一次模型调用",
  );
});

test("允许搜索的域名跟着本批门店走，不能写死", () => {
  assert.ok(!sync.includes("const allowedHosts = ["), "域名写死了，新搜出来的店永远读不出优惠");
  assert.ok(sync.includes("function hostsOf("), "找不到从门店网址取域名的地方");
  assert.ok(sync.includes("allowed_domains: hostsOf("), "web_search 还在用写死的域名列表");
});

test("界面上不再有写死的门店列表", async () => {
  const panel = await readFile(new URL("../app/PlannerPanel.tsx", import.meta.url), "utf8");
  assert.ok(
    !panel.includes("lougheedSources"),
    "写死三家 Lougheed 门店，等于告诉多伦多的用户「你附近只有这三家」",
  );
  assert.ok(panel.includes('type: "discoverStores"'), "界面没有接上按邮编搜索");
});
