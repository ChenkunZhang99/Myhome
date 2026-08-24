"use client";

import { Icon } from "./Icon";
import { HouseholdSwitcher } from "./HouseholdSwitcher";
import { useAppSettings } from "./AppSettings";

export type AppView = "overview" | "inventory" | "flyers" | "recipes" | "budget";

const links: { href: string; view: AppView; icon: "home" | "inventory" | "deals" | "recipes" | "budget"; label: string }[] =
  [
    { href: "/", view: "overview", icon: "home", label: "总览" },
    { href: "/inventory", view: "inventory", icon: "inventory", label: "家庭库存" },
    { href: "/flyers", view: "flyers", icon: "deals", label: "Flyer 优惠" },
    { href: "/#recipes", view: "recipes", icon: "recipes", label: "本周菜谱" },
    { href: "/#budget", view: "budget", icon: "budget", label: "预算记录" },
  ];

export function AppNav({
  active,
  railed,
  onToggleRail,
  notify,
  onAdd,
}: {
  active: AppView;
  railed: boolean;
  onToggleRail: () => void;
  notify: (message: string) => void;
  onAdd: () => void;
}) {
  const { t } = useAppSettings();

  return (
    <>
      <aside className="sidebar" aria-label={t("主要导航")}>
        <button
          type="button"
          className="rail-toggle"
          onClick={onToggleRail}
          aria-expanded={!railed}
          aria-label={railed ? t("展开侧边栏") : t("收起侧边栏")}
          title={railed ? t("展开侧边栏") : t("收起侧边栏")}
        >
          {railed ? "»" : "«"}
        </button>
        <a href="/" className="brand" aria-label={t("返回首页")}>
          <span className="brand-mark">{t("家")}</span>
          <span className="nav-label">{t("家里有数")}</span>
        </a>
        <nav>
          {links.map((item) => (
            <a
              key={item.view}
              href={item.href}
              className={active === item.view ? "nav-item active" : "nav-item"}
              aria-label={t(item.label)}
              title={t(item.label)}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{t(item.label)}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <a href="/#budget" className="nav-item" aria-label={t("家庭设置")} title={t("家庭设置")}>
          <Icon name="settings" />
          <span className="nav-label">{t("家庭设置")}</span>
        </a>
        <HouseholdSwitcher notify={notify} />
      </aside>
      <nav className="mobile-nav" aria-label={t("移动端导航")}>
        <a href="/" className={active === "overview" ? "active" : undefined}>
          <Icon name="home" />
          {t("总览")}
        </a>
        <a href="/inventory" className={active === "inventory" ? "active" : undefined}>
          <Icon name="inventory" />
          {t("库存")}
        </a>
        <button className="mobile-add" onClick={onAdd}>
          ＋
        </button>
        <a href="/flyers" className={active === "flyers" ? "active" : undefined}>
          <Icon name="deals" />
          {t("优惠")}
        </a>
        <a href="/#recipes">
          <Icon name="recipes" />
          {t("菜谱")}
        </a>
      </nav>
    </>
  );
}
