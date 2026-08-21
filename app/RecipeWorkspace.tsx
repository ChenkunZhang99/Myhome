"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { dayIn, detectTimeZone } from "./dateTime";
import {
  applyConsumption,
  coarsePortions,
  describeChange,
  findInventoryMatch,
  planConsumption,
  portionLabels,
  type StockPortion,
} from "./inventoryUsage";
import { withAiHeaders } from "./aiSettings";
import { useAppSettings } from "./AppSettings";
import { readJson } from "./apiClient";
import { Modal } from "./Modal";
import type { Locale } from "./i18n";

type Ingredient = { name: string; amount: string; source: "inventory" | "flyer" | "pantry" };
type RecipePhoto = {
  id: string;
  recipeId: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
};
type Recipe = {
  id: string;
  title: string;
  summary: string;
  reason: string;
  origin: string;
  icon: string;
  cookTime: string;
  difficulty: string;
  servings: number;
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
  mealTypes: string[];
  isFavorite: boolean;
  isCustom: boolean;
  cookedCount: number;
  lastCookedAt?: string | null;
  averageRating?: number | null;
  ratingCount: number;
  photos: RecipePhoto[];
};
type Member = { id: string; name: string; avatar: string };
type MealRequest = {
  id: string;
  recipeId: string;
  memberId: string;
  desiredFrom?: string | null;
  desiredTo?: string | null;
  mealType: string;
  priority: string;
  servings: number;
  notes: string;
  status: string;
  scheduledDate?: string | null;
};
type ConsumptionEntry = { inventoryId: string; name: string };
type CookHistory = {
  id: string;
  recipeId: string;
  requestId?: string | null;
  cookedDate: string;
  mealType: string;
  servings: number;
  cookMemberId: string;
  notes: string;
  consumption?: ConsumptionEntry[];
};
type Rating = { recipeId: string; memberId: string; rating: number };
type RecipePreferences = { allergies: string; avoidFoods: string; dislikes: string; notes: string };
type WorkspaceData = {
  recipes: Recipe[];
  members: Member[];
  requests: MealRequest[];
  history: CookHistory[];
  ratings: Rating[];
  activity: unknown[];
  preferences: RecipePreferences;
  /** 家庭时区，服务端算「今天」用的是它，前端默认值要保持一致。 */
  timeZone: string;
};
type InventoryLite = {
  id: string;
  name: string;
  category: string;
  level: string;
  quantity?: number;
  unit?: string;
  remainingPercent?: number;
};
type ConsumptionRow = {
  ingredient: Ingredient;
  stock: InventoryLite;
  defaultPortion: StockPortion;
  quantityUsed: number | null;
};

const emptyData: WorkspaceData = {
  timeZone: detectTimeZone(),
  recipes: [],
  members: [],
  requests: [],
  history: [],
  ratings: [],
  activity: [],
  preferences: { allergies: "", avoidFoods: "", dislikes: "", notes: "" },
};
const mealOptions = ["", "早餐", "午餐", "晚餐"];

function dateString(timeZone: string, date = new Date()) {
  return dayIn(timeZone, date);
}
function addDays(timeZone: string, value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateString(timeZone, date);
}
function shortDate(value: string | null | undefined, locale: Locale, t: (text: string) => string) {
  if (!value) return t("待安排");
  const [, month, day] = value.split("-");
  if (locale === "zh") return `${Number(month)}月${Number(day)}日`;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(parsed);
}
// 这两个函数是一对：ingredientText 把食材渲染进文本框，parseIngredients 再解析回来。
// 因为标签会跟着语言变，解析端必须同时认识中英文两套写法。
const FLYER_SOURCE = /优惠|购买|flyer|on sale|sale/i;
const INVENTORY_SOURCE = /已有|库存|inventory|at home|home/i;

function parseIngredients(value: string): Ingredient[] {
  return value
    .split("\n")
    .map((line) => {
      const [name = "", amount = "", rawSource = ""] = line.split("|").map((part) => part.trim());
      const source = FLYER_SOURCE.test(rawSource)
        ? "flyer"
        : INVENTORY_SOURCE.test(rawSource)
          ? "inventory"
          : "pantry";
      // amount 留空时交给服务端补默认值，避免把当前语言的「适量」写进库。
      return { name, amount, source } as Ingredient;
    })
    .filter((item) => item.name);
}

function ingredientText(recipe: Recipe | null | undefined, t: (text: string) => string) {
  const label = (source: Ingredient["source"]) =>
    source === "inventory" ? t("家里已有") : source === "flyer" ? t("优惠购买") : t("基础调料");
  return (recipe?.ingredients ?? [])
    .map((item) => `${item.name} | ${item.amount} | ${label(item.source)}`)
    .join("\n");
}

