import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlyerPurchasePlan,
  daysToExpiry,
  estimateDaysLeft,
  isOverviewNearbyPick,
  overviewNearbyInterest,
  packagePrice,
  recommendFlyerDeals,
} from "../app/flyerRecommendations.ts";

const activeWindow = { validFrom: "2026-08-10", validTo: "2026-08-20" };

test("separates targeted household supplies from broad food categories", () => {
  const inventory = [
    { name: "洗碗球", category: "清洁用品", level: "偏少", quantity: 1 },
    { name: "猪肉", category: "肉类海鲜", level: "偏少", quantity: 1 },
    { name: "洗衣球", category: "清洁用品", level: "充足", quantity: 8 },
  ];
  const deals = [
    { id: "dish", itemName: "洗碗块", category: "清洁用品", price: 9, regularPrice: 12, ...activeWindow },
    { id: "meat", itemName: "三文鱼", category: "肉类海鲜", price: 8, regularPrice: 10, ...activeWindow },
    {
      id: "laundry",
      itemName: "洗衣凝珠",
      category: "清洁用品",
      price: 10,
      regularPrice: 14,
      ...activeWindow,
    },
  ];
  const result = recommendFlyerDeals(inventory, deals, "2026-08-14");
  assert.equal(result.find((item) => item.dealId === "dish")?.kind, "substitute");
  assert.equal(result.find((item) => item.dealId === "meat")?.kind, "category");
  assert.equal(
    result.some((item) => item.dealId === "laundry"),
    false,
  );
});

test("ignores expired flyer deals and sufficient inventory", () => {
  const inventory = [{ name: "洗碗球", category: "清洁用品", level: "充足", quantity: 12 }];
  const deals = [
    {
      id: "expired",
      itemName: "洗碗块",
      category: "清洁用品",
      price: 9,
      regularPrice: 12,
      validFrom: "2026-08-01",
      validTo: "2026-08-07",
    },
  ];
  assert.deepEqual(recommendFlyerDeals(inventory, deals, "2026-08-14"), []);
});

test("uses remaining percentage for targeted replenishment regardless of count unit", () => {
  const inventory = [
    { name: "洗碗球", category: "清洁用品", level: "充足", quantity: 1, unit: "袋", remainingPercent: 10 },
  ];
  const deals = [
    {
      id: "dish",
      storeId: "store-a",
      itemName: "洗碗凝珠",
      category: "清洁用品",
      price: 9,
      regularPrice: 14,
      unit: "盒",
      ...activeWindow,
    },
  ];
  const result = recommendFlyerDeals(inventory, deals, "2026-08-14");
  assert.equal(result[0]?.dealId, "dish");
  assert.equal(result[0]?.tier, "must");
});

test("remembers manual match rules and calculates comparable unit prices", () => {
  const inventory = [{ name: "早餐麦片", category: "米面粮油", level: "即将用完", quantity: 1 }];
  const deals = [
    {
      id: "oats",
      storeId: "store-a",
      itemName: "Rolled Oats 2kg",
      category: "米面粮油",
      price: 8,
      regularPrice: 12,
      unit: "袋",
      ...activeWindow,
    },
  ];
  const rules = [
    {
      id: "rule",
      inventoryName: "早餐麦片",
      dealPattern: "Rolled Oats",
      category: "米面粮油",
      matchKind: "substitute",
      active: true,
    },
  ];
  const result = recommendFlyerDeals(inventory, deals, rules, "2026-08-14");
  assert.equal(result[0]?.kind, "substitute");
  assert.equal(result[0]?.tier, "must");
  assert.equal(packagePrice(deals[0]).unitPrice, 4);
  assert.equal(packagePrice(deals[0]).unit, "kg");
});

test("purchase plan respects store limit and category budgets", () => {
  const deals = [
    {
      id: "a",
      storeId: "store-a",
      itemName: "鸡腿",
      category: "肉类海鲜",
      price: 9,
      regularPrice: 12,
      unit: "件",
      ...activeWindow,
    },
    {
      id: "b",
      storeId: "store-b",
      itemName: "鸡翅",
      category: "肉类海鲜",
      price: 7,
      regularPrice: 10,
      unit: "件",
      ...activeWindow,
    },
  ];
  const recommendations = [
    { dealId: "a", storeId: "store-a", score: 120, tier: "must", kind: "targeted" },
    { dealId: "b", storeId: "store-b", score: 70, tier: "recommended", kind: "category" },
  ];
  const plan = buildFlyerPurchasePlan(recommendations, deals, {
    foodBudget: 12,
    householdBudget: 20,
    maxStores: 1,
  });
  assert.deepEqual(plan.storeIds, ["store-a"]);
  assert.deepEqual(plan.dealIds, ["a"]);
  assert.equal(plan.total, 9);
});

