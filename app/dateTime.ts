/**
 * 日期与时区的唯一来源。
 *
 * 这些函数原本以六份拷贝散在各个路由里，名字各不相同（todayDate / today /
 * localDate / vancouverDate），时区一律写死成温哥华。只有一户人家在用时这是对的，
 * 多一个时区的用户就错：保质期倒计时、消费统计的日期边界、flyer 有效期都会偏一天。
 *
 * 时区属于「这一户人家」，不属于「这台设备」。用户出差到别的时区，家里冰箱里的
 * 牛奶不会因此提前过期，所以时区和 city、postal_code 一样存在家庭设置里，
 * 而不是从浏览器每次读取。
 */

export const DEFAULT_TIME_ZONE = "America/Vancouver";

/** IANA 时区名是否被当前运行时支持。非法值会让 Intl 抛 RangeError。 */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // Intl 不接受带空白的时区名，而从数据库或请求里读出来的值可能带空白。
  const zone = value.trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 把任意输入收敛成一个可用的时区，非法或缺失时退回默认值。 */
export function resolveTimeZone(value: unknown): string {
  return isSupportedTimeZone(value) ? value.trim() : DEFAULT_TIME_ZONE;
}

/**
 * 该时区下的日期，格式 YYYY-MM-DD。
 *
 * 用 en-CA 是因为它的短日期格式恰好就是 YYYY-MM-DD，不需要再拼装。
 */
export function dayIn(timeZone: string, date: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 该时区下相对今天偏移若干天的日期，格式 YYYY-MM-DD。 */
export function shiftDay(timeZone: string, offsetDays: number, date: Date = new Date()) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return dayIn(timeZone, shifted);
}

/** 浏览器所在时区，用于首次设置时给出默认值。服务端调用会得到默认时区。 */
export function detectTimeZone() {
  try {
    return resolveTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * 设置界面的时区候选。除了常见时区，还会带上当前设备时区和已保存的值，
 * 避免用户因为不在列表里而改不了。
 */
export function timeZoneChoices(current: string) {
  return Array.from(
    new Set(
      [
        current,
        detectTimeZone(),
        DEFAULT_TIME_ZONE,
        "America/Toronto",
        "America/Los_Angeles",
        "America/New_York",
        "Asia/Shanghai",
        "Asia/Hong_Kong",
        "Asia/Taipei",
        "Asia/Tokyo",
        "Europe/London",
        "Australia/Sydney",
        "UTC",
      ].filter(Boolean),
    ),
  );
}
