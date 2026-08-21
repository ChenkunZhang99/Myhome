import { DEFAULT_TIME_ZONE } from "../../dateTime";

/**
 * 可自动同步的门店目录。
 *
 * 这是全局数据：大统华本周的优惠对所有住户是同一份，按「来源 + 本周」解析一次即可，
 * 不需要每户各解析一遍。见 docs/multi-household-design.md。
 *
 * 目前只有三家，覆盖 Lougheed 一带，而且只有 PriceSmart 有结构化抓取，
 * 其余走模型搜网页的降级方案。怎么让这份目录长大（谁来加、如何判定是同一家店、
 * 长尾怎么办）是还没有回答的问题，所以这里先保持封闭：只能改代码增加。
 */
export type FlyerSource = {
  sourceKey: string;
  name: string;
  address: string;
  flyerUrl: string;
  flyerFormat: string;
  timeZone: string;
};

export const FLYER_SOURCES: FlyerSource[] = [
  {
    sourceKey: "hmart-coquitlam",
    name: "H Mart Coquitlam",
    address: "#100 - 329 North Rd, Coquitlam, BC V3K 3V8",
    flyerUrl: "https://hmart.ca/index.php?pn=flyer",
    flyerFormat: "pdf",
    timeZone: DEFAULT_TIME_ZONE,
  },
  {
    sourceKey: "pricesmart-lougheed",
    name: "PriceSmart Foods Lougheed",
    address: "9899 Austin Rd, Burnaby, BC V3J 1N4",
    flyerUrl: "https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials",
    flyerFormat: "catalog",
    timeZone: DEFAULT_TIME_ZONE,
  },
  {
    sourceKey: "walmart-lougheed",
    name: "Walmart Supercentre Lougheed",
    address: "9855 Austin Rd, Burnaby, BC V3J 1N5",
    flyerUrl: "https://www.walmart.ca/en/flyer",
    flyerFormat: "dynamic",
    timeZone: DEFAULT_TIME_ZONE,
  },
];

export const flyerSourceByKey = new Map(FLYER_SOURCES.map((source) => [source.sourceKey, source]));

/** 手工添加的门店也占一条来源，只是没有人和它共享，也不参与自动同步。 */
export function manualSourceKey() {
  return `manual-${crypto.randomUUID()}`;
}
