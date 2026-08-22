import { env } from "cloudflare:workers";
import { resolveHousehold } from "../../_shared/household";
import { failure, withRoute } from "../../_shared/observability";
import { householdTimeZone } from "../../_shared/household";
import { createOpenAIResponse, getOpenAIConfig } from "../../_shared/openai";
import { demoReceipt, isDemoMode } from "../../_shared/demo";

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

type InventoryCandidate = { id: string; name: string; category: string; unit: string };
type ExtractedItem = {
  name: string;
  quantity: number;
  unit: string;
  category: string;
  /** 实付单价。小票上有折扣时这里是折后价。 */
  unitPrice: number | null;
  /** 原价单价，只有小票上能看到划线价或 "was" 价时才有。 */
  regularUnitPrice: number | null;
  /** 这一行实付的总额，以小票印的为准，不由单价乘数量倒推。 */
  lineTotal: number | null;
  confidence: number;
};

const unitAliases: Record<string, string> = {
  pcs: "个",
  pc: "个",
  ea: "个",
  each: "个",
  ct: "个",
  count: "个",
  pk: "包",
  pack: "包",
  pkg: "包",
  bag: "袋",
  box: "盒",
  bottle: "瓶",
  can: "罐",
  公斤: "kg",
  千克: "kg",
  克: "g",
  磅: "lb",
  lbs: "lb",
  升: "L",
  毫升: "ml",
};

function normalizeUnit(value: string, category: string) {
  const cleaned = value.trim();
  const alias = unitAliases[cleaned.toLowerCase()] ?? unitAliases[cleaned];
  if (alias) return alias;
  if (cleaned) return cleaned;
  if (category === "蔬菜水果") return "个";
  if (["肉类海鲜", "冷冻食品", "零食饮料"].includes(category)) return "包";
  if (category === "乳品蛋类") return "盒";
  if (category === "米面粮油") return "袋";
  if (["调味品", "清洁用品", "洗护用品"].includes(category)) return "瓶";
  return "件";
}

