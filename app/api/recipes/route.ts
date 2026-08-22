import { env } from "cloudflare:workers";
import { resolveHousehold } from "../_shared/household";
import { failure, redact, withRoute } from "../_shared/observability";
import { householdTimeZone } from "../_shared/household";
import { dayIn } from "../../dateTime";
import { ensureSchema } from "../_shared/schema";
import { createOpenAIResponse, getOpenAIConfig } from "../_shared/openai";
import { demoRecipes, isDemoMode } from "../_shared/demo";
import { cleanGeneratedRecipe as cleanRecipe, GeneratedRecipe, RECIPE_SCHEMA } from "../_shared/recipeShape";

const foodCategories = ["蔬菜水果", "肉类海鲜", "乳品蛋类", "米面粮油", "调味品", "冷冻食品", "零食饮料"];

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
    const household = await resolveHousehold(request);
    let focusDealId = "";
    try {
      focusDealId = String(((await request.json()) as { focusDealId?: string }).focusDealId ?? "").trim();
    } catch {
      /* request body is optional */
    }
    const openAI = getOpenAIConfig(request, household);
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
      FROM inventory_items WHERE household_id = ? AND quantity > 0 AND level != '已用完' ORDER BY
      CASE WHEN expiry_date IS NOT NULL THEN 0 ELSE 1 END, expiry_date ASC, updated_at DESC LIMIT 80`,
    )
      .bind(household)
      .all();
    /**
     * 这条查询以前有两处错，而且一直没被发现——演示模式在它之前就返回了，
     * 所以直到线上配上真密钥，它才第一次真正执行。
     *
     *  1. 取的是 stores.name，但多住户改造时那张表已经拆成 household_stores
     *     和 flyer_sources 了，没有叫 stores 的东西
     *  2. 四个占位符只绑了三个值，household 压根没传进去
     *
     * 改用编号参数：today 要用两次，位置绑法在这种时候最容易错位。
     */
    const deals = await env.DB.prepare(
      `SELECT flyer_deals.id, flyer_deals.item_name AS itemName, flyer_deals.category,
      flyer_deals.price, flyer_deals.unit, flyer_deals.valid_to AS validTo,
      flyer_sources.name AS storeName
      FROM flyer_deals
      JOIN household_stores ON household_stores.source_key = flyer_deals.source_key
        AND household_stores.household_id = ?1
      LEFT JOIN flyer_sources ON flyer_sources.source_key = flyer_deals.source_key
      WHERE flyer_deals.valid_from <= ?2 AND flyer_deals.valid_to >= ?2
      ORDER BY CASE WHEN flyer_deals.id = ?3 THEN 0 ELSE 1 END, flyer_deals.valid_to ASC LIMIT 50`,
    )
      .bind(household, today, focusDealId)
      .all();
    const preferences = await env.DB.prepare(
      "SELECT allergies, avoid_foods AS avoidFoods, dislikes, notes FROM recipe_preferences WHERE household_id = ?",
    )
      .bind(household)
      .first<{ allergies: string; avoidFoods: string; dislikes: string; notes: string }>();

    /**
     * 这家人到底爱吃什么。
     *
     * 之前提示词里只有库存、优惠和忌口——模型完全不知道这家人的口味，
     * 只能在食材集合里做排列组合，于是端出姜汁蒸蛋这种「合规但没人会做」的菜。
     * 收藏、做过的次数、评分这些信号一直存着，从来没喂给它。
     */
    const liked = await env.DB.prepare(
      `SELECT recipe_catalog.title, recipe_catalog.cooked_count AS cookedCount,
              ROUND(AVG(recipe_ratings.rating), 1) AS rating
         FROM recipe_catalog
         LEFT JOIN recipe_ratings ON recipe_ratings.recipe_id = recipe_catalog.id
           AND recipe_ratings.household_id = ?1
        WHERE recipe_catalog.household_id = ?1
          AND (recipe_catalog.is_favorite = 1 OR recipe_catalog.cooked_count > 0)
        GROUP BY recipe_catalog.id
        ORDER BY recipe_catalog.cooked_count DESC, recipe_catalog.updated_at DESC
        LIMIT 20`,
    )
      .bind(household)
      .all<{ title: string; cookedCount: number; rating: number | null }>();

    /** 明确说过不要的菜。没有这条，同一道怪菜会一次次回来。 */
    const rejected = await env.DB.prepare(
      `SELECT DISTINCT details_json AS details FROM recipe_activity_log
        WHERE household_id = ? AND action = '不再推荐' ORDER BY created_at DESC LIMIT 40`,
    )
      .bind(household)
      .all<{ details: string }>();
    const rejectedTitles = (rejected.results ?? [])
      .map((row) => {
        try {
          return String((JSON.parse(row.details) as { title?: string }).title ?? "");
        } catch {
          return "";
        }
      })
      .filter(Boolean);

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
    /**
     * 提示词。
     *
     * 「平衡」是家里定的口径：多数推常见家常菜，留一道稍新的；允许补一两样常见食材。
     * 原先那版只给库存和优惠，还硬性禁止引入外部食材，等于要求模型在一堆
     * 原料里做排列组合——姜加蛋就成了姜汁蒸蛋。真实的家常菜是先有菜名，
     * 再倒推食材，所以现在明确要求「必须是有名字的常见菜」。
     */
    const prompt = [
      `为两人家庭生成 4 个具体、容易执行的做菜思路。`,
      `当前库存：${JSON.stringify(usableInventory)}`,
      `当前有效 Flyer 优惠：${JSON.stringify(usableDeals)}`,
      focusDeal ? `本次指定优惠（至少生成 2 道以它为核心的菜）：${JSON.stringify(focusDeal)}` : ``,
      liked.results?.length
        ? `这家人做过或收藏过的菜（口味样本，越靠前越常做）：${JSON.stringify(liked.results)}`
        : `这家人还没有做菜记录，按大众家常口味来。`,
      rejectedTitles.length ? `明确说过不要再推荐的菜：${rejectedTitles.join("、")}` : ``,
      `家庭过敏食材（绝对禁止）：${preferences?.allergies || "无"}`,
      `家庭忌口食材（绝对禁止）：${preferences?.avoidFoods || "无"}`,
      `家庭不喜欢的食物（不要使用）：${preferences?.dislikes || "无"}`,
      `其他饮食要求：${preferences?.notes || "无"}`,
      ``,
      `要求：`,
      `1. 每一道都必须是有通用菜名、家常菜谱里查得到的菜。不要把手头的食材凑成一道新菜——`,
      `   先想「这些食材能做哪道现成的菜」，而不是「这些食材放一起能叫什么」。`,
      `2. 4 道里至少 3 道是大众熟悉的家常菜；最多 1 道可以稍微新一点，但同样要是真实存在的菜。`,
      `3. 至少 2 道优先使用家中已有食材；若有临期食材，至少 1 道优先消耗临期食材。`,
      `4. 若有有效 Flyer 食品优惠，至少 1 道把打折商品作为值得购买的补充；不要把优惠商品说成家里已有。`,
      `5. 每道菜最多允许 2 样需要额外购买的常见食材（source 填 buy），比如葱、蒜、豆腐这类随处能买到的东西。`,
      `   宁可让人多买一样葱，也不要为了凑齐食材而编出一道没人做的菜。`,
      `6. 食材 source 必须准确：inventory=当前库存，flyer=需要按优惠购买，`,
      `   pantry=油盐糖酱醋这类常备调料，buy=需要另外买的常见食材。`,
      `7. 口味以家常中式、亚洲风味和简单西式为主，默认两人份，步骤简洁但足以实际做菜。`,
      `8. reason 说明为什么适合当前库存或哪项 Flyer 优惠；origin 从给定枚举选择。`,
      `9. 严格遵守家庭过敏、忌口和不喜欢的食物；即使库存或 Flyer 中存在这些食材也必须忽略，`,
      `   不得出现在菜名、食材或步骤中。`,
    ]
      .filter(Boolean)
      .join("\n");
    // 单道菜谱的形状和 /api/recipes/draft 共用，见 _shared/recipeShape.ts
    const recipeSchema = RECIPE_SCHEMA;
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
        // 「这道菜是不是真有人做」是个需要判断的问题，low 档下模型更倾向于
        // 把食材排列组合了事。这里多花一点推理换少一点怪菜。
        reasoning: { effort: "medium" },
        input: [
          {
            role: "system",
            content:
              "你是重视家庭食物安全、节省食材并善用超市优惠的菜谱助手。" +
              "你推荐的必须是真实存在、家常菜谱里查得到的菜，不是把手头食材凑起来的新组合。" +
              "过敏和忌口限制优先级最高，严格区分家里已有和需要购买的食材。",
          },
          { role: "user", content: prompt },
        ],
        text: { format: { type: "json_schema", name: "home_recipe_ideas", strict: true, schema } },
      },
      openAI,
    );
    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      // 上游原文可能带着模型名、组织 id 这类内部信息，不该出现在响应里。
      // 见 tests/error-handling.test.mjs：对外只给这个接口自己的安全文案。
      // 只记状态码是不够的：400 有几十种原因，没有原文就只能靠猜。
      // 原文进日志、不出接口——redact 会把 sk- 形态的东西抹掉。
      // 之前只记 message 和 code，拿到的是一句「Bad Request」——对排查毫无用处。
      // 整个错误体记下来（截断 + 脱敏）：400 的原因几乎总在 param 或 type 里。
      // 这里记的是 OpenAI 的响应，不含我们发过去的内容，也就不含密钥。
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          scope: "recipes",
          status: response.status,
          body: redact(JSON.stringify(raw).slice(0, 900)),
        }),
      );
      return Response.json({ error: "菜谱生成暂时失败" }, { status: 502 });
    }
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
    // 记下这次推了什么、基于多少库存和优惠。
    // 不记的话，事后想找一个「怪菜」的例子只能靠人的记忆——而提示词要靠例子才改得动。
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        scope: "recipes",
        event: "generated",
        titles: recipes.map((item) => item.title),
        inventoryCount: usableInventory.length,
        dealCount: usableDeals.length,
        tasteSamples: liked.results?.length ?? 0,
      }),
    );
    return Response.json({ recipes });
  } catch (error) {
    return failure("recipes", error, "菜谱生成失败", 500);
  }
});
