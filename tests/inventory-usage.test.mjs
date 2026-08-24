import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adjustRemaining,
  isMeasurableUnit,
  restock,
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

/**
 * 做菜的档位是「用掉现在剩余量的百分之多少」。
 *
 * 曾经是「从百分比里减掉这么多点」，于是剩得越少越容易被一下子清空：
 * 3 盒 40% 用掉「一半」会变成全空。按比例缩放就没有这个问题。
 */
test("用掉一半：数量和百分比按同一个系数缩放", () => {
  const result = applyConsumption({ quantity: 2, unit: "把", remainingPercent: 100 }, "half");
  assert.deepEqual(result, { quantity: 1, remainingPercent: 50, level: "偏少" });
});

test("剩得少的时候，用掉一半不会变成全空", () => {
  // 只剩 2 lb（满量的一半），再用掉一半就是 1 lb
  assert.deepEqual(applyConsumption({ quantity: 2, unit: "lb", remainingPercent: 50 }, "half"), {
    quantity: 1,
    remainingPercent: 25,
    level: "偏少",
  });
  // 按点数减的旧算法会把这一条算成 0
  assert.deepEqual(applyConsumption({ quantity: 3, unit: "盒", remainingPercent: 40 }, "half"), {
    quantity: 1.5,
    remainingPercent: 20,
    level: "即将用完",
  });
});

/**
 * 百分比的含义是「相对上次补满时还剩几成」，所以它本身就是判断要不要补货的依据，
 * 和单位是 kg 还是袋无关。
 *
 * 这里曾经短暂地按「手上还有几件」来判断等级，前提是「百分比只描述拆开那一件」。
 * 规则统一之后那个前提不成立了——quantity 已经是实际剩余量，
 * 2 袋 25% 的意思是「上次补满有 8 袋，现在剩 2 袋」，判「偏少」是对的。
 */
test("等级只看相对满量的比例", () => {
  assert.equal(levelFromPercent(100), "充足");
  assert.equal(levelFromPercent(25), "偏少");
  assert.equal(levelFromPercent(15), "即将用完");
  assert.equal(levelFromPercent(0), "已用完");
});

test("四个档位都是相对当前剩余量", () => {
  const full = { quantity: 2, unit: "kg", remainingPercent: 100 };
  assert.deepEqual(applyConsumption(full, "quarter"), { quantity: 1.5, remainingPercent: 75, level: "充足" });
  assert.deepEqual(applyConsumption(full, "half"), { quantity: 1, remainingPercent: 50, level: "偏少" });
  assert.deepEqual(applyConsumption(full, "most"), { quantity: 0.5, remainingPercent: 25, level: "偏少" });
  assert.deepEqual(applyConsumption(full, "all"), { quantity: 0, remainingPercent: 0, level: "已用完" });
});

