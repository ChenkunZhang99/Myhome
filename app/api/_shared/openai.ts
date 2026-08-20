import { env } from "cloudflare:workers";

/**
 * 密钥来源有两处，优先级从高到低：
 *  1. 请求头 `x-openai-key` —— 用户在浏览器里自己填的（BYO key），只存在他自己的
 *     localStorage 里；服务端不落库、不回显、不写日志。
 *  2. 环境变量 OPENAI_API_KEY —— 私有部署用 `wrangler secret put` 设置，
 *     也是定时任务（没有浏览器可问）唯一能用的来源。
 */
export const API_KEY_HEADER = "x-openai-key";
export const MODEL_HEADER = "x-openai-model";

const DEFAULT_MODEL = "gpt-5.6-luna";

export type OpenAIConfig = { apiKey: string; model: string };

function envKey() {
  return (env as typeof env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY?.trim() || "";
}

function envModel() {
  return (env as typeof env & { OPENAI_MODEL?: string }).OPENAI_MODEL?.trim() || "";
}

/** 只接受长得像密钥的值，避免把任意请求头内容原样转发出去。 */
function sanitizeKey(value: string | null) {
  const key = (value ?? "").trim();
  return /^[A-Za-z0-9._-]{20,200}$/.test(key) ? key : "";
}

function sanitizeModel(value: string | null) {
  const model = (value ?? "").trim();
  return /^[A-Za-z0-9._-]{1,60}$/.test(model) ? model : "";
}

export function getOpenAIConfig(request?: Request): OpenAIConfig {
  const headerKey = request ? sanitizeKey(request.headers.get(API_KEY_HEADER)) : "";
  const headerModel = request ? sanitizeModel(request.headers.get(MODEL_HEADER)) : "";
  return {
    apiKey: headerKey || envKey(),
    model: headerModel || envModel() || DEFAULT_MODEL,
  };
}

export async function createOpenAIResponse(body: Record<string, unknown>, config: OpenAIConfig) {
  if (!config.apiKey) throw new Error("OPENAI_API_KEY_MISSING");
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
