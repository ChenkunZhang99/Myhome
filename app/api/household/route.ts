import { env } from "cloudflare:workers";
import { accountsInHousehold, moveAccountToHousehold, ownerCount } from "../_shared/accounts";
import { currentAccount, ensureHouseholdMembers } from "../_shared/household";
import {
  createInvite,
  markInviteAccepted,
  pendingInvites,
  purgeExpiredInvites,
  redeemInvite,
  revokeInvite,
} from "../_shared/invites";
import { failure, UserFacingError, withRoute } from "../_shared/observability";
import { ensureSchema } from "../_shared/schema";
import { normalizeEmail } from "../_shared/session";

/**
 * 家庭成员账号。
 *
 * 一家人各用各的账号看同一份库存。做法是让多个 users 行指向同一个 household_id，
 * 而「加入哪个家」由已经在家里的人发邀请决定——不能让人在注册时自己填一个
 * household_id，那等于谁都能进别人家。
 *
 * 注意这里的「成员」和 household_members 表是两回事：那张表是做饭、点菜时
 * 用到的家庭成员称呼，家里的小孩和老人应该能被记进去，但不该因此必须注册邮箱。
 */

async function requireAccount(request: Request) {
  const account = await currentAccount(request);
  if (!account) throw new UserFacingError("请先登录", 401);
  return account;
}