function normalizeName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|lb|lbs|ml|l|oz|ct|pk|pack)\b/gi, "")
    .replace(/[0-9０-９]+(?:\.[0-9]+)?(?:公斤|千克|克|斤|磅|毫升|升|个|件|包|盒|瓶|袋|罐|支|只|枚)?/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(value: string) {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

function similarity(left: string, right: string) {
  const a = normalizeName(left),
    b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return 0.88;
  const aa = bigrams(a),
    bb = [...bigrams(b)];
  let overlap = 0;
  for (const part of aa) {
    const index = bb.indexOf(part);
    if (index >= 0) {
      overlap += 1;
      bb.splice(index, 1);
    }
  }
  return (2 * overlap) / (aa.length + bigrams(b).length);
}

/** 价格只接受正数，负数和 0 多半是把折扣行当成商品读进来了。 */
function cleanPrice(value: unknown) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null;
}

/** 小票没印行合计时，才用单价乘数量兜底。 */
function lineTotalFrom(item: { unitPrice: number | null; quantity: number }) {
  const unitPrice = cleanPrice(item.unitPrice);
  const quantity = Number(item.quantity);
  if (!unitPrice || !Number.isFinite(quantity) || quantity <= 0) return null;
  return Math.round(unitPrice * quantity * 100) / 100;
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function outputText(response: Record<string, unknown>) {
  const output = Array.isArray(response.output)
    ? (response.output as Array<{ content?: Array<{ type?: string; text?: string }> }>)
    : [];
  for (const item of output)
    for (const content of item.content ?? [])
      if (content.type === "output_text" && content.text) return content.text;
  return typeof response.output_text === "string" ? response.output_text : "";
}

export const POST = withRoute("receipts.analyze", async (request: Request) => {
  try {
    const household = await resolveHousehold(request);
    const demo = isDemoMode(request);
    const openAI = getOpenAIConfig(request, household);
    if (!demo && !openAI.apiKey)
      return Response.json({ error: "OpenAI API 私钥尚未配置到网站" }, { status: 503 });
    const form = await request.formData();
    const file = form.get("receipt");
    const preferredCategory = String(form.get("preferredCategory") ?? "").trim();
    if (!(file instanceof File) || file.size === 0)
      return Response.json({ error: "请选择小票图片" }, { status: 400 });
    if (!supportedTypes.has(file.type))
      return Response.json({ error: "请上传 JPG、PNG、WebP 或 GIF 图片" }, { status: 400 });
    if (file.size > 8 * 1024 * 1024) return Response.json({ error: "小票图片不能超过 8MB" }, { status: 400 });

    const imageUrl = demo ? "" : `data:${file.type};base64,${toBase64(await file.arrayBuffer())}`;
    const prompt = `读取这张加拿大购物小票，提取实际购买的商品。忽略税额、小计、优惠汇总、积分和付款信息。
商品名称使用简洁、适合家庭库存的中文名称；无法翻译的品牌或型号可保留英文。
quantity 必须是与 unit 对应的数值。例如 1.2kg 要填 quantity=1.2、unit=kg，不能把“1.2kg”整体写入 unit。
unit 优先使用：个、颗、棵、根、把、串、只、枚、片、块、条、份、件、包、袋、盒、瓶、罐、桶、箱、卷、板、g、kg、lb、ml、L。
category 必须是以下之一：${categories.join("、")}。
如果品类不明确${preferredCategory && categories.includes(preferredCategory) ? `，优先使用当前页面分类“${preferredCategory}”` : "，使用“其他”"}。
purchaseDate 使用 YYYY-MM-DD；看不清的字段使用空字符串或 null。confidence 范围 0 到 1。

价格必须分开读，这是这次识别最重要的部分：
- unitPrice 填实际付款的单价。小票上有会员价、特价、买一送一折算后的价格时，填折后的那个。
- regularUnitPrice 只在小票上明确印了原价（划线价、was、Reg 等）时才填，否则填 null。不要用折后价反推原价。
- lineTotal 填这一行实际计入小计的金额，以小票印的数字为准，不要用 unitPrice 乘 quantity 自己算。
- 按重量计价的商品（例如 1.24 kg × $8.80/kg = $10.91），quantity 填 1.24、unit 填 kg、unitPrice 填 8.80、lineTotal 填 10.91。
- 单独成行的折扣（例如 "SAVE -2.00"）不要作为商品录入，应当体现在它上一行商品的 unitPrice 和 lineTotal 里。`;
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string" },
        purchaseDate: { type: "string" },
        total: { anyOf: [{ type: "number" }, { type: "null" }] },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string" },
              category: { type: "string", enum: categories },
              unitPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
              regularUnitPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
              lineTotal: { anyOf: [{ type: "number" }, { type: "null" }] },
              confidence: { type: "number" },
            },
            required: [
              "name",
              "quantity",
              "unit",
              "category",
              "unitPrice",
              "regularUnitPrice",
              "lineTotal",
              "confidence",
            ],
          },
        },
      },
      required: ["store", "purchaseDate", "total", "items"],
    };
    type Extracted = { store: string; purchaseDate: string; total: number | null; items: ExtractedItem[] };
    let extracted: Extracted;

    if (demo) {
      // 演示模式不调用模型，直接用一份样例小票；下面的库存匹配逻辑照常跑。
      extracted = demoReceipt(await householdTimeZone());
    } else {
      const openAIResponse = await createOpenAIResponse(
        {
          model: openAI.model,
          store: false,
          input: [
            {
              role: "system",
              content: "你是家庭库存小票录入助手。只提取图片中有证据的商品，不要猜测不存在的商品。",
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: imageUrl, detail: "high" },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "receipt_inventory", strict: true, schema } },
        },
        openAI,
      );
      const result = (await openAIResponse.json()) as Record<string, unknown>;
      if (!openAIResponse.ok) {
        const message = (result.error as { message?: string } | undefined)?.message;
        return Response.json({ error: message || "OpenAI 暂时无法识别这张小票" }, { status: 502 });
      }
      const text = outputText(result);
      if (!text) return Response.json({ error: "小票中没有识别到可用内容" }, { status: 422 });
      extracted = JSON.parse(text) as Extracted;
    }
    const inventory = await env.DB.prepare(
      "SELECT id, name, category, unit FROM inventory_items WHERE household_id = ? ORDER BY updated_at DESC",
    )
      .bind(household)
      .all<InventoryCandidate>();
    const items = extracted.items
      .filter((item) => item.name.trim())
      .map((item) => {
        const ranked = inventory.results
          .map((candidate) => ({
            ...candidate,
            score: similarity(item.name, candidate.name) + (candidate.category === item.category ? 0.08 : 0),
          }))
          .sort((a, b) => b.score - a.score);
        const best = ranked[0] && ranked[0].score >= 0.62 ? ranked[0] : null;
        return {
          tempId: crypto.randomUUID(),
          name: item.name.trim(),
          quantity: Math.max(0.01, Number(item.quantity) || 1),
          unit: normalizeUnit(item.unit, item.category),
          category: categories.includes(item.category) ? item.category : preferredCategory || "其他",
          unitPrice: cleanPrice(item.unitPrice),
          regularUnitPrice: cleanPrice(item.regularUnitPrice),
          lineTotal: cleanPrice(item.lineTotal) ?? lineTotalFrom(item),
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
          action: best ? "merge" : "new",
          mergeItemId: best?.id ?? "",
          matchName: best?.name ?? "",
          matchScore: best ? Math.min(1, best.score) : 0,
        };
      });
    return Response.json({
      receipt: { store: extracted.store, purchaseDate: extracted.purchaseDate, total: extracted.total },
      items,
    });
  } catch (error) {
    return failure("receipts.analyze", error, "小票识别失败", 500);
  }
});
