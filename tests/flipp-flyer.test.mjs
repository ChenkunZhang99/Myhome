import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fullPostalCode,
  merchantMatches,
  parseFlippItems,
  toFlippDeal,
} from "../app/api/flyers/sync/flipp.ts";
import { categoryFromText, displayFlyerName } from "../app/api/flyers/sync/flyerNaming.ts";

/**
 * Flipp 那条路的单元测试。
 *
 * 下面的原始记录照抄实测返回的形状（Walmart flyer 8082607，V3J0A1，2026-08-23），
 * 包括 {"name":"Direct Link","price":""} 这种版面元素——387 条里有 37 条是这类，
 * 是真实存在的，不是我编出来凑测试的。
 */

const TZ = "America/Vancouver";
const TODAY = "2026-08-23";
const FROM = "2026-08-20T03:00:00-04:00";
const TO = "2026-08-26T23:59:59-04:00";

const REAL = [
  { name: "Black Diamond Cheestrings 16s", price: "5.97", discount: 17, valid_from: FROM, valid_to: TO },
  { name: "Pork Belly", price: "4.97", discount: 30, valid_from: FROM, valid_to: TO },
  // 版面元素，不是商品
  { name: "Direct Link", price: "", discount: null, valid_from: FROM, valid_to: TO },
  // 没有折扣信息的那三分之一
  { name: "Thai Coco coconut cream", price: "1.98", discount: null, valid_from: FROM, valid_to: TO },
  // 已经过期
  {
    name: "McCain Superfries",
    price: "2.77",
    discount: 20,
    valid_from: "2026-08-01T03:00:00-04:00",
    valid_to: "2026-08-08T23:59:59-04:00",
  },
];

test("整理一份 flyer：丢掉版面元素和过期条目", () => {
  const deals = parseFlippItems(REAL, TODAY, TZ);
  assert.equal(deals.length, 3, "应当只剩三条真商品");
  assert.ok(!deals.some((deal) => deal.itemName === "Direct Link"), "版面元素混进来了");
  assert.ok(!deals.some((deal) => /Superfries/.test(deal.itemName)), "过期的条目混进来了");
});

test("折扣大的排前面", () => {
  const deals = parseFlippItems(REAL, TODAY, TZ);
  assert.equal(deals[0].itemName, "五花肉", "30% 那条应该排第一");
  assert.ok(
    deals[0].discount >= deals[deals.length - 1].discount,
    "一份 flyer 三百多条而下游只取十几条，不排序取到的是版面最靠前的，不是最划算的",
  );
});

test("由折扣百分比反推原价", () => {
  const [deal] = parseFlippItems([REAL[1]], TODAY, TZ);
  assert.equal(deal.price, 4.97);
  // 4.97 ÷ (1 - 0.30) = 7.10
  assert.equal(deal.regularPrice, 7.1);
});

test("折扣离谱就不反推原价", () => {
  const deal = toFlippDeal({ ...REAL[1], discount: 99 }, TODAY, TZ);
  assert.equal(deal.regularPrice, null, "99% 折扣反推出来的原价会是个笑话");
  const none = toFlippDeal({ ...REAL[1], discount: null }, TODAY, TZ);
  assert.equal(none.regularPrice, null, "没有折扣信息时不能编一个原价出来");
});

