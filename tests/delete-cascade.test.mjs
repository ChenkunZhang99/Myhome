import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 删除路径上曾经漏掉两类清理。
 *
 * 删库存物品时只删了 inventory_items，附件记录留在库里，R2 里的图片永远不会被删除
 * ——既持续计费，又仍然可以通过 object key 取到。删门店时留下了优惠元数据和价格历史。
 *
 * 这类问题不会立刻暴露：只有在删掉一个带照片的物品之后才开始漏，而那时没有任何报错。
 * 所以用测试把「谁引用了谁」这件事钉住。
 */

const API_DIR = new URL("../app/api/", import.meta.url);

/** 子表 → 它通过哪一列指向父表。删父行时这些子行必须被处理，不能不闻不问。 */
const REFERENCES = [
  { parent: "inventory_items", child: "inventory_attachments", column: "item_id" },
  { parent: "inventory_items", child: "purchase_records", column: "inventory_id" },
  { parent: "flyer_deals", child: "flyer_deal_metadata", column: "deal_id" },
  { parent: "stores", child: "flyer_price_history", column: "store_id" },
  { parent: "stores", child: "flyer_recommendation_feedback", column: "store_id" },
];

async function collectSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await collectSources(url)));
    else if (entry.name.endsWith(".ts"))
      out.push({ name: url.pathname.split("/api/")[1], code: await readFile(url, "utf8") });
  }
  return out;
}

test("删除父行的地方都处理了指向它的子表", async () => {
  const sources = await collectSources(API_DIR);
  const missing = [];

  for (const file of sources) {
    if (file.name.startsWith("_shared/schema")) continue; // 建表与一次性回填不算删除路径
    for (const { parent, child, column } of REFERENCES) {
      // 只看真正删父行的语句，不看建表里的 DDL
      if (!new RegExp(`DELETE\\s+FROM\\s+${parent}\\s+WHERE`, "i").test(file.code)) continue;
      // 子表要么被删，要么被显式断开引用（置空），两者都算处理过
      const handled =
        new RegExp(`DELETE\\s+FROM\\s+${child}\\b`, "i").test(file.code) ||
        new RegExp(`UPDATE\\s+${child}\\s+SET\\s+${column}\\s*=\\s*NULL`, "i").test(file.code);
      if (!handled) missing.push(`${file.name}: 删了 ${parent} 却没处理 ${child}.${column}`);
    }
  }

  assert.deepEqual(missing, [], `删除时留下了孤儿数据：\n${missing.join("\n")}`);
});

test("删除带附件的记录时同时清理 R2 对象", async () => {
  const sources = await collectSources(API_DIR);
  const offenders = [];

  for (const file of sources) {
    // 谁删了附件表的行，谁就必须同时删掉 R2 里的字节
    const deletesAttachments = /DELETE\s+FROM\s+(inventory_attachments|recipe_attachments)\b/i.test(
      file.code,
    );
    if (!deletesAttachments) continue;
    if (!/UPLOADS\.delete\(/.test(file.code)) offenders.push(`${file.name}: 删了附件记录但没有删除 R2 对象`);
  }

  assert.deepEqual(offenders, [], `R2 里会留下永远不被读取但持续计费的文件：\n${offenders.join("\n")}`);
});
