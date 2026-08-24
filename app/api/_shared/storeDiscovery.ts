import { env } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE } from "../../dateTime";
import { createOpenAIResponse, outputText, type OpenAIConfig } from "./openai";
import { UserFacingError } from "./observability";

/**
 * 按邮编找附近的超市，并把它们并进全局的门店目录。
 *
 * 为什么这件事做得成：读 flyer 那一步早就通用了——`searchFallback` 喂给模型的
 * 只有「名字 + 地址 + 官方 flyer 网址」，加一家新店不需要写新爬虫。所以缺的
 * 只有这一环：给定邮编，这三样从哪来。用的是同一个能力，让模型搜一次。
 *
 * 目录是全局的：同一个片区的第二个人直接命中已有结果，一个 token 都不花。
 * 这也是「一份 flyer 解析一次供所有住户共用」那条设计的自然延伸。
 *
 * 代价是一个人搜出来的脏数据别人也看得到，所以下面每一条都要过 validate()，
 * 并且记下 discovered_by——目录长大之后，出了问题要追得回来。
 */

/**
 * 邮编 → 片区。
 *
 * 加拿大邮编 V3J 1N4 的前三位（FSA）大致就是一个街区，正好是「附近的超市」
 * 这个问题的粒度。美国 ZIP 取前三位是一个更粗的区域，够用。
 *
 * 按完整邮编缓存会让隔壁楼的人重搜一遍；按省份缓存又会把两百公里外的店算成附近。
 */
export function areaOf(postalCode: string) {
  const cleaned = String(postalCode ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 3) return "";
  return cleaned.slice(0, 3);
}

export type DiscoveredStore = {
  sourceKey: string;
  name: string;
  address: string;
  chain: string;
  flyerUrl: string;
  flyerFormat: string;
  /** 这一条是从缓存里来的（免费），还是这次刚搜出来的。 */
  cached: boolean;
};

type Row = {
  sourceKey: string;
  name: string;
  address: string;
  chain: string | null;
  flyerUrl: string;
  flyerFormat: string;
};

/** 这个片区已经知道的店。命中就不用调模型。 */
export async function storesInArea(area: string): Promise<DiscoveredStore[]> {
  if (!area) return [];
  const { results } = await env.DB.prepare(
    `SELECT s.source_key AS sourceKey, s.name, s.address, s.chain,
            s.flyer_url AS flyerUrl, s.flyer_format AS flyerFormat
       FROM flyer_source_areas a
       JOIN flyer_sources s ON s.source_key = a.source_key
      WHERE a.area = ?
      ORDER BY s.name`,
  )
    .bind(area)
    .all<Row>();
  return (results ?? []).map((row) => ({
    sourceKey: row.sourceKey,
    name: row.name,
    address: row.address,
    chain: row.chain ?? "",
    flyerUrl: row.flyerUrl,
    flyerFormat: row.flyerFormat,
    cached: true,
  }));
}

/**
 * 名字 + 地址压成一个稳定的键。
 *
 * 去重靠它：同一家店被两个人在两个邮编下搜出来，应当是目录里的同一行，
 * 否则同一份 flyer 会被解析两遍——正是「全局目录」想省掉的那件事。
 *
 * 只留字母数字并转小写，能吃掉 "#100 - 329 North Rd" 和 "329 North Road" 之间
 * 大部分的写法差异；吃不掉的那部分（Road/Rd）由下面的 street number 兜底。
 */
function identityKey(name: string, address: string) {
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  // 门牌号是地址里最不会被改写的部分，拿它当地址的指纹。
  const streetNumber = (address.match(/\d{2,6}/) ?? [""])[0];
  return `${squash(name)}-${streetNumber}`;
}

function sourceKeyFor(name: string, address: string) {
  const base = identityKey(name, address).slice(0, 40);
  return base ? `auto-${base}` : "";
}

/**
 * 一条搜索结果能不能进目录。
 *
 * 模型会编店：地址像模像样，flyer 网址却指向一个不存在的页面，甚至指向别的连锁。
 * 这里不联网验证（那会让一次搜索变成十几个 fetch，还容易被目标站挡），
 * 只做形状检查，真正的确认交给用户——结果是列出来让人挑，不是直接入库。
 */
function validate(raw: unknown): DiscoveredStore | null {
  const item = raw as Record<string, unknown>;
  const name = String(item.name ?? "").trim();
  const address = String(item.address ?? "").trim();
  const chain = String(item.chain ?? "").trim();
  const flyerUrl = String(item.flyerUrl ?? "").trim();
  const distanceKm = Number(item.distanceKm);
  if (!name || !address || !flyerUrl) return null;
  if (name.length > 80 || address.length > 200) return null;
  if (Number.isFinite(distanceKm) && distanceKm > 5) return null;

  let url: URL;
  try {
    url = new URL(flyerUrl);
  } catch {
    return null;
  }
  // 只收 https。http 的 flyer 页面在 Workers 里取不回来，也不值得为它开例外。
  if (url.protocol !== "https:") return null;
  // 带凭据的网址一律不要：那不是一个公开的 flyer 页面。
  if (url.username || url.password) return null;

  const sourceKey = sourceKeyFor(name, address);
  if (!sourceKey) return null;

  return {
    sourceKey,
    name,
    address,
    chain,
    // 新店一律走模型搜网页那条通用路径。结构化抓取要按连锁写代码，
    // 现在只有 PriceSmart 有，不能替一家没读过的店许这个承诺。
    flyerFormat: "search",
    flyerUrl: url.toString(),
    cached: false,
  };
}

const STORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    stores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          address: { type: "string" },
          chain: { type: "string" },
          flyerUrl: { type: "string" },
          distanceKm: { type: "number" },
        },
        required: ["name", "address", "chain", "flyerUrl", "distanceKm"],
      },
    },
  },
  required: ["stores"],
};

function prompt(postalCode: string) {
  return [
    `邮编 ${postalCode} 附近 5 公里以内有哪些做食品杂货的超市？`,
    "",
    "要求：",
    "- 列 5 到 10 家。大型连锁和本地华人/南亚超市都要，不要只列一个品牌",
    "- 只列真实存在、现在还在营业、并且会发每周 flyer / weekly specials 的超市",
    "- 只列距离该邮编大约 5 公里以内的店，更远的不要列",
    "- distanceKm 填大约距离（公里）",
    "- 便利店、药房、餐厅不算",
    "- address 用官方写法的完整街道地址，要带门牌号和城市",
    "- chain 填连锁品牌名（如 Walmart、T&T、Save-On-Foods）；独立超市就填店名",
    "",
    "flyerUrl 这样给：",
    "- 优先给这家连锁官网上能看到「本店」flyer 的页面",
    "- 确认不到本店专属页面时，给这个连锁官网的 flyer 总入口即可——后面读取时",
    "  会连同店名和地址一起去找，所以总入口是有用的",
    "- 一律不要第三方聚合站（flipp、reebee、salewhale 之类）",
    "- 连这个连锁的官网 flyer 入口都找不到，那就整家不要列",
  ].join("\n");
}

/**
 * 搜一次，把结果并进目录。
 *
 * 先查缓存：这个片区已经有店就直接返回，不调模型。这是「全局目录」省钱的地方，
 * 也是它存在的理由。
 */
export async function discoverStores(
  postalCode: string,
  openAI: OpenAIConfig,
  discoveredBy: string,
): Promise<{ area: string; stores: DiscoveredStore[]; fromCache: boolean }> {
  const area = areaOf(postalCode);
  if (!area) throw new UserFacingError("请填写有效的邮编", 400);

  const cached = await storesInArea(area);
  if (cached.length) return { area, stores: cached, fromCache: true };

  if (!openAI.apiKey) throw new UserFacingError("还没有可用的 OpenAI 密钥，请在设置里填上你自己的", 503);

  const response = await createOpenAIResponse(
    {
      model: openAI.model,
      store: false,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "required",
      input: [
        {
          role: "system",
          content:
            "你是谨慎的门店资料助手。只写官方页面上能查到的门店，绝不编造地址或 flyer 网址；拿不准就少列一家。",
        },
        { role: "user", content: prompt(postalCode) },
      ],
      text: { format: { type: "json_schema", name: "nearby_stores", strict: true, schema: STORE_SCHEMA } },
    },
    openAI,
  );

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new UserFacingError(
      (body.error as { message?: string } | undefined)?.message || "附近门店搜索失败",
      502,
    );
  const text = outputText(body);
  if (!text) throw new UserFacingError("搜索没有返回可用内容，请稍后再试", 502);

  const parsed = JSON.parse(text) as { stores?: unknown[] };
  const seen = new Set<string>();
  const fresh: DiscoveredStore[] = [];
  for (const raw of parsed.stores ?? []) {
    const store = validate(raw);
    if (!store || seen.has(store.sourceKey)) continue;
    seen.add(store.sourceKey);
    fresh.push(store);
  }

  if (!fresh.length) return { area, stores: [], fromCache: false };

  await env.DB.batch([
    // 目录是全局的：这家店可能已经被别的片区搜出来过，那就不动它已有的信息。
    ...fresh.map((store) =>
      env.DB.prepare(
        `INSERT INTO flyer_sources (source_key, name, address, flyer_url, flyer_format, timezone, chain, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO NOTHING`,
      ).bind(
        store.sourceKey,
        store.name,
        store.address,
        store.flyerUrl,
        store.flyerFormat,
        DEFAULT_TIME_ZONE,
        store.chain,
        discoveredBy,
      ),
    ),
    ...fresh.map((store) =>
      env.DB.prepare(
        `INSERT INTO flyer_source_areas (area, source_key, discovered_by) VALUES (?, ?, ?)
         ON CONFLICT(area, source_key) DO NOTHING`,
      ).bind(area, store.sourceKey, discoveredBy),
    ),
  ]);

  return { area, stores: fresh, fromCache: false };
}
