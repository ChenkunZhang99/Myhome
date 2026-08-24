"use client";

import { useEffect, useState } from "react";
import { useAppSettings } from "../AppSettings";
import { LoginGate } from "../LoginGate";
import { LoginLanding } from "../LoginLanding";
import { Icon } from "../Icon";
import { effectiveExpiry, daysInUse, clampPercent, type ShelfLifeInput } from "../inventoryUsage";
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
  openedDate?: string | null;
  openedShelfLifeDays?: number | null;
  note?: string;
  demo?: boolean;
};

type Translate = (text: string, vars?: Record<string, string | number>) => string;

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
  return { label, tone, fromOpening, days };
}

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

export default function ExpiringPage() {
  const { t, tv, tu, fmtNumber, fmtDate } = useAppSettings();
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

  const expiringItems = items
    .map((item) => ({ item, info: getExpiryInfo(item, t) }))
    .filter((entry): entry is { item: InventoryItem; info: NonNullable<ReturnType<typeof getExpiryInfo>> } =>
      entry.info?.tone === "warning" || entry.info?.tone === "danger",
    )
    .sort((a, b) => a.info.days - b.info.days);

  return (
    <>
      <LoginLanding notify={setToast} />
      <LoginGate notify={setToast}>
        <main className="subpage">
          <header className="subpage-header">
            <a href="/" className="back-link">← {t("返回首页")}</a>
            <h1>
              <Icon name="expiring" />
              {t("临期提醒")}
            </h1>
            <p className="subpage-desc">{t("以下物品将在 3 天内过期或已经过期，请尽快处理。")}</p>
          </header>

          {loading ? (
            <div className="subpage-loading">{t("正在加载…")}</div>
          ) : expiringItems.length === 0 ? (
            <div className="subpage-empty">
              <span>✓</span>
              <h3>{t("目前没有临期物品")}</h3>
              <p>{t("所有物品的保质期都很充裕。")}</p>
            </div>
          ) : (
            <div className="subpage-list">
              {expiringItems.map(({ item, info }) => {
                const used = daysInUse(item);
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
                        <span className={`expiry-tag ${info.tone}`}>{info.label}</span>
                        {info.fromOpening && (
                          <span className="opened-tag">{t("开封后推算")}</span>
                        )}
                        {item.expiryDate && (
                          <span className="date-tag">{t("保质期：{date}", { date: fmtDate(item.expiryDate) })}</span>
                        )}
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