test("recommends a product once, keeping the store with the lowest unit price", () => {
  const inventory = [
    { name: "洗衣液", category: "清洁用品", level: "即将用完", quantity: 1, remainingPercent: 20 },
  ];
  const deals = [
    {
      id: "hmart",
      storeId: "store-hmart",
      itemName: "洗衣凝珠 32pk",
      category: "清洁用品",
      price: 9.19,
      regularPrice: 14.99,
      unit: "盒",
      ...activeWindow,
    },
    {
      id: "pricesmart",
      storeId: "store-pricesmart",
      itemName: "洗衣凝珠 32pk",
      category: "清洁用品",
      price: 8.99,
      regularPrice: 14.99,
      unit: "盒",
      ...activeWindow,
    },
  ];
  const result = recommendFlyerDeals(inventory, deals, "2026-08-14");
  // 两家店的同一件商品只出现一次，留下更便宜的那家。
  assert.equal(result.length, 1);
  assert.equal(result[0].dealId, "pricesmart");
  // 并且告诉用户还有一家也在特价。
  assert.equal(result[0].alsoAtStoreCount, 1);
});

test("keeps genuinely different products separate", () => {
  const inventory = [
    { name: "洗衣液", category: "清洁用品", level: "即将用完", quantity: 1, remainingPercent: 20 },
    { name: "菠菜", category: "蔬菜水果", level: "偏少", quantity: 1, remainingPercent: 40 },
  ];
  const deals = [
    {
      id: "pods",
      storeId: "store-a",
      itemName: "洗衣凝珠 32pk",
      category: "清洁用品",
      price: 8.99,
      regularPrice: 14.99,
      unit: "盒",
      ...activeWindow,
    },
    {
      id: "spinach",
      storeId: "store-a",
      itemName: "菠菜",
      category: "蔬菜水果",
      price: 1.49,
      regularPrice: 2.99,
      unit: "把",
      ...activeWindow,
    },
  ];
  const result = recommendFlyerDeals(inventory, deals, "2026-08-14");
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => item.alsoAtStoreCount),
    [0, 0],
  );
});

/**
 * 「还剩多少」说明不了什么，「还能撑几天」才决定要不要现在买。
 *
 * 同样剩 40%：买了 2 天就剩 40% 的，三天后没了；买了 45 天才剩 40% 的，
 * 还能撑两个月。原来的紧急度对这两种情况一视同仁。
 */
test("按消耗速度推算还能撑几天", () => {
  const fast = {
    name: "牛奶",
    category: "乳品蛋类",
    level: "充足",
    remainingPercent: 40,
    purchaseDate: dayOffset(-2),
  };
  const slow = {
    name: "米",
    category: "米面粮油",
    level: "充足",
    remainingPercent: 40,
    purchaseDate: dayOffset(-45),
  };
  const quick = estimateDaysLeft(fast, today());
  const lasting = estimateDaysLeft(slow, today());
  assert.ok(quick !== undefined && lasting !== undefined, "两个都算得出来");
  assert.ok(quick < 3, `两天用掉六成，应该撑不过三天，实得 ${quick}`);
  assert.ok(lasting > 20, `四十五天才用掉六成，应该还早，实得 ${lasting}`);

  // 没动过就没有消耗速度可言，别硬编一个数字出来
  assert.equal(estimateDaysLeft({ ...fast, remainingPercent: 100 }, today()), undefined);
  // 查不到购买日同理
  assert.equal(estimateDaysLeft({ ...fast, purchaseDate: null }, today()), undefined);
});

