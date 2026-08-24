import { env } from "cloudflare:workers";
import { UserFacingError } from "./observability";

/**
 * 会话与一次性登录令牌。
 *
 * 登录有两条路：邮箱一次性链接，和密码（见 password.ts）。这个文件只管前者，
 * 以及两者共用的会话。密码是可选的——不设就只能用链接，设了两种都行。
 *
 * 链接这条路不能删掉：它同时是「忘记密码」的出口。能收到这个邮箱的信就能登录，
 * 登录之后就能改密码，所以不需要再造一条一模一样的重置流程。
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

function userAgent(request?: Request) {
  return request?.headers.get("user-agent")?.trim().slice(0, 300) ?? "";
}

/** 签发一个令牌，返回明文；调用方负责把它送出去，之后就再也拿不到了。 */
async function issue(userId: string, kind: "login" | "session", minutes: number, request?: Request) {
  const token = randomToken();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions
      (token_hash, session_id, user_id, kind, expires_at, created_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await hashToken(token),
      crypto.randomUUID(),
      userId,
      kind,
      expiryIso(minutes),
      now,
      now,
      kind === "session" ? userAgent(request) : "",
    )
    .run();
  return token;
}

export function issueLoginToken(userId: string) {
  return issue(userId, "login", LOGIN_MINUTES);
}

export function issueSessionToken(userId: string, request?: Request) {
  return issue(userId, "session", SESSION_DAYS * 24 * 60, request);
}

/** 取出令牌对应的用户，同时清掉过期记录。找不到或已过期都返回 null。 */
async function consume(token: string, kind: "login" | "session", once: boolean) {
  if (!token) return null;
  const hash = await hashToken(token);
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT user_id AS userId, last_seen_at AS lastSeenAt
       FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?`,
  )
    .bind(hash, kind, now.toISOString())
    .first<{ userId: string; lastSeenAt: string | null }>();
  if (!row) return null;
  // 登录令牌是一次性的：用过即焚，链接被转发或留在浏览历史里也无法重放。
  if (once) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
  } else {
    // 每次请求都写 last_seen 会把一次普通看库存变成额外的 D1 写入。
    // 最多每 15 分钟碰一次，设备列表仍然足够准确。
    const lastSeen = row.lastSeenAt ? Date.parse(row.lastSeenAt) : 0;
    if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen >= 15 * 60_000) {
      await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .bind(now.toISOString(), hash)
        .run();
    }
  }
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

/** 从请求里取当前会话。格式损坏的 cookie 当作没有，不让它把路由撞成 500。 */
export function sessionTokenFromRequest(request: Request) {
  const encoded = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

export type AccountSession = {
  id: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

/** 列出一个账号仍有效的设备会话，不包含一次性登录链接。 */
export async function sessionsForUser(userId: string, currentToken: string): Promise<AccountSession[]> {
  const currentHash = currentToken ? await hashToken(currentToken) : "";
  const result = await env.DB.prepare(
    `SELECT session_id AS id, user_agent AS userAgent, created_at AS createdAt,
            COALESCE(last_seen_at, created_at) AS lastSeenAt, expires_at AS expiresAt,
            CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS isCurrent
       FROM sessions
      WHERE user_id = ? AND kind = 'session' AND expires_at > ?
      ORDER BY isCurrent DESC, last_seen_at DESC, created_at DESC
      LIMIT 50`,
  )
    .bind(currentHash, userId, new Date().toISOString())
    .all<Omit<AccountSession, "current"> & { isCurrent: number }>();
  return result.results.map(({ isCurrent, ...session }) => ({ ...session, current: isCurrent === 1 }));
}

/** 撤销一个确实属于该账号的设备，返回被撤销的是不是当前请求。 */
export async function revokeUserSession(userId: string, sessionId: string, currentToken: string) {
  const currentHash = currentToken ? await hashToken(currentToken) : "";
  const row = await env.DB.prepare(
    "SELECT token_hash AS tokenHash FROM sessions WHERE user_id = ? AND session_id = ? AND kind = 'session'",
  )
    .bind(userId, sessionId)
    .first<{ tokenHash: string }>();
  if (!row) throw new UserFacingError("这个登录设备已经退出或不存在", 404);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND session_id = ? AND kind = 'session'")
    .bind(userId, sessionId)
    .run();
  return row.tokenHash === currentHash;
}

export async function revokeOtherUserSessions(userId: string, currentToken: string) {
  if (!currentToken) throw new UserFacingError("当前登录状态已经失效", 401);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'session' AND token_hash <> ?")
    .bind(userId, await hashToken(currentToken))
    .run();
}

/** 包括设备会话和还没用掉的邮箱登录链接，一起失效。 */
export async function revokeAllUserSessions(userId: string) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/**
 * 改密码和撤销旧会话必须在同一个 D1 batch 里。
 *
 * 如果先改密码再逐条删会话，中间一步失败时接口虽然回 500，旧设备却仍然有效。
 * 这里同时写新密码、清掉所有旧令牌并为当前浏览器签一张新票。
 */
export async function replacePasswordAndRotateSessions(
  userId: string,
  passwordHash: string | null,
  request: Request,
) {
  const token = randomToken();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
    ).bind(passwordHash, userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare(
      `INSERT INTO sessions
        (token_hash, session_id, user_id, kind, expires_at, created_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, 'session', ?, ?, ?, ?)`,
    ).bind(
      await hashToken(token),
      crypto.randomUUID(),
      userId,
      expiryIso(SESSION_DAYS * 24 * 60),
      now,
      now,
      userAgent(request),
    ),
  ]);
  return token;
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
