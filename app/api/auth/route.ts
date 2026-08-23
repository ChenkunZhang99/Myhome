import {
  accountByEmail,
  accountCount,
  clearLoginFailures,
  findOrCreateAccount,
  recordLoginFailure,
  setAccountPassword,
} from "../_shared/accounts";
import { hasUsableInvite, inviteMatches } from "../_shared/invites";
import {
  assertPasswordAllowed,
  burnVerificationTime,
  hashPassword,
  verifyPassword,
} from "../_shared/password";
import { currentAccount, loginRequired } from "../_shared/household";
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
    // 只回布尔值。哈希本身、盐、轮数都不该出现在任何响应里。
    const detail = account ? await accountByEmail(account.email) : null;
    return Response.json({
      signedIn: Boolean(account),
      email: account?.email ?? null,
      hasPassword: Boolean(detail?.passwordHash),
      required: loginRequired(),
    });
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
    const payload = (await request.json()) as {
      action?: string;
      email?: string;
      token?: string;
      password?: string | null;
    };

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

    if (payload.action === "password") {
      return await signInWithPassword(payload);
    }

    if (payload.action === "register") {
      return await registerWithPassword(payload);
    }

    if (payload.action === "setPassword") {
      const account = await currentAccount(request);
      // 改密码必须已经登录。没有「凭旧密码改密码」这条路——想改先登录，
      // 密码忘了就走邮箱链接，那条路本来就是重置流程。
      if (!account) throw new UserFacingError("请先登录后再设置密码", 401);
      if (payload.password === null) {
        await setAccountPassword(account.id, null);
        return Response.json({ ok: true, hasPassword: false });
      }
      const password = assertPasswordAllowed(payload.password);
      await setAccountPassword(account.id, await hashPassword(password));
      return Response.json({ ok: true, hasPassword: true });
    }

    // 默认动作：请求登录链接
    const email = normalizeEmail(payload.email);
    await purgeExpiredSessions();
    await assertMayRegister(email);
    const account = await findOrCreateAccount(email);
    const token = await issueLoginToken(account.id);
    const delivery = await deliverLoginLink(request, email, token);
    return Response.json({ ok: true, ...delivery });
  } catch (error) {
    return failure("auth", error, "登录暂时不可用", 500);
  }
});

/**
 * 这个邮箱可不可以在这里开一个新账号。
 *
 * 请求登录链接的那一刻账号就建出来了，所以闸门必须在这里，不能等到兑换的时候。
 *
 * 放行的三种情况：
 *  1. 账号已经存在——那是登录，不是注册
 *  2. 一个账号都还没有——第一个人得能进来，否则部署完谁也开不了门
 *  3. 有一条还没被用掉的邀请在等他
 *
 * 没开强制登录时完全不拦：那是单机自用的模式，clone 下来跑 pnpm dev 不该先要一封邀请。
 *
 * 不这样做的后果很具体：任何人输个邮箱就能在你的部署上注册，
 * 然后用掉你配在服务端的 OpenAI 额度。
 */
async function assertMayRegister(email: string) {
  if (!loginRequired()) return;
  if (await accountByEmail(email)) return;
  if ((await accountCount()) === 0) return;
  if (await hasUsableInvite(email)) return;
  // 不说「这个邮箱没注册过」——那等于告诉对方哪些邮箱是注册过的。
  throw new UserFacingError("这个站点不接受自助注册，请让家里人给你发一条邀请链接", 403);
}
/**
 * 邮箱 + 密码直接开号。
 *
 * 有这条路是因为这个部署没有发信服务：被邀请的人拿到链接也收不到登录邮件，
 * 链接只写进了服务日志。让人在页面上自己定一个密码，是不依赖任何外部服务
 * 就能把人放进来的唯一办法。
 *
 * 门还是同一道门——assertMayRegister，和邮箱链接那条路共用一个判断，
 * 不因为换了个入口就松一格。
 *
 * 已经存在的邮箱一律拒绝：这里是「开新账号」，不是「改密码」。
 * 允许它意味着任何拿到一条不绑邮箱的邀请的人，都能给别人的邮箱设一个
 * 自己知道的密码，然后用它登进去。改密码要先登录，那条路在 setPassword。
 *
 * 两步的顺序是有讲究的：先过邀请这一关，再查邮箱在不在。反过来的话，
 * 这个接口对谁都能回答「这个邮箱注册过没有」，成了不要凭据的邮箱枚举器。
 */
