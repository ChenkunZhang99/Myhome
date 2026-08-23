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

export type OpenAIConfig = { apiKey: string; model: string };

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
  if (!config.apiKey) throw new UserFacingError("尚未配置 OpenAI API 密钥，请在设置里填写后再试", 503);
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