/** 这个家里有没有攒下东西。换家之前要问一句，免得人稀里糊涂丢了自己的数据。 */
async function householdHasData(householdId: string) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM inventory_items WHERE household_id = ?1) +
       (SELECT COUNT(*) FROM recipe_catalog WHERE household_id = ?1) +
       (SELECT COUNT(*) FROM purchase_records WHERE household_id = ?1) AS total`,
  )
    .bind(householdId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0) > 0;
}

function inviteLink(request: Request, token: string) {
  const url = new URL(request.url);
  return `${url.origin}/?invite=${encodeURIComponent(token)}`;
}

/** 谁在这个家里，还有哪些邀请挂着没被接受。 */
export const GET = withRoute("household", async (request: Request) => {
  try {
    await ensureSchema();
    const account = await requireAccount(request);
    const [members, invites] = await Promise.all([
      accountsInHousehold(account.householdId),
      pendingInvites(account.householdId),
    ]);
    return Response.json({
      role: account.role,
      me: account.id,
      members,
      // 只回哈希。明文令牌在签发的那一刻就送出去了，服务端自己也读不回来。
      invites: invites.map((invite) => ({
        tokenHash: invite.tokenHash,
        email: invite.email,
        expiresAt: invite.expiresAt,
      })),
    });
  } catch (error) {
    return failure("household", error, "家庭成员暂时读不出来", 500);
  }
});

export const POST = withRoute("household", async (request: Request) => {
  try {
    await ensureSchema();
    const payload = (await request.json()) as {
      action?: string;
      email?: string;
      token?: string;
      tokenHash?: string;
      userId?: string;
      confirm?: boolean;
    };

    if (payload.action === "invite") return await invite(request, payload);
    if (payload.action === "accept") return await accept(request, payload);
    if (payload.action === "revokeInvite") return await revoke(request, payload);
    if (payload.action === "promote") return await promote(request, payload);
    if (payload.action === "remove") return await remove(request, payload);
    if (payload.action === "leave") return await leave(request);

    throw new UserFacingError("不认识这个操作", 400);
  } catch (error) {
    return failure("household", error, "操作暂时无法完成", 500);
  }
});

/**
 * 发一条邀请。
 *
 * 邮箱可以不填：不填就是「谁拿到链接谁能进」，方便直接发到家庭群里；
 * 填了就绑死，转错人也进不来。两种都有人需要，所以不替用户做选择。
 */
async function invite(request: Request, payload: { email?: string }) {
  const account = await requireAccount(request);
  await purgeExpiredInvites();
  const email = payload.email?.trim() ? normalizeEmail(payload.email) : null;
  const { token, expiresAt } = await createInvite(account.householdId, account.id, email);
  return Response.json({ ok: true, link: inviteLink(request, token), email, expiresAt });
}

/**
 * 接受邀请，加入对方的家。
 *
 * 如果自己原来那个家已经攒了东西，先挡一次：换家之后那些库存不会跟着走，
 * 也不会消失，但这个账号从此看不到它们了。让人确认过再放行。
 */
async function accept(request: Request, payload: { token?: string; confirm?: boolean }) {
  const account = await requireAccount(request);
  const { householdId, hash } = await redeemInvite(String(payload.token ?? "").trim(), account.email);

  if (householdId === account.householdId) throw new UserFacingError("你已经在这个家里了", 400);

  if (!payload.confirm && (await householdHasData(account.householdId))) {
    // 用一个专门的状态码让前端知道这不是失败，而是需要确认。
    return Response.json(
      {
        needsConfirm: true,
        error: "这个账号名下已经有库存和菜谱。加入新的家之后就看不到它们了，确定要继续吗？",
      },
      { status: 409 },
    );
  }

  // 最后一个 owner 走了，原来那个家就没人管了。数据还在，但谁也进不去——
  // 所以拦下来，让人先把家交给别人，或者用另一个账号接受邀请。
  if (account.role === "owner" && (await ownerCount(account.householdId)) === 1) {
    const others = await accountsInHousehold(account.householdId);
    if (others.length > 1)
      throw new UserFacingError("你是这个家目前唯一的管理者，先把管理权交给别人再离开", 400);
  }

  await moveAccountToHousehold(account.id, householdId, "member");
  await markInviteAccepted(hash, account.id);
  await ensureHouseholdMembers(householdId);
  return Response.json({ ok: true });
}

async function revoke(request: Request, payload: { tokenHash?: string }) {
  const account = await requireAccount(request);
  await revokeInvite(account.householdId, String(payload.tokenHash ?? ""));
  return Response.json({ ok: true });
}

/**
 * 把另一个成员也变成管理者。
 *
 * 上面几处「先把管理权交给别人」指的就是这个。没有它，唯一的 owner 就被
 * 永久困在这个家里——那是把安全检查变成了牢笼。
 */
async function promote(request: Request, payload: { userId?: string }) {
  const account = await requireAccount(request);
  if (account.role !== "owner") throw new UserFacingError("只有管理者可以设置管理者", 403);
  const userId = String(payload.userId ?? "");
  const members = await accountsInHousehold(account.householdId);
  if (!members.some((member) => member.id === userId)) throw new UserFacingError("这个人不在你的家里", 404);
  await moveAccountToHousehold(userId, account.householdId, "owner");
  return Response.json({ ok: true });
}

/**
 * 把一个成员请出去。他会拿到一个全新的空家，数据留在原处。
 *
 * 只有 owner 能做，而且不能踢自己——想走用 leave，那条路会检查这个家还有没有人管。
 */
async function remove(request: Request, payload: { userId?: string }) {
  const account = await requireAccount(request);
  if (account.role !== "owner") throw new UserFacingError("只有管理者可以移除成员", 403);
  const userId = String(payload.userId ?? "");
  if (userId === account.id) throw new UserFacingError("不能移除自己", 400);

  const members = await accountsInHousehold(account.householdId);
  if (!members.some((member) => member.id === userId)) throw new UserFacingError("这个人不在你的家里", 404);

  await moveAccountToHousehold(userId, `household-${crypto.randomUUID()}`, "owner");
  return Response.json({ ok: true });
}

/** 自己退出这个家，拿一个全新的空家。原来的数据留给还在家里的人。 */
async function leave(request: Request) {
  const account = await requireAccount(request);
  const members = await accountsInHousehold(account.householdId);
  if (members.length === 1) throw new UserFacingError("这个家只有你一个人，不需要退出", 400);
  if (account.role === "owner" && (await ownerCount(account.householdId)) === 1)
    throw new UserFacingError("你是这个家目前唯一的管理者，先把管理权交给别人再离开", 400);

  const householdId = `household-${crypto.randomUUID()}`;
  await moveAccountToHousehold(account.id, householdId, "owner");
  await ensureHouseholdMembers(householdId);
  return Response.json({ ok: true });
}