test("有效期换算成门店当地的日期", () => {
  const [deal] = parseFlippItems([REAL[1]], TODAY, TZ);
  assert.match(deal.validFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(deal.validFrom <= TODAY && deal.validTo >= TODAY, "今天必须落在有效期里");
});

test("商品名归到中文，分类归到中文枚举", () => {
  const [pork] = parseFlippItems([REAL[1]], TODAY, TZ);
  assert.equal(pork.itemName, "五花肉");
  assert.equal(pork.category, "肉类海鲜");
});

test("对照表没覆盖的保留英文原名，不硬猜", () => {
  assert.equal(displayFlyerName("LACTANTIA ULTRAPUR ULTRA-FILTERED MILK"), "牛奶");
  assert.equal(
    displayFlyerName("Welch's Fruit Snacks"),
    "Welch's Fruit Snacks",
    "猜不出中文名就留原文——猜错会让它和库存里别的东西错误匹配",
  );
});

test("同一件商品在版面上出现多次只留一条", () => {
  assert.equal(parseFlippItems([REAL[1], { ...REAL[1] }], TODAY, TZ).length, 1);
});

test("肉类排在冷冻前面：frozen shrimp 是海鲜，不是「冷冻食品」", () => {
  assert.equal(categoryFromText("Frozen Black Tiger Shrimp"), "肉类海鲜");
});

/**
 * 片区（FSA，邮编前三位）要补成完整六位。
 * Flipp 只给 V3J 会回 422——这个坑第一版就踩了。
 */
test("片区补成完整邮编", () => {
  assert.equal(fullPostalCode("V3J"), "V3J0A1");
  assert.equal(fullPostalCode("v3j 1n4"), "V3J1N4");
  assert.equal(fullPostalCode("V3J-1N4"), "V3J1N4");
  assert.equal(fullPostalCode("XX"), "", "补不成六位就别去请求");
  assert.equal(fullPostalCode("123"), "", "数字开头不是加拿大邮编");
});

/**
 * 连锁名对分店名。宁可漏配也不要错配——把 Safeway 的价格挂到
 * Save-On-Foods 名下，人跑到店里会发现根本没这个价。
 */
test("连锁名能对上分店名", () => {
  assert.ok(merchantMatches("Safeway", "Safeway Metrotown", "Safeway"));
  assert.ok(merchantMatches("T&T Supermarket", "T&T Supermarket Metropolis", "T&T"));
  assert.ok(merchantMatches("Walmart", "Walmart Supercentre Lougheed", null));
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

const NEWLINE = String.fromCharCode(10);
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, "找不到 " + signature);
  return source.slice(at, source.indexOf(NEWLINE + "}", at));
}

test("Flipp 排在模型搜索之前", () => {
  const useFlipp = route.indexOf("merchantMatches(flyer.merchant");
  const pushFallback = route.indexOf("fallbackStores.push(store)");
  assert.notEqual(useFlipp, -1, "同步里没有用上 Flipp");
  assert.ok(useFlipp < pushFallback, "先问 Flipp，问不到才交给模型搜网页");
});

test("每个片区只列一次 flyer，不是每家店列一次", () => {
  assert.ok(route.includes("const flyersByArea = new Map"), "没有按片区归拢");
  assert.ok(route.includes("[...new Set(stores.results.map((store) => store.area)"), "片区没有去重");
});

test("只取有人订阅的那几份 flyer 的内容", () => {
  const at = route.indexOf("const flyersByArea = new Map");
  const around = route.slice(at, at + 600);
  assert.ok(!around.includes("fetchFlyerDeals"), "在列表阶段就把每份 flyer 都读了——没人订阅的店不该白读一份");
  assert.ok(route.includes("await fetchFlyerDeals(mine.id"), "没有按门店点名去取那一份");
});

test("两个读取函数都不抛异常", () => {
  for (const signature of [
    "export async function fetchFlippFlyers",
    "export async function fetchFlyerDeals",
  ]) {
    const body = functionBody(flipp, signature);
    assert.ok(body.includes("} catch (error) {"), signature + " 没有兜住异常");
    assert.ok(body.includes("return [];"), signature + " 失败时没有退回空数组");
    assert.ok(!body.includes("throw"), "任何抛出都会连累已经能跑的 PriceSmart");
  }
});

test("每次读取都留一行日志，失效不能悄无声息", () => {
  const body = functionBody(flipp, "export async function fetchFlyerDeals");
  assert.ok(body.includes("note({"), "读取路径上没有日志");
  assert.ok(body.includes("raw: raw.length"), "没有记下拿到几条——分不清是接口挂了还是过滤过严");
  assert.ok(body.includes("kept: deals.length"), "没有记下留下几条");
});

test("演示模式不出网", () => {
  const at = route.indexOf("const flyersByArea = new Map");
  const around = route.slice(at, at + 400);
  assert.ok(around.includes("if (!demo)"), "演示模式下不该真的去请求 Flipp");
});

test("认得出品类的排在「其他」前面，哪怕折扣小一些", () => {
  const deals = parseFlippItems(
    [
      // 折扣大但归不进任何食品分类：书、除臭剂这类
      { name: "Distant Shores hardcover", price: "27", discount: 80, valid_from: FROM, valid_to: TO },
      // 折扣小，但是真的会出现在库存里的东西
      { name: "Pork Belly", price: "4.97", discount: 10, valid_from: FROM, valid_to: TO },
    ],
    TODAY,
    TZ,
  );
  assert.equal(
    deals[0].itemName,
    "五花肉",
    "纯按折扣排，头部会是书和除臭剂——打折力度大，但和「家里缺什么」毫无关系",
  );
});

test("同步不对 Flipp 的结果二次排序", () => {
  const at = route.indexOf("await fetchFlyerDeals(mine.id");
  const around = route.slice(at, at + 500);
  assert.ok(
    !around.includes("selectDeals("),
    "selectDeals 只按折扣排，会把 parseFlippItems 排好的「食品优先」再打乱一遍",
  );
  assert.ok(around.includes("flippDeals.slice(0, 18)"), "没有取前若干条");
});
