import { currentAccount } from "../_shared/household";
import { failure, UserFacingError, withRoute } from "../_shared/observability";
import {
  clearedSessionCookie,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
  sessionsForUser,
  sessionTokenFromRequest,
} from "../_shared/session";

async function requireAccount(request: Request) {
  const account = await currentAccount(request);
  if (!account) throw new UserFacingError("请先登录", 401);
  return account;
}

/** 当前账号的有效设备会话。一次性邮箱链接不出现在设备列表里。 */
export const GET = withRoute("sessions", async (request: Request) => {
  try {
    const account = await requireAccount(request);
    return Response.json({
      sessions: await sessionsForUser(account.id, sessionTokenFromRequest(request)),
    });
  } catch (error) {
    return failure("sessions", error, "登录设备暂时无法读取", 500);
  }
});

export const POST = withRoute("sessions", async (request: Request) => {
  try {
    const account = await requireAccount(request);
    const currentToken = sessionTokenFromRequest(request);
    const payload = (await request.json()) as { action?: string; sessionId?: string };

    if (payload.action === "revokeOthers") {
      await revokeOtherUserSessions(account.id, currentToken);
      return Response.json({ ok: true });
    }

    if (payload.action === "revokeAll") {
      await revokeAllUserSessions(account.id);
      return Response.json(
        { ok: true, signedOut: true },
        { headers: { "Set-Cookie": clearedSessionCookie() } },
      );
    }

    if (payload.action === "revoke") {
      const sessionId = String(payload.sessionId ?? "")
        .trim()
        .slice(0, 64);
      if (!sessionId) throw new UserFacingError("缺少登录设备编号", 400);
      const signedOut = await revokeUserSession(account.id, sessionId, currentToken);
      return Response.json(
        { ok: true, signedOut },
        signedOut ? { headers: { "Set-Cookie": clearedSessionCookie() } } : undefined,
      );
    }

    throw new UserFacingError("不认识这个操作", 400);
  } catch (error) {
    return failure("sessions", error, "登录设备暂时无法更新", 500);
  }
});
