"use client";

import { readJson } from "./apiClient";

/**
 * 登录状态。
 *
 * 会话是 HttpOnly cookie，前端读不到也不该读，所以「有没有登录」只能问后端。
 * 这里把那几次请求收在一处，界面只关心结果。
 */

export type AccountState = {
  signedIn: boolean;
  email: string | null;
  /** 有没有设过密码。只是布尔值——哈希不会离开服务端。 */
  hasPassword: boolean;
  required: boolean;
};

export const signedOut: AccountState = {
  signedIn: false,
  email: null,
  hasPassword: false,
  required: false,
};

export async function fetchAccount(): Promise<AccountState> {
  const response = await fetch("/api/auth");
  const result = await readJson<AccountState>(response);
  if (!response.ok) return signedOut;
  return {
    signedIn: Boolean(result.signedIn),
    email: result.email ?? null,
    hasPassword: Boolean(result.hasPassword),
    required: Boolean(result.required),
  };
}

/**
 * 请求登录链接。
 *
 * 本地没有配置发信服务时后端会把链接直接返回，界面就地展示，
 * 这样 clone 下来的人不需要邮箱也能走完登录。
 */
export async function requestLoginLink(email: string) {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const result = await readJson<{ delivered?: "email" | "console"; link?: string }>(response);
  if (!response.ok) throw new Error(result.error || "登录链接发送失败");
  return { delivered: result.delivered ?? "email", link: result.link };
}

/**
 * 邮箱 + 密码登录。
 *
 * 失败时后端只回「邮箱或密码不对」，不区分账号是否存在——
 * 这不是含糊其辞，是不让这个接口变成邮箱枚举器。
 */
export async function signInWithPassword(email: string, password: string) {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "password", email, password }),
  });
  const result = await readJson<Record<string, never>>(response);
  if (!response.ok) throw new Error(result.error || "登录失败");
}

/** 设置或清除密码。传 null 表示以后只用邮箱链接登录。 */
export async function savePassword(password: string | null) {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "setPassword", password }),
  });
  const result = await readJson<{ hasPassword?: boolean }>(response);
  if (!response.ok) throw new Error(result.error || "密码保存失败");
  return Boolean(result.hasPassword);
}

export async function redeemLoginToken(token: string) {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "redeem", token }),
  });
  const result = await readJson<Record<string, never>>(response);
  if (!response.ok) throw new Error(result.error || "登录失败");
}

export async function signOut() {
  await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signOut" }),
  });
}

/**
 * 邮件里的链接形如 /?login=xxx。取出令牌并把它从地址栏抹掉，
 * 免得留在浏览历史或被分享出去——虽然一次性令牌用过就失效，但没必要留着。
 */
export function takeLoginTokenFromUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("login")?.trim() ?? "";
  if (!token) return "";
  url.searchParams.delete("login");
  window.history.replaceState(null, "", url.toString());
  return token;
}
