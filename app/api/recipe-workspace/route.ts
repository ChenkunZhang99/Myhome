import { env } from "cloudflare:workers";
import { ensureHouseholdMembers, resolveHousehold } from "../_shared/household";
import { failure, withRoute } from "../_shared/observability";
import { householdTimeZone } from "../_shared/household";
import { dayIn } from "../../dateTime";
import { ensureSchema } from "../_shared/schema";
import {
  applyConsumption,
  findInventoryMatch,
  parseAmount,
  stockPortions,
  type StockPortion,
} from "../../inventoryUsage";

const mealTypes = ["", "早餐", "午餐", "晚餐"];
const requestStatuses = ["candidate", "scheduled", "completed"];
const priorities = ["想吃", "优先", "一定要吃"];

type Ingredient = { name: string; amount: string; source: "inventory" | "flyer" | "pantry" };
type RecipeInput = {
  id?: string;
  title?: string;
  summary?: string;
  reason?: string;
  origin?: string;
  icon?: string;
  cookTime?: string;
  difficulty?: string;
  servings?: number;
  ingredients?: Ingredient[];
  steps?: string[];
  tags?: string[];
  mealTypes?: string[];
  isFavorite?: boolean;
  isCustom?: boolean;
};

function database() {
  return env.DB;
}
function cleanText(value: unknown, fallback = "", max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}
function cleanId(value: unknown) {
  return cleanText(value, "", 100).replace(/[^a-zA-Z0-9_-]/g, "");
}
function cleanDate(value: unknown) {
  const date = cleanText(value, "", 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}
function cleanInt(value: unknown, fallback: number, min: number, max: number) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function uniqueText(values: unknown, maxItems = 16, maxLength = 32) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : []).map((value) => cleanText(value, "", maxLength)).filter(Boolean),
    ),
  ).slice(0, maxItems);
}
function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
async function today(householdId: string) {
  return dayIn(await householdTimeZone(householdId));
}

type ConsumptionSnapshot = {
  inventoryId: string;
  name: string;
  before: { quantity: number; remainingPercent: number; level: string };
  after: { quantity: number; remainingPercent: number; level: string };
};

/**
 * 按用户在「完成菜谱」里选的用量扣减库存，并返回改动前后的快照。
 * 快照存进制作记录，撤销时才能把库存原样还回去。
 */
