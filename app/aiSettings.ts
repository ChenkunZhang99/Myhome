"use client";

/**
 * 自带密钥（BYO key）。
 *
 * 密钥只保存在使用者自己浏览器的 localStorage 里，随每次请求通过请求头发给
 * 本站后端，由后端转发给 OpenAI。服务端不落库、不回显、不写日志，所以即使
 * 这个站点是公开部署的，也不会替任何人保管凭据。
 *
 * 代价：定时任务（后台同步 flyer）没有浏览器可问，只能用部署方在
 * `wrangler secret` 里配置的服务端密钥。
 */

const KEY_STORAGE = "hsp.openai-key";
const MODEL_STORAGE = "hsp.openai-model";

export const API_KEY_HEADER = "x-openai-key";
export const MODEL_HEADER = "x-openai-model";

export type AiSettings = { apiKey: string; model: string };

export const emptyAiSettings: AiSettings = { apiKey: "", model: "" };

export function readAiSettings(): AiSettings {
  if (typeof window === "undefined") return emptyAiSettings;
  try {
    return {
      apiKey: window.localStorage.getItem(KEY_STORAGE)?.trim() ?? "",
      model: window.localStorage.getItem(MODEL_STORAGE)?.trim() ?? "",
    };
  } catch {
    // localStorage 可能被隐私设置禁用，这时就当作没有配置，退回演示模式。
    return emptyAiSettings;
  }
}

export function writeAiSettings(settings: AiSettings) {
  if (typeof window === "undefined") return;
  try {
    const apiKey = settings.apiKey.trim();
    const model = settings.model.trim();
    if (apiKey) window.localStorage.setItem(KEY_STORAGE, apiKey);
    else window.localStorage.removeItem(KEY_STORAGE);
    if (model) window.localStorage.setItem(MODEL_STORAGE, model);
    else window.localStorage.removeItem(MODEL_STORAGE);
  } catch {
    /* 存不进去就只能这一次会话有效，不影响功能 */
  }
  window.dispatchEvent(new Event(AI_SETTINGS_EVENT));
}

export function clearAiSettings() {
  writeAiSettings(emptyAiSettings);
}

/** 设置变更后广播，让页面上的状态提示同步更新。 */
export const AI_SETTINGS_EVENT = "hsp-ai-settings-changed";

/**
 * 密钥和模型名的形状。和服务端 sanitizeKey 用的是同一套规则。
 *
 * HTTP 头只能装 ISO-8859-1 字符。存了一个带中文、带全角标点或者带换行的值时，
 * Headers.set() 会直接抛 "String contains non ISO-8859-1 code point"——
 * 那个报错出现在点按钮的一瞬间，看起来像是功能坏了，其实是保存的值不对。
 * 与其让它抛，不如在这里就认定「没配置」。
 */
const KEY_SHAPE = /^[A-Za-z0-9._-]{20,200}$/;
const MODEL_SHAPE = /^[A-Za-z0-9._-]{1,60}$/;

/** 保存的密钥是不是一个能用的形状。界面靠它决定要不要提示用户重填。 */
export function isUsableKey(apiKey: string) {
  return KEY_SHAPE.test(apiKey.trim());
}

/** 给需要调用模型的请求补上密钥头；没配置或形状不对时什么都不加。 */
export function withAiHeaders(headers: HeadersInit = {}): HeadersInit {
  const { apiKey, model } = readAiSettings();
  if (!isUsableKey(apiKey)) return headers;
  const merged = new Headers(headers);
  merged.set(API_KEY_HEADER, apiKey.trim());
  if (MODEL_SHAPE.test(model.trim())) merged.set(MODEL_HEADER, model.trim());
  return merged;
}

/** 只用于界面展示，永远不显示完整密钥。 */
export function maskKey(apiKey: string) {
  const key = apiKey.trim();
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}
