import { env } from "cloudflare:workers";
import { householdTimeZone } from "./household";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";
import { shiftDay } from "../../dateTime";
import { ensureSchema } from "./schema";
import { getOpenAIConfig } from "./openai";

/**
 * 演示模式：没有配置 OPENAI_API_KEY 时，需要模型的功能改用内置样例数据，
 * 让任何人 clone 下来 `npm run dev` 就能完整体验，不需要密钥也不产生费用。
 * 用 DEMO_MODE=on / off 可以强制开关。
 */
export function isDemoMode(request?: Request) {
  const explicit = (env as typeof env & { DEMO_MODE?: string }).DEMO_MODE?.trim().toLowerCase();
  if (explicit === "off") return false;
  if (explicit === "on") return true;
  // 传 null：要不要灌演示数据是部署级决定，不该由某个住户的身份左右。
  return !getOpenAIConfig(request, null).apiKey;
}

function daysFromToday(offset: number, timeZone: string) {
  return shiftDay(timeZone, offset);
}

/** 演示用的小票识别结果，字段和真实模型返回完全一致。 */
export function demoReceipt(timeZone: string) {
  return {
    store: "PriceSmart Foods（演示数据）",
    purchaseDate: daysFromToday(0, timeZone),
    total: 27.43,
    items: [
      // 演示折扣：鸡蛋和鸡腿有会员价，原价一并读出来，用于「上次多少钱」的比较。
      {
        name: "鸡蛋",
        quantity: 12,
        unit: "枚",
        category: "乳品蛋类",
        unitPrice: 0.5,
        regularUnitPrice: 0.62,
        lineTotal: 5.99,
        confidence: 0.94,
      },
      {
        name: "菠菜",
        quantity: 1,
        unit: "把",
        category: "蔬菜水果",
        unitPrice: 2.49,
        regularUnitPrice: null,
        lineTotal: 2.49,
        confidence: 0.91,
      },
      {
        name: "鸡腿",
        quantity: 1.24,
        unit: "kg",
        category: "肉类海鲜",
        unitPrice: 8.05,
        regularUnitPrice: 12.9,
        lineTotal: 9.98,
        confidence: 0.88,
      },
      {
        name: "洗洁精",
        quantity: 1,
        unit: "瓶",
        category: "清洁用品",
        unitPrice: 3.99,
        regularUnitPrice: null,
        lineTotal: 3.99,
        confidence: 0.82,
      },
      {
        name: "东北大米",
        quantity: 5,
        unit: "kg",
        category: "米面粮油",
        unitPrice: 0.996,
        regularUnitPrice: null,
        lineTotal: 4.98,
        confidence: 0.76,
      },
    ],
  };
}

/**
 * 演示用的包装扫描结果。故意带一点不确定：照片略糊，鲜牛奶和酸奶都说得通，
 * 让界面走出「先让人挑是哪一种」那一步，而不是假装一次就认准了。
 */
export function demoItemScan(timeZone: string) {
  return {
    imageQuality: "blurry" as const,
    needsChoice: true,
    items: [
      {
        name: "鲜牛奶",
        category: "乳品蛋类",
        quantity: 1,
        unit: "盒",
        identityConfidence: 0.62,
        expiryDate: daysFromToday(6, timeZone),
        expiryConfidence: 0.58,
        expiryUncertain: true,
        expiryGuesses: [daysFromToday(5, timeZone), daysFromToday(6, timeZone), daysFromToday(8, timeZone)],
        reason: "包装上隐约能看到 milk / 鲜牛奶字样，日期数字有点糊",
        alternatives: [
          { name: "酸奶", category: "乳品蛋类", identityConfidence: 0.41 },
          { name: "豆奶", category: "乳品蛋类", identityConfidence: 0.27 },
        ],
      },
    ],
  };
}

/**
 * 演示用的 flyer 优惠，覆盖精准匹配、替代补货和大类机会三种情况。
 * 包装规格写在商品名里（「鸡腿 2kg」），和真实 flyer 一样靠名称解析单位价格。
 */
