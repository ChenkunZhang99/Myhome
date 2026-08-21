import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_TIME_ZONE,
  dayIn,
  detectTimeZone,
  isSupportedTimeZone,
  resolveTimeZone,
  shiftDay,
} from "../app/dateTime.ts";

test("同一时刻在不同时区可能是不同的日期", () => {
  // 温哥华 2026-08-21 18:00（UTC-7）此刻，上海已经是 8 月 22 日。
  const instant = new Date("2026-08-22T01:00:00Z");
  assert.equal(dayIn("America/Vancouver", instant), "2026-08-21");
  assert.equal(dayIn("Asia/Shanghai", instant), "2026-08-22");
  assert.equal(dayIn("UTC", instant), "2026-08-22");
});

test("跨越午夜时日期正确翻页", () => {
  const beforeMidnight = new Date("2026-08-22T06:59:00Z"); // 温哥华 23:59
  const afterMidnight = new Date("2026-08-22T07:01:00Z"); // 温哥华 00:01
  assert.equal(dayIn("America/Vancouver", beforeMidnight), "2026-08-21");
  assert.equal(dayIn("America/Vancouver", afterMidnight), "2026-08-22");
});

test("输出格式始终是 YYYY-MM-DD", () => {
  for (const zone of ["America/Vancouver", "Asia/Shanghai", "UTC", "Europe/London"]) {
    assert.match(dayIn(zone, new Date("2026-01-05T12:00:00Z")), /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("shiftDay 按天偏移", () => {
  const instant = new Date("2026-08-21T20:00:00Z"); // 温哥华 13:00
  assert.equal(shiftDay("America/Vancouver", 0, instant), "2026-08-21");
  assert.equal(shiftDay("America/Vancouver", 1, instant), "2026-08-22");
  assert.equal(shiftDay("America/Vancouver", -1, instant), "2026-08-20");
  assert.equal(shiftDay("America/Vancouver", 14, instant), "2026-09-04");
});

test("跨月和跨年偏移", () => {
  const endOfYear = new Date("2026-12-31T20:00:00Z");
  assert.equal(shiftDay("America/Vancouver", 1, endOfYear), "2027-01-01");
  const endOfMonth = new Date("2026-01-31T20:00:00Z");
  assert.equal(shiftDay("America/Vancouver", 1, endOfMonth), "2026-02-01");
});

test("非法时区退回默认值而不是抛错", () => {
  assert.equal(resolveTimeZone("Mars/Olympus"), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(""), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(null), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(undefined), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(123), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  // 数据库里存的值也可能带空白
  assert.equal(resolveTimeZone("  Asia/Tokyo  "), "Asia/Tokyo");
});

test("非法时区不会让 dayIn 崩溃", () => {
  assert.match(dayIn("Mars/Olympus"), /^\d{4}-\d{2}-\d{2}$/);
});

test("isSupportedTimeZone 判定", () => {
  assert.equal(isSupportedTimeZone("America/Vancouver"), true);
  assert.equal(isSupportedTimeZone("UTC"), true);
  assert.equal(isSupportedTimeZone("Mars/Olympus"), false);
  assert.equal(isSupportedTimeZone(""), false);
  assert.equal(isSupportedTimeZone(null), false);
});

test("detectTimeZone 返回可用的时区", () => {
  assert.equal(isSupportedTimeZone(detectTimeZone()), true);
});

/**
 * 这一条守住的是：时区不能再被写死在别处。
 * 六份拷贝散在各路由、时区一律写死温哥华，正是这次改动要消除的问题。
 */
test("除 dateTime.ts 外没有任何文件写死 IANA 时区", async () => {
  const roots = [new URL("../app/", import.meta.url), new URL("../worker/", import.meta.url)];
  const offenders = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        await walk(url);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name === "dateTime.ts") continue;
      const code = await readFile(url, "utf8");
      // 形如 Region/City 的 IANA 名称，排除注释里的说明性提及
      for (const [match] of code.matchAll(/["'](?:America|Asia|Europe|Africa|Australia)\/\w+["']/g)) {
        offenders.push(`${url.pathname.split("/app/").pop()} 写死了 ${match}`);
      }
    }
  }

  for (const root of roots) await walk(root);
  assert.deepEqual(offenders, [], `时区应来自家庭设置，不能写死：\n${offenders.join("\n")}`);
});
