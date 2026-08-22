import { env } from "cloudflare:workers";
import { UserFacingError } from "./observability";

/**
 * 会话与一次性登录令牌。
 *
 * 这个项目不保存密码：登录靠发到邮箱的一次性链接，链接里的令牌换成会话 cookie。
 * 没有密码就没有密码哈希、没有重置流程、也没有撞库面——对一个不该自己扛安全责任的
 * 小项目来说，这是最省事也最稳妥的选择。
 *
 * 令牌本身只以哈希形式入库。明文只在生成的那一刻存在，发出去之后连服务端也读不回来，
 * 所以即使数据库被看到，也无法冒用任何人的会话。
 */

export const SESSION_COOKIE = "hsp_session";

/** 会话有效期。家庭库存是低频应用，太短会让人反复登录。 */
const SESSION_DAYS = 60;
/** 登录链接有效期。够从收件箱点开，又不至于长期可用。 */
const LOGIN_MINUTES = 15;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 入库前哈希。SHA-256 足够：令牌本身就是 256 位随机数，不存在被猜到的问题。 */
async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expiryIso(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** 签发一个令牌，返回明文；调用方负责把它送出去，之后就再也拿不到了。 */
async function issue(userId: string, kind: "login" | "session", minutes: number) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, kind, expiryIso(minutes))
    .run();
  return token;
}

export function issueLoginToken(userId: string) {
  return issue(userId, "login", LOGIN_MINUTES);
}

export function issueSessionToken(userId: string) {
  return issue(userId, "session", SESSION_DAYS * 24 * 60);
}

/** 取出令牌对应的用户，同时清掉过期记录。找不到或已过期都返回 null。 */
async function consume(token: string, kind: "login" | "session", once: boolean) {
  if (!token) return null;
  const hash = await hashToken(token);
  const row = await env.DB.prepare(
    "SELECT user_id AS userId FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?",
  )
    .bind(hash, kind, new Date().toISOString())
    .first<{ userId: string }>();
  if (!row) return null;
  // 登录令牌是一次性的：用过即焚，链接被转发或留在浏览历史里也无法重放。
  if (once) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
  return row.userId;
}

export function redeemLoginToken(token: string) {
  return consume(token, "login", true);
}

export function readSession(token: string) {
  return consume(token, "session", false);
}

export async function revokeSession(token: string) {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await hashToken(token))
    .run();
}

/** 过期记录不会自己消失，登录时顺手清一次。 */
export async function purgeExpiredSessions() {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
}

export function sessionCookie(token: string) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

export function normalizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  // 只做基本形状检查，真正的验证是「这封信能不能收到」。
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw new UserFacingError("请填写有效的邮箱地址");
  return email;
}
