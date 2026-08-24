import { daysInUse, effectiveExpiry } from "./inventoryUsage.ts";

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
  /** 按当前消耗速度推算还能撑几天。查不到购买日或还没动过时为空。 */
  daysLeft?: number;
  /** 匹配到的物品还有几天到期。负数表示已经过期。 */
  expiresInDays?: number;
  /** 分数由哪几项组成。排查「为什么这条排在前面」时唯一有用的东西。 */
  factors: ScoreFactor[];
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

/**
 * 按已用掉的比例和用了多少天，推算还能撑几天。
 *
 * 「还剩 40%」本身说明不了什么：买了 2 天就剩 40%，三天后就没了；
 * 买了 45 天才剩 40%，还能撑两个月。决定要不要现在买的是后者，不是前者。
 *
 * 只用得上一次购买之内的数据，所以这是个粗估，不是预测。查不到购买日、
 * 或者一口都没动过（没有消耗速度可言）时返回 undefined，调用方据此退回只看剩余量。
 */
export function estimateDaysLeft(item: FlyerInventorySignal, today?: string) {
  const remaining = Math.max(0, Math.min(100, Number(item.remainingPercent ?? 100)));
  // 必须用传进来的这一天，不能读设备时钟：整个推荐都以 today 为基准算有效期和到期日，
  // 消耗天数偷偷用另一个「今天」的话，同一次推荐里的日期就自相矛盾了。
  const days = daysInUse(item, today ? new Date(`${today}T00:00:00`) : undefined);
  if (days === null || days <= 0 || remaining >= 100 || remaining <= 0) return undefined;
  const perDay = (100 - remaining) / days;
  if (perDay <= 0) return undefined;
  return Math.round((remaining / perDay) * 10) / 10;
}

/** 距离到期还有几天。已经过期返回负数。 */
export function daysToExpiry(item: FlyerInventorySignal, today: string) {
  const { date } = effectiveExpiry(item);
  if (!date) return undefined;
  const target = Date.parse(`${date}T00:00:00`);
  const base = Date.parse(`${today}T00:00:00`);
  if (Number.isNaN(target) || Number.isNaN(base)) return undefined;
  return Math.ceil((target - base) / 86400000);
}

/**
 * 有多急着补这件东西。
 *
 * 「急」的定义是「多快就会没有」，而它有三个来源，取最急的那个：
 *  - 剩下多少（原本唯一看的东西）
 *  - 用得多快——同样剩 40%，两天用掉六成和四十天用掉六成不是一回事
 *  - 还有几天过期——快过期的东西等于快没了，哪怕瓶子还是满的
 *
 * 4 留给「已经没有了」这一种确定状态，推算出来的最多到 3：
 * 估算再准也不该和事实平起平坐。
 */
/**
 * 排序权重。
 *
 * 这些数字原本散在三段 score 表达式里，改一个要在三处对齐，而且改完没有任何办法
 * 判断是变好还是变坏。集中放在这里，配合下面的 factors 一起看：
 * 每条推荐都会带上自己的分数是由哪几项、各加了多少组成的。
 *
 * 数值本身仍然是经验值，不是算出来的——但至少现在它们是可读、可调、可解释的。
 */
const WEIGHTS = {
  /** 匹配到具体缺货物品时的起步分，保证它们排在分类机会之前 */
  matchedBase: 90,
  /** 分类兜底的起步分 */
  categoryBase: 45,
  /** 机会购买的起步分：家里不缺，只是便宜 */
  opportunityBase: 25,
  /** 每一级紧急度的加成 */
  urgencyStep: 12,
  categoryUrgencyStep: 8,
  /** 匹配精度：同名 > 同产品族 > 分类 */
  targetedMatch: 18,
  substituteMatch: 8,
  /** 折扣的加成上限——再深的折扣也不该盖过「家里真的缺」 */
  savingsCap: 16,
  categorySavingsCap: 12,
  /** 价格触及历史最低 */
  historicalLow: 10,
  categoryHistoricalLow: 8,
  opportunityHistoricalLow: 12,
} as const;

/** 一条推荐的分数是怎么来的。给人看的，不参与计算。 */
export type ScoreFactor = { label: string; points: number };

function urgency(item: FlyerInventorySignal, today?: string) {
  const remaining = Math.max(0, Math.min(100, Number(item.remainingPercent ?? 100)));
  if (Number(item.quantity) === 0 || remaining === 0 || item.level === "已用完") return 4;

  let level = 0;
  if (remaining <= 20) level = 3;
  else if (remaining <= 50) level = 2;
  if (item.level === "即将用完") level = Math.max(level, 3);
  if (item.level === "偏少") level = Math.max(level, 2);

  const daysLeft = estimateDaysLeft(item, today);
  if (daysLeft !== undefined) {
    if (daysLeft <= 3) level = Math.max(level, 3);
    else if (daysLeft <= 7) level = Math.max(level, 2);
  }

  const untilExpiry = today ? daysToExpiry(item, today) : undefined;
  if (untilExpiry !== undefined) {
    if (untilExpiry <= 2) level = Math.max(level, 3);
    else if (untilExpiry <= 5) level = Math.max(level, 2);
  }

  return level;
}

/**
 * 这件东西在家里放了多少天。
 *
 * 之前这里返回的是按紧急度硬编码的「预计还可使用 N 天」（0/3/10/30），
 * 界面却说得像真算过。改成报告已使用天数：这是从购买日或开封日直接得出的事实，
 * 用户自己就能判断还能撑多久。
 */
