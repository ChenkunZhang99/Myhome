"use client";

import { useEffect } from "react";
import { redeemLoginToken, takeLoginTokenFromUrl } from "./account";

/**
 * 处理邮件登录链接的落地。
 *
 * 链接形如 /?login=xxx，用户从收件箱点进来时落在首页，设置面板是关着的。
 * 所以兑换不能写在设置面板里——那样只有主动打开设置的人才会登录成功。
 * 这个组件不渲染任何东西，只负责在页面挂载时把令牌换成会话。
 *
 * 换成功后整页重新加载：所有数据都是按住户取的，不重新拉就还是上一个身份的内容。
 */
export function LoginLanding({ notify }: { notify: (message: string) => void }) {
  useEffect(() => {
    const token = takeLoginTokenFromUrl();
    if (!token) return;
    let cancelled = false;
    async function redeem() {
      try {
        await redeemLoginToken(token);
        if (cancelled) return;
        window.location.reload();
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : "登录失败");
      }
    }
    void redeem();
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次，令牌取出后地址栏里就没有了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