export function RecipeWorkspace({
  inventory,
  notify,
  onPlannerChange,
  onInventoryChange,
}: {
  inventory: InventoryLite[];
  notify: (message: string) => void;
  onPlannerChange: () => void;
  onInventoryChange: () => void;
}) {
  const { t, tv, tu, locale } = useAppSettings();
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const timeZone = data.timeZone || detectTimeZone();
  const [activeTab, setActiveTab] = useState<"library" | "requests" | "plan" | "history">("library");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("全部");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [recipeDraft, setRecipeDraft] = useState<Recipe | null | undefined>(undefined);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [requestDraft, setRequestDraft] = useState<Partial<MealRequest> | null>(null);
  const [historyDraft, setHistoryDraft] = useState<(Partial<CookHistory> & { rating?: number }) | null>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [memberDraft, setMemberDraft] = useState<Partial<Member> | null>(null);
  const [planRange, setPlanRange] = useState<"3" | "7" | "custom">("7");
  const [planFrom, setPlanFrom] = useState(dateString(detectTimeZone()));
  const [planTo, setPlanTo] = useState(addDays(detectTimeZone(), dateString(detectTimeZone()), 6));
  // 只存用户手动改过的项；默认值渲染时算，这样库存刷新不会冲掉已做的选择。
  const [consumptionOverrides, setConsumptionOverrides] = useState<Record<string, StockPortion>>({});

  async function load() {
    try {
      const response = await fetch("/api/recipe-workspace", { cache: "no-store" });
      const result = await readJson<WorkspaceData>(response);
      if (!response.ok) throw new Error(result.error || t("菜谱工作区读取失败"));
      setData(result);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("菜谱工作区读取失败"));
    }
  }
  // 挂载时拉一次数据，并订阅跨组件的刷新事件。理由同 page.tsx。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const refresh = () => void load();
    window.addEventListener("recipe-workspace-refresh", refresh);
    return () => window.removeEventListener("recipe-workspace-refresh", refresh);
  }, []);

  async function act(payload: Record<string, unknown>, success?: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/recipe-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readJson<
        WorkspaceData & { restored?: number; skipped?: number; consumed?: number; added?: number }
      >(response);
      if (!response.ok) throw new Error(result.error || t("保存失败"));
      setData(result);
      if (success) notify(success);
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : t("保存失败"));
    } finally {
      setBusy(false);
    }
  }

  async function generateRecipes() {
    setBusy(true);
    try {
      const response = await fetch("/api/recipes", { method: "POST", headers: withAiHeaders() });
      const result = await readJson<{ recipes?: unknown[] }>(response);
      if (!response.ok) throw new Error(result.error || t("菜谱生成失败"));
      const imported = await fetch("/api/recipe-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "importRecipes", recipes: result.recipes ?? [] }),
      });
      const workspace = await readJson<WorkspaceData>(imported);
      if (!imported.ok) throw new Error(workspace.error || t("菜谱导入失败"));
      setData(workspace);
      setActiveTab("library");
      notify(t("已加入 {count} 道新的智能推荐", { count: result.recipes?.length ?? 0 }));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("菜谱生成失败"));
    } finally {
      setBusy(false);
    }
  }

  const recipeById = useMemo(
    () => new Map(data.recipes.map((recipe) => [recipe.id, recipe])),
    [data.recipes],
  );
  const selectedRecipe = selectedRecipeId ? (recipeById.get(selectedRecipeId) ?? null) : null;
  const memberById = useMemo(
    () => new Map(data.members.map((member) => [member.id, member])),
    [data.members],
  );
  const allTags = useMemo(
    () =>
      Array.from(new Set(data.recipes.flatMap((recipe) => recipe.tags))).sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
    [data.recipes],
  );
  const filteredRecipes = useMemo(
    () =>
      data.recipes.filter((recipe) => {
        const query = search.trim().toLowerCase();
        const matchesSearch =
          !query ||
          `${recipe.title} ${recipe.summary} ${recipe.tags.join(" ")} ${recipe.ingredients.map((item) => item.name).join(" ")}`
            .toLowerCase()
            .includes(query);
        return (
          matchesSearch &&
          (!favoriteOnly || recipe.isFavorite) &&
          (tagFilter === "全部" || recipe.tags.includes(tagFilter))
        );
      }),
    [data.recipes, search, favoriteOnly, tagFilter],
  );
  const aiRecommendations = filteredRecipes
    .filter((recipe) => !recipe.isFavorite && !recipe.isCustom && recipe.tags.includes("智能推荐"))
    .slice(0, 4);
  const libraryRecipes = filteredRecipes.filter((recipe) => recipe.isFavorite || recipe.isCustom);
  const candidates = data.requests.filter((item) => item.status === "candidate");
  const scheduled = data.requests.filter((item) => item.status === "scheduled");
  const rangeStart = planFrom;
  const rangeEnd =
    planRange === "3"
      ? addDays(timeZone, planFrom, 2)
      : planRange === "7"
        ? addDays(timeZone, planFrom, 6)
        : planTo;
  const plannedInRange = scheduled
    .filter(
      (item) => item.scheduledDate && item.scheduledDate >= rangeStart && item.scheduledDate <= rangeEnd,
    )
    .sort((a, b) => `${a.scheduledDate}-${a.mealType}`.localeCompare(`${b.scheduledDate}-${b.mealType}`));
  const popularRecipes = [...data.recipes]
    .filter((recipe) => recipe.cookedCount || recipe.averageRating)
    .sort(
      (a, b) =>
        Number(b.averageRating ?? 0) * 10 +
        b.cookedCount -
        (Number(a.averageRating ?? 0) * 10 + a.cookedCount),
    )
    .slice(0, 6);
  const activeDietaryPreferences = [
    data.preferences.allergies && t("过敏：{list}", { list: data.preferences.allergies }),
    data.preferences.avoidFoods && t("忌口：{list}", { list: data.preferences.avoidFoods }),
    data.preferences.dislikes && t("不喜欢：{list}", { list: data.preferences.dislikes }),
  ].filter(Boolean) as string[];

  // 记录「完成菜谱」时，把菜谱食材对上家里的库存，让用户确认这一顿用掉了多少。
  const historyRecipe = historyDraft?.recipeId ? (recipeById.get(historyDraft.recipeId) ?? null) : null;
  const consumptionRows = useMemo<ConsumptionRow[]>(() => {
    if (!historyRecipe || historyDraft?.id) return [];
    const claimed = new Set<string>();
    const rows: ConsumptionRow[] = [];
    for (const ingredient of historyRecipe.ingredients) {
      const match = findInventoryMatch(ingredient.name, "", inventory);
      if (!match || claimed.has(match.item.id)) continue;
      claimed.add(match.item.id);
      const stock = match.item;
      const plan = planConsumption(
        ingredient.amount,
        {
          quantity: Number(stock.quantity ?? 0),
          unit: stock.unit,
          remainingPercent: Number(stock.remainingPercent ?? 100),
          category: stock.category,
        },
        ingredient.source,
      );
      rows.push({ ingredient, stock, ...plan });
    }
    return rows;
  }, [historyRecipe, historyDraft?.id, inventory]);

  // 键里带上菜谱 id：换一道菜就自然回到默认值，不需要额外的重置逻辑。
  const overrideKey = (row: ConsumptionRow) => `${historyDraft?.recipeId ?? ""}:${row.stock.id}`;
  const portionFor = (row: ConsumptionRow) => consumptionOverrides[overrideKey(row)] ?? row.defaultPortion;

  function openOrder(recipe: Recipe, request?: MealRequest) {
    setRequestDraft(
      request ?? {
        recipeId: recipe.id,
        memberId: data.members[0]?.id,
        servings: recipe.servings,
        priority: "想吃",
        mealType: "",
        status: "candidate",
        desiredFrom: dateString(timeZone),
        desiredTo: addDays(timeZone, dateString(timeZone), 6),
      },
    );
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tags = String(form.get("tags") ?? "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const mealTypes = form.getAll("mealTypes").map(String);
    const files = form
      .getAll("photos")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    const existingPhotos = recipeDraft?.photos ?? [];
    if (existingPhotos.length + files.length > 2) {
      notify(t("每道自定义菜谱最多保存 2 张照片"));
      return;
    }
    const recipeId = recipeDraft?.id ?? `recipe-${crypto.randomUUID()}`;
    const recipe = {
      id: recipeId,
      title: form.get("title"),
      icon: form.get("icon"),
      summary: form.get("summary"),
      reason: form.get("reason"),
      origin: form.get("origin"),
      cookTime: form.get("cookTime"),
      difficulty: form.get("difficulty"),
      servings: form.get("servings"),
      tags,
      mealTypes,
      ingredients: parseIngredients(String(form.get("ingredients") ?? "")),
      steps: String(form.get("steps") ?? "")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
      isFavorite: recipeDraft?.isFavorite ?? false,
      isCustom: recipeDraft?.isCustom ?? true,
    };
    setBusy(true);
    try {
      const response = await fetch("/api/recipe-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "saveRecipe", recipe }),
      });
      const workspace = await readJson<WorkspaceData>(response);
      if (!response.ok) throw new Error(workspace.error || t("菜谱保存失败"));
      setData(workspace);
      if (files.length) {
        const upload = new FormData();
        upload.set("recipeId", recipeId);
        files.forEach((file) => upload.append("files", file));
        const uploadResponse = await fetch("/api/recipe-files", { method: "POST", body: upload });
        const uploadResult = await readJson<Record<string, never>>(uploadResponse);
        if (!uploadResponse.ok) throw new Error(uploadResult.error || t("菜谱已保存，但照片上传失败"));
        await load();
      }
      notify(recipeDraft?.id ? t("菜谱资料与照片已更新") : t("自定义菜谱已加入菜谱库"));
      setRecipeDraft(undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("菜谱保存失败"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecipePhoto(photo: RecipePhoto) {
    setBusy(true);
    try {
      const response = await fetch(`/api/recipe-files?id=${encodeURIComponent(photo.id)}`, {
        method: "DELETE",
      });
      const result = await readJson<Record<string, never>>(response);
      if (!response.ok) throw new Error(result.error || t("照片删除失败"));
      setRecipeDraft((current) =>
        current ? { ...current, photos: current.photos.filter((item) => item.id !== photo.id) } : current,
      );
      await load();
      notify(t("菜谱照片已删除"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("照片删除失败"));
    } finally {
      setBusy(false);
    }
  }

  function saveRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const request = {
      id: requestDraft?.id,
      recipeId: form.get("recipeId"),
      memberId: form.get("memberId"),
      desiredFrom: form.get("desiredFrom"),
      desiredTo: form.get("desiredTo"),
      mealType: form.get("mealType"),
      priority: form.get("priority"),
      servings: form.get("servings"),
      notes: form.get("notes"),
      status: form.get("status"),
      scheduledDate: form.get("scheduledDate"),
    };
    void act(
      { action: "saveRequest", request },
      requestDraft?.id ? t("点菜与菜单安排已修改") : t("已经加入家庭点菜池"),
    ).then(() => setRequestDraft(null));
  }

  function saveHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const history = {
      id: historyDraft?.id,
      requestId: historyDraft?.requestId,
      recipeId: form.get("recipeId"),
      cookedDate: form.get("cookedDate"),
      mealType: form.get("mealType"),
      servings: form.get("servings"),
      cookMemberId: form.get("cookMemberId"),
      rating: form.get("rating"),
      notes: form.get("notes"),
    };
    const deductions = historyDraft?.id
      ? []
      : consumptionRows
          .map((row) => ({
            inventoryId: row.stock.id,
            portion: portionFor(row),
            quantityUsed: row.quantityUsed,
          }))
          .filter((entry) => entry.portion !== "none");
    void act(
      { action: historyDraft?.id ? "saveHistory" : "completeMeal", history, consumption: deductions },
      historyDraft?.id
        ? t("制作记录已修改")
        : deductions.length
          ? t("已记录完成，并更新了 {count} 项库存", { count: deductions.length })
          : t("已记录完成和评分"),
    ).then(() => {
      setHistoryDraft(null);
      if (deductions.length) onInventoryChange();
    });
  }

  // 撤销要连着把这顿饭扣掉的库存还回去；期间被人手动改过的物品不覆盖。
  async function undoHistory(entry: CookHistory) {
    const result = await act({ action: "undoHistory", historyId: entry.id });
    if (!result) return;
    const restored = Number(result.restored ?? 0),
      skipped = Number(result.skipped ?? 0);
    notify(
      restored
        ? t("已撤销，并还原了 {count} 项库存", { count: restored }) +
            (skipped ? t("（{count} 项已被改动，未还原）", { count: skipped }) : "")
        : t("已撤销这次制作记录"),
    );
    if (restored) onInventoryChange();
  }

  function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(
      {
        action: "saveMember",
        member: { id: memberDraft?.id, name: form.get("name"), avatar: form.get("avatar") },
      },
      memberDraft?.id ? t("成员资料已更新") : t("家庭成员已添加"),
    ).then(() => setMemberDraft(null));
  }

  function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const preferences = {
      allergies: form.get("allergies"),
      avoidFoods: form.get("avoidFoods"),
      dislikes: form.get("dislikes"),
      notes: form.get("notes"),
    };
    void act({ action: "savePreferences", preferences }, "家庭忌口设置已保存，下一次 AI 推荐会自动遵守").then(
      () => setPreferencesOpen(false),
    );
  }

  function renderCatalogCard(recipe: Recipe) {
    return (
      <article className="catalog-recipe-card" key={recipe.id}>
        {recipe.photos[0] && (
          <button
            className="catalog-recipe-photo"
            onClick={() => setSelectedRecipeId(recipe.id)}
            aria-label={t("查看{title}完整菜谱", { title: recipe.title })}
          >
            <img
              src={`/api/recipe-files?fileId=${encodeURIComponent(recipe.photos[0].id)}`}
              alt={recipe.title}
            />
            {recipe.photos.length > 1 && <span>＋{recipe.photos.length - 1} 张</span>}
          </button>
        )}
        <div className="catalog-recipe-top">
          <span>{recipe.icon}</span>
          <button className="catalog-recipe-open" onClick={() => setSelectedRecipeId(recipe.id)}>
            <small>{tv(recipe.origin)}</small>
            <h3>{tv(recipe.title)}</h3>
            <p>{tv(recipe.summary) || tv(recipe.reason)}</p>
            <em>{t("点击查看食材与具体步骤 →")}</em>
          </button>
          <button
            className={recipe.isFavorite ? "catalog-heart active" : "catalog-heart"}
            onClick={() =>
              act(
                { action: "toggleFavorite", recipeId: recipe.id, favorite: !recipe.isFavorite },
                recipe.isFavorite ? t("已取消收藏") : t("已收藏菜谱"),
              )
            }
            aria-label={
              recipe.isFavorite
                ? t("取消收藏{title}", { title: recipe.title })
                : t("收藏{title}", { title: recipe.title })
            }
          >
            {recipe.isFavorite ? "♥" : "♡"}
          </button>
        </div>
        <div className="catalog-tags">
          {recipe.tags.map((tag) => (
            <span key={tag}>{tv(tag)}</span>
          ))}
          {recipe.mealTypes.map((meal) => (
            <span className="meal" key={meal}>
              {tv(meal)}
            </span>
          ))}
        </div>
        <div className="catalog-stats">
          <span>
            <small>{t("做过")}</small>
            <b>{t("{count} 次", { count: recipe.cookedCount })}</b>
          </span>
          <span>
            <small>{t("家庭评分")}</small>
            <b>{recipe.averageRating ? `★ ${recipe.averageRating}/10` : t("尚未评分")}</b>
          </span>
          <span>
            <small>{t("烹饪时间")}</small>
            <b>{recipe.cookTime ? tv(recipe.cookTime) : t("待补充")}</b>
          </span>
        </div>
        <div className="catalog-card-actions">
          <button onClick={() => openOrder(recipe)}>{t("＋ 我想吃")}</button>
          <button onClick={() => setRecipeDraft(recipe)}>{t("编辑资料")}</button>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm(t("确定删除「{title}」及相关点菜、评分和历史吗？", { title: recipe.title })))
                void act({ action: "deleteRecipe", recipeId: recipe.id }, "菜谱已彻底删除");
            }}
          >
            {t("删除")}
          </button>
        </div>
      </article>
    );
  }

  return (
    <section className="panel recipe-panel recipe-workspace" id="recipes">
      <div className="section-head recipe-workspace-head">
        <div>
          <p className="eyebrow">{t("家庭点菜与计划")}</p>
          <h2>{t("本周菜谱")}</h2>
          <p>{t("从统一菜谱库点菜、安排三餐，并记录家人的真实喜好。")}</p>
        </div>
        <div className="recipe-workspace-actions">
          <button className="recipe-member-button" onClick={() => setMemberOpen(true)}>
            {t("👥 家庭成员")}
          </button>
          <button
            className="recipe-secondary-action dietary-settings-button"
            onClick={() => setPreferencesOpen(true)}
          >
            {t("⚠ 忌口设置")}
          </button>
          <button className="recipe-secondary-action" onClick={() => setRecipeDraft(null)}>
            {t("＋ 自定义菜谱")}
          </button>
          <button className="recipe-generate" disabled={busy} onClick={generateRecipes}>
            {busy ? t("处理中…") : t("✦ 根据库存推荐")}
          </button>
        </div>
      </div>
      <div
        className={
          activeDietaryPreferences.length ? "dietary-preference-bar active" : "dietary-preference-bar"
        }
      >
        <div>
          <span>🛡️</span>
          <div>
            <strong>
              {activeDietaryPreferences.length ? t("AI 推荐已启用家庭忌口") : t("尚未设置家庭忌口")}
            </strong>
            <p>
              {activeDietaryPreferences.length
                ? activeDietaryPreferences.join(" · ")
                : t("设置过敏、忌口或不喜欢的食物，AI 生成菜谱时会自动避开。")}
            </p>
          </div>
        </div>
        <button onClick={() => setPreferencesOpen(true)}>
          {activeDietaryPreferences.length ? t("修改") : t("立即设置")}
        </button>
      </div>

      <nav className="recipe-tabs" aria-label={t("菜谱功能")}>
        <button className={activeTab === "library" ? "active" : ""} onClick={() => setActiveTab("library")}>
          {t("菜谱库")} <b>{data.recipes.length}</b>
        </button>
        <button className={activeTab === "requests" ? "active" : ""} onClick={() => setActiveTab("requests")}>
          {t("点菜池")} <b>{candidates.length}</b>
        </button>
        <button className={activeTab === "plan" ? "active" : ""} onClick={() => setActiveTab("plan")}>
          {t("三天／本周")} <b>{scheduled.length}</b>
        </button>
        <button className={activeTab === "history" ? "active" : ""} onClick={() => setActiveTab("history")}>
          {t("做过的菜")} <b>{data.history.length}</b>
        </button>
      </nav>

      {activeTab === "library" && (
        <div className="recipe-library-view">
          <div className="recipe-library-tools">
            <label>
              <span>⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("搜索菜名、食材或 Tag")}
              />
            </label>
            <button className={favoriteOnly ? "active" : ""} onClick={() => setFavoriteOnly(!favoriteOnly)}>
              {t("♥ 只看收藏")}
            </button>
          </div>
          <div className="recipe-tag-filter">
            <button className={tagFilter === "全部" ? "active" : ""} onClick={() => setTagFilter("全部")}>
              {t("全部")}
            </button>
            {allTags.map((tag) => (
              <button
                className={tagFilter === tag ? "active" : ""}
                key={tag}
                onClick={() => setTagFilter(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
          {aiRecommendations.length > 0 && (
            <section className="recipe-library-section ai-recommendation-section">
              <div className="recipe-library-section-head">
                <div>
                  <span>✦</span>
                  <div>
                    <h3>{t("AI 为你推荐")}</h3>
                    <p>{t("最多展示 4 道尚未收藏的新推荐；收藏后会自动移入下方菜谱库。")}</p>
                  </div>
                </div>
                <b>{t("{count} 道", { count: aiRecommendations.length })}</b>
              </div>
              <div className="recipe-catalog-grid">{aiRecommendations.map(renderCatalogCard)}</div>
            </section>
          )}
          <section className="recipe-library-section saved-library-section">
            <div className="recipe-library-section-head">
              <div>
                <span>♥</span>
                <div>
                  <h3>{t("我的菜谱库")}</h3>
                  <p>{t("这里集中显示已经收藏的菜谱和家庭自建菜谱。")}</p>
                </div>
              </div>
              <b>{t("{count} 道", { count: libraryRecipes.length })}</b>
            </div>
            {libraryRecipes.length ? (
              <div className="recipe-catalog-grid">{libraryRecipes.map(renderCatalogCard)}</div>
            ) : (
              <div className="recipe-workspace-empty compact">
                <span>♡</span>
                <strong>{t("菜谱库还没有收藏")}</strong>
                <p>{t("点击上方 AI 推荐的爱心，菜谱就会移动到这里。")}</p>
              </div>
            )}
          </section>
          {!aiRecommendations.length && !libraryRecipes.length && (
            <div className="recipe-workspace-empty">
              <span>🍽️</span>
              <strong>{t("没有符合条件的菜谱")}</strong>
              <p>{t("可以清除筛选、创建家庭菜谱，或根据库存生成一组推荐。")}</p>
            </div>
          )}
        </div>
      )}

      {activeTab === "requests" && (
        <div className="recipe-request-view">
          <div className="recipe-view-heading">
            <div>
              <strong>{t("家庭点菜池")}</strong>
              <small>{t("候选菜不会自动占用日期，确认后再安排进三天或本周菜单。")}</small>
            </div>
          </div>
          {candidates.length ? (
            <div className="request-card-grid">
              {candidates.map((request) => {
                const recipe = recipeById.get(request.recipeId);
                const member = memberById.get(request.memberId);
                if (!recipe) return null;
                return (
                  <article className="request-card" key={request.id}>
                    <div>
                      <span className="request-avatar">{member?.avatar ?? "🙂"}</span>
                      <div>
                        <small>
                          {member?.name ?? t("家庭成员")} · {request.priority}
                        </small>
                        <strong>{tv(recipe.title)}</strong>
                        <p>
                          {request.desiredFrom && request.desiredTo
                            ? `${shortDate(request.desiredFrom, locale, t)}—${shortDate(request.desiredTo, locale, t)}`
                            : t("日期待定")}{" "}
                          · {request.mealType || t("餐次待定")} · {t("{n} 人份", { n: request.servings })}
                        </p>
                        {request.notes && <em>{request.notes}</em>}
                      </div>
                    </div>
                    <div>
                      <button
                        onClick={() =>
                          setRequestDraft({
                            ...request,
                            status: "scheduled",
                            scheduledDate:
                              request.scheduledDate || request.desiredFrom || dateString(timeZone),
                          })
                        }
                      >
                        {t("安排菜单")}
                      </button>
                      <button onClick={() => setRequestDraft(request)}>{t("编辑")}</button>
                      <button
                        className="danger"
                        onClick={() => act({ action: "deleteRequest", requestId: request.id }, "点菜已撤回")}
                      >
                        {t("撤回")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="recipe-workspace-empty">
              <span>🙋</span>
              <strong>{t("点菜池还是空的")}</strong>
              <p>{t("从菜谱库点击“我想吃”，选择成员、日期范围和口味备注。")}</p>
            </div>
          )}
        </div>
      )}

      {activeTab === "plan" && (
        <div className="recipe-plan-view">
          <div className="plan-toolbar">
            <div>
              <button className={planRange === "3" ? "active" : ""} onClick={() => setPlanRange("3")}>
                {t("未来三天")}
              </button>
              <button className={planRange === "7" ? "active" : ""} onClick={() => setPlanRange("7")}>
                {t("本周七天")}
              </button>
              <button
                className={planRange === "custom" ? "active" : ""}
                onClick={() => setPlanRange("custom")}
              >
                {t("自定义")}
              </button>
            </div>
            <label>
              {t("开始日期")}
              <input type="date" value={planFrom} onChange={(event) => setPlanFrom(event.target.value)} />
            </label>
            {planRange === "custom" && (
              <label>
                {t("结束日期")}
                <input
                  type="date"
                  min={planFrom}
                  value={planTo}
                  onChange={(event) => setPlanTo(event.target.value)}
                />
              </label>
            )}
            <button
              className="plan-shopping-button"
              onClick={() =>
                void act(
                  { action: "generateShopping", from: rangeStart, to: rangeEnd },
                  "菜单缺少的优惠食材已加入采购清单",
                ).then(() => onPlannerChange())
              }
            >
              {t("生成采购清单")}
            </button>
          </div>
          <div className="plan-summary">
            <strong>
              {shortDate(rangeStart, locale, t)}—{shortDate(rangeEnd, locale, t)}
            </strong>
            <span>{t("{count} 顿已安排", { count: plannedInRange.length })}</span>
            <button
              onClick={() =>
                setRequestDraft({
                  memberId: data.members[0]?.id,
                  status: "scheduled",
                  scheduledDate: planFrom,
                  servings: 2,
                  priority: "想吃",
                  mealType: "晚餐",
                })
              }
            >
              {t("＋ 直接安排")}
            </button>
          </div>
          {plannedInRange.length ? (
            <div className="meal-plan-list">
              {plannedInRange.map((request) => {
                const recipe = recipeById.get(request.recipeId);
                const member = memberById.get(request.memberId);
                if (!recipe) return null;
                return (
                  <article className="meal-plan-card" key={request.id}>
                    <div className="meal-plan-date">
                      <strong>{shortDate(request.scheduledDate, locale, t)}</strong>
                      <span>{request.mealType || t("未指定餐次")}</span>
                    </div>
                    <span className="meal-plan-icon">{recipe.icon}</span>
                    <div>
                      <strong>{tv(recipe.title)}</strong>
                      <small>
                        {member?.avatar} {member?.name} {t("点菜")} · {t("{n} 人份", { n: request.servings })}
                      </small>
                      <p>{request.notes || tv(recipe.summary)}</p>
                    </div>
                    <div className="meal-plan-actions">
                      <button
                        onClick={() =>
                          setHistoryDraft({
                            recipeId: recipe.id,
                            requestId: request.id,
                            cookedDate: request.scheduledDate || dateString(timeZone),
                            mealType: request.mealType,
                            servings: request.servings,
                            cookMemberId: data.members[0]?.id,
                            rating: 8,
                          })
                        }
                      >
                        {t("完成并评分")}
                      </button>
                      <button onClick={() => setRequestDraft(request)}>{t("调整")}</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="recipe-workspace-empty">
              <span>📅</span>
              <strong>{t("这个时间段还没有菜单")}</strong>
              <p>{t("先从点菜池确认候选菜，或者直接安排菜谱。")}</p>
            </div>
          )}
        </div>
      )}

      {activeTab === "history" && (
        <div className="recipe-history-view">
          <div className="recipe-view-heading">
            <div>
              <strong>{t("家庭喜爱排行")}</strong>
              <small>{t("综合1–10分、制作次数和最近制作记录，帮助判断家人真正喜欢什么。")}</small>
            </div>
          </div>
          {popularRecipes.length > 0 && (
            <div className="popular-recipe-row">
              {popularRecipes.map((recipe, index) => (
                <article key={recipe.id}>
                  <span>{index + 1}</span>
                  <b>{recipe.icon}</b>
                  <div>
                    <strong>{recipe.title}</strong>
                    <small>
                      {recipe.averageRating
                        ? t("{score}/10 分", { score: recipe.averageRating ?? 0 })
                        : t("暂无评分")}{" "}
                      · 已做 {recipe.cookedCount} 次
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="history-list">
            {data.history.map((entry) => {
              const recipe = recipeById.get(entry.recipeId);
              const member = memberById.get(entry.cookMemberId);
              const rating = data.ratings.find(
                (item) => item.recipeId === entry.recipeId && item.memberId === entry.cookMemberId,
              );
              return (
                <article key={entry.id}>
                  <span>{recipe?.icon ?? "🍲"}</span>
                  <div>
                    <strong>{recipe ? tv(recipe.title) : t("已删除菜谱")}</strong>
                    <small>
                      {shortDate(entry.cookedDate, locale, t)} · {entry.mealType || t("未指定餐次")} ·{" "}
                      {t("{n} 人份", { n: entry.servings })} · {member?.avatar} {member?.name}
                    </small>
                    <p>
                      {rating ? t("评分 {score}/10", { score: rating.rating }) : t("尚未评分")}
                      {entry.notes ? ` · ${entry.notes}` : ""}
                    </p>
                    {entry.consumption?.length ? (
                      <em className="history-consumption">
                        {t("用掉了")} {entry.consumption.map((item) => tv(item.name)).join("、")}
                      </em>
                    ) : null}
                  </div>
                  <div>
                    <button onClick={() => setHistoryDraft({ ...entry, rating: rating?.rating })}>
                      {t("编辑")}
                    </button>
                    <button className="danger" onClick={() => undoHistory(entry)}>
                      {t("撤销")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {!data.history.length && (
            <div className="recipe-workspace-empty">
              <span>🕰️</span>
              <strong>{t("还没有制作记录")}</strong>
              <p>{t("菜单完成后在这里记录实际日期、份量和1–10分。")}</p>
            </div>
          )}
        </div>
      )}

      {selectedRecipe && (
        <Modal
          className="recipe-detail-modal"
          title={tv(selectedRecipe.title)}
          onClose={() => setSelectedRecipeId(null)}
          head={
            <div className="modal-head recipe-detail-modal-head">
              <div className="recipe-detail-title">
                <span>{selectedRecipe.icon}</span>
                <div>
                  <p className="eyebrow">
                    {tv(selectedRecipe.origin)} · {t("完整菜谱")}
                  </p>
                  <h2 id="recipe-detail-title">{tv(selectedRecipe.title)}</h2>
                  <p>{tv(selectedRecipe.summary)}</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setSelectedRecipeId(null)}
                aria-label={t("关闭菜谱详情")}
              >
                ×
              </button>
            </div>
          }
        >
          {selectedRecipe.photos.length > 0 && (
            <div className={`recipe-detail-photo-gallery photos-${selectedRecipe.photos.length}`}>
              {selectedRecipe.photos.map((photo) => (
                <img
                  key={photo.id}
                  src={`/api/recipe-files?fileId=${encodeURIComponent(photo.id)}`}
                  alt={t("{title}菜品照片", { title: selectedRecipe.title })}
                />
              ))}
            </div>
          )}
          <div className="recipe-detail-summary">
            <div>
              <small>{t("预计时间")}</small>
              <strong>⏱ {selectedRecipe.cookTime ? tv(selectedRecipe.cookTime) : t("待补充")}</strong>
            </div>
            <div>
              <small>{t("难度")}</small>
              <strong>◎ {selectedRecipe.difficulty ? tv(selectedRecipe.difficulty) : t("待补充")}</strong>
            </div>
            <div>
              <small>{t("份量")}</small>
              <strong>♨ {t("{n} 人份", { n: selectedRecipe.servings })}</strong>
            </div>
            <div>
              <small>{t("家庭记录")}</small>
              <strong>
                ★ {selectedRecipe.averageRating ? `${selectedRecipe.averageRating}/10` : t("尚未评分")} · 做过{" "}
                {t("{count} 次", { count: selectedRecipe.cookedCount })}
              </strong>
            </div>
          </div>
          {selectedRecipe.reason && (
            <section className="recipe-detail-reason">
              <strong>{t("为什么推荐")}</strong>
              <p>{tv(selectedRecipe.reason)}</p>
            </section>
          )}
          <section className="recipe-detail-section">
            <div className="recipe-detail-section-head">
              <div>
                <span>01</span>
                <h3>{t("准备食材")}</h3>
              </div>
              <small>
                <i className="inventory-key" />
                {t("家里已有")} <i className="flyer-key" />
                {t("优惠购买")} <i className="pantry-key" />
                {t("基础调料")}
              </small>
            </div>
            {selectedRecipe.ingredients.length ? (
              <div className="recipe-detail-ingredients">
                {selectedRecipe.ingredients.map((ingredient, index) => (
                  <article className={ingredient.source} key={`${ingredient.name}-${index}`}>
                    <strong>{tv(ingredient.name)}</strong>
                    <span>{tv(ingredient.amount)}</span>
                    <small>
                      {ingredient.source === "inventory"
                        ? t("家里已有")
                        : ingredient.source === "flyer"
                          ? t("优惠购买")
                          : t("基础调料")}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="recipe-detail-empty">{t("还没有记录食材，可通过“编辑资料”补充。")}</p>
            )}
          </section>
          <section className="recipe-detail-section">
            <div className="recipe-detail-section-head">
              <div>
                <span>02</span>
                <h3>{t("具体步骤")}</h3>
              </div>
              <small>{t("按顺序完成")}</small>
            </div>
            {selectedRecipe.steps.length ? (
              <ol className="recipe-detail-steps">
                {selectedRecipe.steps.map((step, index) => (
                  <li key={`${index}-${step}`}>
                    <b>{String(index + 1).padStart(2, "0")}</b>
                    <p>{tv(step)}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="recipe-detail-empty">{t("这道菜还没有具体步骤，可通过“编辑资料”补充。")}</p>
            )}
          </section>
          <div className="recipe-detail-actions">
            <button
              className="secondary-button"
              onClick={() => {
                setRecipeDraft(selectedRecipe);
                setSelectedRecipeId(null);
              }}
            >
              {t("编辑全部资料")}
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                openOrder(selectedRecipe);
                setSelectedRecipeId(null);
              }}
            >
              {t("＋ 我想吃")}
            </button>
            <button className="primary-button" onClick={() => setSelectedRecipeId(null)}>
              {t("看完了")}
            </button>
          </div>
        </Modal>
      )}

      {preferencesOpen && (
        <Modal
          className="dietary-preferences-modal"
          title={t("家庭忌口设置")}
          onClose={() => setPreferencesOpen(false)}
          head={
            <div className="modal-head">
              <div>
                <p className="eyebrow">{t("AI 推荐安全方向")}</p>
                <h2 id="dietary-preferences-title">{t("家庭忌口设置")}</h2>
                <p className="dietary-modal-intro">
                  {t("设置会保存在家庭项目中。AI 会忽略与这些条件冲突的库存和 Flyer 优惠。")}
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setPreferencesOpen(false)}
                aria-label={t("关闭忌口设置")}
              >
                ×
              </button>
            </div>
          }
        >
          <form onSubmit={savePreferences}>
            <div className="dietary-safety-note">
              <span>!</span>
              <p>
                <strong>{t("过敏食材优先级最高")}</strong>
                {t("请填写准确名称；多个项目可使用逗号、顿号或换行分隔。")}
              </p>
            </div>
            <div className="field-grid">
              <label className="field full">
                <span>{t("过敏食材（绝对禁止）")}</span>
                <textarea
                  name="allergies"
                  rows={3}
                  defaultValue={data.preferences.allergies}
                  placeholder={t("例如：花生、坚果、贝类")}
                />
                <small className="field-hint">{t("这些食材不会进入 AI 菜名、食材清单或步骤。")}</small>
              </label>
              <label className="field full">
                <span>{t("家庭忌口（绝对禁止）")}</span>
                <textarea
                  name="avoidFoods"
                  rows={3}
                  defaultValue={data.preferences.avoidFoods}
                  placeholder={t("例如：猪肉、动物内脏、酒精")}
                />
              </label>
              <label className="field full">
                <span>{t("不喜欢的食物")}</span>
                <textarea
                  name="dislikes"
                  rows={3}
                  defaultValue={data.preferences.dislikes}
                  placeholder={t("例如：香菜、芹菜、苦瓜")}
                />
              </label>
              <label className="field full">
                <span>{t("其他饮食要求")}</span>
                <textarea
                  name="notes"
                  rows={3}
                  defaultValue={data.preferences.notes}
                  placeholder={t("例如：少辣、低盐，不要油炸")}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPreferencesOpen(false)}>
                {t("取消")}
              </button>
              <button className="primary-button" disabled={busy}>
                {busy ? t("正在保存…") : t("保存忌口设置")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {recipeDraft !== undefined && (
        <Modal
          className="recipe-editor-modal"
          eyebrow={t("所有字段都可修改")}
          title={recipeDraft?.id ? t("编辑菜谱") : t("创建自定义菜谱")}
          onClose={() => setRecipeDraft(undefined)}
        >
          <form onSubmit={saveRecipe}>
            <div className="field-grid">
              <label className="field">
                <span>{t("菜名")}</span>
                <input name="title" required defaultValue={recipeDraft?.title ?? ""} />
              </label>
              <label className="field">
                <span>{t("图标")}</span>
                <input name="icon" defaultValue={recipeDraft?.icon ?? "🍲"} />
              </label>
              <label className="field full">
                <span>{t("简介")}</span>
                <textarea name="summary" defaultValue={recipeDraft?.summary ?? ""} rows={2} />
              </label>
              <label className="field full">
                <span>{t("推荐理由或家庭备注")}</span>
                <textarea name="reason" defaultValue={recipeDraft?.reason ?? ""} rows={2} />
              </label>
              {(!recipeDraft || recipeDraft.isCustom) && (
                <div className="field full recipe-photo-editor">
                  <div className="recipe-photo-editor-head">
                    <span>{t("菜谱照片（最多 2 张）")}</span>
                    <small>{t("{count}/2 已保存", { count: recipeDraft?.photos.length ?? 0 })}</small>
                  </div>
                  {recipeDraft?.photos.length ? (
                    <div className="recipe-photo-editor-grid">
                      {recipeDraft.photos.map((photo) => (
                        <figure key={photo.id}>
                          <img
                            src={`/api/recipe-files?fileId=${encodeURIComponent(photo.id)}`}
                            alt={recipeDraft.title}
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void deleteRecipePhoto(photo)}
                            aria-label={t("删除{name}", { name: photo.fileName })}
                          >
                            ×
                          </button>
                        </figure>
                      ))}
                    </div>
                  ) : (
                    <div className="recipe-photo-empty">{t("📷 保存后会显示在菜谱大卡片和详情中")}</div>
                  )}
                  <label
                    className={
                      recipeDraft && recipeDraft.photos.length >= 2
                        ? "recipe-photo-picker disabled"
                        : "recipe-photo-picker"
                    }
                  >
                    <strong>{t("＋ 选择照片")}</strong>
                    <small>{t("支持 JPG、PNG、WebP；单张不超过 5MB")}</small>
                    <input
                      name="photos"
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={Boolean(recipeDraft && recipeDraft.photos.length >= 2)}
                    />
                  </label>
                </div>
              )}
              <label className="field">
                <span>{t("来源标志")}</span>
                <input name="origin" defaultValue={recipeDraft?.origin ?? t("家庭自建")} />
              </label>
              <label className="field">
                <span>{t("烹饪时间")}</span>
                <input name="cookTime" defaultValue={recipeDraft?.cookTime ?? t("30 分钟")} />
              </label>
              <label className="field">
                <span>{t("难度")}</span>
                <select name="difficulty" defaultValue={recipeDraft?.difficulty ?? t("简单")}>
                  <option value="简单">{tv("简单")}</option>
                  <option value="中等">{tv("中等")}</option>
                  <option value="复杂">{tv("复杂")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("默认人数")}</span>
                <input
                  name="servings"
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={recipeDraft?.servings ?? 2}
                />
              </label>
              <label className="field full">
                <span>{t("Tag（使用逗号分隔，可完全手动修改）")}</span>
                <input
                  name="tags"
                  defaultValue={(recipeDraft?.tags ?? ["家庭自建"]).join("，")}
                  placeholder={t("例如：快手菜，粤菜，少辣")}
                />
              </label>
              <div className="field full">
                <span>{t("适合餐次（可多选，也可不选）")}</span>
                <div className="meal-checkboxes">
                  {["早餐", "午餐", "晚餐"].map((meal) => (
                    <label key={meal}>
                      <input
                        name="mealTypes"
                        type="checkbox"
                        value={meal}
                        defaultChecked={recipeDraft?.mealTypes.includes(meal)}
                      />
                      {meal}
                    </label>
                  ))}
                </div>
              </div>
              <label className="field full">
                <span>{t("食材：每行“名称 | 用量 | 家里已有／优惠购买／基础调料”")}</span>
                <textarea
                  name="ingredients"
                  defaultValue={ingredientText(recipeDraft, t)}
                  rows={7}
                  placeholder={t("鸡蛋 | 2个 | 家里已有")}
                />
              </label>
              <label className="field full">
                <span>{t("步骤（每行一步）")}</span>
                <textarea name="steps" defaultValue={(recipeDraft?.steps ?? []).join("\n")} rows={7} />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setRecipeDraft(undefined)}>
                {t("取消")}
              </button>
              <button className="primary-button" disabled={busy}>
                {busy ? t("正在保存…") : t("保存菜谱")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {requestDraft && (
        <Modal
          className="meal-request-modal"
          eyebrow={t("点菜与菜单安排")}
          title={requestDraft.id ? t("修改点菜") : t("家庭点菜")}
          onClose={() => setRequestDraft(null)}
        >
          <form onSubmit={saveRequest}>
            <div className="field-grid">
              <label className="field full">
                <span>{t("菜谱")}</span>
                <select name="recipeId" required defaultValue={requestDraft.recipeId ?? ""}>
                  <option value="">{t("请选择")}</option>
                  {data.recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("点菜人")}</span>
                <select name="memberId" required defaultValue={requestDraft.memberId ?? data.members[0]?.id}>
                  {data.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.avatar} {member.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("优先程度")}</span>
                <select name="priority" defaultValue={requestDraft.priority ?? t("想吃")}>
                  <option value="想吃">{tv("想吃")}</option>
                  <option value="优先">{tv("优先")}</option>
                  <option value="一定要吃">{tv("一定要吃")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("希望开始日期")}</span>
                <input
                  name="desiredFrom"
                  type="date"
                  defaultValue={requestDraft.desiredFrom ?? dateString(timeZone)}
                />
              </label>
              <label className="field">
                <span>{t("希望结束日期")}</span>
                <input
                  name="desiredTo"
                  type="date"
                  defaultValue={requestDraft.desiredTo ?? addDays(timeZone, dateString(timeZone), 6)}
                />
              </label>
              <label className="field">
                <span>{t("餐次（可不选）")}</span>
                <select name="mealType" defaultValue={requestDraft.mealType ?? ""}>
                  {mealOptions.map((meal) => (
                    <option key={meal || "none"} value={meal}>
                      {meal || t("暂不指定")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("人数")}</span>
                <input
                  name="servings"
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={requestDraft.servings ?? 2}
                />
              </label>
              <label className="field">
                <span>{t("状态")}</span>
                <select name="status" defaultValue={requestDraft.status ?? "candidate"}>
                  <option value="candidate">{t("候选点菜")}</option>
                  <option value="scheduled">{t("已安排")}</option>
                  <option value="completed">{t("已完成")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("正式安排日期（可留空）")}</span>
                <input name="scheduledDate" type="date" defaultValue={requestDraft.scheduledDate ?? ""} />
              </label>
              <label className="field full">
                <span>{t("口味和其他备注")}</span>
                <textarea
                  name="notes"
                  rows={3}
                  defaultValue={requestDraft.notes ?? ""}
                  placeholder={t("例如：少辣、不要香菜")}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setRequestDraft(null)}>
                {t("取消")}
              </button>
              <button className="primary-button" disabled={busy}>
                {t("保存")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {historyDraft && (
        <Modal
          className="history-editor-modal"
          eyebrow={t("制作记录与量化喜好")}
          title={historyDraft.id ? t("修改记录") : t("完成菜谱")}
          onClose={() => setHistoryDraft(null)}
        >
          <form onSubmit={saveHistory}>
            <div className="field-grid">
              <label className="field full">
                <span>{t("菜谱")}</span>
                <select
                  name="recipeId"
                  required
                  value={historyDraft.recipeId ?? ""}
                  onChange={(event) =>
                    setHistoryDraft((current) =>
                      current ? { ...current, recipeId: event.target.value } : current,
                    )
                  }
                >
                  {data.recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("实际制作日期")}</span>
                <input
                  name="cookedDate"
                  type="date"
                  required
                  defaultValue={historyDraft.cookedDate ?? dateString(timeZone)}
                />
              </label>
              <label className="field">
                <span>{t("餐次")}</span>
                <select name="mealType" defaultValue={historyDraft.mealType ?? ""}>
                  {mealOptions.map((meal) => (
                    <option key={meal || "none"} value={meal}>
                      {meal || t("未指定")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("制作人／评分人")}</span>
                <select
                  name="cookMemberId"
                  required
                  defaultValue={historyDraft.cookMemberId ?? data.members[0]?.id}
                >
                  {data.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.avatar} {member.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("实际人数")}</span>
                <input
                  name="servings"
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={historyDraft.servings ?? 2}
                />
              </label>
              <label className="field full rating-field">
                <span>{t("喜爱度：1–10分")}</span>
                <input
                  name="rating"
                  type="range"
                  min="1"
                  max="10"
                  defaultValue={historyDraft.rating ?? 8}
                  onInput={(event) => {
                    const output = event.currentTarget.nextElementSibling;
                    if (output) output.textContent = `${event.currentTarget.value}/10`;
                  }}
                />
                <output>{historyDraft.rating ?? 8}/10</output>
              </label>
              <label className="field full">
                <span>{t("实际情况或下次调整")}</span>
                <textarea name="notes" rows={3} defaultValue={historyDraft.notes ?? ""} />
              </label>
            </div>
            {!historyDraft.id && (
              <div className="stock-consumption">
                <div className="stock-consumption-head">
                  <strong>{t("这一顿用掉了哪些库存")}</strong>
                  <small>{t("保存后会按下面的选择更新库存，选「没有用到」就不动。")}</small>
                </div>
                {consumptionRows.length ? (
                  <div className="stock-consumption-list">
                    {consumptionRows.map((row) => {
                      const portion = portionFor(row);
                      const before = {
                        quantity: Number(row.stock.quantity ?? 0),
                        unit: row.stock.unit,
                        remainingPercent: Number(row.stock.remainingPercent ?? 100),
                      };
                      const preview = describeChange(
                        row.stock.name,
                        before,
                        applyConsumption(before, portion, row.quantityUsed),
                      );
                      return (
                        <article className="stock-consumption-row" key={row.stock.id}>
                          <div>
                            <strong>{row.ingredient.name}</strong>
                            <small>
                              {t("菜谱用量")} {row.ingredient.amount} · {t("对应库存")} {tv(row.stock.name)}（
                              {tv(row.stock.level)} {row.stock.remainingPercent ?? 100}%）
                            </small>
                          </div>
                          <select
                            value={portion}
                            onChange={(event) =>
                              setConsumptionOverrides((current) => ({
                                ...current,
                                [overrideKey(row)]: event.target.value as StockPortion,
                              }))
                            }
                            aria-label={t("{name}用掉多少", { name: row.ingredient.name })}
                          >
                            {row.quantityUsed !== null && (
                              <option value="measured">
                                {tv(portionLabels.measured)} {row.quantityUsed}{" "}
                                {tu(row.stock.unit ?? "", row.quantityUsed ?? 1)}
                              </option>
                            )}
                            {coarsePortions.map((option) => (
                              <option key={option} value={option}>
                                {tv(portionLabels[option])}
                              </option>
                            ))}
                          </select>
                          <em>{portion === "none" ? t("库存不变") : preview}</em>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="stock-consumption-empty">
                    {t("这道菜的食材没有匹配到家里的库存，保存后不会改动库存。")}
                  </p>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setHistoryDraft(null)}>
                {t("取消")}
              </button>
              <button className="primary-button" disabled={busy}>
                {t("保存记录")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {memberOpen && (
        <Modal
          className="member-modal"
          eyebrow={t("同一个家庭")}
          title={t("家庭成员")}
          onClose={() => setMemberOpen(false)}
        >
          <div className="member-list">
            {data.members.map((member) => (
              <article key={member.id}>
                <span>{member.avatar}</span>
                <strong>{member.name}</strong>
                <button onClick={() => setMemberDraft(member)}>{t("编辑")}</button>
                <button
                  className="danger"
                  onClick={() => act({ action: "deleteMember", memberId: member.id }, "成员已删除")}
                >
                  {t("删除")}
                </button>
              </article>
            ))}
          </div>
          <button className="member-add-button" onClick={() => setMemberDraft({ avatar: "🙂" })}>
            ＋ {t("添加家庭成员")}
          </button>
        </Modal>
      )}

      {memberDraft && (
        <Modal
          className="member-editor-modal"
          backdropClassName="member-editor-layer"
          title={memberDraft.id ? t("编辑成员") : t("添加成员")}
          onClose={() => setMemberDraft(null)}
        >
          <form onSubmit={saveMember}>
            <div className="field-grid">
              <label className="field">
                <span>{t("头像 Emoji")}</span>
                <input name="avatar" defaultValue={memberDraft.avatar ?? "🙂"} />
              </label>
              <label className="field">
                <span>{t("成员姓名或昵称")}</span>
                <input name="name" required defaultValue={memberDraft.name ?? ""} />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setMemberDraft(null)}>
                {t("取消")}
              </button>
              <button className="primary-button" disabled={busy}>
                {t("保存成员")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
