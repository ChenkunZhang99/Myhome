import { env } from "cloudflare:workers";
import { loginRequired } from "./household";
import { UserFacingError } from "./observability";

/**
 * 登录链接的投递。
 *
 * 没有配置发信服务时不报错，而是把链接打到日志。单机模式下还会把它回给前端，
 * 这样 `clone 下来直接 pnpm dev` 这个特性能保住——本地跑不需要任何邮件账号。
 *
 * **但开了强制登录就绝不能这么做。** 那意味着这是一个对外可访问的部署，
 * 把明文链接回给浏览器等于：任何人输入你的邮箱，页面上就出现一条进你家的链接。
 * 那是彻底的认证绕过。这种部署下链接只进日志（wrangler tail 捞得到），
 * 想要正常收信就配 RESEND_API_KEY。
 *
 * 配置了 RESEND_API_KEY 之后自动切换成真实发信。选 Resend 是因为它就是一个
 * HTTPS 接口，Workers 里不需要 SMTP 客户端。换别家只要改这一个函数。
 */

type Delivery = { delivered: "email" | "console"; link?: string };

function loginLink(request: Request, token: string) {
  const url = new URL(request.url);
  return `${url.origin}/?login=${encodeURIComponent(token)}`;
}

function config() {
  const scoped = env as typeof env & { RESEND_API_KEY?: string; LOGIN_FROM_EMAIL?: string };
  return {
    apiKey: scoped.RESEND_API_KEY?.trim() ?? "",
    from: scoped.LOGIN_FROM_EMAIL?.trim() || "onboarding@resend.dev",
  };
}

export async function deliverLoginLink(request: Request, email: string, token: string): Promise<Delivery> {
  const link = loginLink(request, token);
  const { apiKey, from } = config();

  if (!apiKey) {
    console.warn(JSON.stringify({ at: new Date().toISOString(), scope: "auth", loginLink: link }));
    // 强制登录 = 对外部署。链接只留在日志里，绝不回给浏览器。
    if (loginRequired()) return { delivered: "console" };
    return { delivered: "console", link };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: email,
      subject: "登录家里有数",
      text: `点击下面的链接登录，15 分钟内有效：\n\n${link}\n\n如果不是你本人操作，忽略这封邮件即可。`,
    }),
  });
  if (!response.ok) {
    // 把服务商的原文留在日志里，对外只说没发出去。
    console.error(JSON.stringify({ at: new Date().toISOString(), scope: "auth", status: response.status }));
    throw new UserFacingError("登录邮件暂时发不出去，请稍后再试", 502);
  }
  return { delivered: "email" };
}