async function consumeInventory(value: unknown): Promise<ConsumptionSnapshot[]> {
  const entries = (Array.isArray(value) ? value : [])
    .slice(0, 40)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const portion = cleanText(row.portion, "none", 10) as StockPortion;
      const quantityUsed = Number(row.quantityUsed);
      return {
        inventoryId: cleanText(row.inventoryId, "", 100),
        portion,
        quantityUsed: Number.isFinite(quantityUsed) ? quantityUsed : null,
      };
    })
    .filter(
      (entry) => entry.inventoryId && entry.portion !== "none" && stockPortions.includes(entry.portion),
    );
  if (!entries.length) return [];

  await ensureSchema();

  // 一次性把要动的库存全查出来，再一次性写回。
  // 逐条 SELECT + 逐条 UPDATE 的话，一顿饭 5 样食材就是 10 次网络往返。
  const ids = entries.map((entry) => entry.inventoryId);
  const placeholders = ids.map(() => "?").join(", ");
  const stockRows = await env.DB.prepare(
    `SELECT id, name, quantity, unit, remaining_percent AS remainingPercent, level
     FROM inventory_items WHERE household_id = ? AND id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      name: string;
      quantity: number;
      unit: string;
      remainingPercent: number;
      level: string;
    }>();
  const stockById = new Map(stockRows.results.map((row) => [row.id, row]));

  const snapshots: ConsumptionSnapshot[] = [];
  const updates = [];
  for (const entry of entries) {
    const stock = stockById.get(entry.inventoryId);
    if (!stock) continue;
    const before = {
      quantity: Number(stock.quantity),
      remainingPercent: Number(stock.remainingPercent),
      level: stock.level,
    };
    const after = applyConsumption(stock, entry.portion, entry.quantityUsed);
    if (after.quantity === before.quantity && after.remainingPercent === before.remainingPercent) continue;
    updates.push(
      env.DB.prepare(
        `UPDATE inventory_items SET quantity = ?, remaining_percent = ?, level = ?,
        updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?`,
      ).bind(after.quantity, after.remainingPercent, after.level, stock.id),
    );
    snapshots.push({ inventoryId: stock.id, name: stock.name, before, after });
  }
  if (updates.length) await env.DB.batch(updates);

  return snapshots;
}

/**
 * 撤销制作记录时把扣掉的库存还回去。
 * 只还原那些从扣减之后没有再被人改动过的物品，避免覆盖用户后来的修改。
 */
async function restoreInventory(value: string) {
  const snapshots = safeJson<ConsumptionSnapshot[]>(value, []);
  if (!Array.isArray(snapshots) || !snapshots.length) return { restored: 0, skipped: 0 };
  await ensureSchema();

  const usable = snapshots.filter(
    (snapshot) => cleanText(snapshot?.inventoryId, "", 100) && snapshot?.before && snapshot?.after,
  );
  let skipped = snapshots.length - usable.length;
  if (!usable.length) return { restored: 0, skipped };

  // 一次查回当前状态，再一次写回，避免按快照条数逐条往返。
  const ids = usable.map((snapshot) => snapshot.inventoryId);
  const placeholders = ids.map(() => "?").join(", ");
  const currentRows = await env.DB.prepare(
    `SELECT id, quantity, remaining_percent AS remainingPercent
     FROM inventory_items WHERE household_id = ? AND id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string; quantity: number; remainingPercent: number }>();
  const currentById = new Map(currentRows.results.map((row) => [row.id, row]));

  const updates = [];
  for (const snapshot of usable) {
    const current = currentById.get(snapshot.inventoryId);
    // 物品已删除，或扣减之后又被人改过，就不还原，免得盖掉用户的修改。
    const unchanged =
      current &&
      Number(current.quantity) === Number(snapshot.after.quantity) &&
      Number(current.remainingPercent) === Number(snapshot.after.remainingPercent);
    if (!unchanged) {
      skipped += 1;
      continue;
    }
    updates.push(
      env.DB.prepare(
        `UPDATE inventory_items SET quantity = ?, remaining_percent = ?, level = ?,
        updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?`,
      ).bind(
        snapshot.before.quantity,
        snapshot.before.remainingPercent,
        snapshot.before.level,
        snapshot.inventoryId,
      ),
    );
  }
  if (updates.length) await env.DB.batch(updates);
  return { restored: updates.length, skipped };
}

function cleanRecipe(input: RecipeInput) {
  const ingredients = (Array.isArray(input.ingredients) ? input.ingredients : [])
    .slice(0, 30)
    .map((item) => ({
      name: cleanText(item?.name, "", 80),
      amount: cleanText(item?.amount, "适量", 50) || "适量",
      source: ["inventory", "flyer", "pantry"].includes(item?.source) ? item.source : ("pantry" as const),
    }))
    .filter((item) => item.name);
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .slice(0, 16)
    .map((step) => cleanText(step, "", 360))
    .filter(Boolean);
  return {
    title: cleanText(input.title, "未命名菜谱", 100) || "未命名菜谱",
    summary: cleanText(input.summary, "", 260),
    reason: cleanText(input.reason, "", 320),
    origin: cleanText(input.origin, input.isCustom ? "家庭自建" : "智能推荐", 40),
    icon: cleanText(input.icon, "🍲", 12) || "🍲",
    cookTime: cleanText(input.cookTime, "30 分钟", 40),
    difficulty: cleanText(input.difficulty, "简单", 20),
    servings: cleanInt(input.servings, 2, 1, 20),
    ingredients,
    steps,
    tags: uniqueText(input.tags),
    mealTypes: uniqueText(input.mealTypes, 3, 8).filter((item) => mealTypes.includes(item) && item),
    isFavorite: Boolean(input.isFavorite),
    isCustom: Boolean(input.isCustom),
  };
}

