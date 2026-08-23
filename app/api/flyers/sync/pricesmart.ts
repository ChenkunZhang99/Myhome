import { dayIn } from "../../../dateTime.ts";
import { UserFacingError } from "../../_shared/observability.ts";
import { categoryFromText, displayFlyerName } from "./flyerNaming.ts";

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
  if (markerIndex < 0) throw new UserFacingError("PriceSmart 页面没有结构化优惠数据");
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
  throw new UserFacingError("PriceSmart 优惠数据不完整");
}

function localDate(isoDate: string, timeZone: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return dayIn(timeZone, date);
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

function productToDeal(product: ProductCard, today: string, timeZone: string): PriceSmartDeal | null {
  const promotion = product.tprPrice;
  const validFrom = promotion?.effectiveFrom ? localDate(promotion.effectiveFrom, timeZone) : "";
  const validTo = promotion?.effectiveUntil ? localDate(promotion.effectiveUntil, timeZone) : "";
  const price = Number(promotion?.wholePrice);
  if (!promotion?.active || !product.name || !Number.isFinite(price) || price <= 0) return null;
  if (!validFrom || !validTo || validFrom > today || validTo < today) return null;

  const weighted = Boolean(product.unitOfPrice?.abbreviation);
  const regularPrice = weighted ? null : numericPrice(product.wasPrice);
  return {
    itemName: displayFlyerName(product.name).slice(0, 140),
    // 分类的关键词表和 Flipp 那条路共用一份：同一件商品不该因为
    // 来自哪个数据源而落到不同的分类里。
    category: categoryFromText(
      product.name,
      ...(product.categories ?? []).flatMap((entry) => [entry.category, entry.categoryBreadcrumb]),
      ...(product.defaultCategory ?? []).flatMap((entry) => [entry.category, entry.categoryBreadcrumb]),
    ),
    price,
    regularPrice: regularPrice && regularPrice > price ? regularPrice : null,
    unit: unitFor(product),
    validFrom,
    validTo,
    sourceUrl: weeklySpecialsUrl,
  };
}

export function parsePriceSmartDeals(html: string, today: string, timeZone: string) {
  const json = assignedJson(html, "window.__PRELOADED_STATE__=");
  const state = JSON.parse(json) as { search?: { productCardDictionary?: Record<string, ProductCard> } };
  const products = Object.values(state.search?.productCardDictionary ?? {});
  if (!products.length) throw new UserFacingError("PriceSmart 当前优惠列表为空");
  const deals = products
    .map((product) => productToDeal(product, today, timeZone))
    .filter((deal): deal is PriceSmartDeal => Boolean(deal));
  return Array.from(
    new Map(deals.map((deal) => [`${deal.itemName}|${deal.price}|${deal.unit}`, deal])).values(),
  );
}

export async function fetchPriceSmartDeals(today: string, timeZone: string) {
  const response = await fetch(weeklySpecialsUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; HomeStockPlanner/1.0)",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new UserFacingError(`PriceSmart 官方页面返回 ${response.status}`);
  return parsePriceSmartDeals(await response.text(), today, timeZone);
}
