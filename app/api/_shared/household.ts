import { env } from "cloudflare:workers";
import { resolveTimeZone } from "../../dateTime";
import { accountById, touchAccount } from "./accounts";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";
import { UserFacingError } from "./observability";
import { ensureSchema } from "./schema";
import { readSession, SESSION_COOKIE } from "./session";

/**
 * 当前请求属于哪一户人家。
 *
 * 多住户改造里真正昂贵的是「每一条查询都带上住户」，涉及一百多条 SQL；
 * 而「怎么知道是哪一户」只是这一个函数。接入登录时确实只改了这里——
 * 代价是它从同步变成了异步，调用点要加 await，但那些查询一条都没动。
 *
 * 见 docs/multi-household-design.md。
 */

export { DEFAULT_HOUSEHOLD_ID } from "./householdId";

const HEADER = "x-household-id";
const COOKIE = "hsp_household";

/** 只允许安全的标识符，避免把垃圾值写成一户新人家。 */
const VALID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 严格模式下，没有登录的请求直接拒绝。
 *
 * 还没打开：现有数据都在默认住户下，贸然要求登录会让人打不开自己的东西。
 * 登录流程跑通之后把它设成 on，这是一个配置项，不需要改代码。
 */
/** 前端要靠它决定是显示登录页还是应用本体。 */
export function loginRequired() {
  return strictMode();
}

function strictMode() {
  return (env as typeof env & { REQUIRE_HOUSEHOLD?: string }).REQUIRE_HOUSEHOLD?.trim() === "on";
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=")).trim();
  }
  return "";
}

/** 当前登录的账号，没登录返回 null。 */
export async function currentAccount(request?: Request) {
  if (!request) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  await ensureSchema();
  const userId = await readSession(token);
  if (!userId) return null;
  const account = await accountById(userId);
  if (account) await touchAccount(userId);
  return account;
}

/**
 * 取当前住户 id。定时任务没有请求可取，不传即可，它会落到默认住户。
 *
 * 优先级：登录会话 → 显式指定的住户标识（仅非严格模式）→ 默认住户。
 * 严格模式下没有会话就抛 401，交给各路由已有的 failure() 统一处理。
 */
export async function resolveHousehold(request?: Request) {
  const account = await currentAccount(request);
  if (account) return account.householdId;

  // 严格模式下只认会话。显式标识是开发期的便利，如果在这里也放行，
  // 任何人发一个 x-household-id 就能读别人家的数据，严格模式就没有意义了。
  if (strictMode()) throw new UserFacingError("请先登录后再访问", 401);

  const explicit = request ? (request.headers.get(HEADER)?.trim() ?? "") || readCookie(request, COOKIE) : "";
  if (VALID.test(explicit)) return explicit;
  // 回落时留一条日志：真的公开部署之后，能看出有多少匿名流量落进了默认住户。
  if (request)
    console.warn(JSON.stringify({ at: new Date().toISOString(), scope: "household", fallback: true }));
  return DEFAULT_HOUSEHOLD_ID;
}

/**
 * 新住户第一次使用时补上两位默认成员。
 *
 * 这两行原本是建表时的全局种子，id 写死为 member-me / member-family。
 * 多住户之后种子必须按户播，而建表每个 isolate 只跑一次，所以改成懒播种。
 * 已有住户的成员行保持原 id 不动——它们被点菜、评分、制作记录三张表引用着。
 */
export async function ensureHouseholdMembers(householdId: string) {
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM household_members WHERE household_id = ?",
  )
    .bind(householdId)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO household_members (id, household_id, name, avatar) VALUES (?, ?, '我', '🙂')",
    ).bind(crypto.randomUUID(), householdId),
    env.DB.prepare(
      "INSERT INTO household_members (id, household_id, name, avatar) VALUES (?, ?, '家庭成员', '😊')",
    ).bind(crypto.randomUUID(), householdId),
  ]);
}

/**
 * 这一户人家的时区。服务端所有「今天是几号」都必须以它为准。
 *
 * 时区跟着家走，不跟着设备走：用户出差到别的时区，家里的保质期倒计时、
 * 消费统计的日期边界、flyer 有效期都不应该跟着变。所以它和 city、postal_code
 * 一样存在家庭设置里，而不是从浏览器每次读取。
 *
 * 定时任务没有浏览器可问，这也是唯一能让它算对日期的来源。
 */
export async function householdTimeZone(householdId: string = DEFAULT_HOUSEHOLD_ID) {
  await ensureSchema();
  const row = await env.DB.prepare("SELECT timezone FROM household_settings WHERE household_id = ?")
    .bind(householdId)
    .first<{ timezone: string | null }>();
  return resolveTimeZone(row?.timezone);
}
