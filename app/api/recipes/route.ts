import { env } from "cloudflare:workers";
import { resolveHousehold } from "../_shared/household";
import { failure, withRoute } from "../_shared/observability";
import { householdTimeZone } from "../_shared/household";
import { dayIn } from "../../dateTime";
import { ensureSchema } from "../_shared/schema";
import { createOpenAIResponse, getOpenAIConfig } from "../_shared/openai";
import { demoRecipes, isDemoMode } from "../_shared/demo";

const foodCategories = ["蔬菜水果", "肉类海鲜", "乳品蛋类", "米面粮油", "调味品", "冷冻食品", "零食饮料"];
const origins = ["库存优先", "临期优先", "Flyer 搭配", "库存＋优惠"];
const ingredientSources = ["inventory", "flyer", "pantry"];

type GeneratedIngredient = { name: string; amount: string; source: "inventory" | "flyer" | "pantry" };
type GeneratedRecipe = {
  title: string;
  summary: string;
  reason: string;
  origin: string;
  icon: string;
  cookTime: string;
  difficulty: string;
  servings: number;
  ingredients: GeneratedIngredient[];
  steps: string[];
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

async function localDate(householdId: string) {
  return dayIn(await householdTimeZone(householdId));
}

function cleanRecipe(recipe: GeneratedRecipe) {
  const ingredients = (recipe.ingredients ?? [])
    .slice(0, 14)
    .map((item) => ({
      name: String(item.name ?? "")
        .trim()
        .slice(0, 80),
      amount:
        String(item.amount ?? "适量")
          .trim()
          .slice(0, 40) || "适量",
      source: ingredientSources.includes(item.source) ? item.source : "pantry",
    }))
    .filter((item) => item.name);
  const steps = (recipe.steps ?? [])
    .slice(0, 8)
    .map((step) => String(step).trim().slice(0, 240))
    .filter(Boolean);
  return {
    id: crypto.randomUUID(),
    title:
      String(recipe.title ?? "家常料理")
        .trim()
        .slice(0, 80) || "家常料理",
    summary: String(recipe.summary ?? "")
      .trim()
      .slice(0, 180),
    reason: String(recipe.reason ?? "")
      .trim()
      .slice(0, 220),
    origin: origins.includes(recipe.origin) ? recipe.origin : "库存优先",
    icon: String(recipe.icon ?? "🍲").slice(0, 8) || "🍲",
    cookTime: String(recipe.cookTime ?? "30 分钟")
      .trim()
      .slice(0, 30),
    difficulty: String(recipe.difficulty ?? "简单")
      .trim()
      .slice(0, 20),
    servings: Math.min(8, Math.max(1, Math.round(Number(recipe.servings) || 2))),
    ingredients,
    steps,
  };
}

function dietaryTerms(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[,，、;；\n]/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ).slice(0, 40);
}

function containsRestrictedFood(recipe: ReturnType<typeof cleanRecipe>, terms: string[]) {
  if (!terms.length) return false;
  const text =
    `${recipe.title} ${recipe.summary} ${recipe.ingredients.map((item) => item.name).join(" ")}`.toLowerCase();
  return terms.some((term) => text.includes(term));
}