export function demoDeals(sourceKey: string, timeZone: string) {
  const validFrom = daysFromToday(-2, timeZone);
  const validTo = daysFromToday(4, timeZone);
  const shared = [
    // 两家店都在特价的商品，价格不同 —— 用来演示跨店比价和去重。
    {
      itemName: "菠菜",
      category: "蔬菜水果",
      price: 1.49,
      regularPrice: 2.99,
      unit: "把",
      validFrom,
      validTo,
    },
    {
      itemName: "洗衣凝珠 32pk",
      category: "清洁用品",
      price: 8.99,
      regularPrice: 14.99,
      unit: "盒",
      validFrom,
      validTo,
    },
  ];
  const byStore: Record<string, ReturnType<typeof buildDeals>> = {
    "pricesmart-lougheed": buildDeals(
      [
        { itemName: "鸡腿 2kg", category: "肉类海鲜", price: 9.98, regularPrice: 15.99, unit: "包" },
        { itemName: "东北大米 8kg", category: "米面粮油", price: 15.99, regularPrice: 21.99, unit: "袋" },
        { itemName: "鸡蛋 12枚", category: "乳品蛋类", price: 3.99, regularPrice: 5.49, unit: "盒" },
      ],
      validFrom,
      validTo,
    ),
    "hmart-coquitlam": buildDeals(
      [
        { itemName: "五花肉", category: "肉类海鲜", price: 6.99, regularPrice: 9.99, unit: "lb" },
        { itemName: "鲜牛奶 2L", category: "乳品蛋类", price: 4.49, regularPrice: 6.49, unit: "盒" },
        { itemName: "生抽 500ml", category: "调味品", price: 2.99, regularPrice: 4.29, unit: "瓶" },
      ],
      validFrom,
      validTo,
    ),
  };

  // 同一件商品在两家店价格略有差异，这样去重后留下的确实是更便宜的那家。
  const priceNudge = sourceKey === "hmart-coquitlam" ? 0.2 : 0;
  const common = shared.map((deal) => ({ ...deal, price: Number((deal.price + priceNudge).toFixed(2)) }));
  return [...common, ...(byStore[sourceKey] ?? [])];
}

function buildDeals(
  items: { itemName: string; category: string; price: number; regularPrice: number; unit: string }[],
  validFrom: string,
  validTo: string,
) {
  return items.map((item) => ({ ...item, validFrom, validTo }));
}

type DemoIngredient = { name: string; amount: string; source: "inventory" | "flyer" | "pantry" };
type DemoRecipe = {
  title: string;
  summary: string;
  reason: string;
  origin: string;
  icon: string;
  cookTime: string;
  difficulty: string;
  servings: number;
  ingredients: DemoIngredient[];
  steps: string[];
};

/** 演示用的菜谱，食材来源刻意混合库存 / 优惠 / 基础调料三种。 */
export function demoRecipes(): DemoRecipe[] {
  return [
    {
      title: "菠菜炒鸡蛋",
      summary: "十分钟出锅的家常菜，先把快到期的菠菜用掉。",
      reason: "菠菜还剩 40% 且两天后到期，鸡蛋库存充足。",
      origin: "临期优先",
      icon: "🥬",
      cookTime: "10 分钟",
      difficulty: "简单",
      servings: 2,
      ingredients: [
        { name: "菠菜", amount: "1 把", source: "inventory" },
        { name: "鸡蛋", amount: "3 枚", source: "inventory" },
        { name: "盐", amount: "适量", source: "pantry" },
        { name: "食用油", amount: "1 勺", source: "pantry" },
      ],
      steps: [
        "菠菜洗净切段，鸡蛋打散加少许盐。",
        "热锅冷油，倒入蛋液炒至半凝固盛出。",
        "下菠菜快炒至断生，倒回鸡蛋翻匀，出锅前调味。",
      ],
    },
    {
      title: "可乐鸡腿",
      summary: "用本周打折的鸡腿做一道稳定好吃的下饭菜。",
      reason: "鸡腿本周 9.98/包，比平时便宜 38%，适合买回来当主菜。",
      origin: "Flyer 搭配",
      icon: "🍗",
      cookTime: "35 分钟",
      difficulty: "简单",
      servings: 2,
      ingredients: [
        { name: "鸡腿", amount: "600 g", source: "flyer" },
        { name: "生抽", amount: "2 勺", source: "pantry" },
        { name: "姜", amount: "3 片", source: "pantry" },
      ],
      steps: [
        "鸡腿冷水下锅焯水，撇去浮沫捞出。",
        "锅中放鸡腿、姜片、生抽和没过食材的可乐。",
        "大火烧开转小火焖 20 分钟，最后开盖收汁。",
      ],
    },
    {
      title: "五花肉炒饭",
      summary: "把昨天剩的米饭和打折五花肉一起解决。",
      reason: "大米库存偏少但仍可用，五花肉本周有优惠。",
      origin: "库存＋优惠",
      icon: "🍚",
      cookTime: "20 分钟",
      difficulty: "简单",
      servings: 2,
      ingredients: [
        { name: "东北大米", amount: "300 g", source: "inventory" },
        { name: "五花肉", amount: "200 g", source: "flyer" },
        { name: "鸡蛋", amount: "2 枚", source: "inventory" },
        { name: "酱油", amount: "1 勺", source: "pantry" },
      ],
      steps: [
        "五花肉切小丁，中火煸出油脂。",
        "倒入打散的蛋液炒散，再下隔夜米饭炒开。",
        "沿锅边淋酱油炒匀，撒葱花出锅。",
      ],
    },
    {
      title: "番茄牛腩煲",
      summary: "周末花点时间炖一锅，第二天更入味。",
      reason: "适合作为本周的一道正餐，用到的都是常备食材。",
      origin: "库存优先",
      icon: "🍲",
      cookTime: "90 分钟",
      difficulty: "中等",
      servings: 4,
      ingredients: [
        { name: "牛腩", amount: "800 g", source: "flyer" },
        { name: "番茄", amount: "4 个", source: "inventory" },
        { name: "洋葱", amount: "1 个", source: "pantry" },
      ],
      steps: [
        "牛腩切块焯水洗净。",
        "番茄去皮切块，和洋葱一起炒出汤汁。",
        "加入牛腩和热水，小火炖 70 分钟至软烂后调味。",
      ],
    },
  ];
}

