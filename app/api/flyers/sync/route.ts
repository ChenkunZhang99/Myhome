import { env } from "cloudflare:workers";
import { failure, safeMessage, UserFacingError, withRoute } from "../../_shared/observability";
import { householdTimeZone, resolveHousehold } from "../../_shared/household";
import { isInternalCall } from "../../_shared/internal";
import { dayIn } from "../../../dateTime";
import { ensureSchema } from "../../_shared/schema";
import { createOpenAIResponse, getOpenAIConfig, outputText, type OpenAIConfig } from "../../_shared/openai";
import { demoDeals, isDemoMode } from "../../_shared/demo";
import { fetchFlippFlyers, fetchFlyerDeals, merchantMatches, type FlippFlyer } from "./flipp";
import { readFlyerImage } from "./visionFlyer";
import { fetchPriceSmartDeals } from "./pricesmart";
import { normalizeFlyerName } from "../../../flyerRecommendations";

const categories = [
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
  "清洁用品",
  "洗护用品",
  "其他",
] as const;
/**
 * 网页搜索允许落在哪些域名上。
 *
 * 原本是写死的三家。门店目录能按邮编长大之后，写死就等于「新搜出来的店
 * 永远读不出优惠」——模型被限制在这三个域名里，怎么搜都搜不到 Save-On 的 flyer，
 * 而 safeSourceUrl 还会把它给出的网址改写回默认值。
 *
 * 所以改成从这次要读的门店自己的 flyer 网址上取。它同时还是一道限制：
 * 模型只能在这些店的官网里找，不能拿一个第三方聚合站来充数。
 */
