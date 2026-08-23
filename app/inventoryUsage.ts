/**
 * 库存回写的共用逻辑：把「买回来了」和「做过了」换算成库存变化。
 * 前端预览和 API 写库都用这里的函数，保证两边算出来的结果一致。
 */

export type StockPortion = "none" | "measured" | "quarter" | "half" | "most" | "all";

export type InventoryMatchCandidate = {
  id: string;
  name: string;
  category?: string;
  unit?: string;
  level?: string;
};

export type ConsumableStock = {
  quantity: number;
  unit?: string;
  remainingPercent: number;
  level?: string;
};

export type StockChange = { quantity: number; remainingPercent: number; level: string };

export const stockPortions: StockPortion[] = ["none", "measured", "quarter", "half", "most", "all"];

/** 估算用的粗粒度选项，只有算不出准确用量时才需要让用户挑。 */
export const coarsePortions: StockPortion[] = ["none", "quarter", "half", "most", "all"];

export const portionLabels: Record<StockPortion, string> = {
  none: "没有用到",
  measured: "按菜谱用量",
  quarter: "用掉四分之一",
  half: "用掉一半",
  most: "用掉大部分",
  all: "全部用完",
};

const portionPercent: Record<StockPortion, number> = {
  none: 0,
  measured: 0,
  quarter: 25,
  half: 50,
  most: 75,
  all: 100,
};

/** 计量单位按实际用量扣，包装单位只能按余量百分比估。 */
const massUnits: Record<string, number> = { g: 1, kg: 1000, lb: 453.592 };
const volumeUnits: Record<string, number> = { ml: 1, L: 1000 };
const countUnits = ["个", "颗", "棵", "根", "把", "串", "只", "枚", "片", "块", "条", "份", "件"];
const packageUnits = ["包", "袋", "盒", "瓶", "罐", "桶", "箱", "卷", "板"];

/** 一顿饭只会用掉一小部分，估不出用量时不要瞎扣的分类。 */
const lightUseCategories = new Set(["米面粮油", "调味品"]);

const unitAliases: Record<string, string> = {
  克: "g",
  公克: "g",
  千克: "kg",
  公斤: "kg",
  斤: "kg",
  磅: "lb",
  lbs: "lb",
  毫升: "ml",
  升: "L",
  l: "L",
  ml: "ml",
  g: "g",
  kg: "kg",
  lb: "lb",
};

export function normalizeUnit(value: unknown) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^\//, "");
  if (!raw) return "";
  return unitAliases[raw] ?? unitAliases[raw.toLowerCase()] ?? raw;
}

/** 把菜谱里的「300克」「2 个」拆成数量和单位；「适量」这种拆不出来就返回 null。 */
export function parseAmount(value: unknown): { quantity: number; unit: string } | null {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([^\d\s]+)$/);
  if (!match) return null;
  const quantity = Number(match[1]);
  const unit = normalizeUnit(match[2]);
  return quantity > 0 && unit ? { quantity, unit } : null;
}

/** 把用量换算成库存记账用的单位，换不了（比如 300 克 → 袋）就返回 null。 */
export function convertQuantity(quantity: number, fromUnit: string, toUnit: string): number | null {
  const from = normalizeUnit(fromUnit),
    to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return quantity;
  if (massUnits[from] && massUnits[to]) return (quantity * massUnits[from]) / massUnits[to];
  if (volumeUnits[from] && volumeUnits[to]) return (quantity * volumeUnits[from]) / volumeUnits[to];
  // 个、颗、根这类只是数数的说法，视为同一种单位。
  if (countUnits.includes(from) && countUnits.includes(to)) return quantity;
  return null;
}

export type ConsumptionPlan = { quantityUsed: number | null; defaultPortion: StockPortion };

/**
 * 决定「完成菜谱」时这项库存默认怎么扣：
 * 能把菜谱用量换算成库存单位就按实际用量扣，否则退回粗粒度估算。
 */
