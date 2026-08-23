import { env } from "cloudflare:workers";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";

/**
 * 账号与住户的对应关系。
 *
 * 账号和 household_members 是两件事：账号是「能登录的人」，成员是「这户人家里的一个称呼」。
 * 家里的小孩和老人应该能被记成做饭的人、被点菜，但不应该因此必须注册一个邮箱。
 * 所以这两张表分开，以后可以关联，现在不强行合并。
 *
 * 一个人可以属于多个家（自己家、爸妈家），所以「谁能进哪个家」放在
 * household_memberships 里，是多对多。users.household_id 留着，但含义变了：
 * 它是「这个人现在正在看哪个家」的指针，不是归属。
 *
 * 这么分是为了省下一百多条 SQL：resolveHousehold 照样从这个指针取值，
 * 所有带 household_id 的业务查询一条都不用动。切换家庭就变成
 * 「验一下有没有 membership，然后改这个指针」。
 */

export type Account = { id: string; email: string; householdId: string; role: "owner" | "member" };

/**
 * 按邮箱找账号，没有就建一个。
 *
 * 第一个建立的账号会接管默认住户——单机自用的人在改造之前攒下的库存、菜谱、门店
 * 都在那里，登录之后应当原样看到，而不是进到一个空房子。之后的账号各自开新住户。
 */
export async function findOrCreateAccount(email: string): Promise<Account> {
  const existing = await env.DB.prepare(
    "SELECT id, email, household_id AS householdId, role FROM users WHERE email = ?",
  )
    .bind(email)
    .first<Account>();
  if (existing) return existing;

  const claimed = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  const householdId =
    Number(claimed?.count ?? 0) === 0 ? DEFAULT_HOUSEHOLD_ID : `household-${crypto.randomUUID()}`;

  // 自己开的家，自己就是 owner。被邀请进别人家时加的是另一条 membership，
  // 角色由那一条决定，和这一条互不影响。
  const account: Account = { id: crypto.randomUUID(), email, householdId, role: "owner" };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, household_id, role) VALUES (?, ?, ?, ?)").bind(
      account.id,
      account.email,
      account.householdId,
      account.role,
    ),
    // 第一个账号接管的是默认住户，那个家可能已经存在，所以 OR IGNORE。
    env.DB.prepare("INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)").bind(
      householdId,
      "我们的家",
      account.id,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO household_memberships (user_id, household_id, role) VALUES (?, ?, 'owner')",
    ).bind(account.id, householdId),
  ]);
  return account;
}

/**
 * 按 id 取账号，连带「在当前这个家里是什么角色」。
 *
 * memberRole 为 null 是一个有含义的结果，不是缺省值：它表示这个人的指针指着
 * 一个他已经进不去的家（被请出去了，或者自己退了）。调用方必须处理这种情况，
 * 所以这里不用 COALESCE 把它糊掉——糊掉的后果是资格没了照样读得到数据。
 */
export async function accountById(userId: string) {
  return env.DB.prepare(
    `SELECT u.id, u.email, u.household_id AS householdId, u.role, m.role AS memberRole
       FROM users u
       LEFT JOIN household_memberships m ON m.user_id = u.id AND m.household_id = u.household_id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<Account & { memberRole: "owner" | "member" | null }>();
}

export async function touchAccount(userId: string) {
  await env.DB.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId).run();
}

/**
 * 密码登录的账号查询。
 *
 * 和 findOrCreateAccount 分开：那个「找不到就建」，用在邮箱链接上是对的
 * （谁都可以注册）；用在密码登录上却会凭空造出一个没有密码的账号，
 * 还顺带把邮箱是否存在泄露给了调用方。这里只查，不建。
 */
export async function accountByEmail(email: string) {
  return env.DB.prepare(
    `SELECT id, email, household_id AS householdId, role, password_hash AS passwordHash,
            failed_logins AS failedLogins, locked_until AS lockedUntil
       FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<Account & { passwordHash: string | null; failedLogins: number; lockedUntil: string | null }>();
}

export async function setAccountPassword(userId: string, passwordHash: string | null) {
  // 改密码同时清掉失败计数：人已经证明了自己是账号主人。
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
  )
    .bind(passwordHash, userId)
    .run();
}

export async function recordLoginFailure(userId: string, lockedUntil: string | null) {
  await env.DB.prepare("UPDATE users SET failed_logins = failed_logins + 1, locked_until = ? WHERE id = ?")
    .bind(lockedUntil, userId)
    .run();
}

