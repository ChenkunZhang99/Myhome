"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { PlannerPanel } from "./PlannerPanel";
import {
  clampPercent,
  daysInUse,
  defaultOpenedShelfLife,
  effectiveExpiry,
  levelFromPercent,
  type ShelfLifeInput,
} from "./inventoryUsage";
import { withAiHeaders } from "./aiSettings";
import { useAppSettings } from "./AppSettings";
import { LoginGate } from "./LoginGate";
import { LoginLanding } from "./LoginLanding";
import { SettingsPanel } from "./SettingsPanel";
import { locales } from "./i18n";
import { Modal } from "./Modal";
import { readJson } from "./apiClient";
import { compressImage, formatBytes } from "./imageCompression";

type Precision = "simple" | "quantity" | "exact";
type InventoryItem = {
  id: string;
  name: string;
  category: string;
  location: string;
  precision: Precision;
  quantity: number;
  unit: string;
  remainingPercent: number;
  level: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  openedDate?: string | null;
  openedShelfLifeDays?: number | null;
  note?: string;
  source?: string;
  demo?: boolean;
};
type InventoryAttachment = {
  id: string;
  itemId: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
};
type ReceiptDraftItem = {
  tempId: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  unitPrice: number | null;
  regularUnitPrice: number | null;
  lineTotal: number | null;
  confidence: number;
  action: "new" | "merge";
  mergeItemId: string;
  matchName: string;
  matchScore: number;
};
type ReceiptDraft = {
  receipt: { store: string; purchaseDate: string; total: number | null };
  items: ReceiptDraftItem[];
};

const demoItems: InventoryItem[] = [
  {
    id: "demo-1",
    name: "菠菜",
    category: "蔬菜水果",
    location: "冰箱",
    precision: "quantity",
    quantity: 1,
    unit: "把",
    remainingPercent: 40,
    level: "偏少",
    purchaseDate: "2026-08-13",
    expiryDate: "2026-08-15",
    demo: true,
  },
  {
    id: "demo-2",
    name: "鲜牛奶",
    category: "乳品蛋类",
    location: "冰箱",
    precision: "exact",
    quantity: 1,
    unit: "盒",
    remainingPercent: 70,
    level: "充足",
    purchaseDate: "2026-08-12",
    expiryDate: "2026-08-17",
    demo: true,
  },
  {
    id: "demo-3",
    name: "东北大米",
    category: "米面粮油",
    location: "厨房储物柜",
    precision: "simple",
    quantity: 1,
    unit: "袋",
    remainingPercent: 40,
    level: "偏少",
    demo: true,
  },
  {
    id: "demo-4",
    name: "洗衣液",
    category: "清洁用品",
    location: "洗衣房",
    precision: "simple",
    quantity: 1,
    unit: "瓶",
    remainingPercent: 20,
    level: "即将用完",
    demo: true,
  },
];

const categories = [
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
];
const locations = ["冰箱", "冷冻柜", "厨房储物柜", "卫生间", "洗衣房", "其他"];
const unitGroups = [
  {
    label: "按个计数",
    units: ["个", "颗", "棵", "根", "把", "串", "只", "枚", "片", "块", "条", "份", "件"],
  },
  { label: "按包装计数", units: ["包", "袋", "盒", "瓶", "罐", "桶", "箱", "卷", "板"] },
  { label: "按重量计数", units: ["g", "kg", "lb"] },
  { label: "按容量计数", units: ["ml", "L"] },
  { label: "按余量记录", units: ["%"] },
] as const;
const commonUnits = unitGroups.flatMap((group) => group.units);
const categoryIcons: Record<string, string> = {
  蔬菜水果: "🥬",
  肉类海鲜: "🥩",
  乳品蛋类: "🥛",
  米面粮油: "🌾",
  调味品: "🫙",
  冷冻食品: "❄️",
  零食饮料: "🥤",
  清洁用品: "🧴",
  洗护用品: "🫧",
  其他: "📦",
};
const itemIconRules: { keywords: string[]; icon: string }[] = [
  { keywords: ["洗碗球", "洗碗海绵", "百洁布", "海绵"], icon: "🧽" },
  { keywords: ["洗衣球", "洗衣凝珠", "洗衣液", "洗衣粉"], icon: "🧺" },
  { keywords: ["卫生纸", "厕纸", "纸巾", "厨房纸"], icon: "🧻" },
  { keywords: ["垃圾袋"], icon: "🗑️" },
  { keywords: ["洗洁精", "洗碗液", "清洁剂", "消毒液"], icon: "🧴" },
  { keywords: ["虾"], icon: "🦐" },
  { keywords: ["螃蟹", "蟹"], icon: "🦀" },
  { keywords: ["三文鱼", "鳕鱼", "鲈鱼", "鱼"], icon: "🐟" },
  { keywords: ["牛腩", "牛排", "牛肉"], icon: "🥩" },
  { keywords: ["排骨", "五花肉", "猪肉"], icon: "🥓" },
  { keywords: ["鸡腿", "鸡翅", "鸡肉"], icon: "🍗" },
  { keywords: ["番茄", "西红柿"], icon: "🍅" },
  { keywords: ["土豆", "马铃薯"], icon: "🥔" },
  { keywords: ["胡萝卜", "红萝卜"], icon: "🥕" },
  { keywords: ["油菜", "生菜", "菠菜", "白菜", "青菜", "芥蓝"], icon: "🥬" },
  { keywords: ["玉米"], icon: "🌽" },
  { keywords: ["大米", "香米", "糙米", "米饭"], icon: "🍚" },
  { keywords: ["面条", "拉面", "意面", "米粉"], icon: "🍜" },
  { keywords: ["面包", "吐司"], icon: "🍞" },
  { keywords: ["鸡蛋", "鸭蛋", "鹅蛋"], icon: "🥚" },
  { keywords: ["牛奶", "鲜奶"], icon: "🥛" },
  { keywords: ["酸奶", "优格"], icon: "🥣" },
  { keywords: ["苹果"], icon: "🍎" },
  { keywords: ["香蕉"], icon: "🍌" },
  { keywords: ["橙", "橘子", "柑"], icon: "🍊" },
  { keywords: ["葡萄"], icon: "🍇" },
  { keywords: ["西瓜"], icon: "🍉" },
  { keywords: ["食用油", "菜籽油", "橄榄油", "花生油"], icon: "🫗" },
  { keywords: ["盐"], icon: "🧂" },
  { keywords: ["咖啡"], icon: "☕" },
  { keywords: ["茶"], icon: "🍵" },
];

function getItemIcon(item: Pick<InventoryItem, "name" | "category">) {
  const normalizedName = item.name.trim().toLowerCase();
  const matched = itemIconRules.find((rule) =>
    rule.keywords.some((keyword) => normalizedName.includes(keyword.toLowerCase())),
  );
  return matched?.icon ?? categoryIcons[item.category] ?? "📦";
}

type Translate = (text: string, vars?: Record<string, string | number>) => string;

// 下面几个是模块级纯函数，拿不到 hook，所以把需要的格式化器当参数传进来。
/**
 * 到期信息。已经用完的东西没有到期日可言。
 *
 * 这一条挡在这里而不是挡在卡片里，是因为同一个函数还喂着总览上的「临期」计数
 * 和「需要处理」的筛选。只改卡片的话，数字里仍然混着一堆你早就吃完的东西——
 * 一盒空豆浆不该让你觉得有东西要坏了。
 */
