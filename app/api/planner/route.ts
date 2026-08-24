import { env } from "cloudflare:workers";
import { flyerSourceByKey, manualSourceKey } from "../_shared/flyerSources";
import { getSharedOpenAIConfig } from "../_shared/openai";
import { areaOf, discoverStores, storesInArea } from "../_shared/storeDiscovery";
import { resolveHousehold } from "../_shared/household";
import { failure, withRoute } from "../_shared/observability";
import { householdTimeZone } from "../_shared/household";
import { dayIn, resolveTimeZone } from "../../dateTime";
import { ensureSchema } from "../_shared/schema";
import { normalizeFlyerName } from "../../flyerRecommendations";
import { defaultLocation } from "../_shared/inventory";
import { seedDemoPlanner } from "../_shared/demo";

function cleanText(value: unknown, fallback = "", max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function cleanNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function cleanDate(value: unknown) {
  const date = cleanText(value, "", 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

async function todayDate(householdId: string) {
  return dayIn(await householdTimeZone(householdId));
}

export const GET = withRoute("planner", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    await ensureSchema();
    // 预算对账要读 purchase_records，那张表归库存 schema 管。
    await ensureSchema();
    // 演示模式下预置两家收藏门店和一份预算，让推荐和采购方案有数据可算。
    await seedDemoPlanner();
    const settings = await env.DB.prepare(
      `SELECT id, city, postal_code AS postalCode,
      food_budget AS foodBudget, household_budget AS householdBudget,
      max_stores AS maxStores, timezone, updated_at AS updatedAt
      FROM household_settings WHERE household_id = ?`,
    )
      .bind(household)
      .first();
    const stores = await env.DB.prepare(
      `SELECT household_stores.id, household_stores.name, household_stores.address,
      household_stores.source_key AS sourceKey, household_stores.is_favorite AS isFavorite,
      household_stores.created_at AS createdAt,
      flyer_sources.flyer_url AS flyerUrl, flyer_sources.flyer_format AS flyerFormat,
      flyer_sources.last_synced_at AS lastSyncedAt
      FROM household_stores
      LEFT JOIN flyer_sources ON flyer_sources.source_key = household_stores.source_key
      WHERE household_stores.household_id = ? ORDER BY household_stores.created_at ASC`,
    )
      .bind(household)
      .all();
    const deals = await env.DB.prepare(
      `SELECT flyer_deals.id, flyer_deals.source_key AS sourceKey, household_stores.id AS storeId,
      flyer_deals.item_name AS itemName,
      flyer_deals.category, flyer_deals.price, flyer_deals.regular_price AS regularPrice, flyer_deals.unit,
      flyer_deals.valid_from AS validFrom, flyer_deals.valid_to AS validTo, flyer_deals.source,
      flyer_deals.source_url AS sourceUrl, flyer_deals.created_at AS createdAt,
      metadata.package_quantity AS packageQuantity, metadata.package_unit AS packageUnit,
      metadata.confidence, metadata.verified_at AS verifiedAt, metadata.is_saved AS isSaved,
      CASE WHEN metadata.hidden = 1 OR EXISTS (
        SELECT 1 FROM flyer_recommendation_feedback feedback
        WHERE feedback.household_id = ?1 AND feedback.action = 'suppress'
          AND feedback.item_pattern = metadata.item_key
      ) THEN 1 ELSE 0 END AS hidden,
      MIN(history.price) AS lowestPrice, AVG(history.price) AS averagePrice, COUNT(history.id) AS priceObservations
      FROM flyer_deals
      JOIN household_stores ON household_stores.source_key = flyer_deals.source_key
        AND household_stores.household_id = ?1
      LEFT JOIN flyer_deal_metadata metadata ON metadata.deal_id = flyer_deals.id
      LEFT JOIN flyer_price_history history ON history.item_key = metadata.item_key
        AND history.source_key = flyer_deals.source_key
      WHERE flyer_deals.valid_to >= ?2
      GROUP BY flyer_deals.id
      ORDER BY flyer_deals.valid_to ASC, flyer_deals.created_at DESC`,
    )
      .bind(household, await todayDate(household))
      .all();
    const syncSettings = await env.DB.prepare(
      `SELECT enabled, interval_hours AS intervalHours,
      next_sync_at AS nextSyncAt, last_started_at AS lastStartedAt, last_completed_at AS lastCompletedAt,
      last_status AS lastStatus, last_message AS lastMessage, deals_imported AS dealsImported
      FROM flyer_sync_settings WHERE id = 1`,
    ).first();
    const shopping = await env.DB.prepare(
      `SELECT id, name, quantity, unit, category,
      checked, stocked, source, created_at AS createdAt
      FROM shopping_items WHERE household_id = ? ORDER BY checked ASC, created_at DESC`,
    )
      .bind(household)
      .all();
    // 本周实际花费。预算原本只用来筛推荐，从没和真实支出比较过。
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6);
    const since = weekStart.toISOString().slice(0, 10);
    const spendRows = await env.DB.prepare(
      `SELECT category, COALESCE(SUM(line_total), 0) AS total
       FROM purchase_records WHERE household_id = ? AND purchase_date >= ? GROUP BY category`,
    )
      .bind(household, since)
      .all<{ category: string; total: number }>();
    const foodCategories = new Set([
      "蔬菜水果",
      "肉类海鲜",
      "乳品蛋类",
      "米面粮油",
      "调味品",
      "冷冻食品",
      "零食饮料",
    ]);
    let foodSpent = 0,
      householdSpent = 0;
    for (const row of spendRows.results) {
      if (foodCategories.has(row.category)) foodSpent += Number(row.total);
      else householdSpent += Number(row.total);
    }

    const matchRules = await env.DB.prepare(
      `SELECT id, inventory_name AS inventoryName, deal_pattern AS dealPattern,
      category, match_kind AS matchKind, active, updated_at AS updatedAt
      FROM flyer_match_rules WHERE household_id = ? ORDER BY updated_at DESC`,
    )
      .bind(household)
      .all();

    // 这一户填过的邮编所在片区，目录里已经有哪些店。目录是全局的，
    // 所以同一片区的第二个人打开就有得选，不用再搜一次。
    const area = areaOf(String((settings as { postalCode?: string } | null)?.postalCode ?? ""));
    const nearby = await storesInArea(area);

    return Response.json({
      area,
      nearby,
      settings: settings ?? {
        id: 1,
        city: "",
        postalCode: "",
        foodBudget: 0,
        householdBudget: 0,
        maxStores: 2,
      },
      stores: stores.results,
      deals: deals.results,
      syncSettings: syncSettings ?? {
        enabled: 1,
        intervalHours: 24,
        nextSyncAt: null,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastStatus: "never",
        lastMessage: "尚未自动同步",
        dealsImported: 0,
      },
      shopping: shopping.results,
      matchRules: matchRules.results,
      spending: {
        since,
        food: Math.round(foodSpent * 100) / 100,
        household: Math.round(householdSpent * 100) / 100,
      },
    });
  } catch (error) {
    return failure("planner", error, "采购计划暂时无法读取", 500);
  }
});