export function planConsumption(
  amount: unknown,
  stock: ConsumableStock & { category?: string },
  source?: string,
): ConsumptionPlan {
  const parsed = parseAmount(amount);
  const stockUnit = normalizeUnit(stock.unit);
  const converted = parsed && stockUnit ? convertQuantity(parsed.quantity, parsed.unit, stockUnit) : null;
  if (converted !== null && converted > 0 && !packageUnits.includes(stockUnit)) {
    return { quantityUsed: Number(converted.toFixed(3)), defaultPortion: "measured" };
  }
  // 米、油、酱油这类一顿只用一点点，估不出来时默认不动，交给用户判断。
  const light = source === "pantry" || lightUseCategories.has(String(stock.category ?? ""));
  return { quantityUsed: null, defaultPortion: light ? "none" : "half" };
}

export function clampPercent(value: unknown, fallback = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(0, Math.min(100, number))) : fallback;
}

export function levelFromPercent(percent: number) {
  if (percent <= 0) return "已用完";
  if (percent <= 20) return "即将用完";
  if (percent <= 50) return "偏少";
  return "充足";
}

export function normalizeItemName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|lb|lbs|ml|l|oz|ct|pk|pack)\b/gi, "")
    .replace(/[0-9０-９]+(?:\.[0-9]+)?(?:公斤|千克|克|斤|磅|毫升|升|个|件|包|盒|瓶|袋|罐|支|只|枚)?/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(value: string) {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

export function itemNameSimilarity(left: unknown, right: unknown) {
  const a = normalizeItemName(left),
    b = normalizeItemName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return 0.88;
  const aa = bigrams(a),
    bb = [...bigrams(b)];
  let overlap = 0;
  for (const part of aa) {
    const index = bb.indexOf(part);
    if (index >= 0) {
      overlap += 1;
      bb.splice(index, 1);
    }
  }
  return (2 * overlap) / (aa.length + bigrams(b).length);
}

/** 低于这个相似度就不自动建议合并，交给用户自己选。 */
export const inventoryMatchThreshold = 0.55;

/** 按相似度排序的候选库存，用于让用户在少数几个合理选项里挑。 */
export function rankInventoryMatches<T extends InventoryMatchCandidate>(
  name: unknown,
  category: string,
  candidates: T[],
  limit = 5,
): { item: T; score: number }[] {
  return candidates
    .filter((candidate) => Boolean(candidate?.id))
    .map((candidate) => {
      let score = itemNameSimilarity(name, candidate.name);
      if (category && candidate.category && candidate.category !== category) score *= 0.6;
      return { item: candidate, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function findInventoryMatch<T extends InventoryMatchCandidate>(
  name: unknown,
  category: string,
  candidates: T[],
): { item: T; score: number } | null {
  const best = rankInventoryMatches(name, category, candidates, 1)[0];
  return best && best.score >= inventoryMatchThreshold ? best : null;
}

function roundQuantity(value: number) {
  return Number(Math.max(0, value).toFixed(2));
}

/**
 * 消耗一件库存。remainingPercent 表示已开封那一件还剩多少，
 * 用完之后自动接着用下一件（quantity 减一，余量回到 100%）。
 */
export function applyConsumption(
  item: ConsumableStock,
  portion: StockPortion,
  quantityUsed?: number | null,
): StockChange {
  const quantity = roundQuantity(Number(item.quantity) || 0);
  const remainingPercent = clampPercent(item.remainingPercent);
  const used = portionPercent[portion] ?? 0;
  const emptied = { quantity: 0, remainingPercent: 0, level: "已用完" };
  const unchanged = {
    quantity,
    remainingPercent,
    level: quantity <= 0 || remainingPercent <= 0 ? "已用完" : levelFromPercent(remainingPercent),
  };

  // 按实际用量扣：余量百分比按同比例下降，等于记录「相对上次买满时还剩多少」。
  if (portion === "measured") {
    const amount = Number(quantityUsed);
    if (!(amount > 0) || quantity <= 0) return unchanged;
    const nextQuantity = roundQuantity(quantity - amount);
    if (nextQuantity <= 0) return emptied;
    const nextPercent = clampPercent(Math.round((remainingPercent * nextQuantity) / quantity), 0);
    if (nextPercent <= 0) return emptied;
    return {
      quantity: nextQuantity,
      remainingPercent: nextPercent,
      level: levelFromPercent(nextPercent),
    };
  }

  if (!used) return unchanged;
  if (portion === "all" || quantity <= 0) return emptied;

  // 单位是 % 的物品不再需要特判：数量和百分比按同一个系数缩放，本来就同步。

  /**
   * 档位是「用掉现在剩余量的百分之多少」，不是「减掉满量的百分之多少」。
   *
   * 差别在这里：只剩 2 lb（满量的 50%）时用掉一半，结果是 1 lb，
   * 而不是把百分比从 50 减到 0。按点数减的话，剩得越少越容易被一下子清空——
   * 那正是之前 3 盒 40% 用掉「一半」会变成全空的原因。
   *
   * 数量和百分比按同一个系数缩放，所以两者始终讲同一个故事。
   * （界面上的 ±25% 是另一回事：那是相对满量的百分点，见 adjustRemaining。）
   */
  const keep = 1 - used / 100;
  const nextQuantity = roundQuantity(quantity * keep);
  const nextPercent = clampPercent(remainingPercent * keep, 0);
  if (nextQuantity <= 0 || nextPercent <= 0) return emptied;
  return { quantity: nextQuantity, remainingPercent: nextPercent, level: levelFromPercent(nextPercent) };
}

/**
 * 数量和百分比的约定（整个应用只有这一条规则）。
 *
 *   quantity        = 现在实际还剩多少，可以是小数
 *   remainingPercent = 相对「上次补满时」的比例
 *   满量             = quantity ÷ (percent ÷ 100)
 *
 * 单位是 kg 还是袋，算法完全一样：
 *   2 kg 是 50% → 满量 4 kg → 再减 25% → 4 × 0.25 = 1 kg
 *   1 袋减到 75% → 0.75 袋 → 补 2 袋 → 2.75 袋（回到 100%）→ 减 25% → 2.06 袋
 *
 * 之前按单位分了两套走法：可数的单位保持整数、减到 0 才换下一件。
 * 那样「2 袋」和「25%」讲的是两件事（袋数、拆开那袋的余量），
 * 补货时也就没法把 0.75 袋算进去。统一成一条之后这些都不存在了。
 */

/**
 * 这个单位是可以按比例分割的量（重量、体积），还是一件一件数的。
 *
 * 两者的百分比含义完全不同：
 *  - 4 kg 的胡萝卜，60% 就是 2.4 kg，数量本身要跟着变
 *  - 2 袋米，60% 说的是「拆开那一袋还剩六成」，袋数不动
 *
 * 分不清的自定义单位按可数处理：少改一个数字，比把重量算错安全。
 */
export function isMeasurableUnit(unit: unknown) {
  const normalized = normalizeUnit(unit);
  return normalized in massUnits || normalized in volumeUnits;
}

/**
 * 满量是多少。
 *
 * 不额外存一列，而是从「现在还剩多少」和「还剩百分之几」倒推：
 * 4.01 kg 是 65%，那么满量就是 6.17 kg。补货时会重新归一化，
 * 所以这个推算只在两次补货之间有意义——而那正是它被用到的全部场合。
 */
function baselineQuantity(quantity: number, percent: number) {
  if (!(quantity > 0) || !(percent > 0)) return 0;
  return quantity / (percent / 100);
}

/**
 * 手动调整余量（界面上的 ±25%）。
 *
 * 以前这里只改百分比，数量原地不动——于是卡片上会出现「4.01 kg · 65%」
 * 这种自相矛盾的组合：按 65% 算应该是 2.6 kg，可它还写着 4.01。
 *
 * 现在按单位分两种走法，和做菜时的扣减（applyConsumption）保持一致：
 *  - 可量的：数量按满量同比例变化
 *  - 可数的：百分比说的是拆开那一件，减到 0 就换下一件；只剩一件时标记用完
 */
export function adjustRemaining(item: ConsumableStock, deltaPercent: number): StockChange {
  const quantity = roundQuantity(Number(item.quantity) || 0);
  const percent = clampPercent(item.remainingPercent);
  const next = clampPercent(percent + deltaPercent, 0);
  const baseline = baselineQuantity(quantity, percent);

  // 推不出满量（数量或百分比已经是 0）时只动百分比，不要凭空造出一个数量。
  const nextQuantity = baseline > 0 ? roundQuantity((baseline * next) / 100) : quantity;
  if (next <= 0 || nextQuantity <= 0) return { quantity: 0, remainingPercent: 0, level: "已用完" };
  return { quantity: nextQuantity, remainingPercent: next, level: levelFromPercent(next) };
}

/**
 * 买回来补进已有的那一项。
 *
 * 新买的加到「现在还剩的」上面，然后整体重新算作满量——
 * 因为「满」的意思就是「现在手上有的全部」。之后再减 25%，是在这个新基准上减。
 *
 * 之前两条补货路径对这件事的处理并不一致：购物清单那条会回到 100%，
 * 小票那条却保留旧的百分比，于是补完货还显示「剩 40%」。
 */
export function restock(item: ConsumableStock, addedQuantity: number): StockChange {
  // 加的是「现在实际还剩的」，不是「原来有几件」——1 袋减到 75% 就是 0.75 袋，
  // 补 2 袋之后是 2.75 袋，而不是 3 袋。
  const added = Number(addedQuantity) || 0;
  const quantity = roundQuantity(Number(item.quantity) || 0);
  if (!(added > 0))
    return { quantity, remainingPercent: clampPercent(item.remainingPercent), level: item.level ?? "充足" };
  const nextQuantity = roundQuantity(quantity + added);
  return { quantity: nextQuantity, remainingPercent: 100, level: levelFromPercent(100) };
}

/** 把库存变化写成一句给用户看的话，例如「菠菜 40% → 已用完」。 */
export function describeChange(name: string, before: ConsumableStock, after: StockChange) {
  const quantityBefore = roundQuantity(Number(before.quantity) || 0);
  if (after.level === "已用完") return `${name} 将标记为已用完`;
  if (quantityBefore !== after.quantity) {
    const unit = before.unit ?? "";
    const reopened = after.remainingPercent === 100 && clampPercent(before.remainingPercent) < 100;
    return `${name} ${quantityBefore}${unit} → ${after.quantity}${unit}${reopened ? "（重新开一件）" : ""}`;
  }
  return `${name} 余量 ${clampPercent(before.remainingPercent)}% → ${after.remainingPercent}%`;
}

/** 开封后默认还能放几天，按分类给。查不到就不推算。 */
const OPENED_SHELF_LIFE: Record<string, number> = {
  乳品蛋类: 5,
  肉类海鲜: 2,
  蔬菜水果: 5,
  熟食: 3,
  调味品: 90,
  米面粮油: 180,
  冷冻食品: 30,
};

export function defaultOpenedShelfLife(category: string) {
  return OPENED_SHELF_LIFE[category];
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setDate(parsed.getDate() + days);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type ShelfLifeInput = {
  category?: string;
  expiryDate?: string | null;
  openedDate?: string | null;
  openedShelfLifeDays?: number | null;
};

/**
 * 实际到期日。
 *
 * 未开封时就是包装上的保质期。开封之后，牛奶还能放的天数远短于包装标注，
 * 所以取「开封日 + 开封后可用天数」和原保质期里更早的那个。
 * 没有开封日、也没有分类默认值时，退回原保质期。
 */
export function effectiveExpiry(item: ShelfLifeInput): { date: string | null; fromOpening: boolean } {
  const packaged = item.expiryDate?.trim() || null;
  if (!item.openedDate) return { date: packaged, fromOpening: false };

  const shelfLife =
    typeof item.openedShelfLifeDays === "number" && item.openedShelfLifeDays > 0
      ? item.openedShelfLifeDays
      : defaultOpenedShelfLife(String(item.category ?? ""));
  if (!shelfLife) return { date: packaged, fromOpening: false };

  const afterOpening = addDays(item.openedDate, shelfLife);
  if (!afterOpening) return { date: packaged, fromOpening: false };
  if (!packaged) return { date: afterOpening, fromOpening: true };
  return afterOpening < packaged
    ? { date: afterOpening, fromOpening: true }
    : { date: packaged, fromOpening: false };
}

/**
 * 已经用了多少天。开封日优先，没有就用购买日。
 *
 * 这个数字是事实，不是预测。之前那版「预计还可使用 N 天」是按紧急度硬编码的，
 * 看起来像算过其实没有，不如直接说清楚这东西在家里放了多久。
 */
export function daysInUse(
  item: { purchaseDate?: string | null; openedDate?: string | null },
  today = new Date(),
) {
  const from = item.openedDate?.trim() || item.purchaseDate?.trim();
  if (!from) return null;
  const start = new Date(`${from}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return days >= 0 ? days : null;
}
