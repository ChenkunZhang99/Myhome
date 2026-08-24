import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 拍包装扫保质期这条路有两处容易做错：
 *  1. 购买日期从照片里猜——包装上几乎不会印购买日，猜出来的一定是错的。
 *  2. 照片糊的时候只给一个「确定」答案——人没法纠正，错的东西就进库存了。
 */

const route = await readFile(new URL("../app/api/items/scan/route.ts", import.meta.url), "utf8");
const demo = await readFile(new URL("../app/api/_shared/demo.ts", import.meta.url), "utf8");
const modal = await readFile(new URL("../app/ItemScanModal.tsx", import.meta.url), "utf8");

test("购买日期用家里的今天，不从照片读取", () => {
  assert.match(route, /householdTimeZone\(household\)/);
  assert.match(route, /const purchaseDate = dayIn\(timeZone\)/);
  assert.doesNotMatch(route, /purchaseDate: extracted/);
  assert.match(route, /购买日期不要从照片猜/);
});

test("扫描接口本身不写入库存", () => {
  assert.doesNotMatch(route, /INSERT INTO inventory_items/);
  assert.match(modal, /source: "photo-scan"/);
});

test("照片不确定时必须让人先挑选项", () => {
  assert.match(route, /needsChoice/);
  assert.match(route, /identityConfidence < 0\.75/);
  assert.match(route, /alternatives/);
  assert.match(modal, /step === "choose"/);
  assert.match(modal, /可能的物品/);
});

test("演示数据会走出选项这一步", () => {
  assert.match(demo, /export function demoItemScan/);
  assert.match(demo, /needsChoice: true/);
  assert.match(demo, /imageQuality: "blurry"/);
  assert.match(demo, /alternatives/);
});
