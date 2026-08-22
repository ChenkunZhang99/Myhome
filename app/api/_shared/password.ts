import { env } from "cloudflare:workers";
import * as hash from "./passwordHash.ts";

/**
 * 密码哈希的配置层：决定跑多少轮，别的都交给 passwordHash。
 *
 * 20000 轮是一个有意为之的妥协，不是疏忽。OWASP 对 PBKDF2-HMAC-SHA256 的
 * 建议值是 600000，约 60ms CPU；而 Cloudflare Workers 免费版每个请求只有
 * 10ms CPU，跑那个数字登录会直接超时。这个项目要跑在免费版上。
 *
 * 20000 轮实测约 2ms，占 10ms 预算的两成，留给请求里其余部分足够余量
 * （即使 Workers 的 CPU 比开发机慢一倍也不会顶到上限）。
 *
 * 放弃的是什么：库一旦泄露，离线爆破的成本只有 600000 轮的三十分之一。
 * 对一个记录家庭库存的应用，这个取舍是划算的——但如果哪天这里开始存
 * 值钱的东西，或者迁到了 Workers 付费版（单请求 30 秒 CPU），
 * 第一件该做的事就是把 PASSWORD_ITERATIONS 调回 600000。
 * 存量密码不受影响：哈希串自带轮数，老的仍按老参数验证。
 */

const DEFAULT_ITERATIONS = 20_000;
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
