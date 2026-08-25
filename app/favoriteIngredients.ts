/**
 * 总览上的「喜爱食材」。
 *
 * 从收藏、高分或做过的菜里抽出常出现的食材（跳过油盐酱醋）。
 * 家里还没有这类记录时，用下面这套示例让人看懂这一块在干什么。
 */

export type FavoriteIngredient = {
  id: string;
  name: string;
  category: string;
  icon: string;
  /** 可翻译的理由文案；有 reasonTitle 时用「出自某道菜」。 */
  reason: string;
  reasonTitle?: string;
  recipeCount: number;
  demo?: boolean;
};

type RecipeIngredient = { name?: string | null; source?: string | null };
type RecipeSignal = {
  id?: string;
  title?: string;
  isFavorite?: number | boolean;
  cookedCount?: number;
  averageRating?: number | null;
  ingredients?: RecipeIngredient[];
};

const pantrySources = new Set(["pantry"]);

const ingredientLooks: { keywords: string[]; category: string; icon: string }[] = [
  { keywords: ["鸡蛋", "鸭蛋"], category: "乳品蛋类", icon: "🥚" },
  { keywords: ["牛奶", "鲜奶"], category: "乳品蛋类", icon: "🥛" },
  { keywords: ["番茄", "西红柿"], category: "蔬菜水果", icon: "🍅" },
  { keywords: ["菠菜", "青菜", "白菜", "生菜"], category: "蔬菜水果", icon: "🥬" },
  { keywords: ["鸡腿", "鸡翅", "鸡肉"], category: "肉类海鲜", icon: "🍗" },
  { keywords: ["牛腩", "牛肉"], category: "肉类海鲜", icon: "🥩" },
  { keywords: ["五花肉", "猪肉"], category: "肉类海鲜", icon: "🥓" },
  { keywords: ["豆腐"], category: "其他", icon: "🧊" },
  { keywords: ["大米", "米饭"], category: "米面粮油", icon: "🍚" },
];

function lookFor(name: string) {
  const matched = ingredientLooks.find((rule) => rule.keywords.some((keyword) => name.includes(keyword)));
  return matched ?? { category: "其他", icon: "🍲" };
}

/** 总览上喜爱食材的默认范本。没有收藏或做过的菜时先让人看懂这一块。 */
export function demoFavoriteIngredients(): FavoriteIngredient[] {
  return [
    {
      id: "demo-fav-eggs",
      demo: true,
      name: "鸡蛋",
      category: "乳品蛋类",
      icon: "🥚",
      reason: "早餐常做",
      recipeCount: 2,
    },
    {
      id: "demo-fav-tomato",
      demo: true,
      name: "番茄",
      category: "蔬菜水果",
      icon: "🍅",
      reason: "家常菜几乎都会用",
      recipeCount: 3,
    },
    {
      id: "demo-fav-chicken",
      demo: true,
      name: "鸡腿",
      category: "肉类海鲜",
      icon: "🍗",
      reason: "正餐首选",
      recipeCount: 1,
    },
  ];
}

function likedRecipe(recipe: RecipeSignal) {
  return (
    Boolean(recipe.isFavorite) ||
    Number(recipe.cookedCount) > 0 ||
    Number(recipe.averageRating) >= 8
  );
}

/**
 * 从菜谱里抽出常吃的食材。优先看收藏 / 做过 / 高分的菜；
 * 这类菜还没有时退回全部菜谱，仍然抽不出就交给调用方用默认模板。
 */
export function favoriteIngredientsFromRecipes(recipes: RecipeSignal[], limit = 5): FavoriteIngredient[] {
  const pool = recipes.filter(likedRecipe);
  const source = pool.length ? pool : recipes;
  const tallies = new Map<
    string,
    { name: string; count: number; titles: string[]; favoriteBoost: number }
  >();

  for (const recipe of source) {
    const title = String(recipe.title ?? "").trim();
    const weight = Boolean(recipe.isFavorite) ? 2 : 1;
    for (const ingredient of recipe.ingredients ?? []) {
      if (pantrySources.has(String(ingredient.source ?? ""))) continue;
      const name = String(ingredient.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const current = tallies.get(key) ?? { name, count: 0, titles: [], favoriteBoost: 0 };
      current.count += 1;
      current.favoriteBoost += weight;
      if (title && !current.titles.includes(title)) current.titles.push(title);
      tallies.set(key, current);
    }
  }

  return [...tallies.values()]
    .sort((left, right) => right.favoriteBoost - left.favoriteBoost || right.count - left.count)
    .slice(0, limit)
    .map((item) => {
      const look = lookFor(item.name);
      return {
        id: `fav-${item.name}`,
        name: item.name,
        category: look.category,
        icon: look.icon,
        reason: "常做的菜会用到",
        reasonTitle: item.titles[0],
        recipeCount: item.count,
      };
    });
}
