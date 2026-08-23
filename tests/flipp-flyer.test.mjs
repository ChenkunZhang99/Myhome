import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { merchantMatches, parseFlippItems, toFlippDeal } from "../app/api/flyers/sync/flipp.ts";
import { categoryFromText, displayFlyerName } from "../app/api/flyers/sync/flyerNaming.ts";

/**
 * Flipp 那条路的单元测试。
 *
 * 下面的原始记录都照抄实测返回的形状（V3J1N4，2026-08-23），
 * 包括 Chong Lee 那种 name 和 price 都是 null 的占位记录——它是真实存在的，
 * 不是我编出来凑测试的。
 */

const TZ = "America/Vancouver";
const TODAY = "2026-08-23";

const REAL = [
  {
    merchant_name: "T&T Supermarket",
    name: "PORK BELLY",
    current_price: 4.97,
    original_price: null,
    post_price_text: "/lb",
    valid_from: "2026-08-20T07:00:00+00:00",
    valid_to: "2026-08-27T03:59:59+00:00",
    _L1: "Food, Beverages & Tobacco",
    _L2: "Meat & Seafood",
  },
  {
    merchant_name: "No Frills",
    name: "GREEN ONIONS",
    current_price: 1.49,
    original_price: 2.49,
    post_price_text: null,
    valid_from: "2026-08-20T07:00:00+00:00",
    valid_to: "2026-08-27T03:59:59+00:00",
    _L1: "Food, Beverages & Tobacco",
    _L2: "Produce",
  },
  // 实测混在结果里的占位记录：没名字也没价格
  {
    merchant_name: "Chong Lee Market",
    name: null,
    current_price: null,
    valid_from: "2026-08-20T07:00:00+00:00",
    valid_to: "2026-08-27T03:59:59+00:00",
  },
  // 已经过期的，不该录入
  {
    merchant_name: "Safeway",
    name: "COMPLIMENTS Whole Chicken",
    current_price: 4.49,
    post_price_text: "/lb",
    valid_from: "2026-08-01T07:00:00+00:00",
    valid_to: "2026-08-08T03:59:59+00:00",
  },
];

test("整理一批真实记录：丢掉占位的和过期的", () => {
  const deals = parseFlippItems(REAL, TODAY, TZ);
  assert.equal(deals.length, 2, "应当只剩 T&T 和 No Frills 两条");
  assert.deepEqual(deals.map((deal) => deal.merchantName).sort(), ["No Frills", "T&T Supermarket"]);
});

test("价格、原价和单位都取对了", () => {
  const [pork] = parseFlippItems([REAL[0]], TODAY, TZ);
  assert.equal(pork.price, 4.97);
  assert.equal(pork.unit, "lb", "post_price_text 是 /lb");
  assert.equal(pork.regularPrice, null, "没有原价时不能编一个出来");

  const [onion] = parseFlippItems([REAL[1]], TODAY, TZ);
  assert.equal(onion.regularPrice, 2.49);
  assert.equal(onion.unit, "件", "没有计价单位就按件算");
});

test("原价不高于现价时当作没有原价", () => {
  const deal = toFlippDeal({ ...REAL[1], original_price: 1.0 }, TODAY, TZ);
  assert.equal(deal.regularPrice, null, "原价比现价还低，那不是折扣，是脏数据");
});

test("有效期换算成门店当地的日期", () => {
  const [pork] = parseFlippItems([REAL[0]], TODAY, TZ);
  assert.match(pork.validFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(pork.validTo, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pork.validFrom <= TODAY && pork.validTo >= TODAY, "今天必须落在有效期里");
});

test("商品名归到中文，分类归到中文枚举", () => {
  const [pork] = parseFlippItems([REAL[0]], TODAY, TZ);
  assert.equal(pork.itemName, "五花肉");
  assert.equal(pork.category, "肉类海鲜");

  const [onion] = parseFlippItems([REAL[1]], TODAY, TZ);
  assert.equal(onion.itemName, "小葱");
  assert.equal(onion.category, "蔬菜水果");
});

test("对照表没覆盖的保留英文原名，不硬猜", () => {
  assert.equal(displayFlyerName("LACTANTIA ULTRAPUR ULTRA-FILTERED MILK"), "牛奶");
  assert.equal(
    displayFlyerName("Welch's Fruit Snacks"),
    "Welch's Fruit Snacks",
    "猜不出中文名就留原文——猜错会让它和库存里别的东西错误匹配",
  );
});

test("同一件商品在 flyer 里出现多次只留一条", () => {
  const twice = [REAL[0], { ...REAL[0] }];
  assert.equal(parseFlippItems(twice, TODAY, TZ).length, 1);
});

test("肉类排在冷冻前面：frozen shrimp 是海鲜，不是「冷冻食品」", () => {
  assert.equal(categoryFromText("Frozen Black Tiger Shrimp"), "肉类海鲜");
});

/**
 * 连锁名对分店名。宁可漏配也不要错配——把 Safeway 的价格挂到
 * Save-On-Foods 名下，人跑到店里会发现根本没这个价。
 */
test("连锁名能对上分店名", () => {
  assert.ok(merchantMatches("Safeway", "Safeway Metrotown", "Safeway"));
  assert.ok(merchantMatches("T&T Supermarket", "T&T Supermarket Metropolis", "T&T"));
  assert.ok(merchantMatches("Save-On-Foods", "Save-On-Foods Austin", "Save-On-Foods"));
  assert.ok(merchantMatches("PriceSmart foods", "PriceSmart Foods Lougheed", null), "大小写不该影响");
});

test("不是一家店就不能对上", () => {
  assert.ok(!merchantMatches("Safeway", "Save-On-Foods Austin", "Save-On-Foods"));
  assert.ok(!merchantMatches("Walmart", "H Mart Coquitlam", null));
  assert.ok(!merchantMatches("", "Safeway Metrotown", "Safeway"), "空商家名不能配上任何店");
});

/**
 * Flipp 的全部价值是零 token。它必须排在模型搜索之前，
 * 而且它挂了不能拖垮已经能跑的那两条路。
 */

const route = await readFile(new URL("../app/api/flyers/sync/route.ts", import.meta.url), "utf8");
const flipp = await readFile(new URL("../app/api/flyers/sync/flipp.ts", import.meta.url), "utf8");

test("Flipp 排在模型搜索之前", () => {
  const useFlipp = route.indexOf("merchantMatches(deal.merchantName");
  const pushFallback = route.indexOf("fallbackStores.push(store)");
  assert.notEqual(useFlipp, -1, "同步里没有用上 Flipp");
  assert.ok(useFlipp < pushFallback, "先问 Flipp，问不到才交给模型搜网页");
});

test("每个片区只查一次，不是每家店查一次", () => {
  assert.ok(route.includes("const flippByArea = new Map"), "没有按片区归拢");
  assert.ok(route.includes("[...new Set(stores.results.map((store) => store.area)"), "片区没有去重");
});

test("读不到就返回空数组，绝不抛异常", () => {
  const at = flipp.indexOf("export async function fetchFlippDeals");
  const body = flipp.slice(at);
  assert.ok(body.includes("if (!response.ok) return [];"), "HTTP 失败要静默退回");
  assert.ok(body.includes("} catch {"), "没有兜住异常——一个没有文档的接口挂了会拖垮整次同步");
});

test("演示模式不出网", () => {
  const at = route.indexOf("const flippByArea = new Map");
  const around = route.slice(at, at + 400);
  assert.ok(around.includes("if (!demo)"), "演示模式下不该真的去请求 Flipp");
});