test("消耗快的东西会被排到前面", () => {
  const deals = [
    { id: "milk", itemName: "牛奶", category: "乳品蛋类", price: 3, regularPrice: 4, ...activeWindow },
    { id: "rice", itemName: "大米", category: "米面粮油", price: 20, regularPrice: 25, ...activeWindow },
  ];
  const inventory = [
    { name: "牛奶", category: "乳品蛋类", level: "充足", remainingPercent: 40, purchaseDate: dayOffset(-2) },
    { name: "大米", category: "米面粮油", level: "充足", remainingPercent: 40, purchaseDate: dayOffset(-45) },
  ];
  const ranked = recommendFlyerDeals(inventory, deals, [], today());
  const milk = ranked.find((r) => r.dealId === "milk");
  const rice = ranked.find((r) => r.dealId === "rice");
  assert.ok(milk && rice, "两条都该被推出来");
  assert.ok(milk.score > rice.score, "快用完的要排在前面");
  assert.ok(milk.daysLeft < rice.daysLeft, "还能撑的天数要跟着一起给出来");
});

test("快过期等于快没有了，哪怕瓶子还是满的", () => {
  const deals = [
    { id: "milk", itemName: "牛奶", category: "乳品蛋类", price: 3, regularPrice: 4, ...activeWindow },
  ];
  const soon = [
    { name: "牛奶", category: "乳品蛋类", level: "充足", remainingPercent: 90, expiryDate: dayOffset(1) },
  ];
  const later = [
    { name: "牛奶", category: "乳品蛋类", level: "充足", remainingPercent: 90, expiryDate: dayOffset(60) },
  ];
  const urgent = recommendFlyerDeals(soon, deals, [], today());
  const relaxed = recommendFlyerDeals(later, deals, [], today());
  assert.ok(urgent.length, "明天到期的应该产生推荐");
  assert.equal(urgent[0].expiresInDays, 1, "到期天数要一并给出");
  const relaxedScore = relaxed[0]?.score ?? 0;
  assert.ok(urgent[0].score > relaxedScore, "快过期的要排在还早的前面");
});

test("每条推荐都说得清自己的分数是怎么来的", () => {
  const deals = [
    { id: "dish", itemName: "洗碗球", category: "清洁用品", price: 6, regularPrice: 12, ...activeWindow },
  ];
  const inventory = [
    { name: "洗碗球", category: "清洁用品", level: "已用完", quantity: 0, remainingPercent: 0 },
  ];
  const [top] = recommendFlyerDeals(inventory, deals, [], today());
  assert.ok(top.factors?.length, "缺少分数构成，出了烂推荐就无从下手");
  const sum = top.factors.reduce((total, f) => total + f.points, 0);
  assert.equal(Math.round(sum * 100), Math.round(top.score * 100), "各项加起来必须等于总分");
  assert.ok(
    top.factors.some((f) => f.label.includes("同名")),
    "匹配精度要出现在构成里",
  );
  assert.ok(
    top.factors.some((f) => f.label.includes("折扣")),
    "折扣要出现在构成里",
  );
});

function today() {
  return "2026-08-15";
}
function dayOffset(days) {
  const base = new Date("2026-08-15T00:00:00");
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

test("到期天数按传入的那一天算，不看设备时钟", () => {
  const item = { name: "牛奶", category: "乳品蛋类", level: "充足", expiryDate: "2026-08-18" };
  assert.equal(daysToExpiry(item, "2026-08-15"), 3);
  assert.equal(daysToExpiry(item, "2026-08-18"), 0, "当天到期是 0 不是 1");
  assert.equal(daysToExpiry(item, "2026-08-20"), -2, "过期了要给负数");
  assert.equal(daysToExpiry({ ...item, expiryDate: null }, "2026-08-15"), undefined);
});

test("总览附近模块只收历史低价或接近低价，并且是家里正缺的东西", () => {
  assert.equal(
    isOverviewNearbyPick({ priceSignal: "historical-low", kind: "targeted", tier: "must" }),
    true,
  );
  assert.equal(
    isOverviewNearbyPick({ priceSignal: "below-average", kind: "substitute", tier: "recommended" }),
    true,
  );
  assert.equal(
    isOverviewNearbyPick({ priceSignal: "historical-low", kind: "category", tier: "opportunity" }),
    false,
    "纯大类机会不应出现在总览附近卡片上",
  );
  assert.equal(
    isOverviewNearbyPick({ priceSignal: "normal", kind: "targeted", tier: "must" }),
    false,
    "不是低价就不要占总览",
  );
  assert.equal(overviewNearbyInterest({ kind: "targeted", matchedLevel: "偏少" }), "偏少");
  assert.equal(
    overviewNearbyInterest({ kind: "substitute", matchedItemName: "洗碗球" }),
    "可替代家里的洗碗球",
  );
});