async function logActivity(
  household: string,
  action: string,
  recipeId?: string | null,
  memberId?: string | null,
  details: Record<string, unknown> = {},
) {
  await database()
    .prepare(
      "INSERT INTO recipe_activity_log (id, household_id, recipe_id, member_id, action, details_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), household, recipeId ?? null, memberId ?? null, action, JSON.stringify(details))
    .run();
}

async function readWorkspace(household: string) {
  await ensureSchema();
  const db = database();
  const [recipes, members, requests, history, ratings, activity, preferences, attachments] =
    await Promise.all([
      db
        .prepare(
          `SELECT id, title, summary, reason, origin, icon, cook_time AS cookTime, difficulty, servings,
      ingredients_json AS ingredientsJson, steps_json AS stepsJson, tags_json AS tagsJson, meal_types_json AS mealTypesJson,
      is_favorite AS isFavorite, is_custom AS isCustom, cooked_count AS cookedCount, last_cooked_at AS lastCookedAt,
      created_at AS createdAt, updated_at AS updatedAt FROM recipe_catalog
      WHERE household_id = ? ORDER BY is_favorite DESC, updated_at DESC`,
        )
        .bind(household)
        .all(),
      db
        .prepare(
          "SELECT id, name, avatar, created_at AS createdAt, updated_at AS updatedAt FROM household_members WHERE household_id = ? ORDER BY created_at ASC",
        )
        .bind(household)
        .all(),
      db
        .prepare(
          `SELECT id, recipe_id AS recipeId, member_id AS memberId, desired_from AS desiredFrom, desired_to AS desiredTo,
      meal_type AS mealType, priority, servings, notes, status, scheduled_date AS scheduledDate,
      created_at AS createdAt, updated_at AS updatedAt FROM meal_requests
      WHERE household_id = ? ORDER BY updated_at DESC`,
        )
        .bind(household)
        .all(),
      db
        .prepare(
          `SELECT id, recipe_id AS recipeId, request_id AS requestId, cooked_date AS cookedDate, meal_type AS mealType,
      servings, cook_member_id AS cookMemberId, notes, COALESCE(consumption_json, '[]') AS consumptionJson, created_at AS createdAt
      FROM recipe_cook_history WHERE household_id = ? ORDER BY cooked_date DESC, created_at DESC LIMIT 100`,
        )
        .bind(household)
        .all(),
      db
        .prepare(
          "SELECT id, recipe_id AS recipeId, member_id AS memberId, rating, updated_at AS updatedAt FROM recipe_ratings WHERE household_id = ? ORDER BY updated_at DESC",
        )
        .bind(household)
        .all(),
      db
        .prepare(
          "SELECT id, recipe_id AS recipeId, member_id AS memberId, action, details_json AS detailsJson, created_at AS createdAt FROM recipe_activity_log WHERE household_id = ? ORDER BY created_at DESC LIMIT 20",
        )
        .bind(household)
        .all(),
      db
        .prepare(
          "SELECT allergies, avoid_foods AS avoidFoods, dislikes, notes, updated_at AS updatedAt FROM recipe_preferences WHERE household_id = ?",
        )
        .bind(household)
        .first(),
      db
        .prepare(
          "SELECT id, recipe_id AS recipeId, file_name AS fileName, content_type AS contentType, size, created_at AS createdAt FROM recipe_attachments WHERE household_id = ? ORDER BY created_at ASC",
        )
        .bind(household)
        .all(),
    ]);
  const ratingRows = ratings.results as Array<{ recipeId: string; memberId: string; rating: number }>;
  const ratingByRecipe = new Map<string, { total: number; count: number }>();
  for (const rating of ratingRows) {
    const entry = ratingByRecipe.get(rating.recipeId) ?? { total: 0, count: 0 };
    entry.total += Number(rating.rating);
    entry.count++;
    ratingByRecipe.set(rating.recipeId, entry);
  }
  const photosByRecipe = new Map<string, Array<Record<string, unknown>>>();
  for (const photo of attachments.results as Array<Record<string, unknown>>) {
    const recipeId = String(photo.recipeId);
    photosByRecipe.set(recipeId, [...(photosByRecipe.get(recipeId) ?? []), photo]);
  }
  return {
    recipes: (recipes.results as Array<Record<string, unknown>>).map((row) => {
      const score = ratingByRecipe.get(String(row.id));
      return {
        ...row,
        isFavorite: Boolean(row.isFavorite),
        isCustom: Boolean(row.isCustom),
        ingredients: safeJson(String(row.ingredientsJson), []),
        steps: safeJson(String(row.stepsJson), []),
        tags: safeJson(String(row.tagsJson), []),
        mealTypes: safeJson(String(row.mealTypesJson), []),
        ingredientsJson: undefined,
        stepsJson: undefined,
        tagsJson: undefined,
        mealTypesJson: undefined,
        photos: photosByRecipe.get(String(row.id)) ?? [],
        averageRating: score ? Math.round((score.total / score.count) * 10) / 10 : null,
        ratingCount: score?.count ?? 0,
      };
    }),
    members: members.results,
    ratings: ratingRows,
    requests: requests.results,
    history: (history.results as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      consumption: safeJson(String(row.consumptionJson), []),
      consumptionJson: undefined,
    })),
    preferences: preferences ?? { allergies: "", avoidFoods: "", dislikes: "", notes: "" },
    activity: (activity.results as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      details: safeJson(String(row.detailsJson), {}),
      detailsJson: undefined,
    })),
    // 前端的日期默认值要和服务端算的「今天」一致，否则跨时区会差一天。
    timeZone: await householdTimeZone(household),
  };
}

