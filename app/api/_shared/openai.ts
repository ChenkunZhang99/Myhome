import { env } from "cloudflare:workers";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";
import { UserFacingError } from "./observability";

/**
 * 密钥来源有两处，优先级从高到低：
 *  1. 请求头 `x-openai-key` —— 用户在浏览器里自己填的（BYO key），只存在他自己的
 *     localStorage 里；服务端不落库、不回显、不写日志。
 *  2. 环境变量 OPENAI_API_KEY —— 私有部署用 `wrangler secret put` 设置，
 *     也是定时任务（没有浏览器可问）唯一能用的来源。
 *
 * **服务端那份只给部署者自己的家用。** 别的住户要用 AI 功能就自己填一个。
 * 花的是部署者的钱，不该因为某个人被邀请进来、或者以后开放了注册，
 * 就变成谁登录了谁都能刷。哪一家算「自己的家」由 AI_HOUSEHOLD 指定，
 * 默认是第一个账号接管的那个默认住户。
 */
export const API_KEY_HEADER = "x-openai-key";
export const MODEL_HEADER = "x-openai-model";

const DEFAULT_MODEL = "gpt-5.6-luna";

export type OpenAIConfig = {
  apiKey: string;
  model: string;
  /** 没有密钥时的原因。用来分辨「从没填过」和「免费次数用完了」。 */
  reason?: "none" | "quota";
};

/**
 * 没有密钥时该对用户说什么。
 *
 * 两种情况看起来一样（apiKey 是空的），但对用户是两件事：一件是「这个功能
 * 你还没开通」，另一件是「你已经用过 20 次了」。混成一句会让人以为设置丢了。
 */
export function missingKeyMessage(config: OpenAIConfig) {
  return config.reason === "quota"
    ? `免费体验的 ${FREE_SHARED_CALLS} 次已经用完了，继续用请在设置里填上你自己的 OpenAI 密钥`
    : "还没有可用的 OpenAI 密钥，请在设置里填上你自己的";
}

/** 只接受长得像密钥的值：避免把任意内容原样拼进 Authorization 头。 */
function sanitizeKey(value: string | null) {
  const key = (value ?? "").trim();
  return /^[A-Za-z0-9._-]{20,200}$/.test(key) ? key : "";
}

/**
 * 环境变量里的密钥，和请求头那份走同一套校验。
 *
 * 以前这里只做 trim。trim 只去掉首尾空白——中间夹一个换行、两头带着引号、
 * 或者整行连变量名一起粘了进来，都会原样拼进 Authorization 头，
 * 于是请求在到达模型之前就被网关拒掉，回一句没有任何细节的 "Bad Request"。
 * 那种错误最难查：看起来像是我们的请求体写错了，其实是密钥的形状不对。
 *
 * 现在形状不对就当作没配，并且记一条日志说明原因——记长度和字符类别，不记内容。
 */
function envKey() {
  const raw = (env as typeof env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY ?? "";
  const key = sanitizeKey(raw);
  if (!key && raw.trim()) {
    const trimmed = raw.trim();
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        scope: "openai",
        problem: "服务端密钥格式不合法，已当作未配置",
        length: trimmed.length,
        hasWhitespaceInside: /\s/.test(trimmed),
        hasQuotes: /["']/.test(trimmed),
        hasEquals: trimmed.includes("="),
        startsWithSk: trimmed.startsWith("sk-"),
      }),
    );
  }
  return key;
}

/** 允许用服务端密钥的那一家。 */
function serverKeyHousehold() {
  const configured = (env as typeof env & { AI_HOUSEHOLD?: string }).AI_HOUSEHOLD?.trim();
  return configured || DEFAULT_HOUSEHOLD_ID;
}

function envModel() {
  return (env as typeof env & { OPENAI_MODEL?: string }).OPENAI_MODEL?.trim() || "";
}

function sanitizeModel(value: string | null) {
  const model = (value ?? "").trim();
  return /^[A-Za-z0-9._-]{1,60}$/.test(model) ? model : "";
}

/** 每个家可以白用服务端密钥的次数。用完之后要填自己的。 */
export const FREE_SHARED_CALLS = 20;

/**
 * 记一次服务端密钥的使用，用完了就返回 false。
 *
 * 判断和记账必须是同一条语句：读一次再写一次的话，同时打进来的两个请求
 * 会读到同一个旧值，双双通过——配额说是 20，实际能刷出多少取决于并发。
 * `WHERE ai_quota.used < ?` 让 SQLite 自己拦，配额满时 changes 为 0。
 *
 * 先扣后用，不是用成功了再扣。失败也扣看起来不近人情，但反过来
 * 意味着「让它失败」就能无限刷——而每一次失败的调用同样是要付钱的。
 */
