import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the household inventory product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /家里有数/);
  assert.match(html, /家庭库存/);
  assert.match(html, /上传小票/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps inventory editing, unit steps, recommendations, and OpenAI configuration wired", async () => {
  const [
    page,
    openai,
    receipt,
    planner,
    recommendation,
    recipe,
    workspace,
    workspaceRoute,
    recipeFiles,
    skill,
    schema,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_shared/openai.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/receipts/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PlannerPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/flyerRecommendations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/recipes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/RecipeWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/recipe-workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/recipe-files/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/flyer-recommendation-rules.md", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_shared/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /编辑全部资料/);
  assert.match(page, /const unitGroups/);
  assert.match(page, /getUnitStep/);
  assert.match(page, /inventoryGroups/);
  assert.match(page, /inventory-group-heading/);
  assert.match(page, /剩余百分比/);
  assert.match(page, /−20%/);
  assert.match(page, /＋20%/);
  assert.match(page, /remaining-track/);
  assert.match(page, /\["g", "ml"\]/);
  assert.match(page, /\["kg", "lb", "L"\]/);
  assert.match(openai, /OPENAI_API_KEY/);
  assert.match(openai, /OPENAI_MODEL/);
  assert.match(openai, /gpt-5.6-luna/);
  // 自带密钥：请求头优先于环境变量，且密钥不得被落库或回显。
  assert.match(openai, /x-openai-key/);
  assert.match(openai, /headerKey || envKey()/);
  assert.match(receipt, /createOpenAIResponse/);
  assert.match(planner, /智能补货建议/);
  assert.match(planner, /必须补货/);
  assert.match(planner, /修改匹配/);
  assert.match(planner, /用它做菜/);
  assert.match(planner, /以后不推荐/);
  assert.match(planner, /本周采购方案/);
  assert.match(planner, /RecipeWorkspace/);
  assert.match(workspace, /本周菜谱/);
  assert.match(workspace, /自定义菜谱/);
  assert.match(workspace, /家庭点菜池/);
  assert.match(workspace, /未来三天/);
  assert.match(workspace, /喜爱度：1–10分/);
  assert.match(workspace, /Tag（使用逗号分隔，可完全手动修改）/);
  assert.match(workspace, /点击查看食材与具体步骤/);
  assert.doesNotMatch(workspace, /查看详细做法/);
  assert.match(workspace, /具体步骤/);
  assert.match(workspace, /recipe-detail-modal/);
  assert.match(workspace, /AI 为你推荐/);
  assert.match(workspace, /我的菜谱库/);
  assert.match(workspace, /家庭忌口设置/);
  assert.match(workspace, /AI 推荐已启用家庭忌口/);
  assert.match(workspace, /菜谱照片（最多 2 张）/);
  assert.match(workspace, /catalog-recipe-photo/);
  assert.match(workspace, /完成并评分/);
  assert.match(schema, /recipe_catalog/);
  assert.match(schema, /household_members/);
  assert.match(schema, /meal_requests/);
  assert.match(schema, /recipe_cook_history/);
  assert.match(workspaceRoute, /generateShopping/);
  assert.match(schema, /DELETE FROM recipe_suggestions/);
  assert.match(schema, /DELETE FROM recipe_favorites/);
  assert.match(schema, /action = '删除菜谱'/);
  assert.match(workspaceRoute, /savePreferences/);
  assert.match(schema, /recipe_attachments/);
  assert.match(recipeFiles, /MAX_FILES_PER_RECIPE = 2/);
  assert.match(recipeFiles, /env\.UPLOADS\.put/);
  assert.match(recipe, /家庭过敏食材（绝对禁止）/);
  assert.match(recipe, /containsRestrictedFood/);
  assert.match(recommendation, /recommendFlyerDeals/);
  assert.match(recommendation, /洗碗球/);
  assert.match(recommendation, /洗衣球/);
  assert.match(recipe, /当前库存/);
  assert.match(recipe, /当前有效 Flyer 优惠/);
  assert.match(recipe, /source/);
  assert.match(schema, /recipe_favorites/);
  assert.match(recipe, /export async function POST/);
  assert.doesNotMatch(recipe, /export async function (GET|PATCH)/);
  assert.match(skill, /targeted match/);
  assert.match(skill, /category match/);
});
