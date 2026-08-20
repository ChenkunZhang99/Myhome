export type PriceSmartDeal = {
  itemName: string;
  category: string;
  price: number;
  regularPrice: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
  sourceUrl: string;
};

type ProductCard = {
  sku?: string;
  name?: string;
  price?: string;
  wasPrice?: string;
  sellBy?: string;
  categories?: Array<{ category?: string; categoryBreadcrumb?: string }>;
  defaultCategory?: Array<{ category?: string; categoryBreadcrumb?: string }>;
  unitOfPrice?: { abbreviation?: string; label?: string; type?: string };
  tprPrice?: {
    active?: boolean;
    effectiveFrom?: string;
    effectiveUntil?: string;
    wholePrice?: number;
  };
};

const weeklySpecialsUrl = "https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials";

function assignedJson(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error("PriceSmart 页面没有结构化优惠数据");
  const start = markerIndex + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("PriceSmart 优惠数据不完整");
}

function localDate(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function categoryFor(product: ProductCard) {
  const context = [
    product.name,
    ...(product.categories ?? []).flatMap((entry) => [entry.category, entry.categoryBreadcrumb]),
    ...(product.defaultCategory ?? []).flatMap((entry) => [entry.category, entry.categoryBreadcrumb]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/meat|seafood|fish|poultry|chicken|beef|pork|lamb|shrimp|prawn/.test(context)) return "肉类海鲜";
  if (/dairy|milk|cheese|yogurt|egg/.test(context)) return "乳品蛋类";
  if (/frozen|ice cream/.test(context)) return "冷冻食品";
  if (/clean|dishwash|laundry|household|paper towel|toilet tissue/.test(context)) return "清洁用品";
  if (/personal care|shampoo|conditioner|body wash|soap|skincare/.test(context)) return "洗护用品";
  if (/condiment|sauce|spice|seasoning|vinegar/.test(context)) return "调味品";
  if (/rice|pasta|noodle|flour|grain|oil|bakery|bread|cereal/.test(context)) return "米面粮油";
  if (/fruit|vegetable|produce|lettuce|tomato|broccoli|corn|grape|orange|peach|apple/.test(context))
    return "蔬菜水果";
  if (/snack|beverage|drink|water|juice|coffee|tea|candy|chocolate/.test(context)) return "零食饮料";
  return "其他";
}

function displayName(name: string) {
  const translations: Array<[RegExp, string]> = [
    [/broccoli/i, "西兰花"],
    [/iceberg.*lettuce|lettuce.*iceberg/i, "冰山生菜"],
    [/red seedless.*grape|grape.*red seedless/i, "无籽红葡萄"],
    [/navel.*orange|orange.*navel/i, "脐橙"],
    [/corn.*cob/i, "新鲜玉米"],
    [/peach/i, "鲜桃"],
    [/tomato/i, "番茄"],
  ];
  const translated = translations.find(([pattern]) => pattern.test(name));
  return (
    translated?.[1] ??
    name
      .replace(/\s+-\s+/g, " ")
      .replace(/,\s*Fresh\b/gi, "")
      .trim()
  );
}

function unitFor(product: ProductCard) {
  const abbreviation = product.unitOfPrice?.abbreviation?.trim();
  if (abbreviation) return abbreviation;
  const type = product.unitOfPrice?.type?.toLowerCase();
  if (type === "each" || product.sellBy === "each") return "件";
  return product.unitOfPrice?.label?.trim() || "件";
}

function numericPrice(value?: string) {
  const match = value?.match(/\$\s*([\d.]+)/);
  const price = match ? Number(match[1]) : NaN;
  return Number.isFinite(price) ? price : null;
}

function productToDeal(product: ProductCard, today: string): PriceSmartDeal | null {
  const promotion = product.tprPrice;
  const validFrom = promotion?.effectiveFrom ? localDate(promotion.effectiveFrom) : "";
  const validTo = promotion?.effectiveUntil ? localDate(promotion.effectiveUntil) : "";
  const price = Number(promotion?.wholePrice);
  if (!promotion?.active || !product.name || !Number.isFinite(price) || price <= 0) return null;
  if (!validFrom || !validTo || validFrom > today || validTo < today) return null;

  const weighted = Boolean(product.unitOfPrice?.abbreviation);
  const regularPrice = weighted ? null : numericPrice(product.wasPrice);
  return {
    itemName: displayName(product.name).slice(0, 140),
    category: categoryFor(product),
    price,
    regularPrice: regularPrice && regularPrice > price ? regularPrice : null,
    unit: unitFor(product),
    validFrom,
    validTo,
    sourceUrl: weeklySpecialsUrl,
  };
}

export function parsePriceSmartDeals(html: string, today: string) {
  const json = assignedJson(html, "window.__PRELOADED_STATE__=");
  const state = JSON.parse(json) as { search?: { productCardDictionary?: Record<string, ProductCard> } };
  const products = Object.values(state.search?.productCardDictionary ?? {});
  if (!products.length) throw new Error("PriceSmart 当前优惠列表为空");
  const deals = products
    .map((product) => productToDeal(product, today))
    .filter((deal): deal is PriceSmartDeal => Boolean(deal));
  return Array.from(
    new Map(deals.map((deal) => [`${deal.itemName}|${deal.price}|${deal.unit}`, deal])).values(),
  );
}

export async function fetchPriceSmartDeals(today: string) {
  const response = await fetch(weeklySpecialsUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; HomeStockPlanner/1.0)",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`PriceSmart 官方页面返回 ${response.status}`);
  return parsePriceSmartDeals(await response.text(), today);
}
