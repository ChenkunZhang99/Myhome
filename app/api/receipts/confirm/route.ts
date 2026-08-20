import { env } from "cloudflare:workers";
import { ensureSchema } from "../../_shared/schema";
import { defaultLocation } from "../../_shared/inventory";

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
];
type ConfirmItem = {
  name?: string;
  quantity?: number;
  unit?: string;
  category?: string;
  action?: "new" | "merge";
  mergeItemId?: string;
  unitPrice?: number | null;
  regularUnitPrice?: number | null;
  lineTotal?: number | null;
};

/** 价格只接受正数；0 和负数当作没读出来。 */
function price(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function text(value: unknown, fallback = "", max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

/** 当天累计花费，确认后直接回给前端做预算提示。 */
async function sumSpent(date: string) {
  if (!date) return 0;
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(line_total), 0) AS total FROM purchase_records WHERE purchase_date = ?",
  )
    .bind(date)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      store?: string;
      purchaseDate?: string;
      items?: ConfirmItem[];
    };
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 80) : [];
    if (!items.length) return Response.json({ error: "没有需要加入库存的商品" }, { status: 400 });
    await ensureSchema();
    const store = text(payload.store, "未知商店");
    const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(text(payload.purchaseDate))
      ? text(payload.purchaseDate)
      : null;

    // 一张小票十几项，逐条 SELECT 再逐条写就是三十多次网络往返。
    // 先把要合并的目标一次查全，再把所有写操作放进一个 batch。
    const mergeIds = items
      .filter((raw) => raw.action === "merge" && text(raw.mergeItemId))
      .map((raw) => text(raw.mergeItemId));
    const existingById = new Map<string, { id: string; quantity: number; level: string }>();
    if (mergeIds.length) {
      const placeholders = mergeIds.map(() => "?").join(", ");
      const rows = await env.DB.prepare(
        `SELECT id, quantity, level FROM inventory_items WHERE id IN (${placeholders})`,
      )
        .bind(...mergeIds)
        .all<{ id: string; quantity: number; level: string }>();
      for (const row of rows.results) existingById.set(row.id, row);
    }

    const writes = [];
    const purchases: D1PreparedStatement[] = [];
    let added = 0,
      merged = 0;

    // 每一行都记一笔花费，预算才能和真实支出比较，也才能回答「上次买这个多少钱」。
    function recordPurchase(
      inventoryId: string,
      itemName: string,
      itemCategory: string,
      itemQuantity: number,
      itemUnit: string,
      raw: ConfirmItem,
    ) {
      const unitPrice = price(raw.unitPrice);
      const lineTotal = price(raw.lineTotal) ?? (unitPrice ? unitPrice * itemQuantity : null);
      if (!unitPrice && !lineTotal) return; // 没读出价格就不记，免得留一堆 0
      purchases.push(
        env.DB.prepare(
          `INSERT INTO purchase_records
          (id, inventory_id, name, category, quantity, unit, unit_price, regular_unit_price, line_total, store, purchase_date, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt')`,
        ).bind(
          crypto.randomUUID(),
          inventoryId,
          itemName,
          itemCategory,
          itemQuantity,
          itemUnit,
          unitPrice ?? 0,
          price(raw.regularUnitPrice),
          Math.round((lineTotal ?? 0) * 100) / 100,
          store,
          purchaseDate ?? new Date().toISOString().slice(0, 10),
        ),
      );
    }

    for (const raw of items) {
      const name = text(raw.name);
      if (!name) continue;
      const quantity = Number.isFinite(raw.quantity) ? Math.max(0.01, Number(raw.quantity)) : 1;
      const unit = text(raw.unit, "件");
      const category = categories.includes(text(raw.category)) ? text(raw.category) : "其他";
      const existing =
        raw.action === "merge" && text(raw.mergeItemId) ? existingById.get(text(raw.mergeItemId)) : undefined;

      if (existing) {
        const nextQuantity = Number(existing.quantity) + quantity;
        const nextLevel =
          existing.level === "已用完" || Number(existing.quantity) <= 0 ? "充足" : existing.level;
        writes.push(
          env.DB.prepare(
            `UPDATE inventory_items SET quantity = ?, level = ?,
            remaining_percent = CASE WHEN remaining_percent <= 0 THEN 100 ELSE remaining_percent END,
            purchase_date = COALESCE(?, purchase_date),
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(nextQuantity, nextLevel, purchaseDate, existing.id),
        );
        // 同一张小票里有两行合并到同一物品时，第二行要接着第一行的数量继续加。
        existingById.set(existing.id, { ...existing, quantity: nextQuantity, level: nextLevel });
        recordPurchase(existing.id, name, category, quantity, unit, raw);
        merged += 1;
        continue;
      }

      const newId = crypto.randomUUID();
      recordPurchase(newId, name, category, quantity, unit, raw);
      writes.push(
        env.DB.prepare(
          `INSERT INTO inventory_items
          (id, name, category, location, precision, quantity, unit, level, purchase_date, expiry_date, note, source)
          VALUES (?, ?, ?, ?, 'quantity', ?, ?, '充足', ?, NULL, ?, 'receipt')`,
        ).bind(
          newId,
          name,
          category,
          defaultLocation(category),
          quantity,
          unit,
          purchaseDate,
          `${store} 小票自动录入`,
        ),
      );
      added += 1;
    }

    if (writes.length) await env.DB.batch(writes);
    if (purchases.length) await env.DB.batch(purchases);
    const spent = Math.round(purchases.length ? (await sumSpent(purchaseDate ?? "")) * 100 : 0) / 100;
    return Response.json({ ok: true, added, merged, recorded: purchases.length, spent });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "小票商品暂时无法保存" },
      { status: 500 },
    );
  }
}
