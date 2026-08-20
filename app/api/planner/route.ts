import { env } from "cloudflare:workers";
import { once } from "../_shared/once";
import { normalizeFlyerName } from "../../flyerRecommendations";
import { defaultLocation, ensureInventorySchema } from "../_shared/inventory";
import { seedDemoPlanner } from "../_shared/demo";

const lougheedStores = {
  "hmart-coquitlam": {
    id: "store-hmart-coquitlam",
    name: "H Mart Coquitlam",
    address: "#100 - 329 North Rd, Coquitlam, BC V3K 3V8",
    flyerUrl: "https://hmart.ca/index.php?pn=flyer",
    flyerFormat: "pdf",
  },
  "pricesmart-lougheed": {
    id: "store-pricesmart-lougheed",
    name: "PriceSmart Foods Lougheed",
    address: "9899 Austin Rd, Burnaby, BC V3J 1N4",
    flyerUrl: "https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials",
    flyerFormat: "catalog",
  },
  "walmart-lougheed": {
    id: "store-walmart-lougheed",
    name: "Walmart Supercentre Lougheed",
    address: "9855 Austin Rd, Burnaby, BC V3J 1N5",
    flyerUrl: "https://www.walmart.ca/en/flyer",
    flyerFormat: "dynamic",
  },
} as const;

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

function todayDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const ensurePlannerSchema = once(async () => {
  const statements = [
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS household_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      city TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      food_budget REAL NOT NULL DEFAULT 0,
      household_budget REAL NOT NULL DEFAULT 0,
      max_stores INTEGER NOT NULL DEFAULT 2,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      flyer_url TEXT NOT NULL DEFAULT '',
      flyer_format TEXT NOT NULL DEFAULT 'manual',
      last_synced_at TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_deals (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '其他',
      price REAL NOT NULL,
      regular_price REAL,
      unit TEXT NOT NULL DEFAULT '件',
      valid_from TEXT NOT NULL,
      valid_to TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_sync_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      next_sync_at TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'never',
      last_message TEXT NOT NULL DEFAULT '尚未自动同步',
      deals_imported INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_deal_metadata (
      deal_id TEXT PRIMARY KEY,
      item_key TEXT NOT NULL DEFAULT '',
      package_quantity REAL,
      package_unit TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium',
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_saved INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_price_history (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_name TEXT NOT NULL,
      price REAL NOT NULL,
      regular_price REAL,
      unit TEXT NOT NULL DEFAULT '件',
      package_quantity REAL,
      package_unit TEXT NOT NULL DEFAULT '',
      valid_from TEXT NOT NULL,
      valid_to TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_match_rules (
      id TEXT PRIMARY KEY,
      inventory_name TEXT NOT NULL,
      deal_pattern TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      match_kind TEXT NOT NULL DEFAULT 'substitute',
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS flyer_recommendation_feedback (
      id TEXT PRIMARY KEY,
      deal_id TEXT,
      item_pattern TEXT NOT NULL DEFAULT '',
      store_id TEXT,
      action TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shopping_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT '件',
      category TEXT NOT NULL DEFAULT '其他',
      checked INTEGER NOT NULL DEFAULT 0,
      stocked INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_flyer_deals_valid_to ON flyer_deals(valid_to)"),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_flyer_deals_store_source ON flyer_deals(store_id, source)",
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_stores_source_key ON stores(source_key)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_shopping_items_checked ON shopping_items(checked)"),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_flyer_price_history_item_store ON flyer_price_history(item_key, store_id, observed_at)",
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_flyer_price_history_deal ON flyer_price_history(deal_id)"),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_flyer_match_rules_pattern ON flyer_match_rules(deal_pattern, active)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_flyer_feedback_action_pattern ON flyer_recommendation_feedback(action, item_pattern)",
    ),
  ];
  await env.DB.batch(statements);

  // 「已买」和「已入库」是两回事，stocked 是后加的列。
  const columns = await env.DB.prepare("PRAGMA table_info(shopping_items)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "stocked")) {
    await env.DB.prepare("ALTER TABLE shopping_items ADD COLUMN stocked INTEGER NOT NULL DEFAULT 0").run();
  }
});

export async function GET() {
  try {
    await ensurePlannerSchema();
    // 预算对账要读 purchase_records，那张表归库存 schema 管。
    await ensureInventorySchema();
    // 演示模式下预置两家收藏门店和一份预算，让推荐和采购方案有数据可算。
    await seedDemoPlanner();
    const settings = await env.DB.prepare(
      `SELECT id, city, postal_code AS postalCode,
      food_budget AS foodBudget, household_budget AS householdBudget,
      max_stores AS maxStores, updated_at AS updatedAt
      FROM household_settings WHERE id = 1`,
    ).first();
    const stores = await env.DB.prepare(
      `SELECT id, name, address, source_key AS sourceKey,
      flyer_url AS flyerUrl, flyer_format AS flyerFormat, last_synced_at AS lastSyncedAt,
      is_favorite AS isFavorite,
      created_at AS createdAt FROM stores ORDER BY created_at ASC`,
    ).all();
    const deals = await env.DB.prepare(
      `SELECT flyer_deals.id, flyer_deals.store_id AS storeId, flyer_deals.item_name AS itemName,
      flyer_deals.category, flyer_deals.price, flyer_deals.regular_price AS regularPrice, flyer_deals.unit,
      flyer_deals.valid_from AS validFrom, flyer_deals.valid_to AS validTo, flyer_deals.source,
      flyer_deals.source_url AS sourceUrl, flyer_deals.created_at AS createdAt,
      metadata.package_quantity AS packageQuantity, metadata.package_unit AS packageUnit,
      metadata.confidence, metadata.verified_at AS verifiedAt, metadata.is_saved AS isSaved,
      CASE WHEN metadata.hidden = 1 OR EXISTS (
        SELECT 1 FROM flyer_recommendation_feedback feedback
        WHERE feedback.action = 'suppress' AND feedback.item_pattern = metadata.item_key
      ) THEN 1 ELSE 0 END AS hidden,
      MIN(history.price) AS lowestPrice, AVG(history.price) AS averagePrice, COUNT(history.id) AS priceObservations
      FROM flyer_deals
      LEFT JOIN flyer_deal_metadata metadata ON metadata.deal_id = flyer_deals.id
      LEFT JOIN flyer_price_history history ON history.item_key = metadata.item_key AND history.store_id = flyer_deals.store_id
      GROUP BY flyer_deals.id
      ORDER BY flyer_deals.valid_to ASC, flyer_deals.created_at DESC`,
    ).all();
    const syncSettings = await env.DB.prepare(
      `SELECT enabled, interval_hours AS intervalHours,
      next_sync_at AS nextSyncAt, last_started_at AS lastStartedAt, last_completed_at AS lastCompletedAt,
      last_status AS lastStatus, last_message AS lastMessage, deals_imported AS dealsImported
      FROM flyer_sync_settings WHERE id = 1`,
    ).first();
    const shopping = await env.DB.prepare(
      `SELECT id, name, quantity, unit, category,
      checked, stocked, source, created_at AS createdAt
      FROM shopping_items ORDER BY checked ASC, created_at DESC`,
    ).all();
    // 本周实际花费。预算原本只用来筛推荐，从没和真实支出比较过。
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6);
    const since = weekStart.toISOString().slice(0, 10);
    const spendRows = await env.DB.prepare(
      `SELECT category, COALESCE(SUM(line_total), 0) AS total
       FROM purchase_records WHERE purchase_date >= ? GROUP BY category`,
    )
      .bind(since)
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
      FROM flyer_match_rules ORDER BY updated_at DESC`,
    ).all();

    return Response.json({
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
    return Response.json(
      { error: error instanceof Error ? error.message : "采购计划暂时无法读取" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const type = cleanText(payload.type);
    await ensurePlannerSchema();

    if (type === "settings") {
      const city = cleanText(payload.city);
      const postalCode = cleanText(payload.postalCode, "", 20).toUpperCase();
      const foodBudget = cleanNumber(payload.foodBudget);
      const householdBudget = cleanNumber(payload.householdBudget);
      const maxStores = Math.min(5, Math.max(1, Math.round(cleanNumber(payload.maxStores, 2))));
      await env.DB.prepare(
        `INSERT INTO household_settings
        (id, city, postal_code, food_budget, household_budget, max_stores, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET city = excluded.city, postal_code = excluded.postal_code,
        food_budget = excluded.food_budget, household_budget = excluded.household_budget,
        max_stores = excluded.max_stores, updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(city, postalCode, foodBudget, householdBudget, maxStores)
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
      const store = { id: crypto.randomUUID(), name, address: cleanText(payload.address, "", 200) };
      await env.DB.prepare("INSERT INTO stores (id, name, address) VALUES (?, ?, ?)")
        .bind(store.id, store.name, store.address)
        .run();
      return Response.json({ store }, { status: 201 });
    }

    if (type === "storePreset") {
      const sourceKey = cleanText(payload.sourceKey) as keyof typeof lougheedStores;
      const preset = lougheedStores[sourceKey];
      if (!preset) return Response.json({ error: "没有找到这家预设门店" }, { status: 400 });
      await env.DB.prepare(
        `INSERT INTO stores
        (id, name, address, source_key, flyer_url, flyer_format)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address,
        source_key = excluded.source_key, flyer_url = excluded.flyer_url,
        flyer_format = excluded.flyer_format, is_favorite = 1`,
      )
        .bind(preset.id, preset.name, preset.address, sourceKey, preset.flyerUrl, preset.flyerFormat)
        .run();
      return Response.json({ store: { ...preset, sourceKey } }, { status: 201 });
    }

    if (type === "deal") {
      const itemName = cleanText(payload.itemName);
      const storeId = cleanText(payload.storeId);
      const validFrom = cleanText(payload.validFrom);
      const validTo = cleanText(payload.validTo);
      const price = cleanNumber(payload.price);
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
          (id, store_id, item_name, category, price, regular_price, unit, valid_from, valid_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          deal.id,
          deal.storeId,
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
          (id, deal_id, store_id, item_key, item_name, price, regular_price, unit, package_quantity, package_unit, valid_from, valid_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `history-${deal.id}`,
          deal.id,
          deal.storeId,
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
        `SELECT flyer_deals.id, flyer_deals.item_name AS itemName, flyer_deals.store_id AS storeId,
        COALESCE(metadata.item_key, '') AS itemKey FROM flyer_deals
        LEFT JOIN flyer_deal_metadata metadata ON metadata.deal_id = flyer_deals.id WHERE flyer_deals.id = ?`,
      )
        .bind(dealId)
        .first<{ id: string; itemName: string; storeId: string; itemKey: string }>();
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
        (id, deal_id, item_pattern, store_id, action, note) VALUES (?, ?, ?, ?, 'suppress', ?)`,
        )
          .bind(
            crypto.randomUUID(),
            dealId,
            itemKey,
            deal.storeId,
            cleanText(payload.note, "不再推荐此类商品", 200),
          )
          .run();
      if (action === "restore")
        await env.DB.prepare(
          "DELETE FROM flyer_recommendation_feedback WHERE action = 'suppress' AND item_pattern = ?",
        )
          .bind(itemKey)
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
        (id, inventory_name, deal_pattern, category, match_kind, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET inventory_name = excluded.inventory_name, deal_pattern = excluded.deal_pattern,
          category = excluded.category, match_kind = excluded.match_kind, active = excluded.active, updated_at = CURRENT_TIMESTAMP`,
      )
        .bind(
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
        `INSERT INTO shopping_items (id, name, quantity, unit, category, source)
        VALUES (?, ?, ?, ?, ?, 'manual')`,
      )
        .bind(item.id, item.name, item.quantity, item.unit, item.category)
        .run();
      return Response.json({ item }, { status: 201 });
    }

    if (type === "generateShopping") {
      const low = await env.DB.prepare(
        `SELECT name, category, unit FROM inventory_items
        WHERE level IN ('偏少', '即将用完', '已用完') OR quantity = 0`,
      ).all<{ name: string; category: string; unit: string }>();
      const existing = await env.DB.prepare(
        "SELECT lower(name) AS name FROM shopping_items WHERE checked = 0",
      ).all<{ name: string }>();
      const names = new Set(existing.results.map((row) => row.name));
      const additions = low.results.filter((row) => !names.has(row.name.toLowerCase()));
      if (additions.length) {
        await env.DB.batch(
          additions.map((row) =>
            env.DB.prepare(
              `INSERT INTO shopping_items
          (id, name, quantity, unit, category, source) VALUES (?, ?, 1, ?, ?, 'low-stock')`,
            ).bind(crypto.randomUUID(), row.name, row.unit, row.category),
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
      await ensureInventorySchema();
      const purchaseDate = cleanDate(payload.purchaseDate) ?? todayDate();
      const today = todayDate();
      // 勾选 20 件商品时，原来最坏要跑 80 次往返（逐条查清单、查合并目标、写库存、回写状态）。
      // 这里先把两类记录各查一次，再把所有写操作合并成一个 batch。
      const ids = rows.map((row) => cleanText(row.id)).filter(Boolean);
      if (!ids.length) return Response.json({ ok: true, added: 0, merged: 0, skipped: 0 });

      const shoppingRows = await env.DB.prepare(
        `SELECT id, name, quantity, unit, category
         FROM shopping_items WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
        .bind(...ids)
        .all<{ id: string; name: string; quantity: number; unit: string; category: string }>();
      const shoppingById = new Map(shoppingRows.results.map((row) => [row.id, row]));

      const mergeIds = rows
        .map((row) => (cleanText(row.mode, "new") === "merge" ? cleanText(row.mergeItemId) : ""))
        .filter(Boolean);
      const mergeTargets = new Map<string, { id: string; quantity: number }>();
      if (mergeIds.length) {
        const existingRows = await env.DB.prepare(
          `SELECT id, quantity FROM inventory_items WHERE id IN (${mergeIds.map(() => "?").join(", ")})`,
        )
          .bind(...mergeIds)
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
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            ).bind(nextQuantity, purchaseDate, today, existing.id),
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
              (id, name, category, location, precision, quantity, unit, remaining_percent, level, purchase_date, expiry_date, note, source)
              VALUES (?, ?, ?, ?, 'quantity', ?, ?, 100, '充足', ?, NULL, ?, 'shopping')`,
            ).bind(
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
          env.DB.prepare("UPDATE shopping_items SET checked = 1, stocked = 1 WHERE id = ?").bind(id),
        );
      }

      if (writes.length) await env.DB.batch(writes);

      return Response.json({ ok: true, added, merged, skipped });
    }

    return Response.json({ error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "采购计划暂时无法保存" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as { type?: string; id?: string; checked?: boolean };
    if (payload.type !== "shopping" || !payload.id)
      return Response.json({ error: "无效操作" }, { status: 400 });
    await ensurePlannerSchema();
    await env.DB.prepare("UPDATE shopping_items SET checked = ? WHERE id = ?")
      .bind(payload.checked ? 1 : 0, payload.id)
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "采购状态暂时无法更新" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const id = url.searchParams.get("id")?.trim();
    if (!id || !["store", "deal", "shopping"].includes(type ?? ""))
      return Response.json({ error: "无效操作" }, { status: 400 });
    await ensurePlannerSchema();
    if (type === "store") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM flyer_deals WHERE store_id = ?").bind(id),
        env.DB.prepare("DELETE FROM stores WHERE id = ?").bind(id),
      ]);
    } else if (type === "deal") await env.DB.prepare("DELETE FROM flyer_deals WHERE id = ?").bind(id).run();
    else await env.DB.prepare("DELETE FROM shopping_items WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "内容暂时无法删除" },
      { status: 500 },
    );
  }
}