function hostsOf(stores: StoreRow[]) {
  const hosts = new Set<string>();
  for (const store of stores) {
    try {
      hosts.add(new URL(store.flyerUrl).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      // 网址存坏了的那一条跳过，不该拖累同一批的其他门店。
    }
  }
  return [...hosts];
}

type StoreRow = {
  id: string;
  name: string;
  address: string;
  sourceKey: string;
  flyerUrl: string;
  /** 连锁品牌名。Flipp 给的是连锁而不是分店，靠它对上。 */
  chain?: string | null;
  /** 邮编前三位。Flipp 按邮编查，同一片区的门店查一次就够。 */
  area?: string | null;
};
type ExtractedDeal = {
  itemName: string;
  category: string;
  price: number;
  regularPrice: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
  sourceUrl: string;
};
/**
 * 这一家的优惠是从哪条路读来的。
 *
 * 它决定界面上给用户看的可信度标签，而这四条路的可靠程度差得很远：
 *   catalog  连锁官网的结构化数据，价格和有效期都是它自己发布的
 *   flipp    连锁发到 Flipp 的结构化数据，同样是发布方给的
 *   vision   模型看图读出来的。同一张图跑两次，18 项里只有 6 项一致，
 *            还出现过同一件商品一次 2.98 一次 2.68——必须让用户知道要到店核对
 *   search   模型搜网页读出来的，介于两者之间
 */
type DealSource = "catalog" | "flipp" | "vision" | "search";

type ExtractedStore = {
  sourceKey: string;
  status: "ok" | "partial" | "unavailable";
  message: string;
  deals: ExtractedDeal[];
  source: DealSource;
};

function safeSourceUrl(value: string, fallback: string, hosts: string[]) {
  try {
    const url = new URL(value || fallback);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
      ? url.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

function fingerprint(storeId: string, deal: ExtractedDeal) {
  const value = `${storeId}|${deal.itemName.trim().toLowerCase()}|${deal.price}|${deal.unit.trim().toLowerCase()}|${deal.validFrom}|${deal.validTo}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cleanDeal(deal: ExtractedDeal, today: string, flyerUrl: string, hosts: string[]) {
  const itemName = String(deal.itemName ?? "")
    .trim()
    .slice(0, 140);
  const category = categories.includes(deal.category as (typeof categories)[number]) ? deal.category : "其他";
  const price = Number(deal.price);
  const regularPrice = deal.regularPrice == null ? null : Number(deal.regularPrice);
  const unit =
    String(deal.unit ?? "件")
      .trim()
      .slice(0, 30) || "件";
  const validFrom = String(deal.validFrom ?? "").trim();
  const validTo = String(deal.validTo ?? "").trim();
  if (!itemName || !Number.isFinite(price) || price <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(validTo)) return null;
  if (validFrom > today || validTo < today || validFrom > validTo) return null;
  return {
    itemName,
    category,
    price,
    regularPrice: Number.isFinite(regularPrice) && Number(regularPrice) > price ? regularPrice : null,
    unit,
    validFrom,
    validTo,
    sourceUrl: safeSourceUrl(deal.sourceUrl, flyerUrl, hosts),
  };
}

/**
 * 一家店一次最多存这么多条。
 *
 * 原来是 18，而一份 flyer 有两三百条——线上实测 Walmart 读到 256 条只存了 18 条，
 * 四家店合计读回约 550 条、扔掉 87%。
 *
 * 扔掉本身还不是最糟的，糟的是扔的时机：截断发生在「拿库存去匹配」之前
 * （匹配在浏览器里，见 PlannerPanel 调 recommendFlyerDeals）。也就是说，
 * 在还不知道这家人缺什么的时候，就先按折扣率砍掉了 87%。
 * 而这个产品的全部价值恰恰是「你快用完的东西打折了」——你家酱油打 15% 排在
 * 第 40 位，就永远不会被看见。
 *
 * 顺带还连累了价格历史：它只能记录活下来的那些，「上次多少钱」也跟着瘸。
 *
 * 300 不是精挑的数字，只是一个防止异常响应撑爆库的上限。正常 flyer 到不了。
 */
const MAX_DEALS_PER_STORE = 300;

function selectDeals(deals: ExtractedDeal[], limit = MAX_DEALS_PER_STORE) {
  return [...deals]
    .sort((left, right) => {
      const score = (deal: ExtractedDeal) => {
        const discount =
          deal.regularPrice && deal.regularPrice > deal.price
            ? Math.round((1 - deal.price / deal.regularPrice) * 20)
            : 0;
        return discount;
      };
      return score(right) - score(left);
    })
    .slice(0, limit);
}

function nextSyncIso(intervalHours: number) {
  return new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
}

async function markFailure(message: string) {
  await env.DB.prepare(
    `INSERT INTO flyer_sync_settings (id, last_completed_at, last_status, last_message, updated_at)
    VALUES (1, CURRENT_TIMESTAMP, 'error', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET last_completed_at = CURRENT_TIMESTAMP, last_status = 'error',
    last_message = excluded.last_message, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(message.slice(0, 500))
    .run();
}

/**
 * 同步是全局任务，一份 flyer 供所有住户共用，所以这里不能带上任何一户的库存：
 * 那既会让一户人家的采购需求左右所有人看到的数据，也会把私人库存送进模型提示词。
 * 「这户人家缺什么」的匹配放在推荐环节按住户各自计算。
 */
async function searchFallback(stores: StoreRow[], today: string, openAI: OpenAIConfig) {
  const results = new Map<string, ExtractedStore>();
  if (!stores.length) return results;
  if (!openAI.apiKey) {
    for (const store of stores)
      results.set(store.sourceKey, {
        sourceKey: store.sourceKey,
        status: "unavailable",
        source: "search",
        message: "OpenAI API 未配置，无法使用网页搜索降级读取",
        deals: [],
      });
    return results;
  }

  const storeBrief = stores.map((store) => ({
    sourceKey: store.sourceKey,
    name: store.name,
    address: store.address,
    officialFlyer: store.flyerUrl,
  }));
  const prompt = `今天是 ${today}（加拿大温哥华时间）。读取下列门店当前生效的 Flyer/Weekly Specials：\n${JSON.stringify(storeBrief)}\n
只能返回能从官方页面确认商品、优惠价、具体门店和有效期的优惠。每家最多 40 项，优先折扣力度大的日常食品与家用品。只返回 validFrom <= ${today} <= validTo 的数据；日期使用 YYYY-MM-DD。category 从给定中文枚举选择；itemName 用简洁中文；unit 保留官方计价单位。无法确认时 status=unavailable 且 deals 为空。`;
  const dealSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      itemName: { type: "string" },
      category: { type: "string", enum: categories },
      price: { type: "number" },
      regularPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
      unit: { type: "string" },
      validFrom: { type: "string" },
      validTo: { type: "string" },
      sourceUrl: { type: "string" },
    },
    required: ["itemName", "category", "price", "regularPrice", "unit", "validFrom", "validTo", "sourceUrl"],
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      stores: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sourceKey: { type: "string" },
            status: { type: "string", enum: ["ok", "partial", "unavailable"] },
            message: { type: "string" },
            deals: { type: "array", items: dealSchema },
          },
          required: ["sourceKey", "status", "message", "deals"],
        },
      },
    },
    required: ["stores"],
  };

  try {
    const response = await createOpenAIResponse(
      {
        model: openAI.model,
        store: false,
        reasoning: { effort: "low" },
        tools: [
          {
            type: "web_search",
            search_context_size: "medium",
            filters: { allowed_domains: hostsOf(stores) },
            user_location: {
              type: "approximate",
              country: "CA",
              region: "British Columbia",
              city: "Burnaby",
            },
          },
        ],
        tool_choice: "required",
        input: [
          {
            role: "system",
            content:
              "你是谨慎的加拿大超市 Flyer 数据录入助手。没有官方来源证据就不录入，绝不编造价格或日期。",
          },
          { role: "user", content: prompt },
        ],
        text: { format: { type: "json_schema", name: "flyer_sync", strict: true, schema } },
      },
      openAI,
    );
    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new UserFacingError(
        (raw.error as { message?: string } | undefined)?.message || "网页搜索读取失败",
      );
    const text = outputText(raw);
    if (!text) throw new UserFacingError("网页搜索没有返回可用内容");
    const extracted = JSON.parse(text) as { stores: ExtractedStore[] };
    for (const store of extracted.stores) results.set(store.sourceKey, store);
  } catch (error) {
    const message = safeMessage("flyers.sync", error, "网页搜索读取失败");
    for (const store of stores)
      results.set(store.sourceKey, {
        sourceKey: store.sourceKey,
        status: "unavailable",
        source: "search",
        message,
        deals: [],
      });
  }
  return results;
}

