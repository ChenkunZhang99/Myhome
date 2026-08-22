"use client";

import { readJson } from "./apiClient";

/**
 * 菜谱的分享与 AI 补全。
 *
 * 分享用的文件和整库备份是两回事：备份是「我的全部数据」，分享是「这一道菜」。
 * 所以格式带自己的标记，导入时能一眼分清，也不会有人把整库备份当菜谱导进来。
 */

export const RECIPE_FORMAT = "home-stock-planner/recipes";
export const RECIPE_VERSION = 1;

/** 只带菜谱本身，不带收藏状态、做过几次、评分——那些属于导出的人，不属于这道菜。 */
export type SharedRecipe = {
  title: string;
  icon: string;
  summary: string;
  reason: string;
  origin: string;
  cookTime: string;
  difficulty: string;
  servings: number;
  ingredients: Array<{ name: string; amount: string; source: "inventory" | "flyer" | "pantry" }>;
  steps: string[];
  tags: string[];
  mealTypes: string[];
};

type RecipeLike = SharedRecipe & { id: string };

export function toSharedRecipe(recipe: RecipeLike): SharedRecipe {
  return {
    title: recipe.title,
    icon: recipe.icon,
    summary: recipe.summary,
    reason: recipe.reason,
    origin: recipe.origin,
    cookTime: recipe.cookTime,
    difficulty: recipe.difficulty,
    servings: recipe.servings,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    tags: recipe.tags,
    mealTypes: recipe.mealTypes,
  };
}

export function buildRecipeFile(recipes: RecipeLike[]) {
  return JSON.stringify(
    {
      format: RECIPE_FORMAT,
      version: RECIPE_VERSION,
      exportedAt: new Date().toISOString(),
      recipes: recipes.map(toSharedRecipe),
    },
    null,
    2,
  );
}

export function parseRecipeFile(text: string): SharedRecipe[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("这个文件不是有效的 JSON");
  }
  const file = parsed as { format?: string; version?: number; recipes?: SharedRecipe[] };
  if (file.format !== RECIPE_FORMAT) throw new Error("这个文件不是分享出来的菜谱");
  if (!Number.isInteger(file.version) || Number(file.version) > RECIPE_VERSION)
    throw new Error("这份菜谱来自更新的版本，请先升级应用");
  if (!Array.isArray(file.recipes) || !file.recipes.length) throw new Error("这个文件里没有菜谱");
  return file.recipes;
}

/** 触发一次浏览器下载。文件名带菜名，收到的人不用打开就知道是什么。 */
export function downloadRecipeFile(recipes: RecipeLike[]) {
  const name = recipes.length === 1 ? recipes[0].title : `${recipes.length} 道菜谱`;
  const blob = new Blob([buildRecipeFile(recipes)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  // 不撤销的话这个 blob 会一直占着内存直到刷新页面。
  URL.revokeObjectURL(url);
}

/**
 * 模型能填出来的部分。
 *
 * 比 SharedRecipe 少了 tags 和 mealTypes——服务端的 cleanGeneratedRecipe 不产出
 * 这两个字段。类型照实写，编辑已有菜谱时那两项才不会被一个不存在的值冲掉。
 */
export type DraftedRecipe = Omit<SharedRecipe, "tags" | "mealTypes"> & { id: string };

/** 按一段描述生成一份草稿。返回的是初稿，交给人去改，不直接入库。 */
export async function draftRecipeFromDescription(description: string) {
  const response = await fetch("/api/recipes/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const result = await readJson<{ recipe: DraftedRecipe; demo?: boolean }>(response);
  if (!response.ok) throw new Error(result.error || "菜谱补全失败");
  return result;
}
