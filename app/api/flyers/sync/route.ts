import { env } from "cloudflare:workers";
import { safeMessage, UserFacingError, withRoute } from "../../_shared/observability";
import { householdTimeZone } from "../../_shared/household";
import { dayIn } from "../../../dateTime";
import { ensureSchema } from "../../_shared/schema";
import { createOpenAIResponse, getOpenAIConfig, type OpenAIConfig } from "../../_shared/openai";
import { demoDeals, isDemoMode } from "../../_shared/demo";
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
const allowedHosts = ["hmart.ca", "pricesmartfoods.com", "walmart.ca"];

type StoreRow = { id: string; name: string; address: string; sourceKey: string; flyerUrl: string };
type InventoryRow = {
  name: string;
  category: string;
  level: string;
  quantity: number;
  unit: string;
  remainingPercent: number;
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
type ExtractedStore = {
  sourceKey: string;
  status: "ok" | "partial" | "unavailable";
  message: string;
  deals: ExtractedDeal[];
};

function outputText(response: Record<string, unknown>) {
  const output = Array.isArray(response.output)
    ? (response.output as Array<{ content?: Array<{ type?: string; text?: string }> }>)
    : [];
  for (const item of output)
    for (const content of item.content ?? [])
      if (content.type === "output_text" && content.text) return content.text;
  return typeof response.output_text === "string" ? response.output_text : "";
}

function safeSourceUrl(value: string, fallback: string) {
  try {
    const url = new URL(value || fallback);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
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

function cleanDeal(deal: ExtractedDeal, today: string, flyerUrl: string) {
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
    sourceUrl: safeSourceUrl(deal.sourceUrl, flyerUrl),
  };
}

function selectDeals(deals: ExtractedDeal[], lowInventory: InventoryRow[], limit = 18) {
  const lowCategories = new Set(lowInventory.map((item) => item.category));
  const lowNames = lowInventory.map((item) => item.name.toLowerCase());
  return [...deals]
    .sort((left, right) => {
      const score = (deal: ExtractedDeal) => {
        const name = deal.itemName.toLowerCase();
        const exact = lowNames.some((lowName) => name.includes(lowName) || lowName.includes(name)) ? 100 : 0;
        const category = lowCategories.has(deal.category) ? 50 : 0;
        const discount =
          deal.regularPrice && deal.regularPrice > deal.price
            ? Math.round((1 - deal.price / deal.regularPrice) * 20)
            : 0;
        return exact + category + discount;
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

async function searchFallback(
  stores: StoreRow[],
  lowInventory: InventoryRow[],
  today: string,
  openAI: OpenAIConfig,
) {
  const results = new Map<string, ExtractedStore>();
  if (!stores.length) return results;
  if (!openAI.apiKey) {
    for (const store of stores)
      results.set(store.sourceKey, {
        sourceKey: store.sourceKey,
        status: "unavailable",
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
家庭低库存：${JSON.stringify(lowInventory)}\n
只能返回能从官方页面确认商品、优惠价、具体门店和有效期的优惠。每家最多 18 项，优先匹配低库存名称或品类。只返回 validFrom <= ${today} <= validTo 的数据；日期使用 YYYY-MM-DD。category 从给定中文枚举选择；itemName 用简洁中文；unit 保留官方计价单位。无法确认时 status=unavailable 且 deals 为空。`;
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
            filters: { allowed_domains: allowedHosts },
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
      results.set(store.sourceKey, { sourceKey: store.sourceKey, status: "unavailable", message, deals: [] });
  }
  return results;
}

function packageDetails(itemName: string, unit: string) {
  const match = itemName.match(/(\d+(?:\.\d+)?)\s*(kg|g|lb|lbs|ml|l|oz|ct|pk|pack|个|包|卷|颗)/i);
  return { quantity: match ? Number(match[1]) : 1, unit: match ? match[2] : unit.replace(/^\//, "") };
}

export const POST = withRoute("flyers.sync", async (request: Request) => {
  try {
    // 定时任务没有浏览器可问，只会拿到环境变量里的密钥；这里两者都覆盖。
    const openAI = getOpenAIConfig(request);
    await ensureSchema();
    const scheduled = new URL(request.url).searchParams.get("scheduled") === "1";
    const stores = await env.DB.prepare(
      // 目录是全局的：同一份 flyer 解析一次，所有订阅了这家店的住户共享。
      `SELECT source_key AS id, name, address, source_key AS sourceKey, flyer_url AS flyerUrl
      FROM flyer_sources WHERE flyer_format != 'manual' AND flyer_url != '' ORDER BY created_at ASC`,
    ).all<StoreRow>();
    if (!stores.results.length)
      return Response.json({ error: "门店目录里还没有可自动读取的来源" }, { status: 400 });

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

    const lowInventory = await env.DB.prepare(
      `SELECT name, category, level, quantity, unit,
      remaining_percent AS remainingPercent FROM inventory_items
      WHERE quantity = 0 OR remaining_percent <= 50 OR level IN ('偏少', '即将用完', '已用完') ORDER BY updated_at DESC LIMIT 40`,
    ).all<InventoryRow>();
    const timeZone = await householdTimeZone();
    const today = dayIn(timeZone);
    const foundByKey = new Map<string, ExtractedStore>();
    const fallbackStores: StoreRow[] = [];

    const demo = isDemoMode(request);
    for (const store of stores.results) {
      // 演示模式既不抓官网也不调模型，给每家门店一份样例优惠，
      // 后面的去重、单位价格、历史价格和推荐排序逻辑照常执行。
      if (demo) {
        foundByKey.set(store.sourceKey, {
          sourceKey: store.sourceKey,
          status: "ok",
          message: "演示数据（未配置 OPENAI_API_KEY）",
          deals: demoDeals(store.sourceKey, timeZone).map((deal) => ({ ...deal, sourceUrl: store.flyerUrl })),
        });
        continue;
      }
      if (store.sourceKey !== "pricesmart-lougheed") {
        fallbackStores.push(store);
        continue;
      }
      try {
        const directDeals = selectDeals(await fetchPriceSmartDeals(today, timeZone), lowInventory.results);
        foundByKey.set(store.sourceKey, {
          sourceKey: store.sourceKey,
          status: directDeals.length ? "ok" : "unavailable",
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
          message: safeMessage("flyers.sync", error, "PriceSmart 官方页面读取失败"),
          deals: [],
        });
      }
    }

    const fallback = await searchFallback(fallbackStores, lowInventory.results, today, openAI);
    for (const [key, value] of fallback) foundByKey.set(key, value);

    await env.DB.prepare("DELETE FROM flyer_deals WHERE source = 'auto' AND valid_to < ?").bind(today).run();
    let imported = 0;
    const summaries: Array<{ store: string; status: string; imported: number; message: string }> = [];

    for (const store of stores.results) {
      const found = foundByKey.get(store.sourceKey);
      const deals = (found?.deals ?? [])
        .map((deal) => cleanDeal(deal, today, store.flyerUrl))
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
          const confidence =
            store.sourceKey === "pricesmart-lougheed"
              ? "confirmed"
              : found?.status === "ok"
                ? "high"
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
