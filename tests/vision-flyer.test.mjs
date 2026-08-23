import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageCandidates } from "../app/api/flyers/sync/flyerImage.ts";
import { cleanVisionDeals } from "../app/api/flyers/sync/visionShape.ts";

/**
 * 视觉读图这条路。
 *
 * 它伺候的是「整份 flyer 就是一张图」的店——H Mart 的是 6083×4134 的 JPG，
 * 页面 HTML 里连一个 $ 都没有。但找图的规则是通用的（页面上最大的那张），
 * 不是为哪一家写的。
 *
 * 这条路比别的来源更容易读错：价格牌上的 7.98 和 1.98 在缩略图上长得很像。
 * 所以下面的校验比 Flipp 那边更严——错一个价格，人会白跑一趟超市。
 */

const TODAY = "2026-08-23";

// 照抄 H Mart 那个页面的真实结构：一堆 /img/ 下的站点装饰，
// 加一张 /data/editor/ 下带哈希名的大图，那张才是 flyer。
const HMART_HTML = `
  <img src="/img/h-logo.jpg">
  <img src="/img/menu-bar-1-en_US.png">
  <img src="/img/top-btn_01.jpg">
  <img src="/img/bottom-branch-en_US.png">
  <img src="https://hmart.ca/data/editor/2608/d36c32104dda4d25c52aa8faf5df924d_1787258769_4899.jpg">
  <img src="/data/file/banner/">
`;

test("站点装饰被滤掉，flyer 留下", () => {
  const found = imageCandidates(HMART_HTML, "https://hmart.ca/index.php?pn=flyer");
  assert.ok(
    found.includes("https://hmart.ca/data/editor/2608/d36c32104dda4d25c52aa8faf5df924d_1787258769_4899.jpg"),
    "真正的 flyer 被滤掉了",
  );
  // 不断言完全相等：候选表宽一点无所谓，真正把关的是「够大」和「最大的那张」。
  // 但 logo 和菜单条这种一眼可辨的装饰不该还留在里面。
  for (const chrome of ["h-logo", "menu-bar", "top-btn", "bottom-branch"]) {
    assert.ok(!found.some((url) => url.includes(chrome)), chrome + " 不该出现在候选里");
  }
});

test("相对地址会被解析成绝对地址", () => {
  const found = imageCandidates('<img src="/upload/weekly.jpg">', "https://example.com/flyer/index.html");
  assert.deepEqual(found, ["https://example.com/upload/weekly.jpg"]);
});

test("懒加载和社交预览图也算候选", () => {
  const html = `
    <img data-src="/upload/thisweek.jpg" src="/img/placeholder-icon.png">
    <meta property="og:image" content="https://cdn.example.com/weekly-special.png">
  `;
  const found = imageCandidates(html, "https://example.com/flyer");
  assert.ok(found.includes("https://example.com/upload/thisweek.jpg"), "懒加载的真实地址漏了");
  assert.ok(found.includes("https://cdn.example.com/weekly-special.png"), "og:image 常常就是本周 flyer");
  assert.ok(!found.some((url) => /placeholder-icon/.test(url)), "占位图标不该混进来");
});

test("svg 和 gif 不是 flyer", () => {
  const found = imageCandidates('<img src="/a.svg"><img src="/b.gif"><img src="/c.webp">', "https://x.com/");
  assert.deepEqual(found, ["https://x.com/c.webp"]);
});

/**
 * 模型读回来的东西要逐条核对。
 */

const GOOD = {
  validFrom: "2026-08-20",
  validTo: "2026-08-26",
  deals: [
    { itemName: "白虾 30/40", category: "肉类海鲜", price: 9.98, regularPrice: null, unit: "PK" },
    { itemName: "韩国鲭鱼", category: "肉类海鲜", price: 2.98, regularPrice: 4.98, unit: "LB" },
  ],
};

test("读得对的照单收下，有效期落到每一条上", () => {
  const { deals } = cleanVisionDeals(GOOD, TODAY);
  assert.equal(deals.length, 2);
  assert.equal(deals[0].validFrom, "2026-08-20");
  assert.equal(deals[0].validTo, "2026-08-26");
  assert.equal(deals[1].regularPrice, 4.98);
  assert.equal(deals[0].unit, "PK", "计价单位照抄价格牌");
});

test("有效期不覆盖今天，整份都不要", () => {
  const stale = { ...GOOD, validFrom: "2026-08-01", validTo: "2026-08-07" };
  assert.equal(cleanVisionDeals(stale, TODAY).deals.length, 0, "一份上周的 flyer 读得再准也是错的");
});

test("有效期读不成形，整份都不要", () => {
  for (const bad of ["Aug 20", "", "2026/08/20", null]) {
    const result = cleanVisionDeals({ ...GOOD, validFrom: bad }, TODAY);
    assert.equal(result.deals.length, 0, `validFrom=${JSON.stringify(bad)} 不该放行`);
  }
});

