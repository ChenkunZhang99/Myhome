import { env } from "cloudflare:workers";
import { resolveHousehold } from "../_shared/household";
import { failure, withRoute } from "../_shared/observability";
import { ensureSchema } from "../_shared/schema";
import { seedDemoData } from "../_shared/demo";

type InventoryPayload = {
  name?: string;
  category?: string;
  location?: string;
  precision?: "simple" | "quantity" | "exact";
  quantity?: number;
  unit?: string;
  remainingPercent?: number;
  level?: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  openedDate?: string | null;
  openedShelfLifeDays?: number | null;
  note?: string;
  source?: string;
};

function cleanText(value: unknown, fallback = "", max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function resolvedLevel(quantity: number, requested: string, previous = "充足") {
  if (quantity <= 0) return "已用完";
  if (requested && requested !== "已用完") return requested;
  return previous === "已用完" ? "充足" : previous;
}

/** 开封后可用天数只接受 1–3650 的整数；填别的就当没填，交给分类默认值。 */
function cleanShelfLife(value: unknown) {
  const days = Math.round(Number(value));
  return Number.isFinite(days) && days > 0 && days <= 3650 ? days : null;
}

function clampPercent(value: unknown, fallback = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(0, Math.min(100, number))) : fallback;
}

export const GET = withRoute("inventory", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    await ensureSchema();
    // 全新克隆时灌一套演示数据，让界面不是空的（仅演示模式且库存为空时执行）。
    await seedDemoData();
    // 一次传几百行 JSON 对谁都没好处。上限可调，但必须有。
    // 注意 Number(null) 是 0 而且它是有限数，直接判 isFinite 会把「没传参数」当成 limit=0。
    const raw = new URL(request.url).searchParams.get("limit");
    const requested = raw === null ? Number.NaN : Number(raw);
    const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, requested)) : 200;
    const result = await env.DB.prepare(
      `
      SELECT id, name, category, location, precision, quantity, unit,
             remaining_percent AS remainingPercent, level,
             purchase_date AS purchaseDate, expiry_date AS expiryDate,
             opened_date AS openedDate, opened_shelf_life_days AS openedShelfLifeDays,
             note, source, created_at AS createdAt,
             updated_at AS updatedAt
      FROM inventory_items WHERE household_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `,
    )
      .bind(household, limit + 1)
      .all();
    // 多取一条用来判断还有没有更多，返回时去掉。
    const items = result.results.slice(0, limit);
    const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM inventory_items WHERE household_id = ?")
      .bind(household)
      .first<{ count: number }>();
    return Response.json({
      items,
      total: Number(total?.count ?? items.length),
      hasMore: result.results.length > limit,
    });
  } catch (error) {
    return failure("inventory", error, "库存暂时无法读取", 500);
  }
});

