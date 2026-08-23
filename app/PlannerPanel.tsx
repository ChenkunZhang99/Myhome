"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { dayIn, detectTimeZone, resolveTimeZone, timeZoneChoices } from "./dateTime";
import { buildFlyerPurchasePlan, recommendFlyerDeals } from "./flyerRecommendations";
import { findInventoryMatch, rankInventoryMatches } from "./inventoryUsage";
import { withAiHeaders } from "./aiSettings";
import { useAppSettings } from "./AppSettings";
import { readJson } from "./apiClient";
import { Modal } from "./Modal";
import type { Locale } from "./i18n";
import { RecipeWorkspace } from "./RecipeWorkspace";

type Settings = {
  city: string;
  postalCode: string;
  foodBudget: number;
  householdBudget: number;
  maxStores: number;
  timezone: string;
};
type Store = {
  id: string;
  name: string;
  address: string;
  sourceKey?: string | null;
  flyerUrl?: string;
  flyerFormat?: string;
  lastSyncedAt?: string | null;
  isFavorite: number | boolean;
};
type Deal = {
  id: string;
  storeId: string;
  itemName: string;
  category: string;
  price: number;
  regularPrice?: number | null;
  unit: string;
  validFrom: string;
  validTo: string;
  source?: string;
  sourceUrl?: string;
  packageQuantity?: number | null;
  packageUnit?: string | null;
  confidence?: string;
  verifiedAt?: string;
  isSaved?: number | boolean;
  hidden?: number | boolean;
  lowestPrice?: number | null;
  averagePrice?: number | null;
  priceObservations?: number;
};
type ShoppingItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  checked: number | boolean;
  stocked?: number | boolean;
  source: string;
};
type InventoryLite = {
  id: string;
  name: string;
  category: string;
  level: string;
  quantity?: number;
  unit?: string;
  remainingPercent?: number;
  expiryDate?: string | null;
};
type RestockRow = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  mergeItemId: string;
  skip: boolean;
};
type MatchRule = {
  id: string;
  inventoryName: string;
  dealPattern: string;
  category?: string;
  matchKind: "targeted" | "substitute" | "category";
  active: number | boolean;
};
type SyncSettings = {
  enabled: number | boolean;
  intervalHours: number;
  nextSyncAt?: string | null;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastStatus: string;
  lastMessage: string;
  dealsImported: number;
};
type Spending = { since: string; food: number; household: number };
/** 目录里已知的一家店。按邮编搜出来的，和代码里预设的那三家，形状一样。 */
type NearbyStore = {
  sourceKey: string;
  name: string;
  address: string;
  chain: string;
  flyerUrl: string;
  flyerFormat: string;
  cached: boolean;
};
type PlannerData = {
  /** 当前邮编所在的片区（加拿大 FSA，邮编前三位）。 */
  area?: string;
  /** 这个片区目录里已经有的店。全局共享，所以往往一打开就有得选。 */
  nearby?: NearbyStore[];
  settings: Settings;
  stores: Store[];
  deals: Deal[];
  shopping: ShoppingItem[];
  syncSettings: SyncSettings;
  matchRules: MatchRule[];
  spending?: Spending;
};

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
const foodCategorySet = new Set([
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
]);
const tierLabels = { must: "必须补货", recommended: "建议补货", opportunity: "机会购买" } as const;
const matchLabels = { targeted: "精准匹配", substitute: "替代补货", category: "大类机会" } as const;
const confidenceLabels: Record<string, string> = {
  confirmed: "官方结构化核验",
  high: "官方来源核验",
  medium: "网页搜索核验",
  low: "需要确认",
};

function money(value: number) {
  return `$${value.toFixed(2)}`;
}
/**
 * 同步状态的说明文字。
 * 服务端存的 last_message 是中文句子，它不知道访问者的语言，
 * 所以这里只用 last_status + deals_imported 这两个结构化字段自己拼。
 * 只有出错时才回退到服务端消息 —— 那里面通常带着有用的具体原因。
 */
function syncMessage(
  sync: SyncSettings,
  t: (text: string, vars?: Record<string, string | number>) => string,
) {
  const imported = Number(sync.dealsImported) || 0;
  switch (sync.lastStatus) {
    case "running":
      return t("正在读取收藏门店 Flyer");
    case "success":
      return t("已自动录入 {count} 项当前优惠", { count: imported });
    case "partial":
      return t("部分门店读取成功，已录入 {count} 项优惠", { count: imported });
    case "empty":
      return t("这些门店当前没有生效中的优惠");
    case "error":
      return sync.lastMessage || t("Flyer 自动同步失败");
    default:
      return t("尚未自动同步");
  }
}

