import { resolveHousehold, householdTimeZone } from "../../_shared/household";
import { dayIn } from "../../../dateTime";
import { failure, withRoute } from "../../_shared/observability";
import { createOpenAIResponse, getOpenAIConfig, outputText } from "../../_shared/openai";
import { demoItemScan, isDemoMode } from "../../_shared/demo";

const categories = [
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
  "清洁用品",
  "洗护用品",
  "其他",
];
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Alternative = { name: string; category: string; identityConfidence: number };
type ScannedItem = {
  name: string;
  category: string;
  quantity: number;
  unit: string;
  identityConfidence: number;
  expiryDate: string | null;
  expiryConfidence: number;
  expiryUncertain: boolean;
  expiryGuesses: string[];
  reason: string;
  alternatives: Alternative[];
};

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function defaultLocation(category: string) {
  if (["蔬菜水果", "乳品蛋类", "肉类海鲜"].includes(category)) return "冰箱";
  if (category === "冷冻食品") return "冷冻柜";
  if (category === "清洁用品") return "洗衣房";
  if (category === "洗护用品") return "卫生间";
  return "厨房储物柜";
}

function defaultUnit(category: string) {
  if (category === "蔬菜水果") return "个";
  if (["肉类海鲜", "冷冻食品", "零食饮料"].includes(category)) return "包";
  if (category === "乳品蛋类") return "盒";
  if (category === "米面粮油") return "袋";
  if (["调味品", "清洁用品", "洗护用品"].includes(category)) return "瓶";
  return "件";
}

function cleanDate(value: unknown) {
  const date = String(value ?? "").trim();
  return DATE.test(date) ? date : null;
}

function cleanGuesses(values: unknown, fallback: string | null) {
  const unique = new Set<string>();
  if (Array.isArray(values)) {
    for (const value of values) {
      const date = cleanDate(value);
      if (date) unique.add(date);
    }
  }
  if (fallback) unique.add(fallback);
  return [...unique].slice(0, 4);
}

