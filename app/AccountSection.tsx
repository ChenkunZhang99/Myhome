"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAppSettings } from "./AppSettings";
import {
  AccountState,
  fetchAccount,
  registerWithPassword,
  requestLoginLink,
  savePassword,
  signedOut,
  signInWithPassword,
  signOut,
} from "./account";
import { peekStashedInvite } from "./householdAccounts";

/**
 * 账号区块。
 *
 * 三条路并存：
 *  - 注册：第一次来的人自己定一个密码，全程不经过邮箱
 *  - 密码：设过就能直接进，日常最省事
 *  - 邮箱一次性链接：不需要记住任何东西，同时也是「忘记密码」的出口
 *
 * 之所以没有单独的重置密码流程，是因为邮箱链接本来就是：能收到这个邮箱的信，
 * 就能登录，登录之后就能改密码。再造一条一模一样的路只是多一处会出错的地方。
 *
 * 但这条退路依赖发信服务。没配的时候它不存在，界面上就必须承认这件事：
 * 那种部署上密码一旦丢了就真的进不来了，而且同一个邮箱也不能重新注册。
 * 与其画一扇打不开的门让人一直敲，不如提前说清楚。
 *
 * 本地没有配置发信服务时后端会把链接原样返回，界面直接显示出来，
 * 这样 clone 下来的人不需要真实邮箱也能走完整个流程。
 */
export function AccountSection({ notify }: { notify: (message: string) => void }) {
  const { t } = useAppSettings();
  const [account, setAccount] = useState<AccountState>(signedOut);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState("");
  // 回头客占多数，默认停在密码登录；第一次来的人点「注册」。
  const [method, setMethod] = useState<"register" | "password" | "link">("password");
  const [confirm, setConfirm] = useState("");
  const [newPassword, setNewPassword] = useState("");

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

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setDevLink("");
    try {
      const { delivered, link } = await requestLoginLink(email.trim());
      if (delivered === "console" && link) {
        setDevLink(link);
        notify(t("本地未配置发信服务，登录链接显示在下方"));
      } else if (delivered === "console") {
        // 对外部署且没配发信：链接只在服务日志里，界面上拿不到，
        // 说清楚去哪儿找，别让人对着一个没反应的按钮猜。
        notify(t("这个部署还没配置发信服务，登录链接只写进了服务日志"));
      } else {
        notify(t("登录链接已发送，请查收邮件"));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : t("登录链接发送失败"));
    } finally {
      setBusy(false);
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 两遍不一致就地拦下。这个部署的发信服务没配，密码打错一个字母
    // 意味着既登不进去、也收不到重置链接——确认这一步在这里不是多余的。
    if (password !== confirm) {
      notify(t("两次输入的密码不一样"));
      return;
    }
    setBusy(true);
    try {
      // 令牌由 LoginLanding 在落地时存好。只看不取——真正的兑换（加入哪个家）
      // 发生在注册成功、页面重载之后，那时候才知道是谁接受了。
      await registerWithPassword(email.trim(), password, peekStashedInvite());
      window.location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("注册失败"));
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await signInWithPassword(email.trim(), password);
      // 数据按住户取，登录后整页重来最省事，也不会残留登录前的空状态。
      window.location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("登录失败"));
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const has = await savePassword(newPassword);
      setAccount((state) => ({ ...state, hasPassword: has }));
      setNewPassword("");
      notify(t("密码已保存"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("密码保存失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removePassword() {
    setBusy(true);
    try {
      await savePassword(null);
      setAccount((state) => ({ ...state, hasPassword: false }));
      notify(t("已改为只用邮箱链接登录"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("密码保存失败"));
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

        <form onSubmit={changePassword} className="password-block">
          <label className="field full">
            <span>{account.hasPassword ? t("修改密码") : t("设置密码")}</span>
            <input
              type="password"
              value={newPassword}
              autoComplete="new-password"
              placeholder={t("至少 8 位")}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <p className="settings-note">
            {account.hasPassword
              ? t("设了密码之后仍然可以用邮箱链接登录，密码忘了就走那条路。")
              : t("设一个密码，以后可以直接用邮箱加密码登录，不用每次去收邮件。")}
          </p>
          <div className="modal-actions">
            {account.hasPassword && (
              <button type="button" className="secondary-button" disabled={busy} onClick={removePassword}>
                {t("取消密码")}
              </button>
            )}
            <button className="primary-button" disabled={busy || newPassword.length < 8}>
              {busy ? t("处理中…") : t("保存密码")}
            </button>
          </div>
        </form>

        <div className="modal-actions">
          <button type="button" className="secondary-button danger" disabled={busy} onClick={leave}>
            {t("退出登录")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <strong>{t("账号")}</strong>
      <div className="method-switch" role="group" aria-label={t("登录方式")}>
        <button
          type="button"
          className={method === "register" ? "active" : ""}
          aria-pressed={method === "register"}
          onClick={() => setMethod("register")}
        >
          {t("注册")}
        </button>
        <button
          type="button"
          className={method === "password" ? "active" : ""}
          aria-pressed={method === "password"}
          onClick={() => setMethod("password")}
        >
          {t("密码登录")}
        </button>
        {account.canEmail && (
          <button
            type="button"
            className={method === "link" ? "active" : ""}
            aria-pressed={method === "link"}
            onClick={() => setMethod("link")}
          >
            {t("邮箱链接")}
          </button>
        )}
      </div>

      {method === "register" ? (
        <form onSubmit={register}>
          <p className="settings-note">{t("用邮箱和一个自己定的密码开号。")}</p>
          {!account.canEmail && (
            <p className="settings-note warn">
              {t(
                "这个站点还没有配置发信服务：密码丢了没法自助找回，同一个邮箱也不能重新注册。请把密码记牢。",
              )}
            </p>
          )}
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
          <label className="field full">
            <span>{t("设置密码")}</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={t("至少 8 位")}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field full">
            <span>{t("再输一遍")}</span>
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button className="primary-button" disabled={busy || !email.trim() || password.length < 8}>
              {busy ? t("处理中…") : t("注册并登录")}
            </button>
          </div>
        </form>
      ) : method === "password" ? (
        <form onSubmit={signIn}>
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
          <label className="field full">
            <span>{t("密码")}</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p className="settings-note">
            {account.canEmail
              ? t("第一次来请点「注册」；忘了密码走「邮箱链接」。")
              : t("第一次来请点「注册」。这个站点没有配置发信服务，密码丢了找不回来。")}
          </p>
          <div className="modal-actions">
            <button className="primary-button" disabled={busy || !email.trim() || !password}>
              {busy ? t("处理中…") : t("登录")}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={sendLink}>
          <p className="settings-note">{t("填写邮箱，我们会发一条一次性链接。忘了密码也走这里。")}</p>
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
      )}
    </div>
  );
}
