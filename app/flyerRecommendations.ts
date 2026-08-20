import { daysInUse } from "./inventoryUsage.ts";

export type FlyerInventorySignal = {
  name: string;
  category: string;
  level: string;
  quantity?: number;
  unit?: string;
  remainingPercent?: number;
  expiryDate?: string | null;
  purchaseDate?: string | null;
  openedDate?: string | null;
};

export type FlyerDealSignal = {
  id: string;
  storeId: string;
  itemName: string;
  category: string;
  price: number;
  regularPrice?: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
  packageQuantity?: number | null;
  packageUnit?: string | null;
  averagePrice?: number | null;
  lowestPrice?: number | null;
  isSaved?: number | boolean;
  hidden?: number | boolean;
};

export type FlyerMatchRule = {
  id: string;
  inventoryName: string;
  dealPattern: string;
  category?: string;
  matchKind: "targeted" | "substitute" | "category";
  active: number | boolean;
};

export type FlyerRecommendation = {
  dealId: string;
  storeId: string;
  tier: "must" | "recommended" | "opportunity";
  kind: "targeted" | "substitute" | "category";
  score: number;
  matchedItemName?: string;
  matchedLevel?: string;
  /** 已经使用了多少天（从开封日或购买日算起）。查不到日期时为空。 */
  daysUsed?: number;
  lowCategoryCount: number;
  savingsPercent: number;
  unitPrice: number;
  unitLabel: string;
  priceSignal: "historical-low" | "below-average" | "normal" | "unknown";
  suggestedQuantity: number;
  /** 同一件商品还在几家别的门店打折。用来提示「另有 N 家也在特价」而不是重复推荐。 */
  alsoAtStoreCount: number;
};

export type PurchasePlan = {
  storeIds: string[];
  dealIds: string[];
  total: number;
  estimatedSavings: number;
  foodSpend: number;
  householdSpend: number;
  foodBudget: number;
  householdBudget: number;
  withinBudget: boolean;
  overlapFrom?: string;
  overlapTo?: string;
};

const productFamilies = [
  ["洗碗球", "洗碗块", "洗碗凝珠", "洗碗粉", "洗洁精"],
  ["洗衣球", "洗衣凝珠", "洗衣液", "洗衣粉"],
  ["卫生纸", "厕纸", "纸巾", "厨房纸"],
  ["牛腩", "牛肉", "牛排"],
  ["猪肉", "排骨", "五花肉"],
  ["鸡肉", "鸡腿", "鸡翅"],
  ["虾", "大虾", "对虾"],
] as const;
const foodCategories = new Set([
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
]);
const categoryFallbacks = new Set([...foodCategories]);

export function normalizeFlyerName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|lb|lbs|ml|l|oz|ct|pk|pack)\b/gi, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function urgency(item: FlyerInventorySignal) {
  const remaining = Math.max(0, Math.min(100, Number(item.remainingPercent ?? 100)));
  if (Number(item.quantity) === 0 || remaining === 0 || item.level === "已用完") return 4;
  if (remaining <= 20) return 3;
  if (remaining <= 50) return 2;
  if (item.level === "即将用完") return 3;
  if (item.level === "偏少") return 2;
  return 0;
}

/**
 * 这件东西在家里放了多少天。
 *
 * 之前这里返回的是按紧急度硬编码的「预计还可使用 N 天」（0/3/10/30），
 * 界面却说得像真算过。改成报告已使用天数：这是从购买日或开封日直接得出的事实，
 * 用户自己就能判断还能撑多久。
 */
function usedDays(item?: FlyerInventorySignal) {
  return item ? (daysInUse(item) ?? undefined) : undefined;
}

function sameProductFamily(left: string, right: string) {
  const a = normalizeFlyerName(left),
    b = normalizeFlyerName(right);
  return productFamilies.some(
    (family) =>
      family.some((keyword) => a.includes(keyword)) && family.some((keyword) => b.includes(keyword)),
  );
}

function exactProduct(left: string, right: string) {
  const a = normalizeFlyerName(left),
    b = normalizeFlyerName(right);
  return Boolean(a && b && Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a)));
}