export const GET = withRoute("recipe.workspace", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    await ensureHouseholdMembers(household);
    return Response.json(await readWorkspace(household));
  } catch (error) {
    return failure("recipe.workspace", error, "菜谱工作区暂时无法读取", 500);
  }
});

export const POST = withRoute("recipe.workspace", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    await ensureSchema();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = cleanText(payload.action, "", 40);
    const db = database();

    if (action === "savePreferences") {
      const preferences = (payload.preferences ?? {}) as Record<string, unknown>;
      await db
        .prepare(
          `INSERT INTO recipe_preferences (household_id, allergies, avoid_foods, dislikes, notes, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET allergies = excluded.allergies,
        avoid_foods = excluded.avoid_foods, dislikes = excluded.dislikes, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          cleanText(preferences.allergies, "", 500),
          cleanText(preferences.avoidFoods, "", 500),
          cleanText(preferences.dislikes, "", 500),
          cleanText(preferences.notes, "", 800),
        )
        .run();
      await logActivity(household, "更新忌口设置", null, null, {
        allergies: cleanText(preferences.allergies, "", 120),
      });
    } else if (action === "saveRecipe") {
      const input = (payload.recipe ?? {}) as RecipeInput;
      const id = cleanId(input.id) || `recipe-${crypto.randomUUID()}`;
      const recipe = cleanRecipe(input);
      await db
        .prepare(
          `INSERT INTO recipe_catalog
        (household_id, id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json,
        tags_json, meal_types_json, is_favorite, is_custom, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, reason = excluded.reason,
        origin = excluded.origin, icon = excluded.icon, cook_time = excluded.cook_time, difficulty = excluded.difficulty,
        servings = excluded.servings, ingredients_json = excluded.ingredients_json, steps_json = excluded.steps_json,
        tags_json = excluded.tags_json, meal_types_json = excluded.meal_types_json, is_favorite = excluded.is_favorite,
        is_custom = excluded.is_custom, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          household,
          id,
          recipe.title,
          recipe.summary,
          recipe.reason,
          recipe.origin,
          recipe.icon,
          recipe.cookTime,
          recipe.difficulty,
          recipe.servings,
          JSON.stringify(recipe.ingredients),
          JSON.stringify(recipe.steps),
          JSON.stringify(recipe.tags),
          JSON.stringify(recipe.mealTypes),
          Number(recipe.isFavorite),
          Number(recipe.isCustom),
        )
        .run();
      await logActivity(
        household,
        input.id ? "编辑菜谱" : "创建菜谱",
        id,
        cleanId(payload.memberId) || null,
        {
          title: recipe.title,
        },
      );
    } else if (action === "importRecipes") {
      const recipes = Array.isArray(payload.recipes) ? (payload.recipes.slice(0, 8) as RecipeInput[]) : [];
      const inserts = [];
      for (const input of recipes) {
        const id = cleanId(input.id) || `recipe-${crypto.randomUUID()}`;
        const recipe = cleanRecipe({
          ...input,
          tags: uniqueText([...(input.tags ?? []), "智能推荐"]),
          isCustom: false,
        });
        inserts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO recipe_catalog
          (household_id, id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json,
          tags_json, meal_types_json, is_favorite, is_custom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
            )
            .bind(
              household,
              id,
              recipe.title,
              recipe.summary,
              recipe.reason,
              recipe.origin,
              recipe.icon,
              recipe.cookTime,
              recipe.difficulty,
              recipe.servings,
              JSON.stringify(recipe.ingredients),
              JSON.stringify(recipe.steps),
              JSON.stringify(recipe.tags),
              JSON.stringify(recipe.mealTypes),
            ),
        );
      }
      if (inserts.length) await db.batch(inserts);
      await logActivity(household, "导入智能推荐", null, null, { count: recipes.length });
    } else if (action === "toggleFavorite") {
      const recipeId = cleanId(payload.recipeId);
      await db
        .prepare(
          "UPDATE recipe_catalog SET is_favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?",
        )
        .bind(payload.favorite ? 1 : 0, household, recipeId)
        .run();
      await logActivity(household, payload.favorite ? "收藏菜谱" : "取消收藏", recipeId);
    } else if (action === "deleteRecipe") {
      const recipeId = cleanId(payload.recipeId);
      const photos = await db
        .prepare(
          "SELECT object_key AS objectKey FROM recipe_attachments WHERE household_id = ? AND recipe_id = ?",
        )
        .bind(household, recipeId)
        .all<{ objectKey: string }>();
      for (const photo of photos.results) await env.UPLOADS.delete(photo.objectKey);
      await db.batch([
        db
          .prepare("DELETE FROM meal_requests WHERE household_id = ? AND recipe_id = ?")
          .bind(household, recipeId),
        db
          .prepare("DELETE FROM recipe_ratings WHERE household_id = ? AND recipe_id = ?")
          .bind(household, recipeId),
        db
          .prepare("DELETE FROM recipe_cook_history WHERE household_id = ? AND recipe_id = ?")
          .bind(household, recipeId),
        db
          .prepare("DELETE FROM recipe_attachments WHERE household_id = ? AND recipe_id = ?")
          .bind(household, recipeId),
        db.prepare("DELETE FROM recipe_catalog WHERE household_id = ? AND id = ?").bind(household, recipeId),
      ]);
      await logActivity(household, "删除菜谱", recipeId);
    } else if (action === "saveMember") {
      const member = (payload.member ?? {}) as Record<string, unknown>;
      const id = cleanId(member.id) || `member-${crypto.randomUUID()}`;
      const name = cleanText(member.name, "家庭成员", 40) || "家庭成员";
      const avatar = cleanText(member.avatar, "🙂", 12) || "🙂";
      await db
        .prepare(
          `INSERT INTO household_members (id, household_id, name, avatar, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(id, household, name, avatar)
        .run();
      await logActivity(household, member.id ? "编辑成员" : "添加成员", null, id, { name });
    } else if (action === "deleteMember") {
      const memberId = cleanId(payload.memberId);
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM household_members WHERE household_id = ?")
        .bind(household)
        .first<{ count: number }>();
      const used = await db
        .prepare(
          `SELECT
        (SELECT COUNT(*) FROM meal_requests WHERE household_id = ?1 AND member_id = ?2) +
        (SELECT COUNT(*) FROM recipe_cook_history WHERE household_id = ?1 AND cook_member_id = ?2) +
        (SELECT COUNT(*) FROM recipe_ratings WHERE household_id = ?1 AND member_id = ?2) AS count`,
        )
        .bind(household, memberId)
        .first<{ count: number }>();
      if (Number(count?.count) <= 1)
        return Response.json({ error: "家庭中至少需要保留一位成员" }, { status: 400 });
      if (Number(used?.count) > 0)
        return Response.json(
          { error: "这位成员已有点菜、制作或评分记录，请修改姓名而不是删除" },
          { status: 400 },
        );
      await db
        .prepare("DELETE FROM household_members WHERE household_id = ? AND id = ?")
        .bind(household, memberId)
        .run();
    } else if (action === "saveRequest") {
      const item = (payload.request ?? {}) as Record<string, unknown>;
      const id = cleanId(item.id) || `request-${crypto.randomUUID()}`;
      const recipeId = cleanId(item.recipeId);
      const memberId = cleanId(item.memberId);
      if (!recipeId || !memberId) return Response.json({ error: "请选择菜谱和点菜成员" }, { status: 400 });
      const status = requestStatuses.includes(String(item.status)) ? String(item.status) : "candidate";
      const mealType = mealTypes.includes(String(item.mealType)) ? String(item.mealType) : "";
      const priority = priorities.includes(String(item.priority)) ? String(item.priority) : "想吃";
      const scheduledDate = cleanDate(item.scheduledDate);
      await db
        .prepare(
          `INSERT INTO meal_requests
        (household_id, id, recipe_id, member_id, desired_from, desired_to, meal_type, priority, servings, notes, status, scheduled_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET recipe_id = excluded.recipe_id, member_id = excluded.member_id,
        desired_from = excluded.desired_from, desired_to = excluded.desired_to, meal_type = excluded.meal_type,
        priority = excluded.priority, servings = excluded.servings, notes = excluded.notes, status = excluded.status,
        scheduled_date = excluded.scheduled_date, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          household,
          id,
          recipeId,
          memberId,
          cleanDate(item.desiredFrom),
          cleanDate(item.desiredTo),
          mealType,
          priority,
          cleanInt(item.servings, 2, 1, 20),
          cleanText(item.notes, "", 260),
          status,
          scheduledDate,
        )
        .run();
      await logActivity(household, item.id ? "修改点菜" : "家庭点菜", recipeId, memberId, {
        status,
        scheduledDate,
        mealType,
      });
    } else if (action === "deleteRequest") {
      const requestId = cleanId(payload.requestId);
      const existing = await db
        .prepare(
          "SELECT recipe_id AS recipeId, member_id AS memberId FROM meal_requests WHERE household_id = ? AND id = ?",
        )
        .bind(requestId)
        .first<{ recipeId: string; memberId: string }>();
      await db
        .prepare("DELETE FROM meal_requests WHERE household_id = ? AND id = ?")
        .bind(household, requestId)
        .run();
      await logActivity(household, "撤回点菜", existing?.recipeId, existing?.memberId);
    } else if (action === "completeMeal" || action === "saveHistory") {
      const item = (payload.history ?? {}) as Record<string, unknown>;
      const historyId = cleanId(item.id) || `history-${crypto.randomUUID()}`;
      const recipeId = cleanId(item.recipeId);
      const memberId = cleanId(item.cookMemberId);
      const cookedDate = cleanDate(item.cookedDate) || (await today(household));
      if (!recipeId || !memberId) return Response.json({ error: "请选择菜谱和制作成员" }, { status: 400 });
      const existing = item.id
        ? await db
            .prepare(
              "SELECT recipe_id AS recipeId FROM recipe_cook_history WHERE household_id = ? AND id = ?",
            )
            .bind(household, historyId)
            .first<{ recipeId: string }>()
        : null;
      await db
        .prepare(
          `INSERT INTO recipe_cook_history
        (household_id, id, recipe_id, request_id, cooked_date, meal_type, servings, cook_member_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET recipe_id = excluded.recipe_id, request_id = excluded.request_id,
        cooked_date = excluded.cooked_date, meal_type = excluded.meal_type, servings = excluded.servings,
        cook_member_id = excluded.cook_member_id, notes = excluded.notes`,
        )
        .bind(
          household,
          historyId,
          recipeId,
          cleanId(item.requestId) || null,
          cookedDate,
          mealTypes.includes(String(item.mealType)) ? String(item.mealType) : "",
          cleanInt(item.servings, 2, 1, 20),
          memberId,
          cleanText(item.notes, "", 260),
        )
        .run();
      if (cleanId(item.requestId))
        await db
          .prepare(
            "UPDATE meal_requests SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?",
          )
          .bind(household, cleanId(item.requestId))
          .run();
      if (existing?.recipeId && existing.recipeId !== recipeId) {
        await db
          .prepare(
            `UPDATE recipe_catalog SET cooked_count = (SELECT COUNT(*) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2),
          last_cooked_at = (SELECT MAX(cooked_date) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2), updated_at = CURRENT_TIMESTAMP WHERE household_id = ?1 AND id = ?2`,
          )
          .bind(household, existing.recipeId)
          .run();
      }
      await db
        .prepare(
          `UPDATE recipe_catalog SET cooked_count = (SELECT COUNT(*) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2),
        last_cooked_at = (SELECT MAX(cooked_date) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2), updated_at = CURRENT_TIMESTAMP WHERE household_id = ?1 AND id = ?2`,
        )
        .bind(household, recipeId)
        .run();
      const rating = cleanInt(item.rating, 0, 0, 10);
      if (rating)
        await db
          .prepare(
            `INSERT INTO recipe_ratings (household_id, id, recipe_id, member_id, rating, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET rating = excluded.rating, updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(household, `rating-${recipeId}-${memberId}`, recipeId, memberId, rating)
          .run();
      // 只有第一次记录完成时才扣库存，编辑旧记录不应该重复扣。
      const consumption = item.id ? [] : await consumeInventory(payload.consumption);
      if (consumption.length) {
        await db
          .prepare("UPDATE recipe_cook_history SET consumption_json = ? WHERE household_id = ? AND id = ?")
          .bind(JSON.stringify(consumption), household, historyId)
          .run();
      }
      await logActivity(household, item.id ? "修改制作记录" : "完成菜谱", recipeId, memberId, {
        cookedDate,
        rating,
        consumed: consumption.length,
      });
      return Response.json({ ...(await readWorkspace(household)), consumed: consumption.length });
    } else if (action === "undoHistory") {
      const historyId = cleanId(payload.historyId);
      const existing = await db
        .prepare(
          `SELECT recipe_id AS recipeId, request_id AS requestId,
        COALESCE(consumption_json, '[]') AS consumptionJson FROM recipe_cook_history
        WHERE household_id = ? AND id = ?`,
        )
        .bind(household, historyId)
        .first<{ recipeId: string; requestId: string | null; consumptionJson: string }>();
      if (existing) {
        // 先把这顿饭扣掉的库存还回去，再删记录。
        const { restored, skipped } = await restoreInventory(existing.consumptionJson);
        await db
          .prepare("DELETE FROM recipe_cook_history WHERE household_id = ? AND id = ?")
          .bind(household, historyId)
          .run();
        if (existing.requestId)
          await db
            .prepare(
              "UPDATE meal_requests SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP WHERE household_id = ? AND id = ?",
            )
            .bind(household, existing.requestId)
            .run();
        await db
          .prepare(
            `UPDATE recipe_catalog SET cooked_count = (SELECT COUNT(*) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2),
          last_cooked_at = (SELECT MAX(cooked_date) FROM recipe_cook_history WHERE household_id = ?1 AND recipe_id = ?2), updated_at = CURRENT_TIMESTAMP WHERE household_id = ?1 AND id = ?2`,
          )
          .bind(household, existing.recipeId)
          .run();
        await logActivity(household, "撤销完成", existing.recipeId, null, { restored, skipped });
        return Response.json({ ...(await readWorkspace(household)), restored, skipped });
      }
    } else if (action === "rateRecipe") {
      const recipeId = cleanId(payload.recipeId);
      const memberId = cleanId(payload.memberId);
      const rating = cleanInt(payload.rating, 0, 1, 10);
      await db
        .prepare(
          `INSERT INTO recipe_ratings (household_id, id, recipe_id, member_id, rating, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET rating = excluded.rating, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(household, `rating-${recipeId}-${memberId}`, recipeId, memberId, rating)
        .run();
      await logActivity(household, "修改评分", recipeId, memberId, { rating });
    } else if (action === "generateShopping") {
      const from = cleanDate(payload.from) || (await today(household));
      const to = cleanDate(payload.to) || from;
      const planned = await db
        .prepare(
          `SELECT recipe_catalog.ingredients_json AS ingredientsJson
        FROM meal_requests JOIN recipe_catalog ON recipe_catalog.id = meal_requests.recipe_id
        WHERE meal_requests.household_id = ? AND recipe_catalog.household_id = ?
        AND meal_requests.status = 'scheduled' AND meal_requests.scheduled_date >= ? AND meal_requests.scheduled_date <= ?`,
        )
        .bind(household, household, from, to)
        .all<{ ingredientsJson: string }>();
      // 用量要拆成数量和单位分开存，否则「300克」会被当成单位，勾选入库时污染库存。
      await ensureSchema();
      const stock = await env.DB.prepare(
        "SELECT id, name, category, unit FROM inventory_items WHERE household_id = ?",
      )
        .bind(household)
        .all<{
          id: string;
          name: string;
          category: string;
          unit: string;
        }>();
      // 一周菜单可能有几十个食材。原来每个都要先查一次「是否已在清单里」再写一次，
      // 这里改成一次性把待买清单查回来做集合判断，写入合并成一个 batch。
      const pending = await db
        .prepare("SELECT lower(name) AS name FROM shopping_items WHERE household_id = ? AND checked = 0")
        .bind(household)
        .all<{ name: string }>();
      const alreadyListed = new Set(pending.results.map((row) => row.name));

      const inserts = [];
      for (const row of planned.results)
        for (const ingredient of safeJson<Ingredient[]>(row.ingredientsJson, [])) {
          if (ingredient.source !== "flyer" || !ingredient.name) continue;
          const key = ingredient.name.toLowerCase();
          if (alreadyListed.has(key)) continue;
          // 同一周菜单里多道菜用到同一样东西时，只加一次。
          alreadyListed.add(key);

          const parsed = parseAmount(ingredient.amount);
          const match = findInventoryMatch(ingredient.name, "", stock.results);
          inserts.push(
            db
              .prepare(
                "INSERT INTO shopping_items (household_id, id, name, quantity, unit, category, source) VALUES (?, ?, ?, ?, ?, 'menu-plan')",
              )
              .bind(
                `shop-menu-${crypto.randomUUID()}`,
                ingredient.name,
                parsed?.quantity ?? 1,
                parsed?.unit || match?.item.unit || "份",
                match?.item.category || "其他",
              ),
          );
        }
      if (inserts.length) await db.batch(inserts);
      const added = inserts.length;
      await logActivity(household, "从菜单生成采购清单", null, null, { from, to, added });
      return Response.json({ ...(await readWorkspace(household)), added });
    } else {
      return Response.json({ error: "不支持的菜谱操作" }, { status: 400 });
    }
    return Response.json(await readWorkspace(household));
  } catch (error) {
    return failure("recipe.workspace", error, "菜谱操作失败", 500);
  }
});
