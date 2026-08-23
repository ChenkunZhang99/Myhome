/**
 * 把英文的 flyer 商品名归到这个应用的中文口径上。
 *
 * 库存、菜谱、推荐全都按中文分类和中文名工作（见 i18n.ts 里那条约定：
 * 数据库存的永远是中文规范值）。而 flyer 的来源是英文的，所以每条进来的优惠
 * 都要过这一关。
 *
 * 刻意不调模型：分类靠关键词，名字靠一张对照表，两者都是确定性的、免费的、
 * 可测的。Flipp 那条路的全部价值就是「零 token 拿到结构化优惠」，
 * 在归一化这一步再调一次模型等于把省下来的钱又花回去。
 *
 * 表没覆盖到的就保留英文原名——看得懂价格总比看不到强，而且
 * 「$4.97 PORK BELLY」比一个猜错的中文名更不容易误导人。
 */

/** 库存分类的中文枚举。翻译它会破坏匹配，见 i18n.ts。 */
export const FLYER_CATEGORIES = [
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
  "清洁用品",
  "洗护用品",
  "其他",
] as const;

/**
 * 按关键词归类。
 *
 * 顺序有讲究，而且是被真实数据逼出来的：
 *  - 「frozen shrimp」同时命中冷冻和肉类，而对采购来说「这是海鲜」更有用
 *  - 「Betty Crocker fruit snacks」里的 fruit 会让它变成蔬菜水果，
 *    所以零食饮料必须先判——那是一盒软糖，不是水果
 */
export function categoryFromText(...parts: Array<string | undefined | null>) {
  const context = parts.filter(Boolean).join(" ").toLowerCase();
  if (!context) return "其他";
  if (
    /meat|seafood|fish|poultry|chicken|beef|pork|lamb|shrimp|prawn|salmon|tuna|crab|squid|octopus/.test(
      context,
    )
  )
    return "肉类海鲜";
  if (/dairy|milk|cheese|yogurt|yoghurt|butter|cream|egg/.test(context)) return "乳品蛋类";
  if (/frozen|ice cream/.test(context)) return "冷冻食品";
  if (/clean|dishwash|laundry|detergent|household|paper towel|toilet|tissue|garbage bag|bleach/.test(context))
    return "清洁用品";
  if (/personal care|shampoo|conditioner|body wash|soap|skincare|toothpaste|diaper|razor/.test(context))
    return "洗护用品";
  if (/condiment|sauce|spice|seasoning|vinegar|soy sauce|oyster|ketchup|mayo|miso/.test(context))
    return "调味品";
  if (/rice|pasta|noodle|flour|grain|oil|bakery|bread|cereal|tortilla|bun\b/.test(context)) return "米面粮油";
  if (/snack|beverage|drink|water|juice|coffee|tea|candy|chocolate|chip|cookie|soda|pop\b/.test(context))
    return "零食饮料";
  if (
    /fruit|vegetable|produce|lettuce|tomato|broccoli|corn|grape|orange|peach|apple|banana|berry|berries|onion|potato|carrot|cabbage|cucumber|pepper|mushroom|spinach|melon|mango|pear|lemon|lime|avocado|garlic|ginger/.test(
      context,
    )
  )
    return "蔬菜水果";
  return "其他";
}

/**
 * 常见生鲜的中英对照。
 *
 * 只收「家里库存里真的会出现、而且英文写法稳定」的那些。收得太宽反而危险：
 * 把 "Beef Short Rib" 一律译成「牛肉」会让它和库存里的「牛肉馅」错误匹配，
 * 而错误匹配的后果是推荐你去买一件你不需要的东西。
 */
const NAME_TABLE: Array<[RegExp, string]> = [
  // 蔬菜
  [/broccoli/i, "西兰花"],
  [/iceberg.*lettuce|lettuce.*iceberg/i, "冰山生菜"],
  [/romaine/i, "罗马生菜"],
  [/green onion|scallion/i, "小葱"],
  [/yellow onion|cooking onion/i, "洋葱"],
  [/napa cabbage/i, "娃娃菜"],
  [/bok choy|pak choi/i, "小白菜"],
  [/spinach/i, "菠菜"],
  [/carrot/i, "胡萝卜"],
  [/potato/i, "土豆"],
  [/cucumber/i, "黄瓜"],
  [/tomato/i, "番茄"],
  [/corn.*cob|sweet corn/i, "新鲜玉米"],
  [/garlic/i, "大蒜"],
  [/ginger/i, "生姜"],
  [/enoki/i, "金针菇"],
  [/shiitake/i, "香菇"],
  [/mushroom/i, "蘑菇"],
  // 水果
  [/red seedless.*grape|grape.*red seedless/i, "无籽红葡萄"],
  [/grape/i, "葡萄"],
  [/navel.*orange|orange.*navel/i, "脐橙"],
  [/peach|nectarine/i, "鲜桃"],
  [/banana/i, "香蕉"],
  [/strawberr/i, "草莓"],
  [/blueberr/i, "蓝莓"],
  [/watermelon/i, "西瓜"],
  [/kiwi/i, "奇异果"],
  [/avocado/i, "牛油果"],
  // 肉与海鲜
  [/pork belly/i, "五花肉"],
  [/ground beef|lean beef.*ground/i, "牛肉馅"],
  [/ground pork/i, "猪肉馅"],
  [/chicken (drum|leg|thigh)/i, "鸡腿肉"],
  [/chicken breast/i, "鸡胸肉"],
  [/whole chicken/i, "整鸡"],
  [/black tiger shrimp|tiger prawn/i, "黑虎虾"],
  [/shrimp|prawn/i, "虾"],
  [/salmon/i, "三文鱼"],
  [/mackerel/i, "鲭鱼"],
  [/mussel/i, "青口"],
  // 乳品蛋类
  [/large egg|\begg[s]?\b/i, "鸡蛋"],
  [/whole milk|2% milk|1% milk|skim milk|\bmilk\b/i, "牛奶"],
  [/yogurt|yoghurt/i, "酸奶"],
  [/butter/i, "黄油"],
  // 米面粮油
  [/jasmine rice|calrose|\brice\b/i, "大米"],
  [/soy sauce/i, "生抽"],
  [/canola oil|vegetable oil|olive oil/i, "食用油"],
];

/**
 * 商品名。命中对照表就用中文，否则把英文清理一下留着。
 *
 * 清理只做三件小事：拉平多余空格、去掉分隔用的破折号、去掉 ", Fresh" 这种
 * 对匹配毫无帮助的后缀。不做更多——原名是核对价格时唯一的凭据。
 */
export function displayFlyerName(name: string) {
  const matched = NAME_TABLE.find(([pattern]) => pattern.test(name));
  if (matched) return matched[1];
  return name
    .replace(/\s+-\s+/g, " ")
    .replace(/,\s*Fresh\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
