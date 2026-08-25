import assert from "node:assert/strict";
import test from "node:test";
import {
  demoFavoriteIngredients,
  favoriteIngredientsFromRecipes,
} from "../app/favoriteIngredients.ts";

test("demo favourite ingredients ship a fixed template for empty households", () => {
  const demo = demoFavoriteIngredients();
  assert.equal(demo.length, 3);
  assert.ok(demo.every((item) => item.demo));
  assert.deepEqual(
    demo.map((item) => item.name),
    ["鸡蛋", "番茄", "鸡腿"],
  );
});

test("favourite ingredients prefer favourited and cooked recipes and skip pantry staples", () => {
  const picks = favoriteIngredientsFromRecipes([
    {
      title: "番茄炒蛋",
      isFavorite: 1,
      cookedCount: 2,
      averageRating: 9,
      ingredients: [
        { name: "番茄", source: "inventory" },
        { name: "鸡蛋", source: "inventory" },
        { name: "盐", source: "pantry" },
      ],
    },
    {
      title: "白饭",
      isFavorite: 0,
      cookedCount: 0,
      averageRating: 5,
      ingredients: [{ name: "大米", source: "inventory" }],
    },
  ]);
  assert.deepEqual(
    picks.map((item) => item.name),
    ["番茄", "鸡蛋"],
  );
  assert.equal(picks[0].reasonTitle, "番茄炒蛋");
  assert.equal(picks.some((item) => item.name === "盐"), false);
});