export const POST = withRoute("inventory", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const payload = (await request.json()) as InventoryPayload;
    const name = cleanText(payload.name);
    if (!name) {
      return Response.json({ error: "请填写物品名称" }, { status: 400 });
    }

    await ensureSchema();
    const quantity = Number.isFinite(payload.quantity) ? Math.max(0, Number(payload.quantity)) : 1;
    const remainingPercent = clampPercent(payload.remainingPercent);
    const item = {
      id: crypto.randomUUID(),
      name,
      category: cleanText(payload.category, "其他"),
      location: cleanText(payload.location, "未分类"),
      precision: ["simple", "quantity", "exact"].includes(payload.precision ?? "")
        ? payload.precision!
        : "quantity",
      quantity,
      unit: cleanText(payload.unit, "件"),
      remainingPercent,
      level: remainingPercent === 0 ? "已用完" : resolvedLevel(quantity, cleanText(payload.level, "充足")),
      purchaseDate: cleanText(payload.purchaseDate) || null,
      expiryDate: cleanText(payload.expiryDate) || null,
      openedDate: cleanText(payload.openedDate) || null,
      openedShelfLifeDays: cleanShelfLife(payload.openedShelfLifeDays),
      note: cleanText(payload.note, "", 1000),
      source: cleanText(payload.source, "manual"),
    };

    await env.DB.prepare(
      `
      INSERT INTO inventory_items
        (household_id, id, name, category, location, precision, quantity, unit, remaining_percent, level, purchase_date, expiry_date, opened_date, opened_shelf_life_days, note, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
      .bind(
        household,
        item.id,
        item.name,
        item.category,
        item.location,
        item.precision,
        item.quantity,
        item.unit,
        item.remainingPercent,
        item.level,
        item.purchaseDate,
        item.expiryDate,
        item.openedDate,
        item.openedShelfLifeDays,
        item.note,
        item.source,
      )
      .run();

    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return failure("inventory", error, "物品暂时无法保存", 500);
  }
});

export const PATCH = withRoute("inventory", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const payload = (await request.json()) as InventoryPayload & { id?: string };
    const id = cleanText(payload.id);
    if (!id) return Response.json({ error: "缺少物品编号" }, { status: 400 });

    await ensureSchema();
    const existing = await env.DB.prepare(
      `SELECT id, name, category, location, precision, quantity, unit,
      remaining_percent AS remainingPercent, level,
      purchase_date AS purchaseDate, expiry_date AS expiryDate,
      opened_date AS openedDate, opened_shelf_life_days AS openedShelfLifeDays, note, source
      FROM inventory_items WHERE household_id = ? AND id = ?`,
    )
      .bind(household, id)
      .first<InventoryPayload & { id: string; quantity: number; remainingPercent: number; level: string }>();
    if (!existing) return Response.json({ error: "物品不存在" }, { status: 404 });

    const quantity = Number.isFinite(payload.quantity)
      ? Math.max(0, Number(payload.quantity))
      : Number(existing.quantity);
    const requestedLevel =
      payload.level === undefined ? existing.level : cleanText(payload.level, existing.level);
    const remainingPercent =
      payload.remainingPercent === undefined
        ? clampPercent(existing.remainingPercent)
        : clampPercent(payload.remainingPercent);
    const item = {
      id,
      name: payload.name === undefined ? existing.name! : cleanText(payload.name),
      category: payload.category === undefined ? existing.category! : cleanText(payload.category, "其他"),
      location: payload.location === undefined ? existing.location! : cleanText(payload.location, "未分类"),
      precision:
        payload.precision === undefined
          ? existing.precision!
          : ["simple", "quantity", "exact"].includes(payload.precision)
            ? payload.precision
            : "quantity",
      quantity,
      unit: payload.unit === undefined ? existing.unit! : cleanText(payload.unit, "件"),
      remainingPercent,
      level: remainingPercent === 0 ? "已用完" : resolvedLevel(quantity, requestedLevel, existing.level),
      purchaseDate:
        payload.purchaseDate === undefined
          ? (existing.purchaseDate ?? null)
          : cleanText(payload.purchaseDate) || null,
      expiryDate:
        payload.expiryDate === undefined
          ? (existing.expiryDate ?? null)
          : cleanText(payload.expiryDate) || null,
      openedDate:
        payload.openedDate === undefined
          ? (existing.openedDate ?? null)
          : cleanText(payload.openedDate) || null,
      openedShelfLifeDays:
        payload.openedShelfLifeDays === undefined
          ? (existing.openedShelfLifeDays ?? null)
          : cleanShelfLife(payload.openedShelfLifeDays),
      note: payload.note === undefined ? (existing.note ?? "") : cleanText(payload.note, "", 1000),
      source: existing.source ?? "manual",
    };
    if (!item.name) return Response.json({ error: "请填写物品名称" }, { status: 400 });

    await env.DB.prepare(
      `
      UPDATE inventory_items
      SET name = ?, category = ?, location = ?, precision = ?, quantity = ?, unit = ?, remaining_percent = ?, level = ?,
          purchase_date = ?, expiry_date = ?, opened_date = ?, opened_shelf_life_days = ?, note = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE household_id = ? AND id = ?
    `,
    )
      .bind(
        item.name,
        item.category,
        item.location,
        item.precision,
        item.quantity,
        item.unit,
        item.remainingPercent,
        item.level,
        item.purchaseDate,
        item.expiryDate,
        item.openedDate,
        item.openedShelfLifeDays,
        item.note,
        household,
        id,
      )
      .run();

    return Response.json({ ok: true, item });
  } catch (error) {
    return failure("inventory", error, "库存暂时无法更新", 500);
  }
});

export const DELETE = withRoute("inventory", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "缺少物品编号" }, { status: 400 });
    await ensureSchema();

    // 图片的字节在 R2、元数据在库里，两边都要清。先删 R2：
    // 万一失败，库里的记录还在，重试一次就能补上；反过来则会留下无人知晓的孤儿文件，
    // 既一直计费又仍可通过 object key 访问。
    const attachments = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM inventory_attachments WHERE household_id = ? AND item_id = ?",
    )
      .bind(household, id)
      .all<{ objectKey: string }>();
    if (attachments.results.length) await env.UPLOADS.delete(attachments.results.map((row) => row.objectKey));

    await env.DB.batch([
      env.DB.prepare("DELETE FROM inventory_attachments WHERE household_id = ? AND item_id = ?").bind(
        household,
        id,
      ),
      // 采购记录是已经发生过的事实，物品删了也要留着，只断开引用。
      env.DB.prepare(
        "UPDATE purchase_records SET inventory_id = NULL WHERE household_id = ? AND inventory_id = ?",
      ).bind(household, id),
      env.DB.prepare("DELETE FROM inventory_items WHERE household_id = ? AND id = ?").bind(household, id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return failure("inventory", error, "物品暂时无法删除", 500);
  }
});
