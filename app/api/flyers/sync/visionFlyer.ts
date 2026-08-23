import { createOpenAIResponse, outputText, type OpenAIConfig } from "../../_shared/openai.ts";
import { findFlyerImage } from "./flyerImage.ts";

export type VisionResult = { status: "ok" | "unavailable"; message: string; deals: VisionDeal[] };
import { cleanVisionDeals, schema, visionPrompt, type VisionDeal } from "./visionShape.ts";

/**
 * 把一整张 flyer 图片读成结构化优惠。
 *
 * 这是第三条路，排在结构化抓取和 Flipp 后面。它存在的理由很具体：很多超市
 * （尤其是亚洲超市）既不发结构化数据也不上 Flipp，整份 flyer 就是一张图。
 * H Mart 的是 6083×4134、17.8MB 的 JPG，页面 HTML 里连一个 $ 都没有——
 * 让模型去「搜网页」对它永远读不出东西，因为根本没有文字可读。
 *
 * 但这条路不是为 H Mart 写的：找图那一步（flyerImage.ts）按「页面上最大的
 * 那张图」判断，对没见过的店同样成立。谁没上 Flipp 就走这里。
 *
 * **图片不经过 Workers。** 只把地址交给模型去取——十几兆的图读进内存
 * 既顶内存上限也没必要。代价是那张图必须是公开可访问的。
 */

/**
 * 找到这家店的 flyer 图并读出来。
 *
 * 找不到图就明说，让调用方去走网页搜索那条路——那条路对「页面上真的有文字」
 * 的店仍然有用，两者是互补的，不是替代。
 */
export async function readFlyerImage(
  storeName: string,
  flyerUrl: string,
  today: string,
  openAI: OpenAIConfig,
): Promise<VisionResult> {
  if (!openAI.apiKey) return { status: "unavailable", message: "没有可用的模型密钥", deals: [] };

  const image = await findFlyerImage(flyerUrl);
  if (!image) return { status: "unavailable", message: "这个页面上没找到 flyer 图片", deals: [] };

  try {
    const response = await createOpenAIResponse(
      {
        model: openAI.model,
        store: false,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content: "你是谨慎的超市 flyer 录入员。只录入图上看得清的商品和价格，看不清就不录，绝不猜测。",
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: visionPrompt(storeName, today) },
              // detail: high 会把大图切片细看。这张图上的价格是小字，
              // 用默认精度读出来的数字不可信。
              { type: "input_image", image_url: image.url, detail: "high" },
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "flyer_vision", strict: true, schema } },
      },
      openAI,
    );

    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const message = (body.error as { message?: string } | undefined)?.message ?? "";
      note({ store: storeName, status: response.status, problem: message.slice(0, 200) });
      return { status: "unavailable", message: "读取 flyer 图片失败", deals: [] };
    }
    const text = outputText(body);
    if (!text) return { status: "unavailable", message: "模型没有返回可用内容", deals: [] };

    const parsed = JSON.parse(text) as { readable?: boolean; note?: string };
    const { deals, validFrom, validTo } = cleanVisionDeals(parsed, today);
    note({ store: storeName, image: image.url, bytes: image.bytes, validFrom, validTo, kept: deals.length });

    if (!deals.length)
      return {
        status: "unavailable",
        message:
          parsed.readable === false
            ? String(parsed.note ?? "这张 flyer 读不出来")
            : "这张 flyer 上没有当前生效的优惠",
        deals: [],
      };
    return { status: "ok", message: `已从 flyer 图片读出 ${deals.length} 项优惠`, deals };
  } catch (error) {
    note({ store: storeName, problem: error instanceof Error ? error.message : String(error) });
    return { status: "unavailable", message: "读取 flyer 图片失败", deals: [] };
  }
}

/**
 * 留一行日志。
 *
 * 视觉这条路花的是真钱（一次大图 high detail 不便宜），而失败的样子往往是
 * 「读回来零条」而不是报错。记下图有多大、读出的有效期、留下几条，
 * 才分得清是图没找对、日期读错，还是过滤过严。
 */
function note(detail: Record<string, unknown>) {
  console.warn(JSON.stringify({ at: new Date().toISOString(), scope: "flyers.vision", ...detail }));
}