export async function takeSharedCall(householdId: string) {
  const result = await env.DB.prepare(
    `INSERT INTO ai_quota (household_id, used) VALUES (?1, 1)
     ON CONFLICT(household_id) DO UPDATE SET used = used + 1, updated_at = CURRENT_TIMESTAMP
     WHERE ai_quota.used < ?2`,
  )
    .bind(householdId, FREE_SHARED_CALLS)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 这个家还剩几次。只用来在界面上显示，不作为放行依据。 */
export async function remainingSharedCalls(householdId: string) {
  const row = await env.DB.prepare("SELECT used FROM ai_quota WHERE household_id = ?")
    .bind(householdId)
    .first<{ used: number }>();
  return Math.max(0, FREE_SHARED_CALLS - Number(row?.used ?? 0));
}

/**
 * 取出这次请求该用哪个密钥。
 *
 * householdId 必须显式传：
 *  - 传住户标识 —— 只有它等于 serverKeyHousehold() 时才拿得到服务端那份
 *  - 传 null —— 定时任务，没有请求者可言，按部署者本人处理
 *
 * 做成必填参数是有意的。写成可选的话，将来新增一个 AI 接口时很容易忘了传，
 * 而忘记的后果是那个接口对所有住户都放开了服务端密钥——一个不会报错、
 * 只会在账单上出现的疏漏。
 */
export function getOpenAIConfig(request: Request | undefined, householdId: string | null): OpenAIConfig {
  const headerKey = request ? sanitizeKey(request.headers.get(API_KEY_HEADER)) : "";
  const headerModel = request ? sanitizeModel(request.headers.get(MODEL_HEADER)) : "";
  const mayUseServerKey = householdId === null || householdId === serverKeyHousehold();
  return {
    apiKey: headerKey || (mayUseServerKey ? envKey() : ""),
    model: headerModel || envModel() || DEFAULT_MODEL,
  };
}

/**
 * 和上面一样，但别的家也能白用服务端密钥若干次。
 *
 * 部署者自己那个家不限次；定时任务（householdId 为 null）也不限，它没有
 * 请求者可言。其余每个家有 FREE_SHARED_CALLS 次，用完就回到「填自己的密钥」。
 *
 * 自带密钥的请求根本不碰配额——那花的是他自己的钱，没有理由计数。
 *
 * 密钥本身从不离开服务端：这里只把它交给同进程的 fetch，
 * 任何响应里都不会出现它，所以「白用」只能通过这个网站自己的功能兑现。
 */
export async function getSharedOpenAIConfig(
  request: Request | undefined,
  householdId: string | null,
): Promise<OpenAIConfig & { usedSharedCall: boolean }> {
  const own = getOpenAIConfig(request, householdId);
  if (own.apiKey) return { ...own, usedSharedCall: false };
  // 走到这里说明既没带自己的密钥，也不是那个可以无限用的家。
  if (householdId === null) return { ...own, usedSharedCall: false };
  // 部署者压根没配服务端密钥时，没有「免费次数」可言，别拿配额去骗人。
  if (!envKey()) return { ...own, reason: "none", usedSharedCall: false };
  const allowed = await takeSharedCall(householdId);
  if (!allowed) return { ...own, reason: "quota", usedSharedCall: false };
  return { apiKey: envKey(), model: own.model, usedSharedCall: true };
}

/**
 * 从 Responses API 的返回里取出那段文本。
 *
 * 结构比看上去绕：正文藏在 output[].content[] 里 type 为 output_text 的那一项，
 * 而有些返回又直接给一个顶层 output_text。两种都要认。
 */
export function outputText(response: Record<string, unknown>) {
  const output = Array.isArray(response.output)
    ? (response.output as Array<{ content?: Array<{ type?: string; text?: string }> }>)
    : [];
  for (const item of output)
    for (const content of item.content ?? [])
      if (content.type === "output_text" && content.text) return content.text;
  return typeof response.output_text === "string" ? response.output_text : "";
}

export async function createOpenAIResponse(body: Record<string, unknown>, config: OpenAIConfig) {
  // 没有密钥不是程序缺陷，而是使用者还没填，提示要能直接看懂。
  if (!config.apiKey) throw new UserFacingError(missingKeyMessage(config), 503);
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
