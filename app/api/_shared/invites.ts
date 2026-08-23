import { env } from "cloudflare:workers";
import { UserFacingError } from "./observability";

/**
 * 家庭邀请。
 *
 * 一家人各用各的账号，但看的是同一份库存——所以「加入哪个家」必须由已经在
 * 家里的人来决定，不能靠注册时自己填。邀请就是这个决定的载体。
 *
 * 令牌和登录链接一样只以哈希入库：明文只在生成的那一刻存在。数据库被看到
 * 也没法凭它加进任何一个家。
 *
 * 这张表和 sessions 一样属于身份层——按令牌查，令牌本身带着住户，
 * 所以它不在 household-scoping 那份租户表清单里。
 */

/** 七天。够把链接从微信转给家人，又不至于长期挂在那里。 */
const INVITE_DAYS = 7;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Invite = {
  tokenHash: string;
  householdId: string;
  email: string | null;
  expiresAt: string;
  createdAt: string;
};

/** 签发一条邀请，返回明文令牌；调用方负责拼成链接送出去，之后就再也拿不到了。 */
export async function createInvite(householdId: string, invitedBy: string, email: string | null) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO household_invites (token_hash, household_id, invited_by, email, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await hashToken(token), householdId, invitedBy, email, expiresAt)
    .run();
  return { token, expiresAt };
}

/**
 * 兑换邀请。一次性：接受过就作废，链接被转发也没用。
 *
 * 绑了邮箱的邀请只有那个邮箱能接受——否则链接一旦被转错人，
 * 别人就直接进了你家。
 */
export async function redeemInvite(token: string, email: string) {
  if (!token) throw new UserFacingError("这个邀请链接无效", 400);
  const hash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT household_id AS householdId, email, expires_at AS expiresAt, accepted_at AS acceptedAt
       FROM household_invites WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{ householdId: string; email: string | null; expiresAt: string; acceptedAt: string | null }>();

  if (!row || row.acceptedAt) throw new UserFacingError("这个邀请已经用过了，请让家人重新发一条", 400);
  if (row.expiresAt <= new Date().toISOString())
    throw new UserFacingError("这个邀请已经过期，请让家人重新发一条", 400);
  if (row.email && row.email !== email)
    throw new UserFacingError("这条邀请是发给另一个邮箱的，请用收到邀请的那个邮箱登录", 403);

  return { householdId: row.householdId, hash };
}

export async function markInviteAccepted(tokenHash: string, userId: string) {
  await env.DB.prepare(
    "UPDATE household_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ? WHERE token_hash = ?",
  )
    .bind(userId, tokenHash)
    .run();
}

/** 还没被用掉、也还没过期的邀请。发出去的链接看不到明文，只能看到发给谁、什么时候过期。 */
export async function pendingInvites(householdId: string) {
  const { results } = await env.DB.prepare(
    `SELECT token_hash AS tokenHash, email, expires_at AS expiresAt, created_at AS createdAt
       FROM household_invites
      WHERE household_id = ? AND accepted_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`,
  )
    .bind(householdId, new Date().toISOString())
    .all<Invite>();
  return results ?? [];
}

/** 撤回一条还没被接受的邀请。带上住户，免得凭一个哈希撤别人家的。 */
export async function revokeInvite(householdId: string, tokenHash: string) {
  await env.DB.prepare(
    "DELETE FROM household_invites WHERE token_hash = ? AND household_id = ? AND accepted_at IS NULL",
  )
    .bind(tokenHash, householdId)
    .run();
}

/** 过期的邀请不会自己消失，发新邀请时顺手清一次。 */
export async function purgeExpiredInvites() {
  await env.DB.prepare("DELETE FROM household_invites WHERE expires_at <= ? AND accepted_at IS NULL")
    .bind(new Date().toISOString())
    .run();
}

/**
 * 手里这条邀请，能不能用来给这个邮箱开号。只看，不作废。
 *
 * 和下面的 hasUsableInvite 差一个字，但差别是致命的：那个问「有没有一条」，
 * 这个问「这一条行不行」。不绑邮箱的邀请（发到家庭群里那种）对任何邮箱都成立，
 * 所以只要家里还挂着一条没用掉的开放邀请，hasUsableInvite 对陌生人也会说「可以」。
 *
 * 邮箱链接那条路上这不致命——链接得寄到收件箱，陌生人拿不到。
 * 密码注册没有那一层，凭据只能是令牌本身，所以它验的是这一个。
 */
export async function inviteMatches(token: string, email: string) {
  if (!token) return false;
  const row = await env.DB.prepare(
    `SELECT email, expires_at AS expiresAt, accepted_at AS acceptedAt
       FROM household_invites WHERE token_hash = ?`,
  )
    .bind(await hashToken(token))
    .first<{ email: string | null; expiresAt: string; acceptedAt: string | null }>();
  if (!row || row.acceptedAt) return false;
  if (row.expiresAt <= new Date().toISOString()) return false;
  return !row.email || row.email === email;
}

/**
 * 有没有一条还能用的邀请在等这个邮箱。
 *
 * 和 redeemInvite 不同：这里只看，不作废。注册时先问一句，
 * 真正的兑换发生在登录之后——那时候才知道是谁接受了。
 */
export async function hasUsableInvite(email: string) {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM household_invites
      WHERE accepted_at IS NULL AND expires_at > ?
        AND (email IS NULL OR email = ?)
      LIMIT 1`,
  )
    .bind(new Date().toISOString(), email)
    .first<{ ok: number }>();
  return Boolean(row);
}