export async function clearLoginFailures(userId: string) {
  await env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?")
    .bind(userId)
    .run();
}

/** 这个家里所有能登录的账号。设置页要列出来，好知道谁进来了。 */
export async function accountsInHousehold(householdId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, m.role, m.created_at AS createdAt, u.last_seen_at AS lastSeenAt
       FROM household_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ? ORDER BY m.created_at`,
  )
    .bind(householdId)
    .all<{
      id: string;
      email: string;
      role: "owner" | "member";
      createdAt: string;
      lastSeenAt: string | null;
    }>();
  return results ?? [];
}

/**
 * 把一个人加进一个家。已经在里面就什么也不做。
 *
 * 加入不等于离开原来的家——这正是「一个人可以有多个家」的意思。
 * 接受邀请之后，两个家都还在他的切换列表里，谁的数据也没动。
 */
export async function addMembership(userId: string, householdId: string, role: "owner" | "member") {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO household_memberships (user_id, household_id, role) VALUES (?, ?, ?)",
  )
    .bind(userId, householdId, role)
    .run();
}

/** 把一个人从一个家里去掉。那个家的数据一行都不动——数据属于家，不属于人。 */
export async function removeMembership(userId: string, householdId: string) {
  await env.DB.prepare("DELETE FROM household_memberships WHERE user_id = ? AND household_id = ?")
    .bind(userId, householdId)
    .run();
}

export async function setMembershipRole(userId: string, householdId: string, role: "owner" | "member") {
  await env.DB.prepare("UPDATE household_memberships SET role = ? WHERE user_id = ? AND household_id = ?")
    .bind(role, userId, householdId)
    .run();
}

/**
 * 这个人在这个家里是什么角色，不在就是 null。
 *
 * 每一个「切到这个家」「改这个家的东西」的请求都必须先问过它。
 * 少问一次，household_id 就成了任填的参数，户与户之间那堵墙也就没了。
 */
export async function membershipRole(userId: string, householdId: string) {
  const row = await env.DB.prepare(
    "SELECT role FROM household_memberships WHERE user_id = ? AND household_id = ?",
  )
    .bind(userId, householdId)
    .first<{ role: "owner" | "member" }>();
  return row?.role ?? null;
}

/** 我能进的所有家，按加入时间排。切换器直接用这个列表。 */
export async function householdsForUser(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT h.id, h.name, m.role, m.created_at AS joinedAt
       FROM household_memberships m
       JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? ORDER BY m.created_at`,
  )
    .bind(userId)
    .all<{ id: string; name: string; role: "owner" | "member"; joinedAt: string }>();
  return results ?? [];
}

/** 开一个新家，自己是 owner。 */
export async function createHousehold(userId: string, name: string) {
  const householdId = `household-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)").bind(
      householdId,
      name,
      userId,
    ),
    env.DB.prepare(
      "INSERT INTO household_memberships (user_id, household_id, role) VALUES (?, ?, 'owner')",
    ).bind(userId, householdId),
  ]);
  return householdId;
}

export async function renameHousehold(householdId: string, name: string) {
  await env.DB.prepare("UPDATE households SET name = ? WHERE id = ?").bind(name, householdId).run();
}

/** 家没名字就补一行。老库里的家是迁移出来的，不一定有对应记录。 */
export async function ensureHouseholdRow(householdId: string, name = "我们的家") {
  await env.DB.prepare("INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)")
    .bind(householdId, name)
    .run();
}

/**
 * 切换当前正在看的家。
 *
 * 只改指针，不搬数据。调用方必须先用 membershipRole 确认这个人进得去——
 * 这个函数自己不验，因为「刚建完一个家顺手切过去」这种场景也要用它。
 */
export async function setActiveHousehold(userId: string, householdId: string) {
  await env.DB.prepare("UPDATE users SET household_id = ? WHERE id = ?").bind(householdId, userId).run();
}

/** 这个家里还剩几个 owner。踢人和退出时都要看，不能让一个家变成没有主人的孤儿。 */
export async function ownerCount(householdId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM household_memberships WHERE household_id = ? AND role = 'owner'",
  )
    .bind(householdId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** 这个部署上一共有几个账号。用来判断是不是「第一个人」。 */
export async function accountCount() {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return Number(row?.count ?? 0);
}