async function registerWithPassword(payload: { email?: string; password?: string | null; invite?: string }) {
  const email = normalizeEmail(payload.email);
  const password = assertPasswordAllowed(payload.password);
  await assertMayRegister(email);
  await assertInviteInHand(email, String(payload.invite ?? "").trim());
  if (await accountByEmail(email)) throw new UserFacingError("这个邮箱已经注册过了，请直接用密码登录", 409);

  const account = await findOrCreateAccount(email);
  await setAccountPassword(account.id, await hashPassword(password));
  await purgeExpiredSessions();
  const session = await issueSessionToken(account.id);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(session) } });
}

/**
 * 密码注册额外要求：手里真的攥着那条邀请。
 *
 * assertMayRegister 用 hasUsableInvite，它只问「有没有一条还能用的邀请在等这个邮箱」。
 * 不绑邮箱的邀请对任何邮箱都成立，于是只要家里挂着一条开放邀请没被用掉，
 * 这个问题对陌生人也回答「可以」。
 *
 * 邮箱链接那条路上还有第二道锁：链接寄到收件箱，陌生人拿不到。密码注册把那道锁
 * 拆了——这正是加它的目的，因为这个部署根本没有发信服务。锁拆了就得在别处补上，
 * 补的就是这里：凭据从「能收到那封信」换成「手里有那个令牌」。
 *
 * 少了这一段，一条挂在那里的开放邀请等于对全网敞开注册，
 * 而陌生人注册的第一件事就是花掉配在服务端的 OpenAI 额度。
 */
async function assertInviteInHand(email: string, token: string) {
  if (!loginRequired()) return;
  // 第一个人手上不可能有邀请——没人能发给他。这条和 assertMayRegister 里那条是同一件事。
  if ((await accountCount()) === 0) return;
  if (await inviteMatches(token, email)) return;
  throw new UserFacingError("请用家里人发给你的那条邀请链接打开页面，再在这里注册", 403);
}

/** 连续失败几次就锁。5 次是个折中：手滑几次不至于被关在门外，暴力破解又跑不起来。 */
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/**
 * 邮箱 + 密码登录。
 *
 * 所有失败路径都回同一句话、也都花掉差不多的时间。
 * 分别提示「查无此人」和「密码错误」，等于把这个接口变成邮箱枚举器。
 */
async function signInWithPassword(payload: { email?: string; password?: string | null }) {
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";
  const rejected = new UserFacingError("邮箱或密码不对", 401);

  const account = await accountByEmail(email);
  if (!account?.passwordHash) {
    // 账号不存在，或者存在但只用邮箱链接登录。两种情况对外表现必须一致。
    await burnVerificationTime();
    throw rejected;
  }

  if (account.lockedUntil && account.lockedUntil > new Date().toISOString()) {
    throw new UserFacingError(`密码错误次数过多，请 ${LOCK_MINUTES} 分钟后再试，或改用邮箱链接登录`, 429);
  }

  if (!(await verifyPassword(password, account.passwordHash))) {
    const attempts = Number(account.failedLogins ?? 0) + 1;
    const lockedUntil =
      attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    await recordLoginFailure(account.id, lockedUntil);
    throw rejected;
  }

  await clearLoginFailures(account.id);
  await purgeExpiredSessions();
  const session = await issueSessionToken(account.id);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(session) } });
}

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
