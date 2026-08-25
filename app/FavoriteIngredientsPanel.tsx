"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppSettings } from "./AppSettings";
import { readJson } from "./apiClient";
import { demoFavoriteIngredients, favoriteIngredientsFromRecipes } from "./favoriteIngredients";

type RecipeRow = {
  title?: string;
  isFavorite?: number | boolean;
  cookedCount?: number;
  averageRating?: number | null;
  ingredients?: { name?: string | null; source?: string | null }[];
};

export function FavoriteIngredientsPanel() {
  const { t, tv } = useAppSettings();
  const [recipes, setRecipes] = useState<RecipeRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/recipe-workspace", { cache: "no-store" })
      .then(async (response) => {
        const data = await readJson<{ recipes?: RecipeRow[] }>(response);
        if (!response.ok) throw new Error(data.error || t("读取失败"));
        if (!cancelled) setRecipes(data.recipes ?? []);
      })
      .catch(() => {
        if (!cancelled) setRecipes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const picks = useMemo(() => {
    const real = favoriteIngredientsFromRecipes(recipes ?? [], 3);
    return real.length ? real : demoFavoriteIngredients();
  }, [recipes]);

  const showingDemo = picks.some((item) => item.demo);

  return (
    <section className="panel favorite-ingredients-panel" id="favorite-ingredients">
      <div className="section-head">
        <div>
          <p className="eyebrow">{t("家庭口味")}</p>
          <h2>{t("喜爱食材")}</h2>
        </div>
        <a className="text-button" href="/recipes">
          {t("查看本周菜谱")} <span>→</span>
        </a>
      </div>
      <p className="settings-note favorite-ingredients-lead">
        {showingDemo
          ? t("当前为示例。收藏或做过几道菜之后，这里会换成家人真正爱吃的食材。")
          : t("根据收藏、评分和做过的菜，列出家里常出现的食材。")}
      </p>
      <ol className="favorite-ingredient-list" aria-label={t("喜爱食材")}>
        {picks.map((item, index) => (
          <li key={item.id} className={item.demo ? "favorite-ingredient-row demo" : "favorite-ingredient-row"}>
            <span className="favorite-ingredient-rank" aria-hidden="true">
              {index + 1}
            </span>
            <span className="favorite-ingredient-icon" aria-hidden="true">
              {item.icon}
            </span>
            <div className="favorite-ingredient-copy">
              <strong>
                {tv(item.name)}
                {item.demo && <span className="demo-tag">{t("示例")}</span>}
              </strong>
              <small>
                {item.reasonTitle
                  ? t("出自「{title}」", { title: item.reasonTitle })
                  : t(item.reason)}
              </small>
            </div>
            <em>{t("{count} 道菜", { count: item.recipeCount })}</em>
          </li>
        ))}
      </ol>
    </section>
  );
}