function discountPercent(deal: FlyerDealSignal) {
  const regular = Number(deal.regularPrice ?? 0),
    sale = Number(deal.price);
  if (!(regular > sale && sale >= 0)) return 0;
  return Math.round(((regular - sale) / regular) * 100);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function endingSoonBonus(validTo: string, today: string) {
  const end = Date.parse(`${validTo}T00:00:00Z`),
    start = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  const days = Math.round((end - start) / 86400000);
  return days >= 0 && days <= 3 ? 4 - days : 0;
}

export function packagePrice(deal: FlyerDealSignal) {
  let quantity = Number(deal.packageQuantity ?? 0);
  let unit = String(deal.packageUnit ?? "")
    .trim()
    .toLowerCase();
  if (!(quantity > 0)) {
    const match = deal.itemName.match(/(\d+(?:\.\d+)?)\s*(kg|g|lb|lbs|ml|l|oz|ct|pk|pack|个|包|卷|颗)/i);
    if (match) {
      quantity = Number(match[1]);
      unit = match[2].toLowerCase();
    }
  }
  if (!(quantity > 0)) {
    quantity = 1;
    unit =
      String(deal.unit ?? "件")
        .replace(/^\//, "")
        .trim()
        .toLowerCase() || "件";
  }
  if (unit === "g") {
    quantity /= 1000;
    unit = "kg";
  }
  if (unit === "ml") {
    quantity /= 1000;
    unit = "L";
  }
  if (unit === "lbs") unit = "lb";
  if (["ct", "pk", "pack"].includes(unit)) unit = "个";
  return { quantity, unit, unitPrice: quantity > 0 ? Number(deal.price) / quantity : Number(deal.price) };
}

function manualMatch(deal: FlyerDealSignal, inventory: FlyerInventorySignal[], rules: FlyerMatchRule[]) {
  const dealName = normalizeFlyerName(deal.itemName);
  const rule = rules.find(
    (item) =>
      Boolean(item.active) &&
      (!item.category || item.category === deal.category) &&
      dealName.includes(normalizeFlyerName(item.dealPattern)),
  );
  if (!rule) return null;
  const matched = inventory.find(
    (item) => normalizeFlyerName(item.name) === normalizeFlyerName(rule.inventoryName),
  );
  return matched ? { item: matched, kind: rule.matchKind } : null;
}

export function recommendFlyerDeals(
  inventory: FlyerInventorySignal[],
  deals: FlyerDealSignal[],
  rulesOrToday: FlyerMatchRule[] | string = [],
  planningDate?: string,
  limit = 10,
) {
  const rules = Array.isArray(rulesOrToday) ? rulesOrToday : [];
  const today = typeof rulesOrToday === "string" ? rulesOrToday : (planningDate ?? localDateString());
  const lowItems = inventory.filter((item) => urgency(item) > 0);
  const lowByCategory = new Map<string, FlyerInventorySignal[]>();
  for (const item of lowItems)
    lowByCategory.set(item.category, [...(lowByCategory.get(item.category) ?? []), item]);
  const ownedCategories = new Set(inventory.map((item) => item.category));

  const ranked = deals
    .filter((deal) => !deal.hidden && deal.validFrom <= today && deal.validTo >= today)
    .map((deal): FlyerRecommendation | null => {
      const manual = manualMatch(deal, inventory, rules);
      const exact = lowItems
        .filter((item) => item.category === deal.category && exactProduct(item.name, deal.itemName))
        .sort((a, b) => urgency(b) - urgency(a))[0];
      const substitute = lowItems
        .filter((item) => item.category === deal.category && sameProductFamily(item.name, deal.itemName))
        .sort((a, b) => urgency(b) - urgency(a))[0];
      const direct = manual?.item ?? exact ?? substitute;
      const kind = manual?.kind ?? (exact ? "targeted" : substitute ? "substitute" : "category");
      const categoryItems = lowByCategory.get(deal.category) ?? [];
      const savings = discountPercent(deal);
      const endingBonus = endingSoonBonus(deal.validTo, today);
      const pack = packagePrice(deal);
      const average = Number(deal.averagePrice ?? 0),
        lowest = Number(deal.lowestPrice ?? 0);
      const priceSignal =
        lowest > 0 && deal.price <= lowest
          ? "historical-low"
          : average > 0 && deal.price < average * 0.9
            ? "below-average"
            : average > 0
              ? "normal"
              : "unknown";
      if (direct) {
        const level = urgency(direct);
        const tier = level >= 3 ? "must" : "recommended";
        return {
          dealId: deal.id,
          storeId: deal.storeId,
          tier,
          kind,
          matchedItemName: direct.name,
          matchedLevel: direct.level,
          daysUsed: usedDays(direct),
          lowCategoryCount: categoryItems.length,
          savingsPercent: savings,
          unitPrice: pack.unitPrice,
          unitLabel: pack.unit,
          priceSignal,
          suggestedQuantity: level === 4 ? 2 : 1,
          alsoAtStoreCount: 0,
          score:
            90 +
            level * 12 +
            (kind === "targeted" ? 18 : kind === "substitute" ? 8 : 0) +
            Math.min(16, savings / 2) +
            endingBonus +
            (priceSignal === "historical-low" ? 10 : 0),
        };
      }
      if (categoryItems.length && categoryFallbacks.has(deal.category)) {
        const highestUrgency = Math.max(...categoryItems.map(urgency));
        return {
          dealId: deal.id,
          storeId: deal.storeId,
          tier: "recommended",
          kind: "category",
          lowCategoryCount: categoryItems.length,
          savingsPercent: savings,
          unitPrice: pack.unitPrice,
          unitLabel: pack.unit,
          priceSignal,
          suggestedQuantity: 1,
          alsoAtStoreCount: 0,
          score:
            45 +
            highestUrgency * 8 +
            Math.min(12, savings / 3) +
            endingBonus +
            (priceSignal === "historical-low" ? 8 : 0),
        };
      }
      const ownedItem = inventory.find(
        (item) => item.category === deal.category && exactProduct(item.name, deal.itemName),
      );
      if (
        ownedCategories.has(deal.category) &&
        ownedItem &&
        (savings >= 25 || priceSignal === "historical-low")
      ) {
        return {
          dealId: deal.id,
          storeId: deal.storeId,
          tier: "opportunity",
          kind: "category",
          lowCategoryCount: 0,
          savingsPercent: savings,
          unitPrice: pack.unitPrice,
          unitLabel: pack.unit,
          priceSignal,
          suggestedQuantity: 1,
          alsoAtStoreCount: 0,
          score: 25 + savings / 2 + (priceSignal === "historical-low" ? 12 : 0) + endingBonus,
        };
      }
      return null;
    })
    .filter((item): item is FlyerRecommendation => Boolean(item))
    .sort((a, b) => b.score - a.score);

  return keepBestStorePerProduct(ranked, deals).slice(0, limit);
}

/**
 * 同一件商品在多家门店同时打折时，只留单位价格最低的那家。
 *
 * 不去重的话推荐位会被同一件东西占满——两家店的「洗衣凝珠」长得一模一样，
 * 用户根本无从选择。留最便宜的一家，并记下还有几家也在特价，
 * 这才是比价该给出的答案。
 */
function keepBestStorePerProduct(ranked: FlyerRecommendation[], deals: FlyerDealSignal[]) {
  const nameById = new Map(deals.map((deal) => [deal.id, normalizeFlyerName(deal.itemName)]));
  const bestByProduct = new Map<string, FlyerRecommendation>();
  const seenStores = new Map<string, Set<string>>();

  for (const item of ranked) {
    const key = nameById.get(item.dealId) ?? item.dealId;
    const stores = seenStores.get(key) ?? new Set<string>();
    stores.add(item.storeId);
    seenStores.set(key, stores);

    const current = bestByProduct.get(key);
    // 单位价格更低的胜出；持平时用排序分数决定。
    const better =
      !current ||
      item.unitPrice < current.unitPrice ||
      (item.unitPrice === current.unitPrice && item.score > current.score);
    if (better) bestByProduct.set(key, item);
  }

  return [...bestByProduct.values()]
    .map((item) => {
      const key = nameById.get(item.dealId) ?? item.dealId;
      return { ...item, alsoAtStoreCount: Math.max(0, (seenStores.get(key)?.size ?? 1) - 1) };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildFlyerPurchasePlan(
  recommendations: FlyerRecommendation[],
  deals: FlyerDealSignal[],
  settings: { foodBudget: number; householdBudget: number; maxStores: number },
): PurchasePlan {
  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const storeScores = new Map<string, number>();
  for (const item of recommendations)
    storeScores.set(item.storeId, (storeScores.get(item.storeId) ?? 0) + item.score);
  const storeIds = [...storeScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, settings.maxStores || 2))
    .map(([id]) => id);
  let foodSpend = 0,
    householdSpend = 0,
    estimatedSavings = 0;
  const dealIds: string[] = [];
  for (const item of recommendations.filter((entry) => storeIds.includes(entry.storeId))) {
    const deal = byId.get(item.dealId);
    if (!deal) continue;
    const food = foodCategories.has(deal.category);
    const cap = food ? Number(settings.foodBudget || Infinity) : Number(settings.householdBudget || Infinity);
    const spent = food ? foodSpend : householdSpend;
    if (item.tier !== "must" && spent + deal.price > cap) continue;
    dealIds.push(deal.id);
    if (food) foodSpend += deal.price;
    else householdSpend += deal.price;
    estimatedSavings += Math.max(0, Number(deal.regularPrice ?? deal.price) - deal.price);
  }
  const selected = dealIds.map((id) => byId.get(id)).filter((deal): deal is FlyerDealSignal => Boolean(deal));
  const overlapFrom = selected.length
    ? selected.reduce(
        (value, deal) => (deal.validFrom > value ? deal.validFrom : value),
        selected[0].validFrom,
      )
    : undefined;
  const overlapTo = selected.length
    ? selected.reduce((value, deal) => (deal.validTo < value ? deal.validTo : value), selected[0].validTo)
    : undefined;
  return {
    storeIds,
    dealIds,
    total: foodSpend + householdSpend,
    estimatedSavings,
    foodSpend,
    householdSpend,
    foodBudget: Number(settings.foodBudget || 0),
    householdBudget: Number(settings.householdBudget || 0),
    withinBudget:
      (!settings.foodBudget || foodSpend <= settings.foodBudget) &&
      (!settings.householdBudget || householdSpend <= settings.householdBudget),
    overlapFrom: overlapFrom && overlapTo && overlapFrom <= overlapTo ? overlapFrom : undefined,
    overlapTo: overlapFrom && overlapTo && overlapFrom <= overlapTo ? overlapTo : undefined,
  };
}
