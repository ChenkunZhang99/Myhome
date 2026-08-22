import { env } from "cloudflare:workers";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";

/**
 * 账号与住户的对应关系。
 *
 * 账号和 household_members 是两件事：账号是「能登录的人」，成员是「这户人家里的一个称呼」。
 * 家里的小孩和老人应该能被记成做饭的人、被点菜，但不应该因此必须注册一个邮箱。
 * 所以这两张表分开，以后可以关联，现在不强行合并。
 */

export type Account = { id: string; email: string; householdId: string };

/**
 * 按邮箱找账号，没有就建一个。
 *
 * 第一个建立的账号会接管默认住户——单机自用的人在改造之前攒下的库存、菜谱、门店
 * 都在那里，登录之后应当原样看到，而不是进到一个空房子。之后的账号各自开新住户。
 */
export async function findOrCreateAccount(email: string): Promise<Account> {
  const existing = await env.DB.prepare(
    "SELECT id, email, household_id AS householdId FROM users WHERE email = ?",
  )
    .bind(email)
    .first<Account>();
  if (existing) return existing;

  const claimed = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  const householdId =
    Number(claimed?.count ?? 0) === 0 ? DEFAULT_HOUSEHOLD_ID : `household-${crypto.randomUUID()}`;

  const account = { id: crypto.randomUUID(), email, householdId };
  await env.DB.prepare("INSERT INTO users (id, email, household_id) VALUES (?, ?, ?)")
    .bind(account.id, account.email, account.householdId)
    .run();
  return account;
}

export async function accountById(userId: string) {
  return env.DB.prepare("SELECT id, email, household_id AS householdId FROM users WHERE id = ?")
    .bind(userId)
    .first<Account>();
}

export async function touchAccount(userId: string) {
  await env.DB.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId).run();
}
