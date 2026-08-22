"use client";

import { useEffect } from "react";
import { redeemLoginToken, takeLoginTokenFromUrl } from "./account";
import { acceptInvite, takeInviteTokenFromUrl } from "./householdAccounts";

/** 邀请令牌要跨过一次登录才能兑换，先存着。会话级，关掉标签页就没了。 */
const INVITE_KEY = "hsp.pendingInvite";

function stash(token: string) {
  try {
    window.sessionStorage.setItem(INVITE_KEY, token);
  } catch {
    /* 隐私设置禁用了存储，那这次邀请就得在登录后重新点一次链接 */
  }
}

function takeStashed() {
  try {
    const token = window.sessionStorage.getItem(INVITE_KEY) ?? "";
    if (token) window.sessionStorage.removeItem(INVITE_KEY);
    return token;
  } catch {
    return "";
  }
}

/**
 * 处理从链接落地的两件事：邮件登录，和家庭邀请。
 *
 * 两个链接都是用户从收件箱或聊天窗口点进来的，落在首页，设置面板是关着的。
 * 所以兑换不能写在设置面板里——那样只有主动打开设置的人才会成功。
 * 这个组件不渲染任何东西，只在挂载时把地址栏里的令牌处理掉。
 *
 * 邀请比登录多一层：点链接的人可能还没登录。那就先把令牌存进 sessionStorage，
 * 等他用自己的邮箱登录之后再兑换——这样「先登录再入伙」和「先入伙」是同一条路。
 */
export function LoginLanding({ notify }: { notify: (message: string) => void }) {
  useEffect(() => {
    const invite = takeInviteTokenFromUrl();
    if (invite) stash(invite);
    const loginToken = takeLoginTokenFromUrl();
    let cancelled = false;

    async function run() {
      try {
        if (loginToken) {
          await redeemLoginToken(loginToken);
          if (cancelled) return;
          // 登录成功后如果手上还有邀请，先入伙再刷新，省掉一次整页重载。
          await joinIfInvited();
          window.location.reload();
          return;
        }
        await joinIfInvited({ reloadOnSuccess: true });
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : "登录失败");
      }
    }

    async function joinIfInvited({ reloadOnSuccess = false } = {}) {
      const token = takeStashed();
      if (!token) return;
      try {
        await acceptInvite(token);
      } catch (error) {
        const failed = error as Error & { needsConfirm?: boolean };
        if (failed.needsConfirm) {
          // 换家之后原来的库存看不到了。这一步不可逆，必须问过本人。
          if (!window.confirm(failed.message)) return;
          await acceptInvite(token, true);
        } else if (/请先登录/.test(failed.message)) {
          // 还没登录：把令牌放回去，等登录完再兑换。
          stash(token);
          return;
        } else {
          throw failed;
        }
      }
      if (cancelled) return;
      notify("已加入家庭");
      if (reloadOnSuccess) window.location.reload();
    }

    void run();
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次，令牌取出后地址栏里就没有了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