test("「全部用完」才是唯一会清空的档位", () => {
  // 用掉大部分之后还留一点，这是按比例缩放的必然结果——真用完了就选「全部」
  assert.deepEqual(applyConsumption({ quantity: 1, unit: "把", remainingPercent: 30 }, "most"), {
    quantity: 0.25,
    remainingPercent: 8,
    level: "即将用完",
  });
  assert.deepEqual(applyConsumption({ quantity: 1, unit: "把", remainingPercent: 30 }, "all"), {
    quantity: 0,
    remainingPercent: 0,
    level: "已用完",
  });
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

test("单位是 % 的物品两个字段始终同步", () => {
  // 不再需要为这种单位特判：两个字段按同一个系数缩放，本来就同步
  assert.deepEqual(applyConsumption({ quantity: 80, unit: "%", remainingPercent: 80 }, "quarter"), {
    quantity: 60,
    remainingPercent: 60,
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
  const result = effectiveExpiry({
    category: "乳品蛋类",
    expiryDate: "2026-09-01",
    openedDate: "2026-08-20",
  });
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
  const result = effectiveExpiry({
    category: "清洁用品",
    expiryDate: "2026-09-01",
    openedDate: "2026-08-20",
  });
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

/**
 * 已经用完的东西不该再显示到期信息。
 *
 * 一盒喝完的豆浆挂着「已过期 7 天」，看着像是有东西要坏了，其实早就没了。
 * 而且同一个 getExpiryInfo 还喂着总览上的「临期」计数和「需要处理」的筛选——
 * 只在卡片上藏起来的话，数字里仍然混着一堆你早就吃完的东西。
 * 所以闸门必须在函数最前面，早于算日期。
 */
test("已用完的物品不产生到期信息", async () => {
  const page = await readFile(new URL("../app/HomeApp.tsx", import.meta.url), "utf8");
  const body = page.slice(page.indexOf("function getExpiryInfo"));
  const guard = body.indexOf("if (emptied) return null;");
  const compute = body.indexOf("effectiveExpiry(item)");
  assert.ok(guard !== -1, "getExpiryInfo 里缺少「已用完」的闸门");
  assert.ok(guard < compute, "闸门要排在算到期日之前");
});

/**
 * 百分比和数量必须讲同一个故事。
 *
 * 卡片上曾经出现「胡萝卜 4.01 kg · 65%」——按 65% 算应该是 2.6 kg，
 * 可数量原地没动。因为 ±25% 只改了百分比，重量根本没参与。
 */
test("可量的单位：±25% 时重量跟着变", () => {
  const carrot = { name: "胡萝卜", quantity: 4, unit: "kg", remainingPercent: 100, level: "充足" };
  const after = adjustRemaining(carrot, -25);
  assert.equal(after.remainingPercent, 75);
  assert.equal(after.quantity, 3, "4 kg 的 75% 是 3 kg");

  // 再减一次是在新基准上继续按满量算，不是在 3 kg 上再减 25%
  const again = adjustRemaining({ ...carrot, ...after }, -25);
  assert.equal(again.remainingPercent, 50);
  assert.equal(again.quantity, 2, "满量仍是 4 kg，50% 就是 2 kg");
});

test("按件计的单位走同一条算术，数量可以是小数", () => {
  // 1 袋减到 75% 就是 0.75 袋——这正是补货时能算出 2.75 袋的前提
  const bag = { name: "米", quantity: 1, unit: "袋", remainingPercent: 100, level: "充足" };
  const used = adjustRemaining(bag, -25);
  assert.equal(used.quantity, 0.75);
  assert.equal(used.remainingPercent, 75);

  // 2 袋 50%（满量 4 袋）减 25% → 4 × 0.25 = 1 袋
  const two = adjustRemaining({ ...bag, quantity: 2, remainingPercent: 50 }, -25);
  assert.equal(two.quantity, 1);
  assert.equal(two.remainingPercent, 25);

  const gone = adjustRemaining({ ...bag, quantity: 0.5, remainingPercent: 25 }, -25);
  assert.equal(gone.level, "已用完");
  assert.equal(gone.quantity, 0);
});

test("补货：加到剩下的上面，然后整体归一化为满量", () => {
  // 2 kg 标 50% → 满量 4 kg → 减 25% → 1 kg
  const carrot = { name: "胡萝卜", quantity: 2, unit: "kg", remainingPercent: 50, level: "偏少" };
  assert.equal(adjustRemaining(carrot, -25).quantity, 1, "4 kg 的 25%");

  const after = restock(carrot, 3);
  assert.equal(after.quantity, 5, "2 kg 剩货加 3 kg 新货");
  assert.equal(after.remainingPercent, 100, "手上有的全部就是满量");
  assert.equal(adjustRemaining({ ...carrot, ...after }, -25).quantity, 3.75, "5 kg 的 75%");
});

test("一袋米减到 75%，补 2 袋，再减 25%", () => {
  const bag = { name: "米", quantity: 1, unit: "袋", remainingPercent: 100, level: "充足" };
  const used = adjustRemaining(bag, -25);
  assert.equal(used.quantity, 0.75);

  const filled = restock({ ...bag, ...used }, 2);
  assert.equal(filled.quantity, 2.75, "0.75 袋剩货加 2 袋新货");
  assert.equal(filled.remainingPercent, 100);

  const again = adjustRemaining({ ...bag, ...filled }, -25);
  assert.equal(again.quantity, 2.06, "2.75 × 0.75 = 2.0625，保留两位小数");
  assert.equal(again.remainingPercent, 75);
});

test("补货不会把已用完的东西留在已用完", () => {
  const empty = { name: "鸡腿肉", quantity: 0, unit: "包", remainingPercent: 0, level: "已用完" };
  const after = restock(empty, 2);
  assert.equal(after.quantity, 2);
  assert.equal(after.remainingPercent, 100);
  assert.notEqual(after.level, "已用完");
});

test("分不清的单位按可数处理", () => {
  assert.equal(isMeasurableUnit("kg"), true);
  assert.equal(isMeasurableUnit("斤"), true, "中文别名也要认");
  assert.equal(isMeasurableUnit("ml"), true);
  assert.equal(isMeasurableUnit("袋"), false);
  assert.equal(isMeasurableUnit("把"), false);
  assert.equal(isMeasurableUnit("坨"), false, "没见过的单位宁可当可数，少改一个数字比算错重量安全");
});

test("推不出满量时不要凭空造一个重量", () => {
  // 百分比是 0：除下去是无穷大，绝不能拿它去乘
  const broken = { name: "油", quantity: 5, unit: "ml", remainingPercent: 0, level: "已用完" };
  const after = adjustRemaining(broken, 25);
  assert.ok(Number.isFinite(after.quantity), "数量必须是有限数");
  assert.equal(after.quantity, 5, "推不出满量就别动数量");
});