test("价格不成立的那一条丢掉，不影响同一份里的其他条", () => {
  const mixed = {
    ...GOOD,
    deals: [
      ...GOOD.deals,
      { itemName: "读不清的东西", category: "其他", price: 0, regularPrice: null, unit: "EA" },
    ],
  };
  const { deals } = cleanVisionDeals(mixed, TODAY);
  assert.equal(deals.length, 2, "价格为 0 的那条该被丢掉");
});

test("原价不高于现价就当没有原价", () => {
  const odd = {
    ...GOOD,
    deals: [{ itemName: "鸡蛋", category: "乳品蛋类", price: 6.98, regularPrice: 5.0, unit: "DOZ" }],
  };
  assert.equal(cleanVisionDeals(odd, TODAY).deals[0].regularPrice, null, "那不是折扣，是读错了");
});

test("分类不在枚举里就按名字重新归类，不原样收下", () => {
  const odd = {
    ...GOOD,
    deals: [{ itemName: "Pork Belly", category: "生鲜区", price: 4.98, regularPrice: null, unit: "LB" }],
  };
  const [deal] = cleanVisionDeals(odd, TODAY).deals;
  assert.equal(deal.category, "肉类海鲜", "模型编的分类会破坏按分类的匹配");
  assert.equal(deal.itemName, "五花肉", "商品名走的是和别的来源同一张对照表");
});

test("同一件商品在版面上出现两次只留一条", () => {
  const twice = { ...GOOD, deals: [GOOD.deals[0], { ...GOOD.deals[0] }] };
  assert.equal(cleanVisionDeals(twice, TODAY).deals.length, 1);
});

/**
 * 三条路的顺序：结构化 → Flipp → 读图 → 网页搜索。
 * 读图必须排在网页搜索之前，否则对图片型 flyer 永远是先白花一次搜索。
 */

const route = await readFile(new URL("../app/api/flyers/sync/route.ts", import.meta.url), "utf8");
const vision = await readFile(new URL("../app/api/flyers/sync/visionFlyer.ts", import.meta.url), "utf8");
const shape = await readFile(new URL("../app/api/flyers/sync/visionShape.ts", import.meta.url), "utf8");
const image = await readFile(new URL("../app/api/flyers/sync/flyerImage.ts", import.meta.url), "utf8");

test("读图排在网页搜索之前", () => {
  const readImage = route.indexOf("await readFlyerImage(store.name");
  const fallback = route.indexOf("fallbackStores.push(store)");
  assert.notEqual(readImage, -1, "同步里没有接上读图");
  assert.ok(readImage < fallback, "图片型 flyer 会先白花一次网页搜索");
});

test("找不到图时仍然退回网页搜索，两条路互补", () => {
  const at = route.indexOf("await readFlyerImage(store.name");
  const around = route.slice(at, at + 700);
  assert.ok(around.includes("fallbackStores.push(store)"), "读不出来就没有下文了");
});

test("图片不经过 Workers，只把地址交给模型", () => {
  assert.ok(vision.includes("image_url: image.url"), "没有用地址的方式传图");
  assert.ok(!vision.includes("arrayBuffer"), "把十几兆的图读进内存会顶到 Workers 的内存上限");
  assert.ok(image.includes('method: "HEAD"'), "量图大小该用 HEAD，不该下载");
});

test("找图的规则是通用的，不写死任何一家店", () => {
  assert.ok(!/hmart|h-mart/i.test(image), "找图逻辑里出现了具体门店，那就不叫通用了");
  assert.ok(image.includes("MIN_BYTES"), "没有大小下限，会把某个装饰图当成 flyer");
  assert.ok(image.includes("MAX_PROBES"), "没有探测上限，会把免费版的子请求额度花光");
});

test("读图这条路不抛异常", () => {
  const at = vision.indexOf("export async function readFlyerImage");
  const body = vision.slice(at);
  assert.ok(body.includes("} catch (error) {"), "没有兜住异常");
  assert.ok(!body.includes("throw"), "任何抛出都会连累同一次同步里的其他门店");
});

test("纯逻辑和取图分开，否则最该测的那部分测不到", () => {
  // 只看 import 行：注释里提到 cloudflare:workers 是在解释「为什么要拆」，不是依赖
  const imports = shape.split(String.fromCharCode(10)).filter((line) => line.startsWith("import "));
  assert.ok(
    !imports.some((line) => line.includes("cloudflare:workers") || line.includes("_shared")),
    "visionShape 一旦拉进 openai.ts，就会连上 cloudflare:workers，Node 解析不了那个 scheme：" +
      imports.join(" | "),
  );
  assert.ok(shape.includes("export function cleanVisionDeals"), "校验逻辑没有留在可测的那一侧");
});
