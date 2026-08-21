import { env } from "cloudflare:workers";
import { resolveTimeZone } from "../../dateTime";
import { ensureSchema } from "./schema";

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
