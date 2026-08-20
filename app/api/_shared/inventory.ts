export function defaultLocation(category: string) {
  if (["肉类海鲜", "乳品蛋类", "蔬菜水果"].includes(category)) return "冰箱";
  if (category === "冷冻食品") return "冷冻柜";
  if (["清洁用品", "洗护用品"].includes(category)) return "其他";
  return "厨房储物柜";
}
