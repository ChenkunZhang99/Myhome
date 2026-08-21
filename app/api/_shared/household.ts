import { env } from "cloudflare:workers";
import { resolveTimeZone } from "../../dateTime";
import { UserFacingError } from "./observability";
import { ensureSchema } from "./schema";

/**
 * 当前请求属于哪一户人家。
 *
 * 多住户改造里真正昂贵的是「每一条查询都带上住户」，涉及一百多条 SQL；
 * 而「怎么知道是哪一户」只是这一个函数。把两者分开，将来接入登录时
 * 只有这里会改，查询一条都不用动。
 *
 * 见 docs/multi-household-design.md。
 */

export const DEFAULT_HOUSEHOLD_ID = "household-default";

const HEADER = "x-household-id";
const COOKIE = "hsp_household";

/** 只允许安全的标识符，避免把垃圾值写成一户新人家。 */
const VALID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 严格模式下，没有住户标识的请求直接拒绝。
 *
 * 现在默认关闭：还没有登录体系，而 cookie 是数据的唯一把手，
 * 用户清掉 cookie 就再也找不回自己的数据。接入登录之后打开它，
 * 这是一个配置项，不需要改代码。
 */
function strictMode() {
  return (env as typeof env & { REQUIRE_HOUSEHOLD?: string }).REQUIRE_HOUSEHOLD?.trim() === "on";
}

function fromCookie(request: Request) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("=")).trim();
  }
  return "";
}

/**
 * 取当前住户 id。定时任务没有请求可取，传空即可，它会落到默认住户。
 *
 * 严格模式下缺少标识会抛 401，交给各路由已有的 failure() 统一处理。
 */
export function resolveHousehold(request?: Request) {
  const candidate = request ? (request.headers.get(HEADER)?.trim() ?? "") || fromCookie(request) : "";
  if (VALID.test(candidate)) return candidate;

  if (strictMode()) throw new UserFacingError("请先登录后再访问", 401);
  // 回落时留一条日志：真的公开部署之后，能看出有多少匿名流量落进了默认住户。
  if (request)
    console.warn(JSON.stringify({ at: new Date().toISOString(), scope: "household", fallback: true }));
  return DEFAULT_HOUSEHOLD_ID;
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
export async function householdTimeZone() {
  await ensureSchema();
  const row = await env.DB.prepare("SELECT timezone FROM household_settings WHERE id = 1").first<{
    timezone: string | null;
  }>();
  return resolveTimeZone(row?.timezone);
}
