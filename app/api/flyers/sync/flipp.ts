import { dayIn } from "../../../dateTime.ts";
import { categoryFromText, displayFlyerName } from "./flyerNaming.ts";

/**
 * 从 Flipp 读整份 flyer。
 *
 * 加拿大绝大多数连锁把 flyer 发到 Flipp，它按邮编返回结构化数据：商品名、价格、
 * 折扣力度、有效期。**一个模型 token 都不用花**——这是这条路存在的全部理由，
 * 也是为什么归一化那一步坚持用对照表而不是模型。
 *
 * 对照之下，原来的兜底是让模型用网页搜索去读 flyer 页面，而多数 flyer 是图片：
 * H Mart 的整份 flyer 就是一张 6083×4134 的 JPG，页面 HTML 里连一个 $ 都没有，
 * 那条路对它永远读不出东西。
 *
 * 要两步：
 *   1. /flipp/flyers?postal_code=…  这一带在发的 flyer（约 100 份，带商家和有效期）
 *   2. /flipp/flyers/{id}           那一份的全部商品（Walmart 实测 387 条）
 *
 * 第一版走的是 /flipp/items/search&q=，那是个搜索接口：空查询返回的是默认推荐
 * （实测全是 IKEA、RONA、Leon's），根本不是杂货 flyer。留在这里免得再走一遍。
 *
 * **这是一个没有文档的接口。** 它可能改、可能封、可能限速。所以这里所有失败
 * 都返回空而不是抛异常：读不到就退回模型搜索，绝不能拖垮已经能跑的 PriceSmart。
 */

const BASE = "https://backflipp.wishabi.com/flipp";

const HEADERS = {
  Accept: "application/json",
  "Accept-Language": "en-CA,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (compatible; HomeStockPlanner/1.0)",
};

export type FlippFlyer = { id: number; merchant: string; validFrom: string; validTo: string };

export type FlippDeal = {
  itemName: string;
  category: string;
  price: number;
  regularPrice: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
  /** 折扣百分比，用来挑出这份 flyer 里最值得看的那些。 */
  discount: number;
};

type RawItem = {
  name?: string | null;
  price?: string | number | null;
  discount?: number | null;
  valid_from?: string;
  valid_to?: string;
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
 * 补成一个完整的六位邮编。
 *
 * 调用方给的是片区（FSA，邮编前三位）——缓存按片区分，因为一个 FSA 大致就是
 * 一个街区。但 Flipp 只认完整邮编：只给 V3J 会回 422。
 *
 * 补成 V3J0A1 拿回来的结果和 V3J1N4 一样，所以补位不影响准确度，
 * 反而保住了「一个片区查一次」这件事。
 */
export function fullPostalCode(value: string) {
  const code = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code.length >= 6) return code.slice(0, 6);
  // 加拿大邮编形如 A1A 1A1，前三位就是 FSA。
  if (/^[A-Z][0-9][A-Z]$/.test(code)) return code + "0A1";
  return "";
}

/**
 * 一条商品能不能用。
 *
 * flyer 里混着版面元素——实测有 {"name":"Direct Link","price":""} 这样的条目，
 * 387 条里有 37 条是这类。没有名字或没有价格的「优惠」对采购毫无意义。
 */
export function toFlippDeal(raw: RawItem, today: string, timeZone: string): FlippDeal | null {
  const rawName = String(raw.name ?? "").trim();
  const price = toNumber(raw.price);
  if (!rawName || price === null) return null;

  const validFrom = localDate(raw.valid_from, timeZone);
  const validTo = localDate(raw.valid_to, timeZone);
  // 已经过期或还没开始的不录入：整个推荐都以 today 为基准。
  if (!validFrom || !validTo || validFrom > today || validTo < today) return null;

  // discount 是折扣百分比（实测取值 6~88，另有约三分之一为 null）。
  // 由它反推原价：现价 ÷ (1 - 折扣)。95 以上不信——那多半是脏数据，
  // 反推出来会是一个荒唐的原价，让「省了多少」变成一个笑话。
  const discount = Number(raw.discount);
  const usable = Number.isFinite(discount) && discount > 0 && discount < 95;
  const regularPrice = usable ? Math.round((price / (1 - discount / 100)) * 100) / 100 : null;

  return {
    itemName: displayFlyerName(rawName).slice(0, 140),
    category: categoryFromText(rawName),
    price,
    regularPrice: regularPrice && regularPrice > price ? regularPrice : null,
    // 单份 flyer 的条目不带计价单位，包装规格在名字里（"2 x 445 g"），
    // 由 sync 里的 packageDetails 解析。这里统一按件。
    unit: "件",
    validFrom,
    validTo,
    discount: usable ? discount : 0,
  };
}