export const POST = withRoute("items.scan", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const demo = isDemoMode(request);
    const openAI = getOpenAIConfig(request, household);
    if (!demo && !openAI.apiKey)
      return Response.json({ error: "还没有可用的 OpenAI 密钥，请在设置里填上你自己的" }, { status: 503 });

    const form = await request.formData();
    const file = form.get("photo");
    const preferredCategory = String(form.get("preferredCategory") ?? "").trim();
    if (!(file instanceof File) || file.size === 0)
      return Response.json({ error: "请拍一张物品包装照片" }, { status: 400 });
    if (!supportedTypes.has(file.type))
      return Response.json({ error: "请上传 JPG、PNG、WebP 或 GIF 图片" }, { status: 400 });
    if (file.size > 8 * 1024 * 1024) return Response.json({ error: "物品照片不能超过 8MB" }, { status: 400 });

    const timeZone = await householdTimeZone(household);
    const purchaseDate = dayIn(timeZone);
    const imageUrl = demo ? "" : `data:${file.type};base64,${toBase64(await file.arrayBuffer())}`;
    const prompt = `看这张家庭库存照片。可能是一件商品的包装，也可能是好几件放在一起。

任务：
1. 先判断照片清不清晰。糊、暗、裁掉关键文字、反光挡住标签，都算不清晰。
2. 认出照片里有几件不同的物品。每一件单独列。
3. 某件物品看不准时，列出 2–3 个最可能的名字，不要假装只有一个答案。
4. 从包装上读有效日期 / 保质期 / best before / expiry。年月日都看不清就填 null，不要编日期。
5. 购买日期不要从照片猜——调用方会写成今天。

名称用简洁中文，适合家庭库存；看不清的品牌可留英文。
quantity 必须和 unit 对应。unit 优先：个、颗、棵、根、把、串、只、枚、片、块、条、份、件、包、袋、盒、瓶、罐、桶、箱、卷、板、g、kg、lb、ml、L。
category 必须是：${categories.join("、")}。
品类不明确时${preferredCategory && categories.includes(preferredCategory) ? `优先用「${preferredCategory}」` : "用「其他」"}。
日期一律 YYYY-MM-DD。`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        imageQuality: { type: "string", enum: ["clear", "blurry", "dark", "partial"] },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              category: { type: "string", enum: categories },
              quantity: { type: "number" },
              unit: { type: "string" },
              identityConfidence: { type: "number" },
              expiryDate: { anyOf: [{ type: "string" }, { type: "null" }] },
              expiryConfidence: { type: "number" },
              expiryUncertain: { type: "boolean" },
              expiryGuesses: { type: "array", items: { type: "string" } },
              reason: { type: "string" },
              alternatives: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    category: { type: "string", enum: categories },
                    identityConfidence: { type: "number" },
                  },
                  required: ["name", "category", "identityConfidence"],
                },
              },
            },
            required: [
              "name",
              "category",
              "quantity",
              "unit",
              "identityConfidence",
              "expiryDate",
              "expiryConfidence",
              "expiryUncertain",
              "expiryGuesses",
              "reason",
              "alternatives",
            ],
          },
        },
      },
      required: ["imageQuality", "items"],
    };

    type Extracted = {
      imageQuality: "clear" | "blurry" | "dark" | "partial";
      items: ScannedItem[];
    };
    let extracted: Extracted;
    if (demo) {
      extracted = demoItemScan(timeZone);
    } else {
      const openAIResponse = await createOpenAIResponse(
        {
          model: openAI.model,
          store: false,
          input: [
            {
              role: "system",
              content:
                "你是家庭库存拍照录入助手。看不准就给选项，不要把模糊照片认成一个确定的商品，也不要编造包装上没有的日期。",
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: imageUrl, detail: "high" },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "item_photo_scan", strict: true, schema } },
        },
        openAI,
      );
      const result = (await openAIResponse.json()) as Record<string, unknown>;
      if (!openAIResponse.ok) {
        const message = (result.error as { message?: string } | undefined)?.message;
        return Response.json({ error: message || "OpenAI 暂时无法识别这张照片" }, { status: 502 });
      }
      const text = outputText(result);
      if (!text) return Response.json({ error: "照片里没有识别到可用的物品" }, { status: 422 });
      extracted = JSON.parse(text) as Extracted;
    }

    const items = (extracted.items ?? [])
      .filter((item) => item.name.trim())
      .map((item) => {
        const category = categories.includes(item.category)
          ? item.category
          : preferredCategory && categories.includes(preferredCategory)
            ? preferredCategory
            : "其他";
        const expiryDate = cleanDate(item.expiryDate);
        const identityConfidence = Math.min(1, Math.max(0, Number(item.identityConfidence) || 0));
        const alternatives = (item.alternatives ?? [])
          .filter((option) => option.name.trim() && option.name.trim() !== item.name.trim())
          .map((option) => ({
            name: option.name.trim(),
            category: categories.includes(option.category) ? option.category : category,
            identityConfidence: Math.min(1, Math.max(0, Number(option.identityConfidence) || 0)),
          }))
          .slice(0, 3);
        return {
          tempId: crypto.randomUUID(),
          name: item.name.trim(),
          category,
          quantity: Math.max(0.01, Number(item.quantity) || 1),
          unit: String(item.unit ?? "").trim() || defaultUnit(category),
          location: defaultLocation(category),
          identityConfidence,
          expiryDate,
          expiryConfidence: Math.min(1, Math.max(0, Number(item.expiryConfidence) || 0)),
          expiryUncertain: Boolean(item.expiryUncertain) || !expiryDate,
          expiryGuesses: cleanGuesses(item.expiryGuesses, expiryDate),
          reason: String(item.reason ?? "").trim(),
          alternatives,
          selected: true,
        };
      });

    const imageQuality = ["clear", "blurry", "dark", "partial"].includes(extracted.imageQuality)
      ? extracted.imageQuality
      : "partial";
    const needsChoice =
      imageQuality !== "clear" ||
      items.length !== 1 ||
      items.some((item) => item.identityConfidence < 0.75 || item.alternatives.length > 0);

    return Response.json({
      purchaseDate,
      imageQuality,
      needsChoice,
      items,
    });
  } catch (error) {
    return failure("items.scan", error, "物品照片识别失败", 500);
  }
});
