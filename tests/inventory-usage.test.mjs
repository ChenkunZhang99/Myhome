import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConsumption,
  findInventoryMatch,
  levelFromPercent,
  parseAmount,
  planConsumption,
  rankInventoryMatches,
  effectiveExpiry,
  daysInUse,
} from "../app/inventoryUsage.ts";

const inventory = [
  { id: "spinach", name: "菠菜", category: "蔬菜水果", level: "偏少", unit: "把" },
  { id: "milk", name: "鲜牛奶 1L", category: "乳品蛋类", level: "充足", unit: "盒" },
  { id: "detergent", name: "洗衣液", category: "清洁用品", level: "充足", unit: "瓶" },
];

test("matches purchased items to existing stock across package sizes", () => {
  assert.equal(findInventoryMatch("鲜牛奶", "乳品蛋类", inventory)?.item.id, "milk");
  assert.equal(findInventoryMatch("菠菜 500g", "蔬菜水果", inventory)?.item.id, "spinach");
});

test("does not invent a match for an unrelated purchase", () => {
  assert.equal(findInventoryMatch("三文鱼", "肉类海鲜", inventory), null);
});

test("prefers the same category when two stock items share a name", () => {
  const candidates = [
    { id: "cleaning", name: "洗手液", category: "清洁用品", unit: "瓶" },
    { id: "care", name: "洗手液", category: "洗护用品", unit: "瓶" },
  ];
  assert.equal(findInventoryMatch("洗手液", "洗护用品", candidates)?.item.id, "care");
  assert.equal(findInventoryMatch("洗手液", "清洁用品", candidates)?.item.id, "cleaning");
});

test("consuming part of an opened item only moves the remaining percentage", () => {
  const result = applyConsumption({ quantity: 2, unit: "把", remainingPercent: 100 }, "half");
  assert.deepEqual(result, { quantity: 2, remainingPercent: 50, level: "偏少" });
});

test("finishing the opened item starts the next one", () => {
  const result = applyConsumption({ quantity: 3, unit: "盒", remainingPercent: 40 }, "half");
  assert.deepEqual(result, { quantity: 2, remainingPercent: 100, level: "充足" });
});

test("using up the last item marks it as finished", () => {
  const result = applyConsumption({ quantity: 1, unit: "把", remainingPercent: 30 }, "most");
  assert.deepEqual(result, { quantity: 0, remainingPercent: 0, level: "已用完" });
});

test("全部用完 empties the item regardless of how much was left", () => {
  assert.deepEqual(applyConsumption({ quantity: 5, unit: "包", remainingPercent: 100 }, "all"), {
    quantity: 0,
    remainingPercent: 0,
    level: "已用完",
  });
});

test("没有用到 leaves the item untouched", () => {
  assert.deepEqual(applyConsumption({ quantity: 2, unit: "瓶", remainingPercent: 60 }, "none"), {
    quantity: 2,
    remainingPercent: 60,
    level: "充足",
  });
});

test("percentage-tracked items keep quantity and remaining in sync", () => {
  assert.deepEqual(applyConsumption({ quantity: 80, unit: "%", remainingPercent: 80 }, "quarter"), {
    quantity: 55,
    remainingPercent: 55,
    level: "充足",
  });
});

test("levels follow the same thresholds the inventory list shows", () => {
  assert.equal(levelFromPercent(0), "已用完");
  assert.equal(levelFromPercent(20), "即将用完");
  assert.equal(levelFromPercent(50), "偏少");
  assert.equal(levelFromPercent(51), "充足");
});

test("splits recipe amounts into a quantity and a unit", () => {
  assert.deepEqual(parseAmount("300克"), { quantity: 300, unit: "g" });
  assert.deepEqual(parseAmount("2 个"), { quantity: 2, unit: "个" });
  assert.deepEqual(parseAmount("1.5kg"), { quantity: 1.5, unit: "kg" });
  assert.equal(parseAmount("适量"), null);
  assert.equal(parseAmount(""), null);
});

test("deducts the real amount when the recipe and the stock use comparable units", () => {
  const plan = planConsumption("300克", {
    quantity: 5,
    unit: "kg",
    remainingPercent: 100,
    category: "米面粮油",
  });
  assert.deepEqual(plan, { quantityUsed: 0.3, defaultPortion: "measured" });
  const result = applyConsumption({ quantity: 5, unit: "kg", remainingPercent: 100 }, "measured", 0.3);
  assert.deepEqual(result, { quantity: 4.7, remainingPercent: 94, level: "充足" });
});