function usedDays(item?: FlyerInventorySignal, today?: string) {
  if (!item) return undefined;
  return daysInUse(item, today ? new Date(`${today}T00:00:00`) : undefined) ?? undefined;
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
  const lowItems = inventory.filter((item) => urgency(item, today) > 0);
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
        .sort((a, b) => urgency(b, today) - urgency(a, today))[0];
      const substitute = lowItems
        .filter((item) => item.category === deal.category && sameProductFamily(item.name, deal.itemName))
        .sort((a, b) => urgency(b, today) - urgency(a, today))[0];
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
        const level = urgency(direct, today);
        const tier = level >= 3 ? "must" : "recommended";
        const daysLeft = estimateDaysLeft(direct, today);
        const expiresInDays = daysToExpiry(direct, today);
        const factors: ScoreFactor[] = [
          { label: "匹配到缺货物品", points: WEIGHTS.matchedBase },
          { label: `紧急度 ${level}`, points: level * WEIGHTS.urgencyStep },
        ];
        if (kind === "targeted") factors.push({ label: "同名商品", points: WEIGHTS.targetedMatch });
        else if (kind === "substitute") factors.push({ label: "同产品族", points: WEIGHTS.substituteMatch });
        if (savings > 0)
          factors.push({
            label: `折扣 ${Math.round(savings)}%`,
            points: Math.min(WEIGHTS.savingsCap, savings / 2),
          });
        if (endingBonus > 0) factors.push({ label: "优惠即将结束", points: endingBonus });
        if (priceSignal === "historical-low")
          factors.push({ label: "触及历史最低价", points: WEIGHTS.historicalLow });
        return {
          daysLeft,
          expiresInDays,
          factors,
          dealId: deal.id,
          storeId: deal.storeId,
          tier,
          kind,
          matchedItemName: direct.name,
          matchedLevel: direct.level,
          daysUsed: usedDays(direct, today),
          lowCategoryCount: categoryItems.length,
          savingsPercent: savings,
          unitPrice: pack.unitPrice,
          unitLabel: pack.unit,
          priceSignal,
          suggestedQuantity: level === 4 ? 2 : 1,
          alsoAtStoreCount: 0,
          score: factors.reduce((sum, factor) => sum + factor.points, 0),
        };
      }
      if (categoryItems.length && categoryFallbacks.has(deal.category)) {
        const highestUrgency = Math.max(...categoryItems.map((item) => urgency(item, today)));
        /**
         * 这个大类里最快要断的那件还有几天。
         *
         * 注意不能取「最急的那件」——最急的往往是已经用完的，
         * 而用完的东西没有消耗速度可言，算出来是空。要的是那些还剩一点、
         * 但按当前用量马上要没的东西：那才是这一趟该顺手带的。
         *
         * 一件都算不出来（全都空了，或者都没记购买日）时留空，
         * 文案会退回只讲「有几项在减少」。
         */
        const categoryDaysLeft = categoryItems
          .map((item) => estimateDaysLeft(item, today))
          .filter((days): days is number => days !== undefined)
          .sort((x, y) => x - y)[0];
        const factors: ScoreFactor[] = [
          { label: `${deal.category}有 ${categoryItems.length} 项缺货`, points: WEIGHTS.categoryBase },
          {
            label: `最急的一项紧急度 ${highestUrgency}`,
            points: highestUrgency * WEIGHTS.categoryUrgencyStep,
          },
        ];
        if (savings > 0)
          factors.push({
            label: `折扣 ${Math.round(savings)}%`,
            points: Math.min(WEIGHTS.categorySavingsCap, savings / 3),
          });
        if (endingBonus > 0) factors.push({ label: "优惠即将结束", points: endingBonus });
        if (priceSignal === "historical-low")
          factors.push({ label: "触及历史最低价", points: WEIGHTS.categoryHistoricalLow });
        return {
          factors,
          daysLeft: categoryDaysLeft,
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
          score: factors.reduce((sum, factor) => sum + factor.points, 0),
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
        const factors: ScoreFactor[] = [
          { label: "家里有同款，只是便宜", points: WEIGHTS.opportunityBase },
          { label: `折扣 ${Math.round(savings)}%`, points: savings / 2 },
        ];
        if (priceSignal === "historical-low")
          factors.push({ label: "触及历史最低价", points: WEIGHTS.opportunityHistoricalLow });
        if (endingBonus > 0) factors.push({ label: "优惠即将结束", points: endingBonus });
        return {
          factors,
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
          score: factors.reduce((sum, factor) => sum + factor.points, 0),
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

/** 总览「附近超市」只收历史低价 / 接近低价，并且是家里正缺或常买的东西。 */
export function isOverviewNearbyPick(rec: Pick<FlyerRecommendation, "priceSignal" | "kind" | "tier">) {
  const cheap = rec.priceSignal === "historical-low" || rec.priceSignal === "below-average";
  const care =
    rec.kind === "targeted" || rec.kind === "substitute" || rec.tier === "must" || rec.tier === "recommended";
  return cheap && care;
}

export function overviewNearbyInterest(
  rec: Pick<FlyerRecommendation, "kind" | "matchedItemName" | "matchedLevel">,
) {
  if (rec.kind === "substitute") {
    return rec.matchedItemName ? `可替代家里的${rec.matchedItemName}` : "可替代家里现有食材";
  }
  return rec.matchedLevel || "感兴趣的食材";
}
