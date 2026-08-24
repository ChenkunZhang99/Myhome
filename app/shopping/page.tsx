"use client";

import { useEffect, useState } from "react";
import { useAppSettings } from "../AppSettings";
import { LoginGate } from "../LoginGate";
import { LoginLanding } from "../LoginLanding";
import { readJson } from "../apiClient";

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

type Settings = {
  city: string;
  postalCode: string;
  foodBudget: number;
  householdBudget: number;
  maxStores: number;
  timezone: string;
};

type Spending = { since: string; food: number; household: number };

type PlannerData = {
  settings: Settings;
  shopping: ShoppingItem[];
  spending?: Spending;
};

const categoryIcons: Record<string, string> = {
  蔬菜水果: "🥬", 肉类海鲜: "🥩", 乳品蛋类: "🥛", 米面粮油: "🌾",
  调味品: "🫙", 冷冻食品: "❄️", 零食饮料: "🥤", 清洁用品: "🧴",
  洗护用品: "🫧", 其他: "📦",
};

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

export default function ShoppingPage() {
  const { t, tv } = useAppSettings();
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [spending, setSpending] = useState<Spending | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/planner", { cache: "no-store" });
        const data = await readJson<PlannerData>(response);
        if (!response.ok) throw new Error(data.error || t("读取失败"));
        setShopping(data.shopping ?? []);
        setSettings(data.settings ?? null);
        setSpending(data.spending ?? null);
      } catch {
        setToast(t("暂时无法连接采购数据"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const unchecked = shopping.filter((item) => !item.checked);
  const checked = shopping.filter((item) => item.checked);

  return (
    <>
      <LoginLanding notify={setToast} />
      <LoginGate notify={setToast}>
        <main className="subpage">
          <header className="subpage-header">
            <a href="/" className="back-link">← {t("返回首页")}</a>
            <h1>$ {t("采购计划")}</h1>
            <p className="subpage-desc">{t("查看购物清单与预算使用情况。")}</p>
          </header>

          {loading ? (
            <div className="subpage-loading">{t("正在加载…")}</div>
          ) : (
            <>
              {settings && spending && (
                <section className="subpage-budget">
                  <h2>{t("本周预算")}</h2>
                  <div className="budget-cards">
                    <div className="budget-card">
                      <span>{t("食品预算")}</span>
                      <strong>{money(settings.foodBudget)}</strong>
                      <small>{t("已花费 {amount}", { amount: money(spending.food) })}</small>
                      <div className="budget-bar">
                        <i style={{ width: `${Math.min(100, (spending.food / settings.foodBudget) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="budget-card">
                      <span>{t("日用预算")}</span>
                      <strong>{money(settings.householdBudget)}</strong>
                      <small>{t("已花费 {amount}", { amount: money(spending.household) })}</small>
                      <div className="budget-bar">
                        <i style={{ width: `${Math.min(100, (spending.household / settings.householdBudget) * 100)}%` }} />
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <section className="subpage-shopping">
                <h2>{t("购物清单")}{unchecked.length > 0 && ` (${unchecked.length})`}</h2>
                {shopping.length === 0 ? (
                  <div className="subpage-empty">
                    <span>📋</span>
                    <h3>{t("购物清单为空")}</h3>
                    <p>{t("回到首页的采购面板添加需要购买的物品。")}</p>
                  </div>
                ) : (
                  <>
                    {unchecked.length > 0 && (
                      <div className="subpage-list">
                        {unchecked.map((item) => (
                          <article className="subpage-card shopping-card" key={item.id}>
                            <span className="gauge-icon" aria-hidden="true">
                              {categoryIcons[item.category] ?? "📦"}
                            </span>
                            <div className="subpage-card-body">
                              <strong>{tv(item.name)}</strong>
                              <div className="subpage-card-meta">
                                <span>{tv(item.category)}</span>
                                <span>{item.quantity} {tv(item.unit)}</span>
                              </div>
                              <div className="subpage-card-tags">
                                <span className="source-tag">{tv(item.source)}</span>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    {checked.length > 0 && (
                      <>
                        <h3 className="checked-heading">{t("已购买")} ({checked.length})</h3>
                        <div className="subpage-list checked-list">
                          {checked.map((item) => (
                            <article className="subpage-card shopping-card done" key={item.id}>
                              <span className="gauge-icon" aria-hidden="true">✓</span>
                              <div className="subpage-card-body">
                                <strong>{tv(item.name)}</strong>
                                <div className="subpage-card-meta">
                                  <span>{tv(item.category)}</span>
                                  <span>{item.quantity} {tv(item.unit)}</span>
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </LoginGate>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
