"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAppSettings } from "./AppSettings";
import { AccountState, fetchAccount, requestLoginLink, signedOut, signOut } from "./account";

/**
 * 账号区块。
 *
 * 登录用发到邮箱的一次性链接，这里不收密码，也就没有密码可泄露。
 * 本地没有配置发信服务时后端会把链接原样返回，界面直接显示出来，
 * 这样 clone 下来的人不需要真实邮箱也能走完整个流程。
 */
export function AccountSection({ notify }: { notify: (message: string) => void }) {
  const { t } = useAppSettings();
  const [account, setAccount] = useState<AccountState>(signedOut);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState("");

  useEffect(() => {
    // 令牌兑换由 LoginLanding 负责——它始终挂载，而这个面板只在用户点开时才存在。
    let cancelled = false;
    void fetchAccount().then((state) => {
      if (!cancelled) setAccount(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setDevLink("");
    try {
      const { delivered, link } = await requestLoginLink(email.trim());
      if (delivered === "console" && link) {
        setDevLink(link);
        notify(t("本地未配置发信服务，登录链接显示在下方"));
      } else {
        notify(t("登录链接已发送，请查收邮件"));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : t("登录链接发送失败"));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      await signOut();
      setAccount(signedOut);
      notify(t("已退出登录"));
      // 数据是按住户取的，退出后必须重新拉，否则页面上还留着上一个人的东西。
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  if (account.signedIn) {
    return (
      <div className="settings-section">
        <strong>{t("账号")}</strong>
        <div className="settings-status ok">
          <span />
          <p>
            <b>{t("已登录")}</b>
            <small>{account.email}</small>
          </p>
        </div>
        <p className="settings-note">{t("库存、菜谱和采购记录都归属于这个账号所在的家庭。")}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button danger" disabled={busy} onClick={leave}>
            {t("退出登录")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="settings-section">
      <strong>{t("账号")}</strong>
      <p className="settings-note">{t("填写邮箱，我们会发一条一次性登录链接。这个项目不保存密码。")}</p>
      <label className="field full">
        <span>{t("邮箱")}</span>
        <input
          type="email"
          value={email}
          autoComplete="email"
          spellCheck={false}
          placeholder="you@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {devLink && (
        <p className="settings-note">
          <a href={devLink}>{t("点这里完成登录")}</a>
        </p>
      )}
      <div className="modal-actions">
        <button className="primary-button" disabled={busy || !email.trim()}>
          {busy ? t("处理中…") : t("发送登录链接")}
        </button>
      </div>
    </form>
  );
}
