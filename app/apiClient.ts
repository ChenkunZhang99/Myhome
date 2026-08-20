"use client";

/**
 * Cloudflare 的运行时类型把 `Response.json()` 收窄成 `unknown`（比 DOM 的 `any` 更严格），
 * 所以这里统一在一处做断言，调用方传入自己期望的形状。
 *
 * 所有接口出错时都返回 `{ error }`，因此它被并进每个返回类型里。
 */
export type ApiError = { error?: string };

export async function readJson<T>(response: Response): Promise<T & ApiError> {
  return (await response.json()) as T & ApiError;
}
