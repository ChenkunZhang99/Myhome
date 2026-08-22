"use client";

import {
  AlertTriangle,
  Bell,
  Camera,
  Check,
  ChefHat,
  Clock,
  Heart,
  Home,
  MapPin,
  Package,
  Plus,
  ReceiptText,
  RefreshCw,
  ScanBarcode,
  Search,
  Settings,
  Snowflake,
  Sparkles,
  Star,
  Tag,
  Timer,
  Wallet,
} from "lucide-react";

/**
 * 界面图标。
 *
 * 之前导航和操作用的是 Unicode 几何符号（⌂ ▦ ％ ♨ ◔ ⌖ …），
 * 分类和菜谱用的是彩色 emoji。两套视觉语言放在同一屏里，笔画粗细、
 * 圆角和色彩都对不上；而且有几个符号语义不清——♨ 是温泉，◔ 是四分之一圆，
 * ％ 是全角百分号，它们被拿来表示菜谱、预算和优惠。
 *
 * 现在的分工是：**线条图标表示功能，emoji 只表示食物内容**。
 * 🥬 比任何抽象图标都更快让人认出「蔬菜」，那里 emoji 是对的，所以保留。
 *
 * 图标名称集中在这里，改一个符号不需要翻三个上千行的组件文件。
 */

const ICONS = {
  home: Home,
  inventory: Package,
  deals: Tag,
  recipes: ChefHat,
  budget: Wallet,
  settings: Settings,
  search: Search,
  notify: Bell,
  place: MapPin,
  sync: RefreshCw,
  camera: Camera,
  receipt: ReceiptText,
  barcode: ScanBarcode,
  add: Plus,
  favorite: Heart,
  rating: Star,
  ai: Sparkles,
  frozen: Snowflake,
  expiring: Clock,
  done: Check,
  warning: AlertTriangle,
  timer: Timer,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * 尺寸跟随字号（1em），这样图标和它旁边的文字永远等高，
 * 不会因为某处字号调整而错位。
 */
export function Icon({
  name,
  className,
  strokeWidth = 1.75,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph className={className} size="1em" strokeWidth={strokeWidth} aria-hidden="true" focusable="false" />
  );
}