test("counts are interchangeable so eggs deduct one for one", () => {
  const plan = planConsumption("2 个", {
    quantity: 10,
    unit: "枚",
    remainingPercent: 100,
    category: "乳品蛋类",
  });
  assert.deepEqual(plan, { quantityUsed: 2, defaultPortion: "measured" });
  assert.deepEqual(applyConsumption({ quantity: 10, unit: "枚", remainingPercent: 100 }, "measured", 2), {
    quantity: 8,
    remainingPercent: 80,
    level: "充足",
  });
});

test("a bag of rice is never guessed at, because the package size is unknown", () => {
  // 「300克」换算不到「袋」，而米面粮油一顿只用一点点，所以默认不动库存。
  assert.deepEqual(
    planConsumption("300克", { quantity: 1, unit: "袋", remainingPercent: 100, category: "米面粮油" }),
    { quantityUsed: null, defaultPortion: "none" },
  );
});

test("produce without a usable amount still falls back to a half-portion guess", () => {
  assert.deepEqual(
    planConsumption("适量", { quantity: 1, unit: "把", remainingPercent: 100, category: "蔬菜水果" }),
    { quantityUsed: null, defaultPortion: "half" },
  );
});

test("基础调料 defaults to leaving the stock alone", () => {
  assert.equal(
    planConsumption("少许", { quantity: 1, unit: "瓶", remainingPercent: 80, category: "调味品" }, "pantry")
      .defaultPortion,
    "none",
  );
});

test("a measured deduction that empties the stock marks it finished", () => {
  assert.deepEqual(applyConsumption({ quantity: 0.4, unit: "kg", remainingPercent: 40 }, "measured", 0.4), {
    quantity: 0,
    remainingPercent: 0,
    level: "已用完",
  });
});

test("ranked matches put the likely item first and keep the list short", () => {
  const candidates = [
    { id: "a", name: "鲜牛奶", category: "乳品蛋类" },
    { id: "b", name: "牛奶巧克力", category: "零食饮料" },
    { id: "c", name: "菠菜", category: "蔬菜水果" },
  ];
  const ranked = rankInventoryMatches("牛奶", "乳品蛋类", candidates, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].item.id, "a");
});

test("an unopened item keeps the date printed on the package", () => {
  const result = effectiveExpiry({ category: "乳品蛋类", expiryDate: "2026-09-01" });
  assert.deepEqual(result, { date: "2026-09-01", fromOpening: false });
});

test("opening milk shortens its usable life well before the printed date", () => {
  // 牛奶开封后按分类默认 5 天，比包装上的 9 月 1 日早得多。
  const result = effectiveExpiry({ category: "乳品蛋类", expiryDate: "2026-09-01", openedDate: "2026-08-20" });
  assert.deepEqual(result, { date: "2026-08-25", fromOpening: true });
});

test("the printed date still wins when it comes first", () => {
  const result = effectiveExpiry({ category: "调味品", expiryDate: "2026-08-22", openedDate: "2026-08-20" });
  assert.deepEqual(result, { date: "2026-08-22", fromOpening: false });
});

test("a per-item shelf life overrides the category default", () => {
  const result = effectiveExpiry({
    category: "乳品蛋类",
    expiryDate: "2026-09-01",
    openedDate: "2026-08-20",
    openedShelfLifeDays: 2,
  });
  assert.deepEqual(result, { date: "2026-08-22", fromOpening: true });
});

test("categories without a known opened shelf life are left alone", () => {
  const result = effectiveExpiry({ category: "清洁用品", expiryDate: "2026-09-01", openedDate: "2026-08-20" });
  assert.deepEqual(result, { date: "2026-09-01", fromOpening: false });
});

test("days in use counts from the opening date, falling back to the purchase date", () => {
  const today = new Date("2026-08-20T12:00:00");
  assert.equal(daysInUse({ purchaseDate: "2026-08-10", openedDate: "2026-08-18" }, today), 2);
  assert.equal(daysInUse({ purchaseDate: "2026-08-10" }, today), 10);
  assert.equal(daysInUse({}, today), null);
});

test("a future date reports nothing rather than a negative age", () => {
  assert.equal(daysInUse({ purchaseDate: "2026-08-25" }, new Date("2026-08-20T12:00:00")), null);
});
