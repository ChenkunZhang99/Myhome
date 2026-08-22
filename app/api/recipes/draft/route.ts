import { resolveHousehold } from "../../_shared/household";
import { failure, UserFacingError, withRoute } from "../../_shared/observability";
import { createOpenAIResponse, getOpenAIConfig } from "../../_shared/openai";
import { cleanGeneratedRecipe, GeneratedRecipe, RECIPE_SCHEMA } from "../../_shared/recipeShape";
import { isDemoMode } from "../../_shared/demo";

/**
 * 按一段话补全一道菜谱。
 *
 * 自建菜谱要一个个填菜名、简介、食材、步骤，是这个应用里最枯燥的一屏。
 * 这个接口接收一句「妈妈做的番茄牛腩，牛腩先焯水」，把表单填好，
 * 剩下的由人来改——补全的是初稿，不是结论。
 *
 * 和批量推荐不同的是：这里不看库存、不看优惠，只按描述来。
 * 用户此刻想记的是「这道菜」，不是「用现有食材能做什么」。
 */

function outputText(response: Record<string, unknown>) {
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return "";
}

export const POST = withRoute("recipes.draft", async (request: Request) => {
  try {
    // 会调模型就是会花钱，必须先鉴权。见 tests/ai-endpoints-gated.test.mjs。
    await resolveHousehold(request);

    const payload = (await request.json()) as { description?: string };
    const description = String(payload.description ?? "")
      .trim()
      .slice(0, 2000);
    if (description.length < 4) throw new UserFacingError("描述太短了，多写几个字");

    const openAI = getOpenAIConfig(request);
    if (isDemoMode(request)) {
      // 演示模式不花钱，返回一个能看出形状的样例，走同一条清洗路径。
      return Response.json({
        recipe: cleanGeneratedRecipe({
          title: description.slice(0, 20),
          summary: "演示模式下的示例草稿，配置密钥后会按你的描述生成。",
          reason: "",
          origin: "库存优先",
          icon: "🍲",
          cookTime: "30 分钟",
          difficulty: "简单",
          servings: 2,
          ingredients: [{ name: "主料", amount: "适量", source: "pantry" }],
          steps: ["按描述准备食材", "下锅烹饪至熟"],
        } as GeneratedRecipe),
        demo: true,
      });
    }
    if (!openAI.apiKey) throw new UserFacingError("尚未配置 OpenAI 密钥，请在设置里填写后再试", 503);

    const response = await createOpenAIResponse(
      {
        model: openAI.model,
        store: false,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content:
              "你把一段随口的描述整理成一份可执行的家庭菜谱。忠实于描述，不要擅自替换主料。" +
              "描述里没提到的细节按家常做法补齐，步骤写成一步一句、可以照着做的话。",
          },
          { role: "user", content: `把下面这段描述整理成一道菜谱：\n\n${description}` },
        ],
        text: {
          format: { type: "json_schema", name: "home_recipe_draft", strict: true, schema: RECIPE_SCHEMA },
        },
      },
      openAI,
    );
    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      // 服务商的原文留在日志里，对外只给安全文案。
      console.error(
        JSON.stringify({ at: new Date().toISOString(), scope: "recipes.draft", status: response.status }),
      );
      throw new UserFacingError("菜谱补全暂时失败，请稍后再试", 502);
    }
    const text = outputText(raw);
    if (!text) throw new UserFacingError("没有生成可用的内容，换一段描述再试", 422);

    const recipe = cleanGeneratedRecipe(JSON.parse(text) as GeneratedRecipe);
    if (!recipe.ingredients.length || !recipe.steps.length)
      throw new UserFacingError("生成的内容不完整，换一段描述再试", 422);
    return Response.json({ recipe });
  } catch (error) {
    return failure("recipes.draft", error, "菜谱补全暂时不可用", 500);
  }
});
