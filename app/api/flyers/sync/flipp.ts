import { dayIn } from "../../../dateTime.ts";
import { categoryFromText, displayFlyerName } from "./flyerNaming.ts";

/**
 * 从 Flipp 按邮编读当周优惠。
 *
 * 加拿大绝大多数连锁把 flyer 发到 Flipp，它按邮编返回结构化数据：商品名、
 * 现价、原价、计价单位、有效期、商家。**一个模型 token 都不用花**——
 * 这是这条路存在的全部理由，也是为什么归一化那一步坚持用对照表而不是模型。
 *
 * 对照之下，现在的兜底是让模型用网页搜索去读 flyer 页面，而多数 flyer 是图片：
 * H Mart 的整份 flyer 就是一张 6083×4134 的 JPG，页面 HTML 里连一个 $ 都没有，
 * 所以那条路对它永远读不出东西。
 *
 * **这是一个没有文档的接口。** 它可能改、可能封、可能限速。所以这里所有失败
 * 都返回空数组而不是抛异常：读不到就退回原来的模型搜索，绝不能让它拖垮
 * 已经能跑的 PriceSmart。
 */

const ENDPOINT = "https://backflipp.wishabi.com/flipp/items/search";

export type FlippDeal = {
  merchantName: string;
  itemName: string;
  category: string;
  price: number;
  regularPrice: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
};

type RawItem = {
  merchant_name?: string;
  name?: string;
  current_price?: number | string | null;
  original_price?: number | string | null;
  pre_price_text?: string | null;
  post_price_text?: string | null;
  valid_from?: string;
  valid_to?: string;
  _L1?: string;
  _L2?: string;
};

function toNumber(value: unknown) {
  const number = typeof value === "string" ? Number(value.replace(/[^\d.]/g, "")) : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function localDate(iso: string | undefined, timeZone: string) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dayIn(timeZone, date);
}

/**
 * 计价单位。
 *
 * Flipp 把它放在 post_price_text 里，写法是 "/lb"、"/ea"、"each"。
 * 取不到就按「件」算——这个字段只影响显示和单价换算，猜错不会让人买错东西。
 */
function unitFrom(text: string | null | undefined) {
  const raw = String(text ?? "")
    .trim()
    .replace(/^\//, "")
    .toLowerCase();
  if (!raw) return "件";
  if (/^(ea|each|ct)$/.test(raw)) return "件";
  if (/^lbs?$/.test(raw)) return "lb";
  if (/^kgs?$/.test(raw)) return "kg";
  return raw.slice(0, 30);
}

/**
 * 补成一个完整的六位邮编。
 *
 * 调用方给的是片区（FSA，邮编前三位）——缓存按片区分，因为一个 FSA 大致就是
 * 一个街区。但 Flipp 只认完整邮编：只给 V3J 会回 422。
 *
 * 补成 V3J0A1 拿回来的结果和 V3J1N4 一模一样（实测都是 150 条），
 * 所以补位不影响准确度，反而保住了「一个片区查一次」这件事。
 */
function fullPostalCode(value: string) {
  const code = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code.length >= 6) return code.slice(0, 6);
  // 加拿大邮编形如 A1A 1A1，前三位就是 FSA。
  if (/^[A-Z][0-9][A-Z]$/.test(code)) return code + "0A1";
  return "";
}

/**
 * 一条原始记录能不能用。
 *
 * 少数商家（Chong Lee、Pomme Produce 这类）返回 name 和 price 都是 null 的占位记录，
 * 实测就在结果里混着。没有名字或没有价格的「优惠」对采购毫无意义，直接丢掉。
 */
export function toFlippDeal(raw: RawItem, today: string, timeZone: string): FlippDeal | null {
  const merchantName = String(raw.merchant_name ?? "").trim();
  const rawName = String(raw.name ?? "").trim();
  const price = toNumber(raw.current_price);
  if (!merchantName || !rawName || price === null) return null;

  const validFrom = localDate(raw.valid_from, timeZone);
  const validTo = localDate(raw.valid_to, timeZone);
  // 已经过期或还没开始的优惠不录入：整个推荐都以 today 为基准。
  if (!validFrom || !validTo || validFrom > today || validTo < today) return null;

  const regularPrice = toNumber(raw.original_price);
  return {
    merchantName,
    itemName: displayFlyerName(rawName).slice(0, 140),
    category: categoryFromText(rawName, raw._L1, raw._L2),
    price,
    regularPrice: regularPrice && regularPrice > price ? regularPrice : null,
    unit: unitFrom(raw.post_price_text),
    validFrom,
    validTo,
  };
}

/**
 * 把一批原始记录整理成优惠，并按「商家 + 商品 + 价格」去重。
 *
 * 同一件商品会在一份 flyer 的多个版位上重复出现，不去重的话推荐列表里
 * 会连着好几条一模一样的。
 */
export function parseFlippItems(items: RawItem[], today: string, timeZone: string) {
  const deals = items
    .map((item) => toFlippDeal(item, today, timeZone))
    .filter((deal): deal is FlippDeal => Boolean(deal));
  return Array.from(
    new Map(deals.map((deal) => [`${deal.merchantName}|${deal.itemName}|${deal.price}`, deal])).values(),
  );
}

/**
 * 读一个邮编附近所有商家的当周优惠。
 *
 * 空查询返回的就是这一带的整份优惠集合（实测 150 条），不需要按关键词一个个问。
 * 每个片区一次 HTTP，没有模型调用。
 */
export async function fetchFlippDeals(postalCode: string, today: string, timeZone: string) {
  const code = fullPostalCode(postalCode);
  if (!code) return [];
  const url = `${ENDPOINT}?locale=en-ca&postal_code=${encodeURIComponent(code)}&q=`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-CA,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; HomeStockPlanner/1.0)",
      },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { items?: RawItem[] };
    return parseFlippItems(body.items ?? [], today, timeZone);
  } catch {
    // 没有文档的接口，随时可能变。读不到就当这一片区没有数据，
    // 调用方会退回原来的模型搜索。
    return [];
  }
}

/**
 * Flipp 给的是连锁名（"Safeway"），而这个应用的门店是具体某一家分店
 * （"Safeway Metrotown"）。这里判断一条优惠属不属于某家门店。
 *
 * 只做包含匹配，两个方向都试：门店名里通常含连锁名，而独立超市的
 * chain 字段填的就是店名本身。
 *
 * 宁可漏配也不要错配：把 Safeway 的优惠挂到 Save-On-Foods 名下，
 * 人跑到店里会发现根本没这个价。
 */
export function merchantMatches(merchantName: string, storeName: string, chain?: string | null) {
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const merchant = squash(merchantName);
  if (merchant.length < 3) return false;
  const candidates = [squash(storeName), squash(chain ?? "")].filter((value) => value.length >= 3);
  return candidates.some((candidate) => candidate.includes(merchant) || merchant.includes(candidate));
}