function todayString(timeZone: string) {
  return dayIn(timeZone);
}
function shortDate(value: string, locale: Locale) {
  const [, month, day] = value.split("-");
  if (locale === "zh") return `${month}月${day}日`;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(parsed);
}
function syncTime(
  value: string | null | undefined,
  locale: Locale,
  timeZone: string,
  t?: (text: string) => string,
) {
  if (!value) return t ? t("尚未同步") : "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-CA", {
    timeZone: resolveTimeZone(timeZone),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function readDate(
  form: FormData,
  prefix: string,
  label: string,
  t: (text: string, vars?: Record<string, string | number>) => string,
) {
  const year = String(form.get(`${prefix}Year`) ?? "").trim();
  const month = String(form.get(`${prefix}Month`) ?? "").trim();
  const day = String(form.get(`${prefix}Day`) ?? "").trim();
  if (!year || !month || !day) throw new Error(t("请完整填写{label}", { label }));
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidate.getUTCFullYear() !== Number(year) ||
    candidate.getUTCMonth() !== Number(month) - 1 ||
    candidate.getUTCDate() !== Number(day)
  )
    throw new Error(t("{label}不是有效日期", { label }));
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function CompactDate({ prefix, label }: { prefix: string; label: string }) {
  const { t } = useAppSettings();
  return (
    <div className="field full" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="date-parts compact-date">
        <label className="date-part">
          <input name={`${prefix}Year`} type="number" min="2020" max="2100" placeholder="2026" required />
          <b>{t("年")}</b>
        </label>
        <label className="date-part">
          <input name={`${prefix}Month`} type="number" min="1" max="12" placeholder="08" required />
          <b>{t("月")}</b>
        </label>
        <label className="date-part">
          <input name={`${prefix}Day`} type="number" min="1" max="31" placeholder="14" required />
          <b>{t("日")}</b>
        </label>
      </div>
    </div>
  );
}

export function PlannerPanel({
  inventory,
  notify,
  onInventoryChange,
}: {
  inventory: InventoryLite[];
  notify: (message: string) => void;
  onInventoryChange: () => void;
}) {
  const { t, tv, tu, locale } = useAppSettings();
  const [data, setData] = useState<PlannerData>({
    settings: {
      city: "",
      postalCode: "",
      foodBudget: 0,
      householdBudget: 0,
      maxStores: 2,
      timezone: detectTimeZone(),
    },
    stores: [],
    deals: [],
    shopping: [],
    syncSettings: {
      enabled: 1,
      intervalHours: 24,
      lastStatus: "never",
      lastMessage: "尚未自动同步",
      dealsImported: 0,
    },
    matchRules: [],
    spending: { since: "", food: 0, household: 0 },
    area: "",
    nearby: [],
  });
  const timeZone = data.settings.timezone || detectTimeZone();
  // 界面一打开就有得选：GET 已经按这户填的邮编把片区里已知的店带回来了。
  const nearby = data.nearby ?? [];
  const [modal, setModal] = useState<"settings" | "store" | "deal" | "shopping" | "match" | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [restockRows, setRestockRows] = useState<RestockRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // 找附近超市：邮编输入、搜索中、以及勾了哪几家
  const [areaCode, setAreaCode] = useState("");
  const [finding, setFinding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const autoSyncing = useRef(false);

  async function load() {
    try {
      const response = await fetch("/api/planner", { cache: "no-store" });
      const result = await readJson<PlannerData>(response);
      if (!response.ok) throw new Error(result.error || t("读取失败"));
      setData(result);
      const due =
        Boolean(result.syncSettings?.enabled) &&
        (!result.syncSettings?.nextSyncAt ||
          new Date(result.syncSettings.nextSyncAt).getTime() <= Date.now());
      const supportedStore = result.stores?.some((store: Store) => store.sourceKey && store.flyerUrl);
      if (due && supportedStore && result.syncSettings?.lastStatus !== "running" && !autoSyncing.current)
        void syncFlyers(true);
    } catch {
      notify(t("采购计划暂时无法读取"));
    }
  }
  // 挂载时拉一次数据。规则希望改用框架级的数据加载或 SWR 之类的库，
  // 但为此在这个规模的项目里引入一整套数据层并不划算，这里明确保留。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function post(payload: Record<string, unknown>, success?: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readJson<{ ok?: boolean; added?: number; merged?: number; skipped?: number }>(
        response,
      );
      if (!response.ok) throw new Error(result.error || t("保存失败"));
      setModal(null);
      if (success) notify(success);
      await load();
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : t("保存失败"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 按邮编找附近的超市。
   *
   * 目录是全局的：这个片区别人搜过就直接命中，一个 token 都不花。
   * 所以这个按钮点下去往往是瞬间返回的，而不是每次都去调模型。
   */
  async function findNearby(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const postalCode = areaCode.trim() || data.settings.postalCode;
    if (!postalCode) {
      notify(t("请先填写邮编"));
      return;
    }
    setFinding(true);
    try {
      const response = await fetch("/api/planner", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...withAiHeaders() },
        body: JSON.stringify({ type: "discoverStores", postalCode }),
      });
      const result = await readJson<{ area?: string; stores?: NearbyStore[]; fromCache?: boolean }>(response);
      if (!response.ok) throw new Error(result.error || t("附近门店搜索失败"));
      const found = result.stores ?? [];
      setData((current) => ({ ...current, area: result.area ?? "", nearby: found }));
      notify(
        found.length === 0
          ? t("这个片区暂时没搜到会发 Flyer 的超市")
          : result.fromCache
            ? t("从目录里找到 {count} 家（没有花费）", { count: found.length })
            : t("搜到 {count} 家，勾选你常去的", { count: found.length }),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : t("附近门店搜索失败"));
    } finally {
      setFinding(false);
    }
  }

  /** 把勾中的几家一次性收藏，然后立刻读一次它们的 Flyer。 */
  async function savePickedAndSync() {
    if (!picked.length) return;
    setBusy(true);
    try {
      for (const sourceKey of picked) {
        const response = await fetch("/api/planner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "storePreset", sourceKey }),
        });
        const result = await readJson<Record<string, never>>(response);
        if (!response.ok) throw new Error(result.error || t("收藏失败"));
      }
      setPicked([]);
      await load();
      notify(t("已收藏，正在读取它们的 Flyer…"));
      await syncFlyers();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("收藏失败"));
    } finally {
      setBusy(false);
    }
  }

  async function syncFlyers(silent = false) {
    if (autoSyncing.current) return;
    autoSyncing.current = true;
    setSyncing(true);
    try {
      const response = await fetch("/api/flyers/sync", { method: "POST", headers: withAiHeaders() });
      const result = await readJson<{ imported?: number; message?: string }>(response);
      if (!response.ok) throw new Error(result.error || t("Flyer 自动同步失败"));
      const imported = result.imported ?? 0;
      if (!silent || imported > 0)
        notify(result.message || t("已自动录入 {count} 项优惠", { count: imported }));
      await load();
    } catch (error) {
      if (!silent) notify(error instanceof Error ? error.message : t("Flyer 自动同步失败"));
      else await load();
    } finally {
      autoSyncing.current = false;
      setSyncing(false);
    }
  }

  async function remove(type: "store" | "deal" | "shopping", id: string) {
    const response = await fetch(`/api/planner?type=${type}&id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) notify(t("删除失败"));
    else await load();
  }

  // 在超市里边走边勾，所以勾选必须是瞬时的；入库放到回家以后统一确认。
  async function toggle(item: ShoppingItem) {
    const checked = !item.checked;
    setData((current) => ({
      ...current,
      shopping: current.shopping.map((entry) => (entry.id === item.id ? { ...entry, checked } : entry)),
    }));
    const response = await fetch("/api/planner", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "shopping", id: item.id, checked }),
    });
    if (!response.ok) {
      notify(t("采购状态更新失败"));
      await load();
    }
  }

  function openRestock() {
    if (!pendingRestock.length) return;
    setRestockRows(
      pendingRestock.map((item) => {
        const match = findInventoryMatch(item.name, item.category, inventory);
        return {
          id: item.id,
          name: item.name,
          quantity: Number(item.quantity) || 1,
          unit: item.unit || t("件"),
          category: item.category || t("其他"),
          mergeItemId: match?.item.id ?? "",
          skip: false,
        };
      }),
    );
  }

  function updateRestockRow(id: string, changes: Partial<RestockRow>) {
    setRestockRows(
      (current) => current?.map((row) => (row.id === id ? { ...row, ...changes } : row)) ?? null,
    );
  }

  async function saveRestock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restockRows) return;
    const form = new FormData(event.currentTarget);
    const items = restockRows.map((row) => ({
      ...row,
      mode: row.skip ? "skip" : row.mergeItemId ? "merge" : "new",
    }));
    const result = await post({ type: "restockBatch", purchaseDate: form.get("purchaseDate"), items });
    if (result?.ok) {
      setRestockRows(null);
      notify(
        t("已入库：新增 {added} 项，合并 {merged} 项", {
          added: result.added ?? 0,
          merged: result.merged ?? 0,
        }) + (result.skipped ? t("，跳过 {skipped} 项", { skipped: result.skipped }) : ""),
      );
      onInventoryChange();
    }
  }

  const storeNames = useMemo(
    () => new Map(data.stores.map((store) => [store.id, store.name])),
    [data.stores],
  );
  const budget = Number(data.settings.foodBudget) + Number(data.settings.householdBudget);
  const savings = data.deals.reduce(
    (sum, deal) => sum + Math.max(0, Number(deal.regularPrice ?? 0) - Number(deal.price)),
    0,
  );
  const unchecked = data.shopping.filter((item) => !item.checked);
  // 已经买了但还没写进库存的，就是等着一次性入库的那批。
  const pendingRestock = data.shopping.filter((item) => item.checked && !item.stocked);
  const overlap = useMemo(() => {
    const candidates: { from: string; to: string; stores: string[] }[] = [];
    for (let i = 0; i < data.deals.length; i++)
      for (let j = i + 1; j < data.deals.length; j++) {
        const a = data.deals[i],
          b = data.deals[j];
        if (a.storeId === b.storeId) continue;
        const from = a.validFrom > b.validFrom ? a.validFrom : b.validFrom;
        const to = a.validTo < b.validTo ? a.validTo : b.validTo;
        if (from <= to)
          candidates.push({
            from,
            to,
            stores: [storeNames.get(a.storeId) ?? t("门店"), storeNames.get(b.storeId) ?? t("门店")],
          });
      }
    return candidates.sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
  }, [data.deals, storeNames]);

  const flyerRecommendations = useMemo(() => {
    const ranked = recommendFlyerDeals(inventory, data.deals, data.matchRules);
    const dealsById = new Map(data.deals.map((deal) => [deal.id, deal]));
    return ranked.flatMap((recommendation) => {
      const deal = dealsById.get(recommendation.dealId);
      return deal ? [{ ...recommendation, deal }] : [];
    });
  }, [inventory, data.deals, data.matchRules]);
  const purchasePlan = useMemo(
    () => buildFlyerPurchasePlan(flyerRecommendations, data.deals, data.settings),
    [flyerRecommendations, data.deals, data.settings],
  );
  const selectedDeal = selectedDealId
    ? (data.deals.find((deal) => deal.id === selectedDealId) ?? null)
    : null;

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    post(
      {
        type: "settings",
        city: form.get("city"),
        postalCode: form.get("postalCode"),
        foodBudget: form.get("foodBudget"),
        householdBudget: form.get("householdBudget"),
        maxStores: form.get("maxStores"),
        timezone: form.get("timezone"),
      },
      "家庭设置已保存",
    );
  }
  function saveStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    post({ type: "store", name: form.get("name"), address: form.get("address") }, "收藏门店已添加");
  }

  function saveDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      post(
        {
          type: "deal",
          storeId: form.get("storeId"),
          itemName: form.get("itemName"),
          category: form.get("category"),
          price: form.get("price"),
          regularPrice: form.get("regularPrice"),
          unit: form.get("unit"),
          packageQuantity: form.get("packageQuantity"),
          packageUnit: form.get("packageUnit"),
          validFrom: readDate(form, "dealFrom", t("开始日期"), t),
          validTo: readDate(form, "dealTo", t("结束日期"), t),
        },
        "Flyer 优惠已添加",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : t("日期无效"));
    }
  }
  function saveShopping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    post(
      {
        type: "shopping",
        name: form.get("name"),
        quantity: form.get("quantity"),
        unit: form.get("unit"),
        category: form.get("category"),
      },
      "已加入采购清单",
    );
  }
  function saveMatchRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    post(
      {
        type: "matchRule",
        inventoryName: form.get("inventoryName"),
        dealPattern: form.get("dealPattern"),
        category: selectedDeal?.category,
        matchKind: form.get("matchKind"),
        active: true,
      },
      "匹配规则已保存，后续推荐会自动记住",
    );
  }
  async function dealPreference(deal: Deal, action: "save" | "unsave" | "ignore" | "restore" | "suppress") {
    await post(
      { type: "dealPreference", dealId: deal.id, action },
      action === "save"
        ? t("优惠已收藏")
        : action === "suppress"
          ? t("以后不再推荐此类商品")
          : action === "ignore"
            ? t("本次推荐已忽略")
            : t("优惠设置已更新"),
    );
  }
  async function generateRecipeFromDeal(deal: Deal) {
    setBusy(true);
    try {
      const response = await fetch("/api/recipes", {
        method: "POST",
        headers: withAiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ focusDealId: deal.id }),
      });
      const result = await readJson<{ recipes?: unknown[] }>(response);
      if (!response.ok) throw new Error(result.error || t("菜谱生成失败"));
      const imported = await fetch("/api/recipe-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "importRecipes", recipes: result.recipes ?? [] }),
      });
      const workspace = await readJson<Record<string, never>>(imported);
      if (!imported.ok) throw new Error(workspace.error || t("菜谱导入失败"));
      window.dispatchEvent(new Event("recipe-workspace-refresh"));
      notify(
        t("已根据{name}生成 {count} 道菜谱", { name: tv(deal.itemName), count: result.recipes?.length ?? 0 }),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : t("菜谱生成失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel budget-panel" id="budget">
        <div className="section-head">
          <div>
            <p className="eyebrow">{t("家庭设置")}</p>
            <h2>{t("地区与预算")}</h2>
          </div>
          <button className="text-button" onClick={() => setModal("settings")}>
            {t("编辑")}
          </button>
        </div>
        <div className="budget-amount">
          <strong>{budget ? money(budget) : t("待设置")}</strong>
          <span>{t("每周总预算")}</span>
        </div>
        {(() => {
          const spending = data.spending;
          const foodBudget = Number(data.settings.foodBudget) || 0;
          const householdBudget = Number(data.settings.householdBudget) || 0;
          if (!spending || (!foodBudget && !householdBudget)) return null;
          const spent = spending.food + spending.household;
          const over =
            (foodBudget && spending.food > foodBudget) ||
            (householdBudget && spending.household > householdBudget);
          return (
            <div className={over ? "budget-actual over" : "budget-actual"}>
              <span>{t("最近 7 天实际花费")}</span>
              <strong>{money(spent)}</strong>
              <small>
                {t("食品 {food} / {foodBudget} · 日用 {household} / {householdBudget}", {
                  food: money(spending.food),
                  foodBudget: money(foodBudget),
                  household: money(spending.household),
                  householdBudget: money(householdBudget),
                })}
              </small>
            </div>
          );
        })()}
        <div className="budget-split">
          <span>
            {t("食品")} <b>{money(Number(data.settings.foodBudget))}</b>
          </span>
          <span>
            {t("日用品")} <b>{money(Number(data.settings.householdBudget))}</b>
          </span>
        </div>
        <div className="location-line">
          <Icon name="place" />
          <p>
            <strong>{data.settings.city || t("城市待填写")}</strong>
            <small>{data.settings.postalCode || t("填写邮编后可接入本地 Flyer")}</small>
          </p>
        </div>
        <div className="store-head">
          <strong>{t("收藏门店")}</strong>
          <button onClick={() => setModal("store")}>{t("＋ 添加")}</button>
        </div>
        {data.stores.length ? (
          <div className="store-chips">
            {data.stores.map((store) => (
              <span key={store.id}>
                {store.name}
                <button
                  onClick={() => remove("store", store.id)}
                  aria-label={t("删除{name}", { name: store.name })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="micro-empty">{t("添加你常去的超市，系统只关注这些门店。")}</p>
        )}
      </section>

      <section className="panel flyer-panel" id="flyers">
        <div className="section-head">
          <div>
            <p className="eyebrow">{t("采购时机")}</p>
            <h2>{t("Flyer 优惠")}</h2>
          </div>
          <div className="flyer-head-actions">
            <button
              className="sync-now"
              disabled={syncing || busy || !data.stores.some((store) => store.sourceKey)}
              onClick={() => syncFlyers()}
            >
              {syncing ? t("同步中…") : t("↻ 立即同步")}
            </button>
            <button
              className="mini-primary"
              onClick={() => (data.stores.length ? setModal("deal") : setModal("store"))}
            >
              {t("＋ 手动录入")}
            </button>
          </div>
        </div>
        <div className={`flyer-automation ${data.syncSettings.lastStatus}`}>
          <div>
            <span className="automation-dot" />
            <p>
              <strong>
                {t("自动录入")} {data.syncSettings.enabled ? t("已开启") : t("已暂停")}
              </strong>
              <small>
                {syncMessage(data.syncSettings, t)} · 上次{" "}
                {syncTime(data.syncSettings.lastCompletedAt, locale, timeZone, t)}
              </small>
            </p>
          </div>
          <label className="sync-frequency">
            <span>{t("刷新")}</span>
            <select
              value={data.syncSettings.intervalHours}
              disabled={busy || syncing || !data.syncSettings.enabled}
              onChange={(event) =>
                post(
                  {
                    type: "flyerSyncSettings",
                    enabled: Boolean(data.syncSettings.enabled),
                    intervalHours: Number(event.target.value),
                  },
                  "自动同步频率已更新",
                )
              }
            >
              <option value={12}>{t("每 12 小时")}</option>
              <option value={24}>{t("每天")}</option>
              <option value={72}>{t("每 3 天")}</option>
              <option value={168}>{t("每周")}</option>
            </select>
          </label>
          <button
            className={data.syncSettings.enabled ? "automation-toggle on" : "automation-toggle"}
            role="switch"
            aria-checked={Boolean(data.syncSettings.enabled)}
            disabled={busy || syncing}
            onClick={() =>
              post(
                {
                  type: "flyerSyncSettings",
                  enabled: !data.syncSettings.enabled,
                  intervalHours: data.syncSettings.intervalHours,
                },
                data.syncSettings.enabled ? t("自动录入已暂停") : t("自动录入已开启"),
              )
            }
          >
            <i />
          </button>
        </div>
        {/*
          原来这里是写死的三家 Lougheed 门店，不管用户住在哪都显示同样的三家。
          现在按邮编搜：结果进全局目录并按片区索引，同一片区的下一个人直接命中，
          不用再花一次模型调用。
        */}
        <form className="store-finder" onSubmit={findNearby}>
          <label className="field">
            <span>{t("邮编")}</span>
            <input
              type="text"
              value={areaCode}
              maxLength={20}
              placeholder={data.settings.postalCode || "V3J 1N4"}
              autoComplete="postal-code"
              spellCheck={false}
              onChange={(event) => setAreaCode(event.target.value)}
            />
          </label>
          <button className="mini-primary" disabled={finding || busy}>
            {finding ? t("搜索中…") : t("找附近的超市")}
          </button>
        </form>

        {nearby.length > 0 && (
          <div className="flyer-sources" aria-label={t("附近的 Flyer 来源")}>
            {nearby.map((source) => {
              const saved = data.stores.some((store) => store.sourceKey === source.sourceKey);
              const checked = picked.includes(source.sourceKey);
              return (
                <article key={source.sourceKey}>
                  <label className="source-pick">
                    <input
                      type="checkbox"
                      aria-label={t("收藏 {name}", { name: source.name })}
                      checked={checked}
                      disabled={saved || busy}
                      onChange={(event) =>
                        setPicked((current) =>
                          event.target.checked
                            ? [...current, source.sourceKey]
                            : current.filter((key) => key !== source.sourceKey),
                        )
                      }
                    />
                    <span>
                      <strong>{source.name}</strong>
                      <small>
                        {source.address}
                        {source.chain ? ` · ${source.chain}` : ""}
                      </small>
                    </span>
                  </label>
                  <div className="source-actions">
                    <a href={source.flyerUrl} target="_blank" rel="noreferrer">
                      {t("查看官方 Flyer")}
                    </a>
                    {saved && <span className="source-saved">{t("已收藏")}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {picked.length > 0 && (
          <div className="modal-actions">
            <button className="primary-button" disabled={busy || syncing} onClick={savePickedAndSync}>
              {busy || syncing
                ? t("处理中…")
                : t("收藏这 {count} 家并立即读取 Flyer", { count: picked.length })}
            </button>
          </div>
        )}

        {nearby.length === 0 && (
          <p className="settings-note">
            {t("填邮编找一次，附近会发 Flyer 的超市就会列在这里，勾上常去的几家。")}
          </p>
        )}
        {overlap ? (
          <div className="overlap-card">
            <span>{t("最佳重叠窗口")}</span>
            <strong>
              {shortDate(overlap.from, locale)} – {shortDate(overlap.to, locale)}
            </strong>
            <small>{overlap.stores.join(" × ")}</small>
          </div>
        ) : (
          <div className="flyer-empty-art small">
            <div className="calendar-sheet">
              <span>{new Date().getDate()}</span>
              <small>NOW</small>
            </div>
            <div className="overlap-lines">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {flyerRecommendations.length > 0 && (
          <section className="flyer-purchase-plan">
            <div>
              <span>{t("本周采购方案")}</span>
              <strong>
                {purchasePlan.storeIds
                  .map((id) => storeNames.get(id))
                  .filter(Boolean)
                  .join(" ＋ ") || t("收藏门店")}
              </strong>
              <small>
                {purchasePlan.overlapFrom && purchasePlan.overlapTo
                  ? t("建议在 {from}—{to} 完成", {
                      from: shortDate(purchasePlan.overlapFrom, locale),
                      to: shortDate(purchasePlan.overlapTo, locale),
                    })
                  : t("各门店优惠期没有完整重叠，请优先购买必须补货项目")}
              </small>
            </div>
            <div>
              <b>{money(purchasePlan.total)}</b>
              <small>预计节省 {money(purchasePlan.estimatedSavings)}</small>
              <em className={purchasePlan.withinBudget ? "ok" : "over"}>
                {purchasePlan.withinBudget ? t("预算内") : t("包含必须补货，可能超预算")}
              </em>
            </div>
          </section>
        )}
        <div className="stock-recommendations">
          <div className="recommendation-heading">
            <div>
              <strong>{t("智能补货建议")}</strong>
              <small>{t("综合库存紧急度、替代关系、单位价格、历史价格、预算和门店数量")}</small>
            </div>
            <span>{t("{count} 项", { count: flyerRecommendations.length })}</span>
          </div>
          {flyerRecommendations.length ? (
            <div className="recommendation-list">
              {flyerRecommendations.map((recommendation) => {
                const { deal } = recommendation;
                const alreadyAdded = data.shopping.some(
                  (item) => !item.checked && item.name.toLowerCase() === deal.itemName.toLowerCase(),
                );
                const matchedName = tv(recommendation.matchedItemName ?? "");
                const matchedLevel = tv(recommendation.matchedLevel ?? "");
                /**
                 * 「还能撑几天」比「已使用几天」更能决定要不要现在买，
                 * 所以有推算结果时优先说它；推不出来（没记购买日、或者还没动过）
                 * 才退回讲事实：已经放了多少天，让人自己判断。
                 */
                /**
                 * 天数是估算，显示成 0.5 或 1.3 会让人以为算得很准。
                 * 不到一天就直说不到一天，其余取整。
                 */
                const paceText = (days: number) =>
                  days < 1 ? t("不到 1 天就会用完") : t("约还能撑 {days} 天", { days: Math.round(days) });
                const paceNote =
                  recommendation.daysLeft === undefined
                    ? recommendation.daysUsed === undefined
                      ? ""
                      : t("，已使用 {days} 天", { days: recommendation.daysUsed })
                    : t("，按目前用量{pace}", { pace: paceText(recommendation.daysLeft) });
                const expiryNote =
                  recommendation.expiresInDays === undefined || recommendation.expiresInDays > 5
                    ? ""
                    : recommendation.expiresInDays < 0
                      ? t("，且已过期")
                      : t("，且 {days} 天后到期", { days: recommendation.expiresInDays });
                const targetedReason = t("{name}目前{level}{pace}{expiry}。", {
                  name: matchedName,
                  level: matchedLevel,
                  pace: paceNote,
                  expiry: expiryNote,
                });
                const reason =
                  recommendation.kind === "targeted"
                    ? targetedReason
                    : recommendation.kind === "substitute"
                      ? t("{deal}可替代目前{level}的{name}，匹配关系可手动修改。", {
                          deal: tv(deal.itemName),
                          level: tv(recommendation.matchedLevel ?? ""),
                          name: tv(recommendation.matchedItemName ?? ""),
                        })
                      : recommendation.lowCategoryCount
                        ? // 「这个大类有 4 项在减少」等于没说——4 项里最急的那项还能撑多久，
                          // 才是决定这一趟要不要买的信息。天数已经算出来了，这里必须接上。
                          recommendation.daysLeft === undefined
                          ? t("{category}中有 {count} 项库存开始减少，适合补充这个大类。", {
                              category: tv(deal.category),
                              count: recommendation.lowCategoryCount,
                            })
                          : // 说的是「最快要断的」不是「最急的」——最急的往往已经空了，
                            // 而算得出天数的恰恰是那些还剩一点、马上要没的。
                            t("{category}中有 {count} 项库存开始减少，最快要断的一项{pace}。", {
                              category: tv(deal.category),
                              count: recommendation.lowCategoryCount,
                              pace: paceText(recommendation.daysLeft),
                            })
                        : t("当前库存尚可，但这项优惠达到值得关注的价格。");
                const priceNote =
                  recommendation.priceSignal === "historical-low"
                    ? t("当前为已记录最低价")
                    : recommendation.priceSignal === "below-average"
                      ? t("低于近期平均价")
                      : Number(deal.priceObservations) > 1
                        ? t("历史均价 {price}", { price: money(Number(deal.averagePrice)) })
                        : t("价格历史正在积累");
                return (
                  <article
                    key={deal.id}
                    className={`recommendation-card ${recommendation.kind} ${recommendation.tier}`}
                  >
                    <div className="recommendation-top">
                      <span>
                        {tv(tierLabels[recommendation.tier])} · {tv(matchLabels[recommendation.kind])}
                      </span>
                      {recommendation.savingsPercent > 0 && (
                        <b>{t("省 {percent}%", { percent: recommendation.savingsPercent })}</b>
                      )}
                    </div>
                    <strong>{tv(deal.itemName)}</strong>
                    <small>{reason}</small>
                    <div className="recommendation-price">
                      <b>
                        {money(Number(deal.price))}/{tu(deal.unit)}
                      </b>
                      <span>
                        {t("约 {price}/{unit}", {
                          price: money(recommendation.unitPrice),
                          unit: tu(recommendation.unitLabel),
                        })}
                      </span>
                      <em>{priceNote}</em>
                    </div>
                    <div className="recommendation-evidence">
                      <span>{storeNames.get(deal.storeId) ?? t("收藏门店")}</span>
                      {recommendation.alsoAtStoreCount > 0 && (
                        <span className="also-at">
                          {t("另有 {count} 家也在特价", { count: recommendation.alsoAtStoreCount })}
                        </span>
                      )}
                      <span>{tv(confidenceLabels[deal.confidence ?? "low"] ?? t("需要确认"))}</span>
                      <span>
                        {deal.verifiedAt
                          ? t("{time}核验", { time: syncTime(deal.verifiedAt, locale, timeZone) })
                          : t("待核验")}
                      </span>
                      {deal.sourceUrl && (
                        <a href={deal.sourceUrl} target="_blank" rel="noreferrer">
                          {t("来源")}
                        </a>
                      )}
                    </div>
                    <div className="recommendation-actions">
                      <button
                        className="primary"
                        disabled={alreadyAdded || busy}
                        onClick={() =>
                          post(
                            {
                              type: "shopping",
                              name: deal.itemName,
                              quantity: recommendation.suggestedQuantity,
                              unit: deal.unit,
                              category: deal.category,
                            },
                            t("{name} 已加入采购清单", { name: tv(deal.itemName) }),
                          )
                        }
                      >
                        {alreadyAdded
                          ? t("已在清单")
                          : t("加入 {qty} {unit}", {
                              qty: recommendation.suggestedQuantity,
                              unit: tu(deal.unit, recommendation.suggestedQuantity),
                            })}
                      </button>
                      <button
                        onClick={() => {
                          setSelectedDealId(deal.id);
                          setModal("match");
                        }}
                      >
                        {t("修改匹配")}
                      </button>
                      <button onClick={() => void dealPreference(deal, deal.isSaved ? "unsave" : "save")}>
                        {deal.isSaved ? t("取消收藏") : t("收藏优惠")}
                      </button>
                      {foodCategorySet.has(deal.category) && (
                        <button onClick={() => void generateRecipeFromDeal(deal)}>{t("用它做菜")}</button>
                      )}
                      <button onClick={() => void dealPreference(deal, "ignore")}>{t("本次忽略")}</button>
                      <button className="danger" onClick={() => void dealPreference(deal, "suppress")}>
                        {t("以后不推荐")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="recommendation-empty">
              {data.deals.length
                ? t("当前没有达到补货或历史低价条件的优惠；被忽略的商品也不会显示。")
                : t("录入当前 Flyer 优惠后，系统会自动匹配库存、历史价格和预算。")}
            </p>
          )}
        </div>
        {data.deals.length ? (
          <div className="deal-list">
            {data.deals.slice(0, 12).map((deal) => (
              <div className={deal.hidden ? "deal-row hidden" : "deal-row"} key={deal.id}>
                <div>
                  <strong>
                    {tv(deal.itemName)}
                    {deal.source === "auto" && <em>{t("自动")}</em>}
                    {Boolean(deal.isSaved) && <em>{t("已收藏")}</em>}
                  </strong>
                  <small>
                    {storeNames.get(deal.storeId)} · {shortDate(deal.validFrom, locale)}–
                    {shortDate(deal.validTo, locale)} ·{" "}
                    {tv(confidenceLabels[deal.confidence ?? "low"] ?? "需要确认")}
                    {deal.sourceUrl && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={deal.sourceUrl} target="_blank" rel="noreferrer">
                          {t("来源")}
                        </a>
                      </>
                    )}
                  </small>
                </div>
                <span>
                  {money(Number(deal.price))}/{tu(deal.unit)}
                </span>
                {deal.hidden ? (
                  <button onClick={() => void dealPreference(deal, "restore")}>{t("恢复")}</button>
                ) : (
                  <button
                    onClick={() => remove("deal", deal.id)}
                    aria-label={t("删除{name}优惠", { name: tv(deal.itemName) })}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-note">
            {t("收藏门店后，后台会每 6 小时检查是否到达设定的同步时间；也可点击“立即同步”。")}
          </p>
        )}
        {savings > 0 && (
          <div className="savings-line">
            {t("当前录入优惠预计可省")} <strong>{money(savings)}</strong>
          </div>
        )}
      </section>

      <section className="panel shopping-panel" id="shopping">
        <div className="section-head">
          <div>
            <p className="eyebrow">{t("自动补货")}</p>
            <h2>{t("采购清单")}</h2>
          </div>
          <button className="text-button" onClick={() => setModal("shopping")}>
            {t("手动添加")}
          </button>
        </div>
        <button
          className="generate-button"
          onClick={async () => {
            const result = await post({ type: "generateShopping" }, "低库存物品已加入采购清单");
            if (result?.added === 0) notify(t("没有新的低库存物品需要加入"));
          }}
        >
          {t("↻ 从低库存生成清单")}
        </button>
        {data.shopping.length ? (
          <div className="shopping-list">
            {data.shopping.map((item) => (
              <label className={item.checked ? "shopping-row checked" : "shopping-row"} key={item.id}>
                <input type="checkbox" checked={Boolean(item.checked)} onChange={() => toggle(item)} />
                <span>
                  <strong>
                    {tv(item.name)}
                    {item.stocked ? <em className="stocked-tag">{t("已入库")}</em> : null}
                  </strong>
                  <small>
                    {item.quantity} {tu(item.unit, item.quantity)} ·{" "}
                    {item.source === "low-stock"
                      ? t("低库存自动加入")
                      : item.source === "menu-plan"
                        ? t("本周菜单自动加入")
                        : t("手动加入")}
                  </small>
                </span>
                <button
                  type="button"
                  onClick={() => remove("shopping", item.id)}
                  aria-label={t("删除{name}", { name: tv(item.name) })}
                >
                  ×
                </button>
              </label>
            ))}
          </div>
        ) : (
          <p className="panel-note">{t("目前没有待买物品。可以从低库存自动生成，也可以手动添加。")}</p>
        )}
        {pendingRestock.length > 0 && (
          <button className="restock-button" onClick={openRestock} disabled={busy}>
            📦 把已买的 {pendingRestock.length} 项加入库存
          </button>
        )}
        {data.shopping.length > 0 && (
          <div className="shopping-progress">
            <span
              style={{
                width: `${(data.shopping.filter((item) => item.checked).length / data.shopping.length) * 100}%`,
              }}
            />
          </div>
        )}
        <small className="shopping-summary">
          {t("待购买 {count} 件 · 勾选后可直接入库 · 最多安排 {stores} 家门店", {
            count: unchecked.length,
            stores: data.settings.maxStores || 2,
          })}
        </small>
      </section>

      <RecipeWorkspace
        inventory={inventory}
        notify={notify}
        onPlannerChange={load}
        onInventoryChange={onInventoryChange}
      />

      {modal && (
        <Modal
          className="planner-modal"
          eyebrow={t("家庭采购计划")}
          onClose={() => setModal(null)}
          title={
            modal === "settings"
              ? t("地区与预算")
              : modal === "store"
                ? t("添加收藏门店")
                : modal === "deal"
                  ? t("录入 Flyer 优惠")
                  : modal === "match"
                    ? t("修改并记住匹配")
                    : t("添加采购物品")
          }
        >
          {modal === "settings" && (
            <form onSubmit={saveSettings}>
              <div className="field-grid">
                <label className="field">
                  <span>{t("城市")}</span>
                  <input name="city" defaultValue={data.settings.city} placeholder={t("例如：Vancouver")} />
                </label>
                <label className="field">
                  <span>{t("邮编")}</span>
                  <input
                    name="postalCode"
                    defaultValue={data.settings.postalCode}
                    placeholder={t("例如：V6B 1A1")}
                  />
                </label>
                <label className="field">
                  <span>{t("每周食品预算")}</span>
                  <input
                    name="foodBudget"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={data.settings.foodBudget}
                  />
                </label>
                <label className="field">
                  <span>{t("每周日用品预算")}</span>
                  <input
                    name="householdBudget"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={data.settings.householdBudget}
                  />
                </label>
                <label className="field full">
                  <span>{t("一次最多去几家超市")}</span>
                  <select name="maxStores" defaultValue={data.settings.maxStores}>
                    {[1, 2, 3, 4, 5].map((number) => (
                      <option key={number} value={number}>
                        {t("{count} 家", { count: number })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field full">
                  <span>{t("时区")}</span>
                  <select name="timezone" defaultValue={timeZone}>
                    {timeZoneChoices(timeZone).map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                  <small>{t("保质期倒计时和消费统计按这个时区计算")}</small>
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                  {t("取消")}
                </button>
                <button className="primary-button" disabled={busy}>
                  {t("保存设置")}
                </button>
              </div>
            </form>
          )}
          {modal === "store" && (
            <form onSubmit={saveStore}>
              <label className="field full">
                <span>{t("超市名称")}</span>
                <input name="name" required placeholder={t("例如：Costco Richmond")} />
              </label>
              <label className="field full">
                <span>{t("地址或备注（可选）")}</span>
                <input name="address" placeholder={t("门店地址、商圈或回家路线")} />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                  {t("取消")}
                </button>
                <button className="primary-button" disabled={busy}>
                  {t("添加门店")}
                </button>
              </div>
            </form>
          )}
          {modal === "deal" && (
            <form onSubmit={saveDeal}>
              <div className="field-grid">
                <label className="field">
                  <span>{t("门店")}</span>
                  <select name="storeId" required>
                    {data.stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("商品")}</span>
                  <input name="itemName" required placeholder={t("例如：鸡腿 2kg")} />
                </label>
                <label className="field">
                  <span>{t("种类")}</span>
                  <select name="category">
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {tv(category)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("Flyer 计价单位")}</span>
                  <input name="unit" defaultValue="件" />
                </label>
                <label className="field">
                  <span>{t("优惠价")}</span>
                  <input name="price" type="number" min="0.01" step="0.01" required />
                </label>
                <label className="field">
                  <span>{t("原价（可选）")}</span>
                  <input name="regularPrice" type="number" min="0" step="0.01" />
                </label>
                <label className="field">
                  <span>{t("包装数量（用于单位价格）")}</span>
                  <input
                    name="packageQuantity"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder={t("例如：24")}
                  />
                </label>
                <label className="field">
                  <span>{t("包装比较单位")}</span>
                  <input name="packageUnit" placeholder={t("例如：个、kg、L")} />
                </label>
                <CompactDate prefix="dealFrom" label={t("开始日期（年 / 月 / 日）")} />
                <CompactDate prefix="dealTo" label={t("结束日期（年 / 月 / 日）")} />
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                  {t("取消")}
                </button>
                <button className="primary-button" disabled={busy}>
                  {t("保存优惠")}
                </button>
              </div>
            </form>
          )}
          {modal === "match" && selectedDeal && (
            <form onSubmit={saveMatchRule}>
              <p className="match-editor-note">
                {t("将")} <strong>{tv(selectedDeal.itemName)}</strong>{" "}
                {t("与家里的某项库存建立关系。保存后，相似优惠会继续使用这条规则。")}
              </p>
              <div className="field-grid">
                <label className="field full">
                  <span>{t("对应库存物品")}</span>
                  <select name="inventoryName" required defaultValue="">
                    <option value="">{t("请选择")}</option>
                    {inventory.map((item) => (
                      <option key={`${item.category}-${item.name}`} value={item.name}>
                        {tv(item.name)} · {tv(item.level)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("优惠名称匹配词")}</span>
                  <input name="dealPattern" required defaultValue={selectedDeal.itemName} />
                </label>
                <label className="field">
                  <span>{t("匹配关系")}</span>
                  <select name="matchKind" defaultValue="substitute">
                    <option value="targeted">{t("精准匹配：就是同一种")}</option>
                    <option value="substitute">{t("替代补货：可以替代")}</option>
                    <option value="category">{t("大类机会：只关联类别")}</option>
                  </select>
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                  {t("取消")}
                </button>
                <button className="primary-button" disabled={busy}>
                  {t("保存并记住")}
                </button>
              </div>
            </form>
          )}
          {modal === "shopping" && (
            <form onSubmit={saveShopping}>
              <div className="field-grid">
                <label className="field full">
                  <span>{t("采购物品")}</span>
                  <input name="name" required />
                </label>
                <label className="field">
                  <span>{t("数量")}</span>
                  <input name="quantity" type="number" min="0.1" step="0.1" defaultValue="1" />
                </label>
                <label className="field">
                  <span>{t("单位")}</span>
                  <input name="unit" defaultValue="件" />
                </label>
                <label className="field full">
                  <span>{t("种类")}</span>
                  <select name="category">
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {tv(category)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                  {t("取消")}
                </button>
                <button className="primary-button" disabled={busy}>
                  {t("加入清单")}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {restockRows && (
        <Modal
          className="restock-modal"
          eyebrow={t("买回来了")}
          title={t("确认入库")}
          onClose={() => setRestockRows(null)}
        >
          <form onSubmit={saveRestock}>
            <label className="field full restock-date">
              <span>{t("购买日期")}</span>
              <input name="purchaseDate" type="date" defaultValue={todayString(timeZone)} />
            </label>
            <div className="restock-list">
              {restockRows.map((row) => {
                const ranked = rankInventoryMatches(row.name, row.category, inventory);
                const rankedIds = new Set(ranked.map((entry) => entry.item.id));
                const rest = inventory.filter((item) => !rankedIds.has(item.id));
                return (
                  <article className={row.skip ? "restock-row skipped" : "restock-row"} key={row.id}>
                    <div className="restock-row-main">
                      <input
                        value={row.name}
                        onChange={(event) => updateRestockRow(row.id, { name: event.target.value })}
                        aria-label={t("物品名称")}
                        required={!row.skip}
                      />
                      <div className="restock-amount">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={row.quantity}
                          onChange={(event) =>
                            updateRestockRow(row.id, { quantity: Number(event.target.value) })
                          }
                          aria-label={t("{name}数量", { name: row.name })}
                          required={!row.skip}
                        />
                        <input
                          value={row.unit}
                          onChange={(event) => updateRestockRow(row.id, { unit: event.target.value })}
                          aria-label={t("{name}单位", { name: row.name })}
                          required={!row.skip}
                        />
                        <select
                          value={row.category}
                          onChange={(event) => updateRestockRow(row.id, { category: event.target.value })}
                          aria-label={t("{name}种类", { name: row.name })}
                        >
                          {categories.map((category) => (
                            <option key={category} value={category}>
                              {tv(category)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="restock-row-side">
                      <select
                        value={row.mergeItemId}
                        onChange={(event) => updateRestockRow(row.id, { mergeItemId: event.target.value })}
                        aria-label={t("{name}入库方式", { name: row.name })}
                      >
                        <option value="">{t("新建库存条目")}</option>
                        {ranked.length > 0 && (
                          <optgroup label={t("可能是同一样东西")}>
                            {ranked.map((entry) => (
                              <option key={entry.item.id} value={entry.item.id}>
                                {t("并入 {name}（{level}）", {
                                  name: tv(entry.item.name),
                                  level: tv(entry.item.level),
                                })}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {rest.length > 0 && (
                          <optgroup label={t("其他库存")}>
                            {rest.map((item) => (
                              <option key={item.id} value={item.id}>
                                {t("并入 {name}（{level}）", { name: tv(item.name), level: tv(item.level) })}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <label className="restock-skip">
                        <input
                          type="checkbox"
                          checked={row.skip}
                          onChange={(event) => updateRestockRow(row.id, { skip: event.target.checked })}
                        />
                        {t("这项不入库")}
                      </label>
                    </div>
                  </article>
                );
              })}
            </div>
            <p className="restock-hint">
              {t(
                "并入现有库存时，数量会累加、余量恢复到 100%，过期的旧日期会被清掉。跳过的物品保持「已买」，之后还能再入库。",
              )}
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setRestockRows(null)}>
                {t("稍后再说")}
              </button>
              <button className="primary-button" disabled={busy}>
                {t("确认入库")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