export const POST = withRoute("recipes", async (request: Request) => {
  try {
    const household = resolveHousehold(request);
    let focusDealId = "";
    try {
      focusDealId = String(((await request.json()) as { focusDealId?: string }).focusDealId ?? "").trim();
    } catch {
      /* request body is optional */
    }
    const openAI = getOpenAIConfig(request);
    if (isDemoMode(request)) {
      // 演示模式不调用模型，返回一组固定的示例菜谱，走和真实结果相同的清洗与入库流程。
      const sample = demoRecipes().map(cleanRecipe);
      return Response.json({ recipes: sample, demo: true });
    }
    if (!openAI.apiKey) return Response.json({ error: "OpenAI API 私钥尚未配置到网站" }, { status: 503 });
    await ensureSchema();
    const today = await localDate(household);
    const inventory = await env.DB.prepare(
      `SELECT name, category, quantity, unit, level, expiry_date AS expiryDate
      FROM inventory_items WHERE quantity > 0 AND level != '已用完' ORDER BY
      CASE WHEN expiry_date IS NOT NULL THEN 0 ELSE 1 END, expiry_date ASC, updated_at DESC LIMIT 80`,
    ).all();
    const deals = await env.DB.prepare(
      `SELECT flyer_deals.id, flyer_deals.item_name AS itemName, flyer_deals.category,
      flyer_deals.price, flyer_deals.unit, flyer_deals.valid_to AS validTo, stores.name AS storeName
      FROM flyer_deals
      JOIN household_stores ON household_stores.source_key = flyer_deals.source_key
        AND household_stores.household_id = ?
      LEFT JOIN flyer_sources ON flyer_sources.source_key = flyer_deals.source_key
      WHERE flyer_deals.valid_from <= ? AND flyer_deals.valid_to >= ?
      ORDER BY CASE WHEN flyer_deals.id = ? THEN 0 ELSE 1 END, flyer_deals.valid_to ASC LIMIT 50`,
    )
      .bind(today, today, focusDealId)
      .all();
    const preferences = await env.DB.prepare(
      "SELECT allergies, avoid_foods AS avoidFoods, dislikes, notes FROM recipe_preferences WHERE household_id = ?",
    )
      .bind(household)
      .first<{ allergies: string; avoidFoods: string; dislikes: string; notes: string }>();
    const usableInventory = inventory.results.filter((item) =>
      foodCategories.includes(String((item as { category?: string }).category)),
    );
    const usableDeals = deals.results.filter((item) =>
      foodCategories.includes(String((item as { category?: string }).category)),
    );
    if (!usableInventory.length && !usableDeals.length)
      return Response.json({ error: "请先录入一些食品库存，或同步当前 Flyer 优惠" }, { status: 400 });

    const focusDeal = focusDealId
      ? usableDeals.find((item) => String((item as { id?: string }).id) === focusDealId)
      : null;
    const prompt = `为两人家庭生成 4 个具体、容易执行的做菜思路。\n当前库存：${JSON.stringify(usableInventory)}\n当前有效 Flyer 优惠：${JSON.stringify(usableDeals)}\n${focusDeal ? `本次指定优惠（至少生成 2 道以它为核心的菜）：${JSON.stringify(focusDeal)}\n` : ""}家庭过敏食材（绝对禁止）：${preferences?.allergies || "无"}\n家庭忌口食材（绝对禁止）：${preferences?.avoidFoods || "无"}\n家庭不喜欢的食物（不要使用）：${preferences?.dislikes || "无"}\n其他饮食要求：${preferences?.notes || "无"}\n
要求：
1. 至少 2 个方案优先使用家中已有食材；若有临期食材，至少 1 个方案优先消耗临期食材。
2. 若有有效 Flyer 食品优惠，至少 1 个方案把打折商品作为值得购买的补充；不要把优惠商品说成家里已有。
3. 食材 source 必须准确：inventory=当前库存，flyer=需要按优惠购买，pantry=油、盐、水、糖、酱油等常见基础调料。
4. 除 pantry 基础调料外，不要引入当前库存和 Flyer 都没有的主要食材。
5. 口味以家常中式、亚洲风味和简单西式为主，默认两人份，步骤简洁但足以实际做菜。
6. reason 明确说明为什么适合当前库存或哪项 Flyer 优惠；origin 从给定枚举选择。
7. 严格遵守家庭过敏、忌口和不喜欢的食物；即使库存或 Flyer 中存在这些食材也必须忽略，不得出现在菜名、食材或步骤中。`;
    const ingredientSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        amount: { type: "string" },
        source: { type: "string", enum: ingredientSources },
      },
      required: ["name", "amount", "source"],
    };
    const recipeSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        reason: { type: "string" },
        origin: { type: "string", enum: origins },
        icon: { type: "string" },
        cookTime: { type: "string" },
        difficulty: { type: "string", enum: ["简单", "中等"] },
        servings: { type: "integer" },
        ingredients: { type: "array", items: ingredientSchema },
        steps: { type: "array", items: { type: "string" } },
      },
      required: [
        "title",
        "summary",
        "reason",
        "origin",
        "icon",
        "cookTime",
        "difficulty",
        "servings",
        "ingredients",
        "steps",
      ],
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        recipes: { type: "array", items: recipeSchema },
      },
      required: ["recipes"],
    };
    const response = await createOpenAIResponse(
      {
        model: openAI.model,
        store: false,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content:
              "你是重视家庭食物安全、节省食材并善用超市优惠的菜谱助手。过敏和忌口限制优先级最高，严格区分家里已有和需要购买的食材。",
          },
          { role: "user", content: prompt },
        ],
        text: { format: { type: "json_schema", name: "home_recipe_ideas", strict: true, schema } },
      },
      openAI,
    );
    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      return Response.json(
        { error: (raw.error as { message?: string } | undefined)?.message || "菜谱生成暂时失败" },
        { status: 502 },
      );
    const text = outputText(raw);
    if (!text) return Response.json({ error: "没有生成可用的菜谱" }, { status: 422 });
    const generated = JSON.parse(text) as { recipes: GeneratedRecipe[] };
    const restrictedTerms = dietaryTerms(
      `${preferences?.allergies ?? ""},${preferences?.avoidFoods ?? ""},${preferences?.dislikes ?? ""}`,
    );
    const recipes = generated.recipes
      .slice(0, 4)
      .map(cleanRecipe)
      .filter(
        (recipe) =>
          recipe.ingredients.length &&
          recipe.steps.length &&
          !containsRestrictedFood(recipe, restrictedTerms),
      );
    if (!recipes.length) return Response.json({ error: "没有生成可用的菜谱" }, { status: 422 });
    return Response.json({ recipes });
  } catch (error) {
    return failure("recipes", error, "菜谱生成失败", 500);
  }
});