function getExpiryInfo(
  item: ShelfLifeInput & { quantity?: number; remainingPercent?: number },
  t: Translate,
) {
  const emptied = Number(item.quantity) <= 0 || Number(item.remainingPercent) <= 0;
  if (emptied) return null;
  const { date, fromOpening } = effectiveExpiry(item);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${date}T00:00:00`);
  const days = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  const tone = days < 0 || days === 0 ? "danger" : days <= 3 ? "warning" : "calm";
  const label =
    days < 0
      ? t("已过期 {days} 天", { days: Math.abs(days) })
      : days === 0
        ? t("今天到期")
        : t("{days} 天后到期", { days });
  // 标出这个日期是开封后推算的，而不是包装上印的，否则用户会以为记错了。
  return { label, tone, fromOpening };
}

type QuantityFormatters = {
  fmtNumber: (value: number) => string;
  tu: (unit: string, quantity?: number) => string;
  tv: (value: string | null | undefined) => string;
  t: Translate;
};

function formatQuantity(
  item: Pick<InventoryItem, "precision" | "quantity" | "unit" | "level">,
  f: QuantityFormatters,
) {
  if (item.precision === "simple" && item.unit === "%")
    return `${f.tv(item.level)} · ${f.t("约 {percent}%", { percent: f.fmtNumber(item.quantity) })}`;
  return `${f.fmtNumber(item.quantity)} ${f.tu(item.unit, item.quantity)}`;
}

function getUnitStep(item: Pick<InventoryItem, "precision" | "unit">) {
  if (item.unit === "%") return 10;
  if (["g", "ml"].includes(item.unit)) return 100;
  if (["kg", "lb", "L"].includes(item.unit)) return 0.1;
  return 1;
}

function money(value: number) {
  return `$${Number(value).toFixed(2)}`;
}

function remainingTone(percent: number) {
  if (percent <= 0) return "empty";
  if (percent <= 20) return "low";
  if (percent <= 50) return "medium";
  return "good";
}

function defaultUnitForCategory(category: string) {
  if (category === "蔬菜水果") return "个";
  if (["肉类海鲜", "冷冻食品", "零食饮料"].includes(category)) return "包";
  if (category === "乳品蛋类") return "盒";
  if (category === "米面粮油") return "袋";
  if (["调味品", "清洁用品", "洗护用品"].includes(category)) return "瓶";
  return "件";
}

function UnitSelect({ id, name, defaultValue }: { id: string; name: string; defaultValue: string }) {
  const { t, tv } = useAppSettings();
  const hasCurrent = commonUnits.includes(defaultValue as (typeof commonUnits)[number]);
  return (
    <select id={id} name={name} defaultValue={defaultValue} required>
      {!hasCurrent && (
        <option value={defaultValue}>
          {tv(defaultValue)}
          {t("（原单位）")}
        </option>
      )}
      {unitGroups.map((group) => (
        <optgroup key={group.label} label={t(group.label)}>
          {group.units.map((unit) => (
            <option key={unit} value={unit}>
              {tv(unit)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function readYmdDate(form: FormData, prefix: string, label: string, t: Translate) {
  const year = String(form.get(`${prefix}Year`) ?? "").trim();
  const month = String(form.get(`${prefix}Month`) ?? "").trim();
  const day = String(form.get(`${prefix}Day`) ?? "").trim();
  if (!year && !month && !day) return null;
  if (!year || !month || !day) throw new Error(t("请完整填写{label}的年、月、日", { label }));

  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (
    !Number.isInteger(y) ||
    year.length !== 4 ||
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== m - 1 ||
    candidate.getUTCDate() !== d
  )
    throw new Error(t("{label}不是有效日期", { label }));

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function YmdDateInput({ prefix, label, value }: { prefix: string; label: string; value?: string | null }) {
  const { t } = useAppSettings();
  const [year = "", month = "", day = ""] = value?.split("-") ?? [];
  return (
    <div className="field full" role="group" aria-labelledby={`${prefix}-label`}>
      <span id={`${prefix}-label`}>{label}</span>
      <div className="date-parts">
        <label className="date-part">
          <input
            name={`${prefix}Year`}
            type="number"
            inputMode="numeric"
            min="1900"
            max="2100"
            placeholder="2026"
            defaultValue={year}
            aria-label={t("{label}年份", { label })}
          />
          <b>{t("年")}</b>
        </label>
        <label className="date-part">
          <input
            name={`${prefix}Month`}
            type="number"
            inputMode="numeric"
            min="1"
            max="12"
            placeholder="08"
            defaultValue={month}
            aria-label={t("{label}月份", { label })}
          />
          <b>{t("月")}</b>
        </label>
        <label className="date-part">
          <input
            name={`${prefix}Day`}
            type="number"
            inputMode="numeric"
            min="1"
            max="31"
            placeholder="14"
            defaultValue={day}
            aria-label={t("{label}日期", { label })}
          />
          <b>{t("日")}</b>
        </label>
      </div>
    </div>
  );
}

export default function Home() {
  const { t, tv, tu, fmtNumber, fmtDate, locale, setLocale, demo } = useAppSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  // 连同 itemId 一起存：切换物品时不必先清空再加载，渲染时判断是不是当前物品的即可。
  const [attachments, setAttachments] = useState<{ itemId: string; files: InventoryAttachment[] }>({
    itemId: "",
    files: [],
  });
  const [uploading, setUploading] = useState(false);
  const [editingItem, setEditingItem] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  // 选好的小票要先给用户看一眼，确认拍清楚了再识别。
  const [receiptPreview, setReceiptPreview] = useState<{
    url: string;
    name: string;
    size: number;
    originalSize: number;
    file: File;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null);
  const [analyzingReceipt, setAnalyzingReceipt] = useState(false);
  const [confirmingReceipt, setConfirmingReceipt] = useState(false);

  async function loadItems() {
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      const data = await readJson<{ items?: InventoryItem[] }>(response);
      if (!response.ok) throw new Error(data.error || t("读取失败"));
      setItems(
        (data.items ?? []).map((item: InventoryItem) => ({
          ...item,
          remainingPercent: clampPercent(item.remainingPercent),
        })),
      );
    } catch {
      setToast(t("暂时无法连接在线库存，正在显示示例界面"));
    } finally {
      setLoading(false);
    }
  }

  // 挂载时拉一次数据。规则希望改用框架级的数据加载或 SWR 之类的库，
  // 但为此在这个规模的项目里引入一整套数据层并不划算，这里明确保留。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadItems();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!selectedItem || selectedItem.demo) return;
    const itemId = selectedItem.id;
    let active = true;
    fetch(`/api/inventory-files?itemId=${encodeURIComponent(itemId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await readJson<{ attachments?: InventoryAttachment[] }>(response);
        if (!response.ok) throw new Error(data.error || t("读取图片失败"));
        if (active) setAttachments({ itemId, files: data.attachments ?? [] });
      })
      .catch((error) => {
        // 失败也要落一次，否则界面会一直停在「正在读取」。
        if (!active) return;
        setAttachments({ itemId, files: [] });
        setToast(error instanceof Error ? error.message : t("读取图片失败"));
      });
    return () => {
      active = false;
    };
  }, [selectedItem]);

  // 渲染期推导，不再需要一个 loadingDetails state。
  const itemAttachments = selectedItem && attachments.itemId === selectedItem.id ? attachments.files : [];
  const loadingDetails =
    Boolean(selectedItem) && !selectedItem?.demo && attachments.itemId !== selectedItem?.id;

  const showingDemo = !loading && items.length === 0;
  const displayItems = showingDemo ? demoItems : items;
  // 打开应用时想知道的是「什么快过期、什么快没了」，不是「我有哪 150 件东西」。
  // 所以默认只展示需要处理的，全部库存收进另一个视图。
  const [scope, setScope] = useState<"attention" | "all">("attention");
  // 大屏上多出来的宽度应该给内容，而不是给一列常驻的导航文字。
  const [railed, setRailed] = useState(false);

  // 侧边栏的展开状态记在本地，下次打开保持上次的选择。
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRailed(window.localStorage.getItem("hsp.sidebar") === "rail");
    } catch {
      /* localStorage 可能被隐私设置禁用，那就保持展开 */
    }
  }, []);

  function toggleRail() {
    setRailed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("hsp.sidebar", next ? "rail" : "full");
      } catch {
        /* 存不下就只在本次会话生效 */
      }
      return next;
    });
  }

  const filteredItems = useMemo(
    () =>
      displayItems.filter((item) => {
        const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase());
        const matchesCategory = category === "全部" || item.category === category;
        return matchesSearch && matchesCategory;
      }),
    [displayItems, search, category],
  );
  /** 需要处理 = 临期或即将过期，或者数量偏少、已用完。 */
  function needsAttention(item: InventoryItem) {
    const info = getExpiryInfo(item, t);
    if (info?.tone === "warning" || info?.tone === "danger") return true;
    if (["偏少", "即将用完", "已用完"].includes(item.level)) return true;
    return Number(item.quantity) <= 0 || Number(item.remainingPercent) <= 30;
  }

  const attentionItems = useMemo(
    () => filteredItems.filter(needsAttention),
    // getExpiryInfo 只依赖翻译函数，翻译变了标签文案会变，但分类结果不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredItems],
  );
  const visibleItems = scope === "attention" ? attentionItems : filteredItems;

  const inventoryGroups = useMemo(() => {
    const grouped = new Map<string, InventoryItem[]>();
    visibleItems.forEach((item) => grouped.set(item.category, [...(grouped.get(item.category) ?? []), item]));
    const knownGroups = categories.filter((name) => grouped.has(name));
    const customGroups = [...grouped.keys()]
      .filter((name) => !categories.includes(name))
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    return [...knownGroups, ...customGroups].map((name) => ({ name, items: grouped.get(name) ?? [] }));
  }, [visibleItems]);

  const expiringCount = displayItems.filter((item) => {
    const info = getExpiryInfo(item, t);
    return info?.tone === "warning" || info?.tone === "danger";
  }).length;
  const lowCount = displayItems.filter(
    (item) =>
      item.remainingPercent <= 50 ||
      item.level === "偏少" ||
      item.level === "即将用完" ||
      item.quantity === 0,
  ).length;

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const purchaseDate = readYmdDate(form, "purchase", "购买日期", t);
      const expiryDate = readYmdDate(form, "expiry", "保质期", t);
      const payload = {
        name: form.get("name"),
        category: form.get("category"),
        location: form.get("location"),
        precision: form.get("precision"),
        quantity: Number(form.get("quantity")),
        unit: form.get("unit"),
        remainingPercent: clampPercent(form.get("remainingPercent")),
        level: form.get("level"),
        purchaseDate,
        expiryDate,
        note: form.get("note"),
      };
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson<Record<string, never>>(response);
      if (!response.ok) throw new Error(data.error || t("保存失败"));
      setShowAdd(false);
      setToast(t("{name} 已加入库存", { name: String(payload.name) }));
      await loadItems();
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("暂时无法保存"));
    } finally {
      setSaving(false);
    }
  }

  async function changeQuantity(item: InventoryItem, direction: -1 | 1) {
    if (item.demo) {
      setToast(t("这是示例物品，添加真实库存后即可调整"));
      return;
    }
    const step = getUnitStep(item);
    const next = Math.max(0, Number((item.quantity + direction * step).toFixed(2)));
    const nextPercent = next === 0 ? 0 : item.quantity === 0 ? 100 : item.remainingPercent;
    const nextLevel = next === 0 ? t("已用完") : item.quantity === 0 ? t("充足") : item.level;
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id
          ? { ...entry, quantity: next, remainingPercent: nextPercent, level: nextLevel }
          : entry,
      ),
    );
    const response = await fetch("/api/inventory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, quantity: next, remainingPercent: nextPercent, level: nextLevel }),
    });
    if (!response.ok) {
      setToast(t("更新失败，已恢复原数量"));
      await loadItems();
    }
  }

  async function changeRemaining(item: InventoryItem, delta: number) {
    if (item.demo) {
      setToast(t("这是示例物品，添加真实库存后即可调整"));
      return;
    }
    const nextPercent = clampPercent(item.remainingPercent + delta);
    const nextLevel = levelFromPercent(nextPercent);
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id ? { ...entry, remainingPercent: nextPercent, level: nextLevel } : entry,
      ),
    );
    if (selectedItem?.id === item.id)
      setSelectedItem({ ...item, remainingPercent: nextPercent, level: nextLevel });
    const response = await fetch("/api/inventory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, remainingPercent: nextPercent, level: nextLevel }),
    });
    if (!response.ok) {
      setToast(t("余量更新失败，已恢复原记录"));
      await loadItems();
    }
  }

  async function uploadItemImages(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || selectedItem.demo) return;
    const uploadForm = event.currentTarget;
    const form = new FormData(uploadForm);
    form.set("itemId", selectedItem.id);
    setUploading(true);
    try {
      const response = await fetch("/api/inventory-files", { method: "POST", body: form });
      const data = await readJson<{ attachments?: InventoryAttachment[] }>(response);
      if (!response.ok) throw new Error(data.error || t("图片上传失败"));
      setAttachments((current) => ({
        itemId: selectedItem.id,
        files: [...(data.attachments ?? []), ...current.files],
      }));
      uploadForm.reset();
      setToast(t("物品图片已保存"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("图片上传失败"));
    } finally {
      setUploading(false);
    }
  }

  async function deleteItemImage(id: string) {
    const response = await fetch(`/api/inventory-files?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      setToast(t("图片删除失败"));
      return;
    }
    setAttachments((current) => ({
      ...current,
      files: current.files.filter((attachment) => attachment.id !== id),
    }));
    setToast(t("图片已删除"));
  }

  async function saveItemEdits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || selectedItem.demo) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const payload = {
        id: selectedItem.id,
        name: form.get("name"),
        category: form.get("category"),
        location: form.get("location"),
        precision: form.get("precision"),
        quantity: Number(form.get("quantity")),
        unit: form.get("unit"),
        level: form.get("level"),
        remainingPercent: clampPercent(form.get("remainingPercent")),
        purchaseDate: readYmdDate(form, "editPurchase", "购买日期", t),
        expiryDate: readYmdDate(form, "editExpiry", "保质期", t),
        openedDate: readYmdDate(form, "editOpened", "开封日", t),
        openedShelfLifeDays: form.get("openedShelfLifeDays") ? Number(form.get("openedShelfLifeDays")) : null,
        note: form.get("note"),
      };
      const response = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson<{ item?: InventoryItem }>(response);
      if (!response.ok) throw new Error(data.error || t("保存失败"));
      const updated = { ...selectedItem, ...data.item } as InventoryItem;
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedItem(updated);
      setEditingItem(false);
      setToast(t("物品资料已更新"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function pickReceipt(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    if (receiptPreview) URL.revokeObjectURL(receiptPreview.url);
    setReceiptPreview(null);
    if (!picked) return;

    // 手机拍的小票动辄好几 MB，先在浏览器里压到 1MB 以内再上传。
    setCompressing(true);
    try {
      const { file, originalSize } = await compressImage(picked);
      setReceiptPreview({
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        originalSize,
        file,
      });
    } catch {
      setReceiptPreview({
        url: URL.createObjectURL(picked),
        name: picked.name,
        size: picked.size,
        originalSize: picked.size,
        file: picked,
      });
    } finally {
      setCompressing(false);
    }
  }

  function closeReceipt() {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview.url);
    setReceiptPreview(null);
    setReceiptDraft(null);
    setReceiptOpen(false);
  }

  async function analyzeReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (receiptPreview) form.set("receipt", receiptPreview.file, receiptPreview.name);
    form.set("preferredCategory", category === "全部" ? "" : category);
    setAnalyzingReceipt(true);
    try {
      const response = await fetch("/api/receipts/analyze", {
        method: "POST",
        headers: withAiHeaders(),
        body: form,
      });
      const data = await readJson<ReceiptDraft>(response);
      if (!response.ok) throw new Error(data.error || t("小票识别失败"));
      setReceiptDraft(data);
      setToast(t("识别到 {count} 项商品，请确认", { count: data.items?.length ?? 0 }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("小票识别失败"));
    } finally {
      setAnalyzingReceipt(false);
    }
  }

  function updateReceiptItem(tempId: string, changes: Partial<ReceiptDraftItem>) {
    setReceiptDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.tempId === tempId ? { ...item, ...changes } : item)),
          }
        : current,
    );
  }

  async function confirmReceiptItems() {
    if (!receiptDraft?.items.length) return;
    setConfirmingReceipt(true);
    try {
      const response = await fetch("/api/receipts/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...receiptDraft.receipt, items: receiptDraft.items }),
      });
      const data = await readJson<{ added?: number; merged?: number }>(response);
      if (!response.ok) throw new Error(data.error || t("保存失败"));
      closeReceipt();
      await loadItems();
      setToast(
        t("小票已处理：新增 {added} 项，合并 {merged} 项", {
          added: data.added ?? 0,
          merged: data.merged ?? 0,
        }),
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("保存失败"));
    } finally {
      setConfirmingReceipt(false);
    }
  }

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openAddForCurrentCategory() {
    setShowAdd(true);
  }

  /**
   * 紧凑行。
   *
   * 原来每件物品是 109px 高、7 个按钮的卡片，150 件就是 23 屏、1000 多个按钮。
   * 这里把「剩余百分比微调」那四个按钮收进详情——它们是低频的精确操作，
   * 不该在每一行里常驻。整行可点开详情，加减数量留在行内因为它最常用。
   */
  /**
   * 物品卡片。
   *
   * 左侧是一个小仪表：图标在上，进度条和百分比在下面，一眼看出还剩多少。
   * 中间是名称、已购买天数和到期提醒——天数比存放位置有用得多：
   * 同样剩 40%，「买了 2 天」和「买了 45 天」是完全不同的消耗速度。
   *
   * 状态标签（偏少 / 充足）本来就是百分比的分档结果，同一个数字显示两遍，
   * 所以只在「已用完」这个需要立刻行动的状态下才出现。
   */
  /**
   * 物品卡片，两行排布。
   *
   * 原来仪表、名称、微调、数量四块挤在一行，341px 的卡片里信息区只剩 126px，
   * 「3 天后到期」这类文字被截断。改成两行之后横向压力变成纵向空间，
   * 而纵向是这个页面最不缺的。
   *
   * 左侧仪表跨两行：图标在上，进度条和百分比在下面。
   * 第一行是名称和数量，第二行是已购买天数、到期提醒和余量微调。
   */
  function renderItem(item: InventoryItem) {
    const expiry = getExpiryInfo(item, t);
    const used = daysInUse(item);
    const emptied = Number(item.quantity) <= 0 || Number(item.remainingPercent) <= 0;
    return (
      <article className="item-card" key={item.id}>
        <span className={`item-gauge ${remainingTone(item.remainingPercent)}`}>
          <span className="gauge-icon" aria-hidden="true">
            {getItemIcon(item)}
          </span>
          <span className="gauge-bar" aria-hidden="true">
            <i style={{ width: `${item.remainingPercent}%` }} />
          </span>
          <b>{item.remainingPercent}%</b>
        </span>
        <div className="item-row">
          <button
            type="button"
            className="item-open"
            onClick={() => setSelectedItem(item)}
            aria-label={t("查看{name}详细资料", { name: item.name })}
          >
            <strong>{tv(item.name)}</strong>
            {item.demo && <span className="demo-tag">{t("示例")}</span>}
            {emptied && <span className="stock-tag low">{tv("已用完")}</span>}
          </button>
          <div className="item-qty">
            <button
              onClick={() => changeQuantity(item, -1)}
              aria-label={t("减少{name}数量", { name: tv(item.name) })}
            >
              −
            </button>
            <strong>{formatQuantity(item, { fmtNumber, tu, tv, t })}</strong>
            <button
              onClick={() => changeQuantity(item, 1)}
              aria-label={t("增加{name}数量", { name: tv(item.name) })}
            >
              ＋
            </button>
          </div>
        </div>
        <div className="item-row item-meta">
          <span className="item-sub">
            {used === null ? tv(item.category) : t("买了 {days} 天", { days: used })}
            {expiry && <span className={`expiry-tag ${expiry.tone}`}>{expiry.label}</span>}
          </span>
          <span className="item-tune">
            <button
              onClick={() => changeRemaining(item, -25)}
              aria-label={t("减少{name}余量", { name: tv(item.name) })}
            >
              −25%
            </button>
            <button
              onClick={() => changeRemaining(item, 25)}
              aria-label={t("增加{name}余量", { name: tv(item.name) })}
            >
              ＋25%
            </button>
          </span>
        </div>
      </article>
    );
  }

  return (
    <>
      {/* 兑换必须在门外：从邮件点进来时还没有会话，门是关着的，
          挂在门里的组件根本不会渲染，令牌也就永远换不成会话。 */}
      <LoginLanding notify={setToast} />
      <LoginGate notify={setToast}>
        <main className={railed ? "app-shell railed" : "app-shell"}>
          <aside className="sidebar" aria-label={t("主要导航")}>
            <button
              type="button"
              className="rail-toggle"
              onClick={toggleRail}
              aria-expanded={!railed}
              aria-label={railed ? t("展开侧边栏") : t("收起侧边栏")}
              title={railed ? t("展开侧边栏") : t("收起侧边栏")}
            >
              {railed ? "»" : "«"}
            </button>
            <button className="brand" onClick={() => scrollTo("overview")} aria-label={t("返回首页")}>
              <span className="brand-mark">{t("家")}</span>
              <span className="nav-label">{t("家里有数")}</span>
            </button>
            <nav>
              <button
                className="nav-item active"
                onClick={() => scrollTo("overview")}
                aria-label={t("总览")}
                title={t("总览")}
              >
                <Icon name="home" />
                <span className="nav-label">{t("总览")}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => scrollTo("inventory")}
                aria-label={t("家庭库存")}
                title={t("家庭库存")}
              >
                <Icon name="inventory" />
                <span className="nav-label">{t("家庭库存")}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => scrollTo("flyers")}
                aria-label={t("Flyer 优惠")}
                title={t("Flyer 优惠")}
              >
                <Icon name="deals" />
                <span className="nav-label">{t("Flyer 优惠")}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => scrollTo("recipes")}
                aria-label={t("本周菜谱")}
                title={t("本周菜谱")}
              >
                <Icon name="recipes" />
                <span className="nav-label">{t("本周菜谱")}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => scrollTo("budget")}
                aria-label={t("预算记录")}
                title={t("预算记录")}
              >
                <Icon name="budget" />
                <span className="nav-label">{t("预算记录")}</span>
              </button>
            </nav>
            <div className="sidebar-spacer" />
            <button
              className="nav-item"
              onClick={() => scrollTo("budget")}
              aria-label={t("家庭设置")}
              title={t("家庭设置")}
            >
              <Icon name="settings" />
              <span className="nav-label">{t("家庭设置")}</span>
            </button>
            <div className="home-profile">
              <span className="avatar">{t("两")}</span>
              <div className="nav-label">
                <strong>{t("我们的家")}</strong>
                <small>{t("2 人 · 个人维护")}</small>
              </div>
            </div>
          </aside>

          <section className="content">
            <header className="topbar">
              <div className="mobile-brand">
                <span className="brand-mark">{t("家")}</span>
                <strong>{t("家里有数")}</strong>
              </div>
              <label className="global-search">
                <Icon name="search" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("搜索家里的物品…")}
                />
              </label>
              <div className="locale-switch compact" role="group" aria-label={t("语言")}>
                {locales.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={option === locale ? "active" : ""}
                    aria-pressed={option === locale}
                    onClick={() => setLocale(option)}
                  >
                    {/* 语言开关上的字永远不翻译：切到英文后
                        「中」被译成 EN，两个按钮就都写着 EN 了。
                        每个选项显示它自己那门语言的名字，看不懂当前语言的人
                        才找得到自己的那一个。 */}
                    {option === "zh" ? "中" : "EN"}
                  </button>
                ))}
              </div>
              <button
                className={demo ? "icon-button demo" : "icon-button"}
                onClick={() => setSettingsOpen(true)}
                aria-label={t("设置")}
                title={demo ? t("演示模式") : t("已配置")}
              >
                <Icon name="settings" />
              </button>
              <button className="primary-button compact" onClick={() => setShowAdd(true)}>
                ＋ {t("添加物品")}
              </button>
            </header>

            <div className="dashboard" id="overview">
              <section className="hero-row">
                <div>
                  <p className="eyebrow">{t("家庭补给台")}</p>
                  <h1>{t("晚上好，家里一切有数。")}</h1>
                  <p className="hero-copy">{t("先看需要处理的，再决定这周买什么。")}</p>
                </div>
                <div className="sync-pill">
                  <span className="pulse" /> {t("已同步 · 多设备可用")}
                </div>
              </section>

              {showingDemo && (
                <div className="demo-banner">
                  <div>
                    <strong>{t("这是一个示例家庭")}</strong>
                    <span>{t("下面的物品都带有“示例”标记，不会写入你的真实库存。")}</span>
                  </div>
                  <button onClick={() => setShowAdd(true)}>{t("录入第一件真实物品")}</button>
                </div>
              )}

              <section className="summary-grid" aria-label={t("库存摘要")}>
                <article className="summary-card green">
                  <div className="summary-icon">
                    <Icon name="inventory" />
                  </div>
                  <div>
                    <span>{t("库存物品")}</span>
                    <strong>
                      {loading ? "—" : showingDemo ? t("4 件示例") : t("{count} 件", { count: items.length })}
                    </strong>
                    <small>{showingDemo ? t("等待真实录入") : t("跨设备同步")}</small>
                  </div>
                </article>
                <article className="summary-card amber">
                  <div className="summary-icon">
                    <Icon name="expiring" />
                  </div>
                  <div>
                    <span>{t("临期提醒")}</span>
                    <strong>{t("{count} 件", { count: expiringCount })}</strong>
                    <small>{t("未来 3 天需要处理")}</small>
                  </div>
                </article>
                <article className="summary-card coral">
                  <div className="summary-icon">↓</div>
                  <div>
                    <span>{t("需要补货")}</span>
                    <strong>{t("{count} 件", { count: lowCount })}</strong>
                    <small>{t("偏少或即将用完")}</small>
                  </div>
                </article>
                <article className="summary-card blue">
                  <div className="summary-icon">$</div>
                  <div>
                    <span>{t("采购计划")}</span>
                    <strong>{t("已启用")}</strong>
                    <small>{t("预算、门店与 Flyer")}</small>
                  </div>
                </article>
              </section>

              <section className="main-grid">
                <div className="left-column">
                  <section className="panel inventory-panel" id="inventory">
                    <div className="section-head">
                      <div>
                        <p className="eyebrow">{scope === "attention" ? t("需要关注") : t("全部库存")}</p>
                        <h2>
                          {t("库存状态")}
                          <small className="section-count">
                            {t("{count} 项", {
                              count: scope === "attention" ? attentionItems.length : filteredItems.length,
                            })}
                          </small>
                        </h2>
                      </div>
                      <div className="section-actions">
                        <button className="mini-add-button" onClick={openAddForCurrentCategory}>
                          {t("＋ 添加物品")}
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setScope((value) => (value === "all" ? "attention" : "all"))}
                        >
                          {scope === "attention" ? t("查看全部") : t("只看需要处理")} <span>→</span>
                        </button>
                      </div>
                    </div>
                    <div className="filter-row">
                      {["全部", "蔬菜水果", "乳品蛋类", "米面粮油", "清洁用品"].map((name) => (
                        <button
                          key={name}
                          onClick={() => setCategory(name)}
                          className={category === name ? "filter-chip active" : "filter-chip"}
                        >
                          {name === "全部" ? t("全部") : tv(name)}
                        </button>
                      ))}
                    </div>
                    <div className={`inventory-list${category === "全部" ? " grouped" : ""}`}>
                      {visibleItems.length === 0 ? (
                        scope === "attention" && filteredItems.length > 0 ? (
                          // 没有需要处理的不是空状态，是好消息，不该催人添加物品。
                          <div className="empty-state calm">
                            <span>✓</span>
                            <h3>{t("目前没有需要处理的物品")}</h3>
                            <p>{t("临期、偏少和已用完的物品会出现在这里。")}</p>
                            <button className="secondary-button" onClick={() => setScope("all")}>
                              {t("查看全部")}
                            </button>
                          </div>
                        ) : (
                          <div className="empty-state">
                            <span>📦</span>
                            <h3>{t("还没有符合条件的物品")}</h3>
                            <p>{t("从手动录入开始，之后可以继续接入照片、小票和条码。")}</p>
                            <button className="primary-button" onClick={() => setShowAdd(true)}>
                              {t("添加物品")}
                            </button>
                          </div>
                        )
                      ) : category === "全部" ? (
                        inventoryGroups.map((group) => (
                          <section
                            className="inventory-group"
                            key={group.name}
                            aria-labelledby={`inventory-group-${group.name}`}
                          >
                            <header className="inventory-group-heading">
                              <div>
                                <span aria-hidden="true">{categoryIcons[group.name] ?? "📦"}</span>
                                <h3 id={`inventory-group-${group.name}`}>{tv(group.name)}</h3>
                              </div>
                              <small>{t("{count} 项", { count: group.items.length })}</small>
                            </header>
                            <div className="inventory-group-items">{group.items.map(renderItem)}</div>
                          </section>
                        ))
                      ) : (
                        visibleItems.map(renderItem)
                      )}
                    </div>
                  </section>

                  <section className="panel quick-panel">
                    <div className="section-head">
                      <div>
                        <p className="eyebrow">{t("快速录入")}</p>
                        <h2>{t("怎么更新最方便？")}</h2>
                      </div>
                    </div>
                    <div className="quick-grid">
                      <button className="quick-action ready" onClick={() => setShowAdd(true)}>
                        <span>＋</span>
                        <strong>{t("手动添加")}</strong>
                        <small>{t("现在可用")}</small>
                      </button>
                      <button
                        className="quick-action"
                        onClick={() => setToast(t("照片识别将在下一阶段接入"))}
                      >
                        <Icon name="camera" />
                        <strong>{t("拍照识别")}</strong>
                        <small>{t("下一阶段")}</small>
                      </button>
                      <button
                        className="quick-action ready"
                        onClick={() => {
                          setReceiptDraft(null);
                          setReceiptOpen(true);
                        }}
                      >
                        <Icon name="receipt" />
                        <strong>{t("上传小票")}</strong>
                        <small>{t("AI 自动识别")}</small>
                      </button>
                      <button
                        className="quick-action"
                        onClick={() => setToast(t("条码扫描将在下一阶段接入"))}
                      >
                        <Icon name="barcode" />
                        <strong>{t("扫描条码")}</strong>
                        <small>{t("下一阶段")}</small>
                      </button>
                    </div>
                  </section>
                </div>

                <div className="right-column">
                  <PlannerPanel inventory={items} notify={setToast} onInventoryChange={loadItems} />
                </div>
              </section>
            </div>
          </section>

          <nav className="mobile-nav" aria-label={t("移动端导航")}>
            <button onClick={() => scrollTo("overview")}>
              <Icon name="home" />
              {t("总览")}
            </button>
            <button onClick={() => scrollTo("inventory")}>
              <Icon name="inventory" />
              {t("库存")}
            </button>
            <button className="mobile-add" onClick={() => setShowAdd(true)}>
              ＋
            </button>
            <button onClick={() => scrollTo("flyers")}>
              <Icon name="deals" />
              {t("优惠")}
            </button>
            <button onClick={() => scrollTo("recipes")}>
              <Icon name="recipes" />
              {t("菜谱")}
            </button>
          </nav>

          {showAdd && (
            <Modal eyebrow={t("真实库存")} title={t("添加一件物品")} onClose={() => setShowAdd(false)}>
              <form onSubmit={saveItem}>
                <label className="field full">
                  <span>{t("物品名称")}</span>
                  <input name="name" required placeholder={t("例如：鸡蛋、洗衣液")} />
                </label>
                <div className="field-grid">
                  <label className="field">
                    <span>{t("种类")}</span>
                    <select name="category" defaultValue={category === "全部" ? t("蔬菜水果") : category}>
                      {categories.map((item) => (
                        <option key={item} value={item}>
                          {tv(item)}
                        </option>
                      ))}
                    </select>
                    <small className="field-hint">
                      {category === "全部"
                        ? t("可选择物品种类")
                        : t("已定位到当前分类：{category}", { category: tv(category) })}
                    </small>
                  </label>
                  <label className="field">
                    <span>{t("存放位置")}</span>
                    <select name="location" defaultValue="冰箱">
                      {locations.map((item) => (
                        <option key={item} value={item}>
                          {tv(item)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("记录方式")}</span>
                    <select name="precision" defaultValue="quantity">
                      <option value="simple">{t("简单状态")}</option>
                      <option value="quantity">{t("数量模式")}</option>
                      <option value="exact">{t("精确模式")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("库存状态")}</span>
                    <select name="level" defaultValue="充足">
                      <option value="充足">{tv("充足")}</option>
                      <option value="偏少">{tv("偏少")}</option>
                      <option value="即将用完">{tv("即将用完")}</option>
                      <option value="已用完">{tv("已用完")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("数量")}</span>
                    <input name="quantity" type="number" min="0" step="0.1" defaultValue="1" required />
                  </label>
                  <label className="field" htmlFor="add-unit">
                    <span>{t("计数单位")}</span>
                    <UnitSelect
                      id="add-unit"
                      name="unit"
                      defaultValue={defaultUnitForCategory(category === "全部" ? t("蔬菜水果") : category)}
                    />
                    <small className="field-hint">{t("计件、包装、重量、容量与余量分开记录")}</small>
                  </label>
                  <label className="field full">
                    <span>{t("剩余百分比")}</span>
                    <input
                      name="remainingPercent"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max="100"
                      step="1"
                      defaultValue="100"
                      required
                    />
                    <small className="field-hint">{t("适用于所有计数单位，范围 0–100%")}</small>
                  </label>
                  <YmdDateInput prefix="purchase" label={t("购买日期（可选）")} />
                  <YmdDateInput prefix="expiry" label={t("保质期（可选）")} />
                  <label className="field full">
                    <span>{t("备注（可选）")}</span>
                    <textarea name="note" rows={3} placeholder={t("品牌、开封日期或其他信息")} />
                  </label>
                </div>
                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={() => setShowAdd(false)}>
                    {t("取消")}
                  </button>
                  <button type="submit" className="primary-button" disabled={saving}>
                    {saving ? t("正在保存…") : t("加入库存")}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {selectedItem && (
            <Modal
              className="detail-modal"
              title={tv(selectedItem.name)}
              onClose={() => {
                setSelectedItem(null);
                setEditingItem(false);
              }}
              head={
                <div className="modal-head detail-head">
                  <div className="detail-title-group">
                    <span className="detail-icon" aria-hidden="true">
                      {getItemIcon(selectedItem)}
                    </span>
                    <div>
                      <p className="eyebrow">{t("物品详细资料")}</p>
                      <h2 id="detail-title">{tv(selectedItem.name)}</h2>
                      {!selectedItem.demo && (
                        <small className="detail-edit-hint">
                          {t("名称、种类、位置、数量、单位、状态与日期均可修改")}
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="detail-head-actions">
                    {!selectedItem.demo && (
                      <button
                        className="text-button edit-toggle"
                        onClick={() => setEditingItem((current) => !current)}
                      >
                        {editingItem ? t("取消编辑") : t("编辑全部资料")}
                      </button>
                    )}
                    <button
                      className="modal-close"
                      onClick={() => {
                        setSelectedItem(null);
                        setEditingItem(false);
                      }}
                      aria-label={t("关闭")}
                    >
                      ×
                    </button>
                  </div>
                </div>
              }
            >
              {editingItem ? (
                <form className="detail-edit-form" onSubmit={saveItemEdits}>
                  <div className="field-grid">
                    <label className="field full">
                      <span>{t("物品名称")}</span>
                      <input name="name" required defaultValue={selectedItem.name} />
                    </label>
                    <label className="field">
                      <span>{t("种类")}</span>
                      <select name="category" defaultValue={selectedItem.category}>
                        {categories.map((item) => (
                          <option key={item} value={item}>
                            {tv(item)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("存放位置")}</span>
                      <select name="location" defaultValue={selectedItem.location}>
                        {locations.map((item) => (
                          <option key={item} value={item}>
                            {tv(item)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("记录方式")}</span>
                      <select name="precision" defaultValue={selectedItem.precision}>
                        <option value="simple">{t("简单状态")}</option>
                        <option value="quantity">{t("数量模式")}</option>
                        <option value="exact">{t("精确模式")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("库存状态")}</span>
                      <select name="level" defaultValue={selectedItem.level}>
                        <option value="充足">{tv("充足")}</option>
                        <option value="偏少">{tv("偏少")}</option>
                        <option value="即将用完">{tv("即将用完")}</option>
                        <option value="已用完">{tv("已用完")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("数量")}</span>
                      <input
                        name="quantity"
                        type="number"
                        min="0"
                        step="0.1"
                        defaultValue={selectedItem.quantity}
                        required
                      />
                    </label>
                    <label className="field" htmlFor="edit-unit">
                      <span>{t("计数单位")}</span>
                      <UnitSelect id="edit-unit" name="unit" defaultValue={selectedItem.unit} />
                      <small className="field-hint">{t("保存后，加减按钮会自动使用对应步长")}</small>
                    </label>
                    <label className="field full">
                      <span>{t("剩余百分比")}</span>
                      <input
                        name="remainingPercent"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max="100"
                        step="1"
                        defaultValue={selectedItem.remainingPercent}
                        required
                      />
                      <small className="field-hint">{t("可手动输入 0–100；保存时会限制在此范围内")}</small>
                    </label>
                    <YmdDateInput
                      prefix="editPurchase"
                      label={t("购买日期（可选）")}
                      value={selectedItem.purchaseDate}
                    />
                    <YmdDateInput
                      prefix="editExpiry"
                      label={t("保质期（可选）")}
                      value={selectedItem.expiryDate}
                    />
                    <YmdDateInput
                      prefix="editOpened"
                      label={t("开封日（可选）")}
                      value={selectedItem.openedDate}
                    />
                    <label className="field" htmlFor="edit-opened-shelf">
                      <span>{t("开封后可用天数")}</span>
                      <input
                        id="edit-opened-shelf"
                        name="openedShelfLifeDays"
                        type="number"
                        min="1"
                        max="3650"
                        defaultValue={selectedItem.openedShelfLifeDays ?? ""}
                        placeholder={String(defaultOpenedShelfLife(selectedItem.category) ?? "")}
                      />
                      <small className="field-hint">{t("留空则按分类默认值推算")}</small>
                    </label>
                    <label className="field full">
                      <span>{t("备注（可选）")}</span>
                      <textarea name="note" rows={3} defaultValue={selectedItem.note ?? ""} />
                    </label>
                  </div>
                  <div className="edit-actions">
                    <button type="button" className="secondary-button" onClick={() => setEditingItem(false)}>
                      {t("取消")}
                    </button>
                    <button className="primary-button" disabled={saving}>
                      {saving ? t("正在保存…") : t("保存修改")}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="detail-facts">
                    <div>
                      <span>{t("种类")}</span>
                      <strong>{tv(selectedItem.category)}</strong>
                    </div>
                    <div>
                      <span>{t("存放位置")}</span>
                      <strong>{tv(selectedItem.location)}</strong>
                    </div>
                    <div>
                      <span>{t("当前数量")}</span>
                      <strong>{formatQuantity(selectedItem, { fmtNumber, tu, tv, t })}</strong>
                    </div>
                    <div>
                      <span>{t("库存状态")}</span>
                      <strong>{tv(selectedItem.level)}</strong>
                    </div>
                    <div className="detail-remaining">
                      <span>{t("剩余百分比")}</span>
                      <strong>{selectedItem.remainingPercent}%</strong>
                      <div className={`remaining-track ${remainingTone(selectedItem.remainingPercent)}`}>
                        <i style={{ width: `${selectedItem.remainingPercent}%` }} />
                      </div>
                    </div>
                    <div>
                      <span>{t("购买日期")}</span>
                      <strong>
                        {selectedItem.purchaseDate ? fmtDate(selectedItem.purchaseDate) : t("未记录")}
                      </strong>
                    </div>
                    <div>
                      <span>{t("保质期")}</span>
                      <strong>
                        {selectedItem.expiryDate ? fmtDate(selectedItem.expiryDate) : t("未记录")}
                      </strong>
                    </div>
                    <div>
                      <span>{t("开封日")}</span>
                      <strong>
                        {selectedItem.openedDate ? fmtDate(selectedItem.openedDate) : t("尚未开封")}
                      </strong>
                    </div>
                    <div>
                      <span>{t("已使用")}</span>
                      <strong>
                        {daysInUse(selectedItem) === null
                          ? t("未记录")
                          : t("{days} 天", { days: daysInUse(selectedItem) ?? 0 })}
                      </strong>
                    </div>
                  </div>
                  {(() => {
                    // 开封后的实际到期日常常早于包装标注，这里明确写出依据，
                    // 免得用户看到两个日期不一致以为记错了。
                    const effective = effectiveExpiry(selectedItem);
                    if (!effective.fromOpening || !effective.date) return null;
                    return (
                      <p className="detail-opened-note">
                        {t("开封后实际应在 {date} 前用完", { date: fmtDate(effective.date) })}
                      </p>
                    );
                  })()}
                  <section className="detail-note">
                    <span>{t("备注")}</span>
                    <p>{selectedItem.note ? tv(selectedItem.note) : t("暂无备注")}</p>
                  </section>
                </>
              )}
              <section className="photo-section">
                <div className="photo-heading">
                  <div>
                    <span>{t("物品照片")}</span>
                    <small>{t("包装、标签、保质期或购买小票都可以拍下来保存")}</small>
                  </div>
                  <b>{itemAttachments.length}/8</b>
                </div>
                {loadingDetails ? (
                  <p className="photo-status">{t("正在读取图片…")}</p>
                ) : itemAttachments.length ? (
                  <div className="photo-grid">
                    {itemAttachments.map((attachment) => (
                      <figure key={attachment.id}>
                        <img
                          src={`/api/inventory-files?fileId=${encodeURIComponent(attachment.id)}`}
                          alt={`${selectedItem.name} - ${attachment.fileName}`}
                        />
                        <button
                          type="button"
                          onClick={() => deleteItemImage(attachment.id)}
                          aria-label={t("删除{name}", { name: attachment.fileName })}
                        >
                          ×
                        </button>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <div className="photo-empty">
                    <Icon name="camera" />
                    <p>{selectedItem.demo ? t("示例物品不能上传图片") : t("还没有保存图片")}</p>
                  </div>
                )}
                {!selectedItem.demo && (
                  <form className="photo-upload" onSubmit={uploadItemImages}>
                    <label>
                      <span>{t("＋ 选择图片")}</span>
                      <input name="files" type="file" accept="image/*" multiple required />
                    </label>
                    <button className="primary-button" disabled={uploading || itemAttachments.length >= 8}>
                      {uploading ? t("正在上传…") : t("上传图片")}
                    </button>
                  </form>
                )}
                <small className="upload-note">{t("每张最大 5MB，每件物品最多 8 张。")}</small>
              </section>
            </Modal>
          )}

          {receiptOpen && (
            <Modal
              className="receipt-modal"
              eyebrow={t("AI 小票录入")}
              title={receiptDraft ? t("确认识别结果") : t("上传购物小票")}
              onClose={() => {
                if (!analyzingReceipt && !confirmingReceipt) closeReceipt();
              }}
            >
              {!receiptDraft ? (
                <form className="receipt-upload-form" onSubmit={analyzeReceipt}>
                  <div className={receiptPreview ? "receipt-upload-box has-preview" : "receipt-upload-box"}>
                    {compressing ? (
                      <>
                        <span>◌</span>
                        <strong>{t("正在压缩照片…")}</strong>
                        <p>{t("上传前会先压到 1MB 以内，避免超出大小限制。")}</p>
                      </>
                    ) : receiptPreview ? (
                      <>
                        <img
                          className="receipt-preview"
                          src={receiptPreview.url}
                          alt={t("已选择的小票照片")}
                        />
                        <small className="receipt-file-meta">
                          {receiptPreview.name} · {formatBytes(receiptPreview.size)}
                          {receiptPreview.originalSize > receiptPreview.size
                            ? ` · ${t("已从 {before} 压缩", { before: formatBytes(receiptPreview.originalSize) })}`
                            : ""}
                        </small>
                      </>
                    ) : (
                      <>
                        <Icon name="receipt" />
                        <strong>{t("选择清晰的小票照片")}</strong>
                        <p>
                          {t(
                            "系统会识别商品、数量、价格与购买日期。识别结果不会直接写入库存，需要你先确认。",
                          )}
                        </p>
                      </>
                    )}
                    <label>
                      <span>{receiptPreview ? t("重新选择") : t("选择照片")}</span>
                      <input
                        name="receipt"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        required
                        onChange={pickReceipt}
                      />
                    </label>
                  </div>
                  {category !== "全部" && (
                    <p className="receipt-category-hint">
                      {t("识别不明确时，会优先归入当前分类「{category}」。", { category: tv(category) })}
                    </p>
                  )}
                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={closeReceipt}>
                      {t("取消")}
                    </button>
                    <button className="primary-button" disabled={compressing || analyzingReceipt}>
                      {analyzingReceipt ? t("正在识别小票…") : t("开始识别")}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="receipt-summary">
                    <label>
                      <span>{t("商店")}</span>
                      <input
                        value={receiptDraft.receipt.store}
                        onChange={(event) =>
                          setReceiptDraft({
                            ...receiptDraft,
                            receipt: { ...receiptDraft.receipt, store: event.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>{t("购买日期")}</span>
                      <input
                        value={receiptDraft.receipt.purchaseDate}
                        placeholder="YYYY-MM-DD"
                        onChange={(event) =>
                          setReceiptDraft({
                            ...receiptDraft,
                            receipt: { ...receiptDraft.receipt, purchaseDate: event.target.value },
                          })
                        }
                      />
                    </label>
                    <div>
                      <span>{t("小票总额")}</span>
                      <strong>
                        {receiptDraft.receipt.total == null
                          ? t("未识别")
                          : `$${Number(receiptDraft.receipt.total).toFixed(2)}`}
                      </strong>
                    </div>
                  </div>
                  <div className="receipt-review-head">
                    <div>
                      <strong>{t("识别到 {count} 项", { count: receiptDraft.items.length })}</strong>
                      <small>{t("可修改名称、分类、数量，也可以选择新建或合并到已有物品。")}</small>
                    </div>
                    <button className="text-button" onClick={() => setReceiptDraft(null)}>
                      {t("重新上传")}
                    </button>
                  </div>
                  <div className="receipt-items">
                    {receiptDraft.items.map((item) => (
                      <article key={item.tempId}>
                        <div className="receipt-item-top">
                          <input
                            className="receipt-name"
                            value={item.name}
                            onChange={(event) => updateReceiptItem(item.tempId, { name: event.target.value })}
                            aria-label={t("商品名称")}
                          />
                          <span className={item.confidence >= 0.75 ? "confidence good" : "confidence review"}>
                            {item.confidence >= 0.75 ? t("识别较清晰") : t("请重点确认")}
                          </span>
                          <button
                            onClick={() =>
                              setReceiptDraft({
                                ...receiptDraft,
                                items: receiptDraft.items.filter((entry) => entry.tempId !== item.tempId),
                              })
                            }
                            aria-label={t("移除{name}", { name: item.name })}
                          >
                            ×
                          </button>
                        </div>
                        <div className="receipt-item-fields">
                          <label>
                            <span>{t("实付单价")}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unitPrice ?? ""}
                              placeholder="0.00"
                              onChange={(event) => {
                                const unitPrice = event.target.value ? Number(event.target.value) : null;
                                // 单价改了就重算行合计，除非用户自己填过合计。
                                updateReceiptItem(item.tempId, {
                                  unitPrice,
                                  lineTotal:
                                    unitPrice === null
                                      ? null
                                      : Math.round(unitPrice * item.quantity * 100) / 100,
                                });
                              }}
                            />
                            {item.regularUnitPrice !== null && item.unitPrice !== null && (
                              <small className="receipt-was-price">
                                {t("原价 {price}", { price: money(item.regularUnitPrice) })}
                              </small>
                            )}
                          </label>
                          <label>
                            <span>{t("数量")}</span>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={item.quantity}
                              onChange={(event) =>
                                updateReceiptItem(item.tempId, { quantity: Number(event.target.value) })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("计数单位")}</span>
                            <select
                              value={item.unit}
                              onChange={(event) =>
                                updateReceiptItem(item.tempId, { unit: event.target.value })
                              }
                            >
                              {!commonUnits.includes(item.unit as (typeof commonUnits)[number]) && (
                                <option value={item.unit}>{item.unit}</option>
                              )}
                              {unitGroups.map((group) => (
                                <optgroup key={group.label} label={group.label}>
                                  {group.units.map((unit) => (
                                    <option key={unit} value={unit}>
                                      {tv(unit)}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>{t("分类")}</span>
                            <select
                              value={item.category}
                              onChange={(event) =>
                                updateReceiptItem(item.tempId, { category: event.target.value })
                              }
                            >
                              {categories.map((name) => (
                                <option key={name} value={name}>
                                  {tv(name)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>{t("处理方式")}</span>
                            <select
                              value={item.action}
                              onChange={(event) =>
                                updateReceiptItem(item.tempId, {
                                  action: event.target.value as "new" | "merge",
                                })
                              }
                            >
                              <option value="new">{t("新建物品")}</option>
                              <option value="merge">{t("合并已有")}</option>
                            </select>
                          </label>
                        </div>
                        {item.action === "merge" && (
                          <label className="merge-target">
                            <span>{t("合并到")}</span>
                            <select
                              value={item.mergeItemId}
                              onChange={(event) =>
                                updateReceiptItem(item.tempId, { mergeItemId: event.target.value })
                              }
                            >
                              <option value="">{t("请选择已有物品")}</option>
                              {items.map((existing) => (
                                <option key={existing.id} value={existing.id}>
                                  {existing.name} · {formatQuantity(existing, { fmtNumber, tu, tv, t })}
                                </option>
                              ))}
                            </select>
                            {item.matchName && (
                              <small>
                                模糊匹配建议：{item.matchName}（{Math.round(item.matchScore * 100)}%）
                              </small>
                            )}
                          </label>
                        )}
                        {item.lineTotal != null && (
                          <small className="receipt-price">
                            {t("小票金额 {total}", { total: money(item.lineTotal) })}
                          </small>
                        )}
                      </article>
                    ))}
                  </div>
                  <div className="modal-actions">
                    <button className="secondary-button" onClick={closeReceipt}>
                      {t("取消")}
                    </button>
                    <button
                      className="primary-button"
                      onClick={confirmReceiptItems}
                      disabled={confirmingReceipt || !receiptDraft.items.length}
                    >
                      {confirmingReceipt ? t("正在写入库存…") : t("确认并加入库存")}
                    </button>
                  </div>
                </>
              )}
            </Modal>
          )}

          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} notify={setToast} />}
          {toast && (
            <div className="toast" role="status">
              {toast}
            </div>
          )}
        </main>
      </LoginGate>
    </>
  );
}
