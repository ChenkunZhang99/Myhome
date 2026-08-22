import { env } from "cloudflare:workers";
import * as hash from "./passwordHash.ts";

/**
 * 密码哈希的配置层：决定跑多少轮，别的都交给 passwordHash。
 *
 * 默认 600000 轮，是 OWASP 对 PBKDF2-HMAC-SHA256 的建议值。
 * 代价要说清楚：这在普通机器上约 60ms CPU。Cloudflare Workers 免费版每个请求
 * 只有 10ms CPU，登录会直接超时；付费版是 30 秒，绰绰有余。
 * 真要部署到免费版，用 PASSWORD_ITERATIONS 调低——知道自己在降什么再降。
 */

const DEFAULT_ITERATIONS = 600_000;
/** 低于这个数就不是「调低」而是形同虚设了，直接忽略，用默认值。 */
const FLOOR = 10_000;

function iterations() {
  const configured = Number((env as typeof env & { PASSWORD_ITERATIONS?: string }).PASSWORD_ITERATIONS);
  return Number.isFinite(configured) && configured >= FLOOR ? Math.floor(configured) : DEFAULT_ITERATIONS;
}

export function hashPassword(password: string) {
  return hash.hashPassword(password, iterations());
}

export function burnVerificationTime() {
  return hash.burnVerificationTime(iterations());
}

export const verifyPassword = hash.verifyPassword;
export const assertPasswordAllowed = hash.assertPasswordAllowed;
