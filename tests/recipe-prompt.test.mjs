import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 推荐提示词的几条约束。
 *
 * 出「姜汁蒸蛋」这种菜不是模型跑偏，是规则被严格执行的结果：原先只给库存和优惠、
 * 又硬性禁止引入外部食材，等于要求它在一堆原料里做排列组合。真实的家常菜是
 * 先有菜名再倒推食材，所以现在要求「必须是有名字的常见菜」，并允许补一两样。
 *
 * 这几条容易在后续调整时被无意抹掉，钉在这里。
 */

const route = await readFile(new URL("../app/api/recipes/route.ts", import.meta.url), "utf8");

test("口味样本进了提示词——否则模型不知道这家人吃什么", () => {
  assert.match(
    route,
    /is_favorite = 1 OR recipe_catalog\.cooked_count > 0/,
    "收藏和做过的菜是唯一的口味依据",
  );
  assert.match(route, /口味样本/, "查出来还得真的喂进提示词");
});

test("说过不要的菜会被带进提示词", () => {
  assert.match(route, /action = '不再推荐'/);
  assert.match(route, /明确说过不要再推荐的菜/, "查出来不喂进去等于没做");
});

test("要求推真实存在的菜，而不是凑食材", () => {
  assert.match(route, /有通用菜名、家常菜谱里查得到的菜/);
  assert.match(route, /不要把手头的食材凑成一道新菜/);
});

test("允许少量额外购买——那条硬约束正是怪菜的来源", () => {
  assert.match(route, /最多允许 2 样需要额外购买的常见食材/);
  const shape = "app/api/_shared/recipeShape.ts";
  return readFile(new URL("../" + shape, import.meta.url), "utf8").then((code) => {
    assert.match(code, /"buy"/, "buy 必须在允许的来源枚举里，否则模型填了会被清洗掉");
  });
});

test("生成结果进日志——不然坏例子没处找", () => {
  assert.match(route, /event: "generated"/);
  assert.match(route, /titles: recipes\.map/);
});

test("判断一道菜正不正常需要推理，不能用最低档", () => {
  assert.match(route, /reasoning: \{ effort: "medium" \}/);
});
