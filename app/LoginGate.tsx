"use client";

import { ReactNode, useEffect, useState } from "react";
import { AccountState, fetchAccount } from "./account";
import { AccountSection } from "./AccountSection";
import { useAppSettings } from "./AppSettings";
import { localeLabels, locales } from "./i18n";

/**
 * 登录门。
 *
 * 只在服务端开启强制登录（REQUIRE_HOUSEHOLD=on）且当前没有会话时挡住应用。
 * 没开的时候完全透明——单机自用的人不需要为了看自己的库存先注册。
 *
 * 挡住的理由是体验而不是安全：真正的隔离在服务端，每条查询都带住户。
 * 这里只是避免让人看到一屏「请先登录」的错误提示。
 */
export function LoginGate({ children, notify }: { children: ReactNode; notify: (message: string) => void }) {
  const { t, locale, setLocale } = useAppSettings();
  const [account, setAccount] = useState<AccountState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAccount().then((state) => {
      if (!cancelled) setAccount(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 结果没回来之前先渲染应用：服务端渲染时永远问不到会话，
  // 在这里返回 null 会让首屏整个空掉，连没开强制登录的人也看不到东西。
  if (!account || !account.required || account.signedIn) return <>{children}</>;

  return (
    <div className="login-gate">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">{t("家")}</span>
          <strong>{t("家里有数")}</strong>
        </div>
        <p className="settings-note">{t("登录后才能看到这个家的库存、菜谱与采购记录。")}</p>
        <AccountSection notify={notify} />
        <div className="locale-switch" role="group" aria-label={t("语言")}>
          {locales.map((option) => (
            <button
              key={option}
              type="button"
              className={option === locale ? "active" : ""}
              aria-pressed={option === locale}
              onClick={() => setLocale(option)}
            >
              {localeLabels[option]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