function packageDetails(itemName: string, unit: string) {
  const match = itemName.match(/(\d+(?:\.\d+)?)\s*(kg|g|lb|lbs|ml|l|oz|ct|pk|pack|个|包|卷|颗)/i);
  return { quantity: match ? Number(match[1]) : 1, unit: match ? match[2] : unit.replace(/^\//, "") };
}

export const POST = withRoute("flyers.sync", async (request: Request) => {
  // 这个接口会调用模型，也就是会花钱。不鉴权的话，任何人循环打它就能
  // 把服务端配置的额度烧光——他不需要拿到密钥，把这个 Worker 当免费代理就够了。
  // 定时任务带着进程内的内部令牌，走另一条路。
  //
  // 闸门单独放在下面那个 try 之外：被拒绝不是「同步失败」，不能走 markFailure，
  // 否则谁都能把界面上的「上次同步」刷成一条无关的错误。状态码也要是 401 而不是 500。
  // null 表示定时任务：它没有请求者可言，按部署者本人处理。
  let household: string | null = null;
  try {
    if (!isInternalCall(request)) household = await resolveHousehold(request);
  } catch (error) {
    return failure("flyers.sync", error, "Flyer 自动同步失败", 401);
  }

  try {
    // 定时任务没有浏览器可问，只会拿到环境变量里的密钥；这里两者都覆盖。
    const openAI = getOpenAIConfig(request, household);
    await ensureSchema();
    const scheduled = new URL(request.url).searchParams.get("scheduled") === "1";
    const stores = await env.DB.prepare(
      // 目录是全局的：同一份 flyer 解析一次，所有订阅了这家店的住户共享。
      //
      // 但只读真的有人收藏的那些。目录能按邮编长大之后，「读遍目录」会随着
      // 用户变多而线性膨胀——一个多伦多用户搜出来的店，没有任何人订阅，
      // 却要在每次同步时花一次模型调用。
      `SELECT flyer_sources.source_key AS id, flyer_sources.name, flyer_sources.address,
      flyer_sources.source_key AS sourceKey, flyer_sources.flyer_url AS flyerUrl, flyer_sources.chain,
      (SELECT MIN(area) FROM flyer_source_areas WHERE flyer_source_areas.source_key = flyer_sources.source_key) AS area
      FROM flyer_sources
      WHERE flyer_format != 'manual' AND flyer_url != ''
        AND EXISTS (SELECT 1 FROM household_stores WHERE household_stores.source_key = flyer_sources.source_key)
      ORDER BY created_at ASC`,
    ).all<StoreRow>();
    if (!stores.results.length)
      return Response.json({ error: "还没有收藏任何可自动读取的门店" }, { status: 400 });

    const settings = await env.DB.prepare(
      "SELECT enabled, interval_hours AS intervalHours, next_sync_at AS nextSyncAt FROM flyer_sync_settings WHERE id = 1",
    ).first<{ enabled: number; intervalHours: number; nextSyncAt?: string | null }>();
    if (
      scheduled &&
      (!settings?.enabled || (settings.nextSyncAt && Date.parse(settings.nextSyncAt) > Date.now()))
    ) {
      return Response.json({ ok: true, skipped: true, imported: 0, message: "后台检查完成，尚未到同步时间" });
    }
    const intervalHours = Math.max(6, Math.min(168, Number(settings?.intervalHours) || 24));
    await env.DB.prepare(
      `INSERT INTO flyer_sync_settings (id, enabled, interval_hours, last_started_at, last_status, last_message, updated_at)
      VALUES (1, 1, ?, CURRENT_TIMESTAMP, 'running', '正在读取收藏门店 Flyer', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET last_started_at = CURRENT_TIMESTAMP, last_status = 'running',
      last_message = '正在读取收藏门店 Flyer', updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(intervalHours)
      .run();

    const timeZone = await householdTimeZone();
    const today = dayIn(timeZone);
    const foundByKey = new Map<string, ExtractedStore>();
    const fallbackStores: StoreRow[] = [];

    const demo = isDemoMode(request);

    /*
     * 先按片区把这一带在发的 flyer 列一遍。
     *
     * 每个片区一次 HTTP、零模型调用。真正取商品是下面按门店点名去取的，
     * 没人订阅的店不会白读一份。
     *
     * 剩下那条「让模型搜网页」的路只留给 Flipp 上没有的店——多是亚洲超市，
     * 它们的 flyer 是一整张图，网页里根本没有文字。
     *
     * 演示模式下不出网。
     */
    const flyersByArea = new Map<string, FlippFlyer[]>();
    if (!demo) {
      const areas = [...new Set(stores.results.map((store) => store.area).filter(Boolean))] as string[];
      for (const area of areas) {
        flyersByArea.set(area, await fetchFlippFlyers(area));
      }
    }

    for (const store of stores.results) {
      // 演示模式既不抓官网也不调模型，给每家门店一份样例优惠，
      // 后面的去重、单位价格、历史价格和推荐排序逻辑照常执行。
      if (demo) {
        foundByKey.set(store.sourceKey, {
          sourceKey: store.sourceKey,
          status: "ok",
          source: "catalog",
          message: "演示数据（未配置 OPENAI_API_KEY）",
          deals: demoDeals(store.sourceKey, timeZone).map((deal) => ({ ...deal, sourceUrl: store.flyerUrl })),
        });
        continue;
      }
      if (store.sourceKey !== "pricesmart-lougheed") {
        // Flipp 上有这家店的 flyer 就直接读，省掉一次模型调用。
        const areaFlyers = store.area ? (flyersByArea.get(store.area) ?? []) : [];
        const mine = areaFlyers.find((flyer) => merchantMatches(flyer.merchant, store.name, store.chain));
        const flippDeals =
          mine && store.area ? await fetchFlyerDeals(mine.id, store.area, today, timeZone) : [];
        if (flippDeals.length) {
          foundByKey.set(store.sourceKey, {
            sourceKey: store.sourceKey,
            status: "ok",
            source: "flipp",
            message: `已从 Flipp 读取 ${mine?.merchant ?? ""} 本周 flyer 的 ${flippDeals.length} 项优惠`,
            // 这里不走 selectDeals：它只按折扣排，会把 parseFlippItems 已经
            // 排好的「食品优先」再打乱一遍。那边排完直接取前若干条即可。
            deals: flippDeals
              .slice(0, MAX_DEALS_PER_STORE)
              .map((deal) => ({ ...deal, sourceUrl: store.flyerUrl })),
          });
          continue;
        }
        // Flipp 上没有这家店。多半是亚洲超市——它们的 flyer 是一整张图，
        // 页面里没有文字，让模型搜网页永远读不出东西。改成直接读那张图。
        const vision = await readFlyerImage(store.name, store.flyerUrl, today, openAI);
        if (vision.deals.length) {
          foundByKey.set(store.sourceKey, {
            sourceKey: store.sourceKey,
            status: "ok",
            source: "vision",
            message: vision.message,
            deals: vision.deals
              .slice(0, MAX_DEALS_PER_STORE)
              .map((deal) => ({ ...deal, sourceUrl: store.flyerUrl })),
          });
          continue;
        }
        // 连图都没有的页面（内容靠 JS 渲染那种）还是交给网页搜索，两者互补。
        fallbackStores.push(store);
        continue;
      }
      try {
        const directDeals = selectDeals(await fetchPriceSmartDeals(today, timeZone));
        foundByKey.set(store.sourceKey, {
          sourceKey: store.sourceKey,
          status: directDeals.length ? "ok" : "unavailable",
          source: "catalog",
          message: directDeals.length
            ? "已从 PriceSmart 官方结构化优惠页核对价格和有效期"
            : "PriceSmart 当前没有生效中的结构化优惠",
          deals: directDeals,
        });
      } catch (error) {
        fallbackStores.push(store);
        foundByKey.set(store.sourceKey, {
          sourceKey: store.sourceKey,
          status: "unavailable",
          source: "catalog",
          message: safeMessage("flyers.sync", error, "PriceSmart 官方页面读取失败"),
          deals: [],
        });
      }
    }

    const fallback = await searchFallback(fallbackStores, today, openAI);
    for (const [key, value] of fallback) foundByKey.set(key, value);

    await env.DB.prepare("DELETE FROM flyer_deals WHERE source = 'auto' AND valid_to < ?").bind(today).run();
    let imported = 0;
    const summaries: Array<{ store: string; status: string; imported: number; message: string }> = [];
    // 这一批门店的官网域名，算一次。它决定 sourceUrl 能不能被采信。
    const hosts = hostsOf(stores.results);

    for (const store of stores.results) {
      const found = foundByKey.get(store.sourceKey);
      const deals = (found?.deals ?? [])
        .map((deal) => cleanDeal(deal, today, store.flyerUrl, hosts))
        .filter((deal): deal is NonNullable<typeof deal> => Boolean(deal));
      const unique = Array.from(new Map(deals.map((deal) => [fingerprint(store.id, deal), deal])).entries());
      if (unique.length) {
        const statements = [
          env.DB.prepare("DELETE FROM flyer_deals WHERE source_key = ? AND source = 'auto'").bind(store.id),
        ];
        for (const [dealFingerprint, deal] of unique) {
          const dealId = `auto-${store.id}-${dealFingerprint}`;
          const itemKey = normalizeFlyerName(deal.itemName);
          const pack = packageDetails(deal.itemName, deal.unit);
          // 可信度按来源算，不按「读没读出来」算。
          //
          // 读图那条路读出来的东西同样是 status:"ok"，但它的可靠程度和
          // 官方结构化数据差着量级：同一张图跑两次，18 项里只有 6 项一致，
          // 还出现过同一件商品一次 2.98 一次 2.68。把它标成「官方来源核验」
          // 是在骗人——人照着一个读错的价格跑一趟超市，比没有这条推荐更糟。
          const confidence =
            found?.source === "catalog" || found?.source === "flipp"
              ? found.source === "catalog"
                ? "confirmed"
                : "high"
              : found?.source === "vision"
                ? "vision"
                : "medium";
          statements.push(
            env.DB.prepare(
              `INSERT INTO flyer_deals
            (id, source_key, item_name, category, price, regular_price, unit, valid_from, valid_to, source, source_url, source_fingerprint)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?)`,
            ).bind(
              dealId,
              store.id,
              deal.itemName,
              deal.category,
              deal.price,
              deal.regularPrice,
              deal.unit,
              deal.validFrom,
              deal.validTo,
              deal.sourceUrl,
              dealFingerprint,
            ),
          );
          statements.push(
            env.DB.prepare(
              `INSERT INTO flyer_deal_metadata
            (deal_id, item_key, package_quantity, package_unit, confidence, verified_at, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(deal_id) DO UPDATE SET item_key = excluded.item_key, package_quantity = excluded.package_quantity,
              package_unit = excluded.package_unit, confidence = excluded.confidence, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
            ).bind(dealId, itemKey, pack.quantity, pack.unit, confidence),
          );
          statements.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO flyer_price_history
            (id, deal_id, source_key, item_key, item_name, price, regular_price, unit, package_quantity, package_unit, valid_from, valid_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              `history-${store.id}-${dealFingerprint}`,
              dealId,
              store.id,
              itemKey,
              deal.itemName,
              deal.price,
              deal.regularPrice,
              deal.unit,
              pack.quantity,
              pack.unit,
              deal.validFrom,
              deal.validTo,
            ),
          );
        }
        statements.push(
          env.DB.prepare(
            "UPDATE flyer_sources SET last_synced_at = CURRENT_TIMESTAMP WHERE source_key = ?",
          ).bind(store.sourceKey),
        );
        await env.DB.batch(statements);
      }
      imported += unique.length;
      const preserved = !unique.length ? "；未覆盖上次仍有效的数据" : "";
      summaries.push({
        store: store.name,
        status: found?.status ?? "unavailable",
        imported: unique.length,
        message: `${found?.message || "官方页面当前无法可靠读取"}${preserved}`,
      });
    }

    // 同步会删掉过期的和不再上架的优惠，它们的元数据必须跟着清掉，否则每轮定时任务都会留下一批。
    // 放在全部导入完成之后统一做，而不是跟着每条 DELETE 走：优惠 id 是确定性的
    // （auto-门店-指纹），重新同步会复用同一个 id，跟着删会把用户的「已收藏 / 已隐藏」一起抹掉。
    await env.DB.prepare(
      "DELETE FROM flyer_deal_metadata WHERE deal_id NOT IN (SELECT id FROM flyer_deals)",
    ).run();

    const successfulStores = summaries.filter((summary) => summary.imported > 0).length;
    const status =
      imported > 0 ? (successfulStores === stores.results.length ? "success" : "partial") : "empty";
    const message =
      imported > 0
        ? `已从 ${successfulStores} 家门店自动录入 ${imported} 项当前优惠`
        : "本次仍未读取到可确认的当前优惠，系统已保留上次仍有效的数据";
    await env.DB.prepare(
      `INSERT INTO flyer_sync_settings
      (id, enabled, interval_hours, next_sync_at, last_completed_at, last_status, last_message, deals_imported, updated_at)
      VALUES (1, 1, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET interval_hours = excluded.interval_hours, next_sync_at = excluded.next_sync_at,
      last_completed_at = CURRENT_TIMESTAMP, last_status = excluded.last_status, last_message = excluded.last_message,
      deals_imported = excluded.deals_imported, updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(intervalHours, nextSyncIso(intervalHours), status, message, imported)
      .run();
    return Response.json({ ok: true, imported, status, message, stores: summaries });
  } catch (error) {
    const message = safeMessage("flyers.sync", error, "Flyer 自动同步失败");
    try {
      await markFailure(message);
    } catch {
      /* preserve original error */
    }
    return Response.json({ error: message }, { status: 500 });
  }
});
