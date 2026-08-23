import { FLYER_CATEGORIES, categoryFromText, displayFlyerName } from "./flyerNaming.ts";

/**
 * 视觉读图的输出形状与校验。
 *
 * 单独成一个模块，是因为 visionFlyer.ts 要 import openai.ts，而那条链上有
 * cloudflare:workers——Node 解析不了那个 scheme，于是这里的纯逻辑就测不到。
 * 而这恰恰是最需要测的部分：视觉读图比读结构化数据更容易出错，
 * 价格牌上的 7.98 和 1.98 在缩略图上长得很像。
 *
 * 同样的道理在 recipeShape.ts 里已经用过一次。
 */

const dealSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    itemName: { type: "string" },
    category: { type: "string", enum: [...FLYER_CATEGORIES] },
    price: { type: "number" },
    regularPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
    unit: { type: "string" },
  },
  required: ["itemName", "category", "price", "regularPrice", "unit"],
};

export const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // 有效期印在版头的横幅上（"SALE PERIOD Aug 20 ~ Aug 26"），整份共用一个。
    validFrom: { type: "string" },
    validTo: { type: "string" },
    readable: { type: "boolean" },
    note: { type: "string" },
    deals: { type: "array", items: dealSchema },
  },
  required: ["validFrom", "validTo", "readable", "note", "deals"],
};

export function visionPrompt(storeName: string, today: string) {
  return [
    `这是 ${storeName} 本周的 flyer。今天是 ${today}（加拿大西部时间）。`,
    "",
    "把上面的优惠读成结构化数据：",
    "- 先读版头横幅上的有效期（常写成 SALE PERIOD Aug 20 ~ Aug 26），转成 YYYY-MM-DD",
    "  横幅上只有月日没有年份时，按今天所在的年份推断；跨年时不要推出一个已经过去的日期",
    "- 最多 40 项，优先食材和日用品：肉、海鲜、蔬菜水果、蛋奶、米面粮油、调味品",
    "- price 是价格牌上的大字数字。写着 2 FOR 10.00 就填单价 5.00",
    "- regularPrice 只在图上真的印了原价时才填，没印就填 null。不要自己推算",
    "- unit 用价格牌上的计价单位：EA、PK、BOX、LB、BAG 等，照抄",
    "- itemName 用中文；图上是韩文或英文就译成中文常用叫法",
    "",
    "读不清就少读几项。**绝不要猜价格**——一个猜错的价格会让人白跑一趟超市，",
    "而少读一项只是少一条推荐。整张图都读不出来就把 readable 设成 false。",
  ].join("\n");
}

export type VisionDeal = {
  itemName: string;
  category: string;
  price: number;
  regularPrice: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
};

export type VisionResult = { status: "ok" | "unavailable"; message: string; deals: VisionDeal[] };

function isDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 逐条核对模型读出来的东西。
 *
 * 视觉读图比读结构化数据更容易出错——价格牌上的 7.98 和 1.98 在缩略图上
 * 长得很像。所以这里比别的来源更严：日期必须成形、必须覆盖今天，价格必须是
 * 正数，原价必须真的高于现价。任何一条不满足就丢掉那一项。
 */
export function cleanVisionDeals(
  raw: unknown,
  today: string,
): { deals: VisionDeal[]; validFrom: string; validTo: string } {
  const parsed = raw as {
    validFrom?: unknown;
    validTo?: unknown;
    deals?: Array<Record<string, unknown>>;
  };
  const validFrom = isDate(parsed.validFrom) ? String(parsed.validFrom) : "";
  const validTo = isDate(parsed.validTo) ? String(parsed.validTo) : "";
  // 有效期不成形、或者今天根本不在期内，那整份都不该录入：
  // 一份上周的 flyer 读得再准也是错的。
  if (!validFrom || !validTo || validFrom > today || validTo < today)
    return { deals: [], validFrom, validTo };

  const deals: VisionDeal[] = [];
  for (const entry of parsed.deals ?? []) {
    const rawName = String(entry.itemName ?? "").trim();
    const price = Number(entry.price);
    if (!rawName || !Number.isFinite(price) || price <= 0) continue;
    const regular = Number(entry.regularPrice);
    const category = FLYER_CATEGORIES.includes(entry.category as (typeof FLYER_CATEGORIES)[number])
      ? String(entry.category)
      : categoryFromText(rawName);
    deals.push({
      itemName: displayFlyerName(rawName).slice(0, 140),
      category,
      price,
      regularPrice: Number.isFinite(regular) && regular > price ? regular : null,
      unit:
        String(entry.unit ?? "件")
          .trim()
          .slice(0, 30) || "件",
      validFrom,
      validTo,
    });
  }
  // 同一件商品在版面上可能出现两次
  const unique = Array.from(new Map(deals.map((deal) => [`${deal.itemName}|${deal.price}`, deal])).values());
  return { deals: unique, validFrom, validTo };
}
