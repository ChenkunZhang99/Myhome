/**
 * 模型生成的菜谱长什么样，以及怎么把它清洗成能入库的形状。
 *
 * 抽出来是因为现在有两个地方要用：批量推荐（/api/recipes）和按描述补全
 * （/api/recipes/draft）。两份各自演化的清洗逻辑迟早会在长度上限、
 * 默认值或字段名上分叉，而那种分叉只会在某条数据坏掉的时候才被发现。
 */

export const RECIPE_ORIGINS = ["库存优先", "临期优先", "Flyer 搭配", "库存＋优惠"];
export const INGREDIENT_SOURCES = ["inventory", "flyer", "pantry"];

export type GeneratedIngredient = { name: string; amount: string; source: "inventory" | "flyer" | "pantry" };

export type GeneratedRecipe = {
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

/** 单道菜谱的 JSON schema，两个接口共用；批量那个把它包进 recipes 数组。 */
export const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
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
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    reason: { type: "string" },
    origin: { type: "string", enum: RECIPE_ORIGINS },
    icon: { type: "string" },
    cookTime: { type: "string" },
    difficulty: { type: "string" },
    servings: { type: "integer" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "amount", "source"],
        properties: {
          name: { type: "string" },
          amount: { type: "string" },
          source: { type: "string", enum: INGREDIENT_SOURCES },
        },
      },
    },
    steps: { type: "array", items: { type: "string" } },
  },
} as const;

/** 模型返回的东西一律当作不可信输入：截断、兜底、丢掉空项。 */
export function cleanGeneratedRecipe(recipe: GeneratedRecipe) {
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
      source: INGREDIENT_SOURCES.includes(item.source) ? item.source : "pantry",
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
    origin: RECIPE_ORIGINS.includes(recipe.origin) ? recipe.origin : "库存优先",
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