/**
 * 把一份 flyer 整理成优惠，折扣大的排前面，并按「商品 + 价格」去重。
 *
 * 同一件商品会在版面上重复出现，不去重的话推荐列表里会连着好几条一模一样的。
 * 排序很重要：一份 flyer 有三百多条，而下游只取前十几条——不排序的话
 * 取到的是版面顺序上最靠前的那些（婴儿奶粉、芝士条），不是最划算的。
 */
export function parseFlippItems(items: RawItem[], today: string, timeZone: string) {
  const deals = items
    .map((item) => toFlippDeal(item, today, timeZone))
    .filter((deal): deal is FlippDeal => Boolean(deal));
  const unique = Array.from(new Map(deals.map((deal) => [`${deal.itemName}|${deal.price}`, deal])).values());
  return unique.sort((left, right) => right.discount - left.discount);
}

/** 这一带正在发的 flyer。一次 HTTP，带商家名和有效期。 */
export async function fetchFlippFlyers(postalCode: string): Promise<FlippFlyer[]> {
  const code = fullPostalCode(postalCode);
  if (!code) {
    note({ area: postalCode, problem: "邮编补不成六位" });
    return [];
  }
  try {
    const response = await fetch(`${BASE}/flyers?locale=en-ca&postal_code=${code}`, { headers: HEADERS });
    if (!response.ok) {
      note({ code, status: response.status, problem: "flyer 列表返回非 200" });
      return [];
    }
    const body = (await response.json()) as unknown;
    const list = (Array.isArray(body) ? body : ((body as { flyers?: unknown[] }).flyers ?? [])) as Array<
      Record<string, unknown>
    >;
    const flyers = list
      .map((entry) => ({
        id: Number(entry.id),
        merchant: String(entry.merchant ?? "").trim(),
        validFrom: String(entry.valid_from ?? ""),
        validTo: String(entry.valid_to ?? ""),
      }))
      .filter((flyer) => Number.isFinite(flyer.id) && flyer.merchant);
    note({ code, flyers: flyers.length });
    return flyers;
  } catch (error) {
    note({ code, problem: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** 一份 flyer 里的全部商品。 */
export async function fetchFlyerDeals(
  flyerId: number,
  postalCode: string,
  today: string,
  timeZone: string,
): Promise<FlippDeal[]> {
  const code = fullPostalCode(postalCode);
  if (!code) return [];
  try {
    const response = await fetch(`${BASE}/flyers/${flyerId}?locale=en-ca&postal_code=${code}`, {
      headers: HEADERS,
    });
    if (!response.ok) {
      note({ flyerId, status: response.status, problem: "flyer 内容返回非 200" });
      return [];
    }
    const body = (await response.json()) as { items?: RawItem[] };
    const raw = body.items ?? [];
    const deals = parseFlippItems(raw, today, timeZone);
    note({ flyerId, raw: raw.length, kept: deals.length, today });
    return deals;
  } catch (error) {
    note({ flyerId, problem: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Flipp 给的是连锁名（"Safeway"），而这个应用的门店是具体某一家分店
 * （"Safeway Metrotown"）。这里判断一份 flyer 属不属于某家门店。
 *
 * 只做包含匹配，两个方向都试：门店名里通常含连锁名，而独立超市的
 * chain 字段填的就是店名本身。
 *
 * 宁可漏配也不要错配：把 Safeway 的价格挂到 Save-On-Foods 名下，
 * 人跑到店里会发现根本没这个价。
 */
export function merchantMatches(merchantName: string, storeName: string, chain?: string | null) {
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const merchant = squash(merchantName);
  if (merchant.length < 3) return false;
  const candidates = [squash(storeName), squash(chain ?? "")].filter((value) => value.length >= 3);
  return candidates.some((candidate) => candidate.includes(merchant) || merchant.includes(candidate));
}

/**
 * 每次读取都留一行日志。
 *
 * 这是一个没有文档的接口：它哪天改了字段名或者开始挡请求，表现是「优惠悄悄
 * 变少了」，而不是报错——那种失效不留痕迹的话，可能几个月都没人发现。
 * 记下拿到几条、留下几条，一眼就能看出是接口挂了还是过滤过严。
 */
function note(detail: Record<string, unknown>) {
  console.warn(JSON.stringify({ at: new Date().toISOString(), scope: "flyers.flipp", ...detail }));
}
