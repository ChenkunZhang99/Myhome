"use client";

import { useEffect } from "react";
import { redeemLoginToken, takeLoginTokenFromUrl } from "./account";
import {
  acceptInvite,
  peekStashedInvite,
  stashInvite,
  takeInviteTokenFromUrl,
  takeStashedInvite,
} from "./householdAccounts";

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
    if (invite) stashInvite(invite);
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

    /**
     * 先看一眼，兑换成功了才清。
     *
     * 不能一上来就取走：还没登录的人在这里必然失败一次，而在他去填注册表单的
     * 那几十秒里，令牌得一直待在原处——注册表单要拿它当「我确实收到了邀请」的凭据。
     * 取走再放回去中间有个窗口期，窗口里注册就成了「没有邀请」。
     */
    async function joinIfInvited({ reloadOnSuccess = false } = {}) {
      const token = peekStashedInvite();
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
          // 还没登录：原样留着，等注册或登录完再兑换。
          return;
        } else {
          throw failed;
        }
      }
      // 兑换是一次性的，成功之后才把它从暂存里划掉。
      takeStashedInvite();
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