export const POST = withRoute("planner", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const type = cleanText(payload.type);
    await ensureSchema();

    if (type === "settings") {
      const city = cleanText(payload.city);
      const postalCode = cleanText(payload.postalCode, "", 20).toUpperCase();
      const foodBudget = cleanNumber(payload.foodBudget);
      const householdBudget = cleanNumber(payload.householdBudget);
      const maxStores = Math.min(5, Math.max(1, Math.round(cleanNumber(payload.maxStores, 2))));
      const timezone = resolveTimeZone(payload.timezone);
      await env.DB.prepare(
        `INSERT INTO household_settings
        (household_id, city, postal_code, food_budget, household_budget, max_stores, timezone, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(household_id) DO UPDATE SET city = excluded.city, postal_code = excluded.postal_code,
        food_budget = excluded.food_budget, household_budget = excluded.household_budget,
        max_stores = excluded.max_stores, timezone = excluded.timezone, updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(household, city, postalCode, foodBudget, householdBudget, maxStores, timezone)
        .run();
      return Response.json({ ok: true });
    }

    if (type === "flyerSyncSettings") {
      const enabled = payload.enabled === false || payload.enabled === 0 ? 0 : 1;
      const intervalHours = Math.min(168, Math.max(6, Math.round(cleanNumber(payload.intervalHours, 24))));
      await env.DB.prepare(
        `INSERT INTO flyer_sync_settings (id, enabled, interval_hours, next_sync_at, updated_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, interval_hours = excluded.interval_hours,
        next_sync_at = CASE WHEN flyer_sync_settings.enabled != excluded.enabled OR flyer_sync_settings.interval_hours != excluded.interval_hours
          THEN CURRENT_TIMESTAMP ELSE flyer_sync_settings.next_sync_at END, updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(enabled, intervalHours)
        .run();
      return Response.json({ ok: true });
    }

    if (type === "store") {
      const name = cleanText(payload.name);
      if (!name) return Response.json({ error: "请填写超市名称" }, { status: 400 });
      // 手工门店也占一条来源，只是没有别人订阅，也不参与自动同步。
      const sourceKey = manualSourceKey();
      const store = {
        id: crypto.randomUUID(),
        name,
        address: cleanText(payload.address, "", 200),
        sourceKey,
      };
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO flyer_sources (source_key, name, address, flyer_format) VALUES (?, ?, ?, 'manual')",
        ).bind(sourceKey, store.name, store.address),
        env.DB.prepare(
          "INSERT INTO household_stores (id, household_id, source_key, name, address) VALUES (?, ?, ?, ?, ?)",
        ).bind(store.id, household, sourceKey, store.name, store.address),
      ]);
      return Response.json({ store }, { status: 201 });
    }

    /**
     * 按邮编搜附近的超市。
     *
     * 结果并进全局目录并按片区索引：同一个片区的下一个人直接命中缓存，
     * 一个 token 都不花。这也是「一份 flyer 解析一次供所有住户共用」的延伸。
     *
     * 搜出来只是候选，要用户自己挑了才会进他家的收藏——模型会编店，
     * 这一步的确认交给人，比在服务端逐个 fetch 验证更靠谱也更省。
     */
    if (type === "discoverStores") {
      const postalCode = cleanText(payload.postalCode, "", 20).toUpperCase();
      const result = await discoverStores(
        postalCode,
        await getSharedOpenAIConfig(request, household),
        household,
      );
      return Response.json(result);
    }

    if (type === "storePreset") {
      const sourceKey = cleanText(payload.sourceKey);
      // 代码里写死的那三家，和按邮编搜出来进了目录的，都算数。
      // 只认写死的那份就等于搜出来的店永远收藏不了。
      const preset =
        flyerSourceByKey.get(sourceKey) ??
        (await env.DB.prepare("SELECT name, address FROM flyer_sources WHERE source_key = ?")
          .bind(sourceKey)
          .first<{ name: string; address: string }>());
      if (!preset) return Response.json({ error: "门店目录里没有这一家" }, { status: 400 });
      // 目录是全局的，这里只是这一户订阅它。
      await env.DB.prepare(
        `INSERT INTO household_stores (id, household_id, source_key, name, address, is_favorite)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(household_id, source_key) DO UPDATE SET name = excluded.name,
        address = excluded.address, is_favorite = 1`,
      )
        .bind(crypto.randomUUID(), household, sourceKey, preset.name, preset.address)
        .run();
      return Response.json({ store: { ...preset, sourceKey } }, { status: 201 });
    }

    if (type === "deal") {
      const itemName = cleanText(payload.itemName);
      const storeId = cleanText(payload.storeId);
      // 优惠挂在来源上，前端给的是这一户的订阅行，先换成来源标识。
      const owner = storeId
        ? await env.DB.prepare(
            "SELECT source_key AS sourceKey FROM household_stores WHERE household_id = ? AND id = ?",
          )
            .bind(household, storeId)
            .first<{ sourceKey: string }>()
        : null;
      const validFrom = cleanText(payload.validFrom);
      const validTo = cleanText(payload.validTo);
      const price = cleanNumber(payload.price);
      if (!owner) return Response.json({ error: "找不到这家门店" }, { status: 404 });
      if (!itemName || !storeId || !validFrom || !validTo || price <= 0) {
        return Response.json({ error: "请完整填写优惠商品、门店、价格和有效日期" }, { status: 400 });
      }
      if (validFrom > validTo)
        return Response.json({ error: "优惠结束日期不能早于开始日期" }, { status: 400 });
      const deal = {
        id: crypto.randomUUID(),
        storeId,
        itemName,
        category: cleanText(payload.category, "其他"),
        price,
        regularPrice: payload.regularPrice ? cleanNumber(payload.regularPrice) : null,
        unit: cleanText(payload.unit, "件"),
        validFrom,
        validTo,
        packageQuantity: payload.packageQuantity ? cleanNumber(payload.packageQuantity) : null,
        packageUnit: cleanText(payload.packageUnit, ""),
      };
      const itemKey = normalizeFlyerName(deal.itemName);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO flyer_deals
          (id, source_key, item_name, category, price, regular_price, unit, valid_from, valid_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          deal.id,
          owner.sourceKey,
          deal.itemName,
          deal.category,
          deal.price,
          deal.regularPrice,
          deal.unit,
          deal.validFrom,
          deal.validTo,
        ),
        env.DB.prepare(
          `INSERT INTO flyer_deal_metadata
          (deal_id, item_key, package_quantity, package_unit, confidence, verified_at)
          VALUES (?, ?, ?, ?, 'confirmed', CURRENT_TIMESTAMP)`,
        ).bind(deal.id, itemKey, deal.packageQuantity, deal.packageUnit),
        env.DB.prepare(
          `INSERT OR IGNORE INTO flyer_price_history
          (id, deal_id, source_key, item_key, item_name, price, regular_price, unit, package_quantity, package_unit, valid_from, valid_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `history-${deal.id}`,
          deal.id,
          owner.sourceKey,
          itemKey,
          deal.itemName,
          deal.price,
          deal.regularPrice,
          deal.unit,
          deal.packageQuantity,
          deal.packageUnit,
          deal.validFrom,
          deal.validTo,
        ),
      ]);
      return Response.json({ deal }, { status: 201 });
    }

    if (type === "dealPreference") {
      const dealId = cleanText(payload.dealId);
      const action = cleanText(payload.action);
      if (!dealId || !["save", "unsave", "ignore", "restore", "suppress"].includes(action))
        return Response.json({ error: "无效的优惠操作" }, { status: 400 });
      const deal = await env.DB.prepare(
        `SELECT flyer_deals.id, flyer_deals.item_name AS itemName, flyer_deals.source_key AS sourceKey,
        COALESCE(metadata.item_key, '') AS itemKey FROM flyer_deals
        LEFT JOIN flyer_deal_metadata metadata ON metadata.deal_id = flyer_deals.id WHERE flyer_deals.id = ?`,
      )
        .bind(dealId)
        .first<{ id: string; itemName: string; sourceKey: string; itemKey: string }>();
      if (!deal) return Response.json({ error: "优惠不存在" }, { status: 404 });
      const itemKey = deal.itemKey || normalizeFlyerName(deal.itemName);
      await env.DB.prepare(
        `INSERT INTO flyer_deal_metadata (deal_id, item_key, is_saved, hidden, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(deal_id) DO UPDATE SET item_key = excluded.item_key,
          is_saved = CASE WHEN ? IN ('save','unsave') THEN excluded.is_saved ELSE flyer_deal_metadata.is_saved END,
          hidden = CASE WHEN ? IN ('ignore','restore') THEN excluded.hidden ELSE flyer_deal_metadata.hidden END,
          updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(dealId, itemKey, action === "save" ? 1 : 0, action === "ignore" ? 1 : 0, action, action)
        .run();
      if (action === "suppress")
        await env.DB.prepare(
          `INSERT INTO flyer_recommendation_feedback
        (id, deal_id, item_pattern, source_key, household_id, action, note) VALUES (?, ?, ?, ?, ?, 'suppress', ?)`,
        )
          .bind(
            crypto.randomUUID(),
            dealId,
            itemKey,
            deal.sourceKey,
            household,
            cleanText(payload.note, "不再推荐此类商品", 200),
          )
          .run();
      if (action === "restore")
        await env.DB.prepare(
          "DELETE FROM flyer_recommendation_feedback WHERE household_id = ? AND action = 'suppress' AND item_pattern = ?",
        )
          .bind(household, itemKey)
          .run();
      return Response.json({ ok: true });
    }

    if (type === "matchRule") {
      const id = cleanText(payload.id) || crypto.randomUUID();
      const inventoryName = cleanText(payload.inventoryName);
      const dealPattern = cleanText(payload.dealPattern);
      const matchKind = cleanText(payload.matchKind, "substitute");
      if (!inventoryName || !dealPattern || !["targeted", "substitute", "category"].includes(matchKind))
        return Response.json({ error: "请完整填写匹配规则" }, { status: 400 });
      await env.DB.prepare(
        `INSERT INTO flyer_match_rules
        (household_id, id, inventory_name, deal_pattern, category, match_kind, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET inventory_name = excluded.inventory_name, deal_pattern = excluded.deal_pattern,
          category = excluded.category, match_kind = excluded.match_kind, active = excluded.active, updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(
          household,
          id,
          inventoryName,
          dealPattern,
          cleanText(payload.category),
          matchKind,
          payload.active === false ? 0 : 1,
        )
        .run();
      return Response.json({ ok: true, id });
    }

    if (type === "shopping") {
      const name = cleanText(payload.name);
      if (!name) return Response.json({ error: "请填写采购物品" }, { status: 400 });
      const item = {
        id: crypto.randomUUID(),
        name,
        quantity: cleanNumber(payload.quantity, 1) || 1,
        unit: cleanText(payload.unit, "件"),
        category: cleanText(payload.category, "其他"),
      };
      await env.DB.prepare(
        `INSERT INTO shopping_items (household_id, id, name, quantity, unit, category, source)
        VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
      )
        .bind(household, item.id, item.name, item.quantity, item.unit, item.category)
        .run();
      return Response.json({ item }, { status: 201 });
    }

    if (type === "generateShopping") {
      const low = await env.DB.prepare(
        `SELECT name, category, unit FROM inventory_items
        WHERE household_id = ? AND (level IN ('偏少', '即将用完', '已用完') OR quantity = 0)`,
      )
        .bind(household)
        .all<{ name: string; category: string; unit: string }>();
      const existing = await env.DB.prepare(
        "SELECT lower(name) AS name FROM shopping_items WHERE household_id = ? AND checked = 0",
      )
        .bind(household)
        .all<{ name: string }>();
      const names = new Set(existing.results.map((row) => row.name));
      const additions = low.results.filter((row) => !names.has(row.name.toLowerCase()));
      if (additions.length) {
        await env.DB.batch(
          additions.map((row) =>
            env.DB.prepare(
              `INSERT INTO shopping_items
          (household_id, id, name, quantity, unit, category, source) VALUES (?, ?, ?, 1, ?, ?, 'low-stock')`,
            ).bind(household, crypto.randomUUID(), row.name, row.unit, row.category),
          ),
        );
      }
      return Response.json({ ok: true, added: additions.length });
    }

    // 买完之后一次性把已勾选的物品写回库存，避免再走一遍小票识别。
    if (type === "restockBatch") {
      const rows = Array.isArray(payload.items)
        ? (payload.items.slice(0, 80) as Array<Record<string, unknown>>)
        : [];
      if (!rows.length) return Response.json({ error: "没有需要入库的物品" }, { status: 400 });
      await ensureSchema();
      const today = await todayDate(household);
      const purchaseDate = cleanDate(payload.purchaseDate) ?? today;
      // 勾选 20 件商品时，原来最坏要跑 80 次往返（逐条查清单、查合并目标、写库存、回写状态）。
      // 这里先把两类记录各查一次，再把所有写操作合并成一个 batch。
      const ids = rows.map((row) => cleanText(row.id)).filter(Boolean);
      if (!ids.length) return Response.json({ ok: true, added: 0, merged: 0, skipped: 0 });

      const shoppingRows = await env.DB.prepare(
        `SELECT id, name, quantity, unit, category
         FROM shopping_items WHERE household_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      )
        .bind(household, ...ids)
        .all<{ id: string; name: string; quantity: number; unit: string; category: string }>();
      const shoppingById = new Map(shoppingRows.results.map((row) => [row.id, row]));

      const mergeIds = rows
        .map((row) => (cleanText(row.mode, "new") === "merge" ? cleanText(row.mergeItemId) : ""))
        .filter(Boolean);
      const mergeTargets = new Map<string, { id: string; quantity: number }>();
      if (mergeIds.length) {
        const existingRows = await env.DB.prepare(
          `SELECT id, quantity FROM inventory_items WHERE household_id = ? AND id IN (${mergeIds.map(() => "?").join(", ")})`,
        )
          .bind(household, ...mergeIds)
          .all<{ id: string; quantity: number }>();
        for (const row of existingRows.results) mergeTargets.set(row.id, row);
      }

      const writes = [];
      let added = 0,
        merged = 0,
        skipped = 0;

      for (const row of rows) {
        const id = cleanText(row.id);
        const shoppingItem = id ? shoppingById.get(id) : undefined;
        if (!shoppingItem) continue;

        const mode = cleanText(row.mode, "new");
        if (mode === "skip") {
          skipped += 1;
          continue;
        }
        const name = cleanText(row.name, shoppingItem.name);
        const quantity = Math.max(0.01, cleanNumber(row.quantity, Number(shoppingItem.quantity) || 1) || 1);
        const unit = cleanText(row.unit, shoppingItem.unit || "件");
        const category = cleanText(row.category, shoppingItem.category || "其他");
        const mergeItemId = cleanText(row.mergeItemId);
        const existing = mode === "merge" && mergeItemId ? mergeTargets.get(mergeItemId) : undefined;

        if (mode === "merge" && mergeItemId) {
          if (!existing) {
            skipped += 1;
            continue;
          }
          const nextQuantity = Number(existing.quantity) + quantity;
          // 刚买回来的一件是完整的，所以余量回到 100%；上一件留下的过期日期不能套在新货上。
          writes.push(
            env.DB.prepare(
              `UPDATE inventory_items
              SET quantity = ?, remaining_percent = 100, level = '充足',
                purchase_date = ?,
                expiry_date = CASE WHEN expiry_date < ? THEN NULL ELSE expiry_date END,
                updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?`,
            ).bind(nextQuantity, purchaseDate, today, household, existing.id),
          );
          // 同一批里两行并入同一物品时，第二行要接着累加。
          mergeTargets.set(existing.id, { ...existing, quantity: nextQuantity });
          merged += 1;
        } else {
          if (!name) {
            skipped += 1;
            continue;
          }
          writes.push(
            env.DB.prepare(
              `INSERT INTO inventory_items
              (household_id, id, name, category, location, precision, quantity, unit, remaining_percent, level, purchase_date, expiry_date, note, source)
              VALUES (?, ?, ?, ?, ?, 'quantity', ?, ?, 100, '充足', ?, NULL, ?, 'shopping')`,
            ).bind(
              household,
              crypto.randomUUID(),
              name,
              category,
              defaultLocation(category),
              quantity,
              unit,
              purchaseDate,
              "采购清单入库",
            ),
          );
          added += 1;
        }
        writes.push(
          env.DB.prepare(
            "UPDATE shopping_items SET checked = 1, stocked = 1 WHERE household_id = ? AND id = ?",
          ).bind(household, id),
        );
      }

      if (writes.length) await env.DB.batch(writes);

      return Response.json({ ok: true, added, merged, skipped });
    }

    return Response.json({ error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    return failure("planner", error, "采购计划暂时无法保存", 500);
  }
});

export const PATCH = withRoute("planner", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const payload = (await request.json()) as { type?: string; id?: string; checked?: boolean };
    if (payload.type !== "shopping" || !payload.id)
      return Response.json({ error: "无效操作" }, { status: 400 });
    await ensureSchema();
    await env.DB.prepare("UPDATE shopping_items SET checked = ? WHERE household_id = ? AND id = ?")
      .bind(payload.checked ? 1 : 0, household, payload.id)
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return failure("planner", error, "采购状态暂时无法更新", 500);
  }
});

export const DELETE = withRoute("planner", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const id = url.searchParams.get("id")?.trim();
    if (!id || !["store", "deal", "shopping"].includes(type ?? ""))
      return Response.json({ error: "无效操作" }, { status: 400 });
    await ensureSchema();
    if (type === "store") {
      // 删的是这一户的订阅。优惠和价格历史属于全局层，别的住户可能还在用，不能跟着删。
      // 只有手工门店的私有来源没人共享，随订阅一起清掉。
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM flyer_deals WHERE source_key LIKE 'manual-%' AND source_key IN
           (SELECT source_key FROM household_stores WHERE household_id = ? AND id = ?)`,
        ).bind(household, id),
        env.DB.prepare(
          `DELETE FROM flyer_sources WHERE flyer_format = 'manual' AND source_key IN
           (SELECT source_key FROM household_stores WHERE household_id = ? AND id = ?)`,
        ).bind(household, id),
        env.DB.prepare("DELETE FROM household_stores WHERE household_id = ? AND id = ?").bind(household, id),
        env.DB.prepare("DELETE FROM flyer_deal_metadata WHERE deal_id NOT IN (SELECT id FROM flyer_deals)"),
      ]);
    } else if (type === "deal")
      await env.DB.batch([
        env.DB.prepare("DELETE FROM flyer_deal_metadata WHERE deal_id = ?").bind(id),
        env.DB.prepare("DELETE FROM flyer_deals WHERE id = ?").bind(id),
      ]);
    else
      await env.DB.prepare("DELETE FROM shopping_items WHERE household_id = ? AND id = ?")
        .bind(household, id)
        .run();
    return Response.json({ ok: true });
  } catch (error) {
    return failure("planner", error, "内容暂时无法删除", 500);
  }
});
