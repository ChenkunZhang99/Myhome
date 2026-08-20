import assert from "node:assert/strict";
import test from "node:test";
import { buildFlyerPurchasePlan, packagePrice, recommendFlyerDeals } from "../app/flyerRecommendations.ts";

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
