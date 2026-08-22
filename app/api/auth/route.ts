import { findOrCreateAccount } from "../_shared/accounts";
import { currentAccount } from "../_shared/household";
import { failure, UserFacingError, withRoute } from "../_shared/observability";
import { ensureSchema } from "../_shared/schema";
import {
  clearedSessionCookie,
  issueLoginToken,
  issueSessionToken,
  normalizeEmail,
  purgeExpiredSessions,
  readSession,
  redeemLoginToken,
  revokeSession,
  sessionCookie,
  SESSION_COOKIE,
} from "../_shared/session";
import { deliverLoginLink } from "../_shared/mailer";

/** 谁登录了。前端靠它决定显示登录页还是应用本体。 */
export const GET = withRoute("auth", async (request: Request) => {
  try {
    const account = await currentAccount(request);
    return Response.json({ signedIn: Boolean(account), email: account?.email ?? null });
  } catch (error) {
    return failure("auth", error, "登录状态暂时无法读取", 500);
  }
});

/**
 * 请求登录链接，或用链接里的令牌换会话。
 *
 * 不返回「这个邮箱是否已注册」——那会让人可以拿这个接口枚举用户。
 * 无论邮箱是否存在，回应都一样。
 */
export const POST = withRoute("auth", async (request: Request) => {
  try {
    await ensureSchema();
    const payload = (await request.json()) as { action?: string; email?: string; token?: string };

    if (payload.action === "signOut") {
      const cookie = request.headers.get("cookie") ?? "";
      const token = cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
        ?.slice(SESSION_COOKIE.length + 1);
      if (token) await revokeSession(decodeURIComponent(token));
      return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
    }

    if (payload.action === "redeem") {
      const token = String(payload.token ?? "").trim();
      const userId = await redeemLoginToken(token);
      if (!userId) throw new UserFacingError("这个登录链接已经用过或已过期，请重新获取", 401);
      const session = await issueSessionToken(userId);
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(session) } });
    }

    // 默认动作：请求登录链接
    const email = normalizeEmail(payload.email);
    await purgeExpiredSessions();
    const account = await findOrCreateAccount(email);
    const token = await issueLoginToken(account.id);
    const delivery = await deliverLoginLink(request, email, token);
    return Response.json({ ok: true, ...delivery });
  } catch (error) {
    return failure("auth", error, "登录暂时不可用", 500);
  }
});

/** 校验会话是否仍然有效，用于前端在长时间挂起后自查。 */
export const PATCH = withRoute("auth", async (request: Request) => {
  try {
    const cookie = request.headers.get("cookie") ?? "";
    const raw = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const userId = raw ? await readSession(decodeURIComponent(raw)) : null;
    return Response.json({ valid: Boolean(userId) });
  } catch (error) {
    return failure("auth", error, "登录状态暂时无法校验", 500);
  }
});
