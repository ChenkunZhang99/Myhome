"use client";

import { useEffect, useState } from "react";
import { useAppSettings } from "../AppSettings";
import { LoginGate } from "../LoginGate";
import { LoginLanding } from "../LoginLanding";
import { clampPercent, daysInUse } from "../inventoryUsage";
import { readJson } from "../apiClient";

type InventoryItem = {
  id: string;
  name: string;
  category: string;
  location: string;
  precision: string;
  quantity: number;
  unit: string;
  remainingPercent: number;
  level: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  note?: string;
  demo?: boolean;
};

const categoryIcons: Record<string, string> = {
  蔬菜水果: "🥬", 肉类海鲜: "🥩", 乳品蛋类: "🥛", 米面粮油: "🌾",
  调味品: "🫙", 冷冻食品: "❄️", 零食饮料: "🥤", 清洁用品: "🧴",
  洗护用品: "🫧", 其他: "📦",
};

function remainingTone(percent: number) {
  if (percent <= 0) return "empty";
  if (percent <= 20) return "low";
  if (percent <= 50) return "medium";
  return "good";
}

export default function LowStockPage() {
  const { t, tv, tu, fmtNumber } = useAppSettings();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/inventory", { cache: "no-store" });
        const data = await readJson<{ items?: InventoryItem[] }>(response);
        if (!response.ok) throw new Error(data.error || t("读取失败"));
        setItems(
          (data.items ?? []).map((item) => ({
            ...item,
            remainingPercent: clampPercent(item.remainingPercent),
          })),
        );
      } catch {
        setToast(t("暂时无法连接在线库存"));
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

  const lowItems = items
    .filter(
      (item) =>
        item.remainingPercent <= 50 ||
        item.level === "偏少" ||
        item.level === "即将用完" ||
        item.level === "已用完" ||
        item.quantity === 0,
    )
    .sort((a, b) => a.remainingPercent - b.remainingPercent);

  return (
    <>
      <LoginLanding notify={setToast} />
      <LoginGate notify={setToast}>
        <main className="subpage">
          <header className="subpage-header">
            <a href="/" className="back-link">← {t("返回首页")}</a>
            <h1>↓ {t("需要补货")}</h1>
            <p className="subpage-desc">{t("以下物品库存偏少或已用完，建议尽快补货。")}</p>
          </header>

          {loading ? (
            <div className="subpage-loading">{t("正在加载…")}</div>
          ) : lowItems.length === 0 ? (
            <div className="subpage-empty">
              <span>✓</span>
              <h3>{t("所有物品库存充足")}</h3>
              <p>{t("目前没有需要补货的物品。")}</p>
            </div>
          ) : (
            <div className="subpage-list">
              {lowItems.map((item) => {
                const used = daysInUse(item);
                const emptied = item.quantity <= 0 || item.remainingPercent <= 0;
                return (
                  <article className="subpage-card" key={item.id}>
                    <span className={`item-gauge ${remainingTone(item.remainingPercent)}`}>
                      <span className="gauge-icon" aria-hidden="true">
                        {categoryIcons[item.category] ?? "📦"}
                      </span>
                      <span className="gauge-bar" aria-hidden="true">
                        <i style={{ width: `${item.remainingPercent}%` }} />
                      </span>
                      <b>{item.remainingPercent}%</b>
                    </span>
                    <div className="subpage-card-body">
                      <strong>{tv(item.name)}</strong>
                      <div className="subpage-card-meta">
                        <span>{tv(item.category)} · {tv(item.location)}</span>
                        <span>
                          {fmtNumber(item.quantity)} {tu(item.unit, item.quantity)}
                        </span>
                      </div>
                      <div className="subpage-card-tags">
                        <span className={`stock-tag ${emptied ? "empty" : "low"}`}>
                          {emptied ? tv("已用完") : tv(item.level)}
                        </span>
                        {used !== null && (
                          <span className="date-tag">{t("已购买 {days} 天", { days: used })}</span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </LoginGate>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