const demoInventory = [
  ["菠菜", "蔬菜水果", "冰箱", "quantity", 1, "把", 40, "偏少", -3, 2],
  ["鲜牛奶", "乳品蛋类", "冰箱", "exact", 1, "盒", 70, "充足", -4, 3],
  ["鸡蛋", "乳品蛋类", "冰箱", "quantity", 10, "枚", 100, "充足", -5, 20],
  ["鸡腿", "肉类海鲜", "冷冻柜", "quantity", 1, "包", 100, "充足", -8, 45],
  ["东北大米", "米面粮油", "厨房储物柜", "simple", 1, "袋", 40, "偏少", -30, null],
  ["生抽", "调味品", "厨房储物柜", "simple", 1, "瓶", 60, "充足", -60, null],
  ["洗衣液", "清洁用品", "洗衣房", "simple", 1, "瓶", 20, "即将用完", -45, null],
  ["洗碗球", "清洁用品", "厨房储物柜", "quantity", 0, "个", 0, "已用完", -50, null],
  ["卫生纸", "洗护用品", "卫生间", "quantity", 4, "卷", 100, "充足", -20, null],
  ["番茄", "蔬菜水果", "冰箱", "quantity", 4, "个", 100, "充足", -2, 5],
] as const;

/**
 * 第一次打开时灌入一套演示数据，让界面不是空的。
 * 只在库存表为空时执行，所以用户自己录入之后永远不会被覆盖。
 *
 * 注意这里刻意不看请求头里的密钥：数据库是整个部署共享的，
 * 要不要灌演示数据是部署级决定，不该由某一个访客带的 key 左右。
 */
export async function seedDemoData() {
  if (!isDemoMode()) return false;
  await ensureSchema();
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM inventory_items WHERE household_id = ?",
  )
    .bind(DEFAULT_HOUSEHOLD_ID)
    .first<{
      count: number;
    }>();
  if (Number(existing?.count ?? 0) > 0) return false;

  const timeZone = await householdTimeZone();
  const statements = demoInventory.map(
    ([name, category, location, precision, quantity, unit, percent, level, purchaseOffset, expiryOffset]) =>
      env.DB.prepare(
        `INSERT INTO inventory_items
      (household_id, id, name, category, location, precision, quantity, unit, remaining_percent, level, purchase_date, expiry_date, note, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '演示数据', 'demo')`,
      ).bind(
        DEFAULT_HOUSEHOLD_ID,
        crypto.randomUUID(),
        name,
        category,
        location,
        precision,
        quantity,
        unit,
        percent,
        level,
        daysFromToday(purchaseOffset, timeZone),
        expiryOffset === null ? null : daysFromToday(expiryOffset, timeZone),
      ),
  );

  await env.DB.batch(statements);
  return true;
}

const demoStores = [
  [
    "store-pricesmart-lougheed",
    "PriceSmart Foods Lougheed",
    "9899 Austin Rd, Burnaby, BC",
    "pricesmart-lougheed",
    "https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials",
    "catalog",
  ],
  [
    "store-hmart-coquitlam",
    "H Mart Coquitlam",
    "#100 - 329 North Rd, Coquitlam, BC",
    "hmart-coquitlam",
    "https://hmart.ca/index.php?pn=flyer",
    "pdf",
  ],
] as const;

/**
 * 演示用的收藏门店和预算，让 flyer 同步和采购方案有东西可算。
 * 同样只在表为空时执行。
 */
export async function seedDemoPlanner() {
  if (!isDemoMode()) return false;
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM household_stores WHERE household_id = ?",
  )
    .bind(DEFAULT_HOUSEHOLD_ID)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return false;

  await env.DB.batch([
    // 演示门店订阅的是全局目录里的来源，flyer 地址和格式跟着目录走，不再各存一份。
    ...demoStores.map(([id, name, address, sourceKey]) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO household_stores (id, household_id, source_key, name, address, is_favorite)
        VALUES (?, ?, ?, ?, ?, 1)`,
      ).bind(id, DEFAULT_HOUSEHOLD_ID, sourceKey, name, address),
    ),
    env.DB.prepare(
      `INSERT INTO household_settings (household_id, city, postal_code, food_budget, household_budget, max_stores)
      VALUES (?, 'Burnaby', 'V3J 1N4', 120, 40, 2)
      ON CONFLICT(household_id) DO NOTHING`,
    ).bind(DEFAULT_HOUSEHOLD_ID),
  ]);
  return true;
}
