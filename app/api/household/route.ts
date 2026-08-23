import {
  accountsInHousehold,
  addMembership,
  createHousehold,
  ensureHouseholdRow,
  householdsForUser,
  membershipRole,
  ownerCount,
  removeMembership,
  renameHousehold,
  setActiveHousehold,
  setMembershipRole,
} from "../_shared/accounts";
import { currentAccount, ensureHouseholdMembers, repointToAnyHousehold } from "../_shared/household";
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
 * 家庭：谁能进，进哪一个。
 *
 * 一个人可以属于多个家——自己家、爸妈家、合租的那个家。所以「谁能进哪个家」
 * 是一张多对多的表（household_memberships），而 users.household_id 退化成
 * 「我现在正在看哪个家」的指针。切换家庭就是改这个指针。
 *
 * 这里每一个会碰到某个 household_id 的动作，第一步都是 membershipRole()。
 * 少问一次，household_id 就成了请求里任填的参数，户与户之间那堵墙就没了。
 *
 * 注意「家庭成员账号」和 household_members 表是两回事：那张表是做饭、点菜时
 * 用的称呼，家里的小孩老人应该能被记进去，但不该因此必须注册一个邮箱。
 */

async function requireAccount(request: Request) {
  const account = await currentAccount(request);
  if (!account) throw new UserFacingError("请先登录", 401);
  return account;
}

/** 当前这个家里，我是不是管理者。改设置、发邀请、请人出去都要过这一关。 */
async function requireOwner(request: Request) {
  const account = await requireAccount(request);
  const role = await membershipRole(account.id, account.householdId);
  if (role !== "owner") throw new UserFacingError("只有这个家的管理者可以做这件事", 403);
  return account;
}

function inviteLink(request: Request, token: string) {
  const url = new URL(request.url);
  return `${url.origin}/?invite=${encodeURIComponent(token)}`;
}

function cleanName(value: unknown, fallback = "我们的家") {
  const name = String(value ?? "").trim();
  if (!name) return fallback;
  return name.slice(0, 40);
}

/** 我能进哪些家、现在在哪个家、这个家里有谁、还有哪些邀请挂着。 */
export const GET = withRoute("household", async (request: Request) => {
  try {
    await ensureSchema();
    const account = await requireAccount(request);
    await ensureHouseholdRow(account.householdId);
    const [households, members, invites] = await Promise.all([
      householdsForUser(account.id),
      accountsInHousehold(account.householdId),
      pendingInvites(account.householdId),
    ]);
    const active = households.find((household) => household.id === account.householdId);
    return Response.json({
      role: active?.role ?? account.role,
      me: account.id,
      householdId: account.householdId,
      householdName: active?.name ?? "我们的家",
      households,
      members,
      // 只回哈希。明文令牌在签发的那一刻就送出去了，服务端自己也读不回来。
      invites: invites.map((invite) => ({
        tokenHash: invite.tokenHash,
        email: invite.email,
        expiresAt: invite.expiresAt,
      })),
    });
  } catch (error) {
    return failure("household", error, "家庭信息暂时读不出来", 500);
  }
});

export const POST = withRoute("household", async (request: Request) => {
  try {
    await ensureSchema();
    const payload = (await request.json()) as {
      action?: string;
      email?: string;
      name?: string;
      token?: string;
      tokenHash?: string;
      householdId?: string;
      userId?: string;
    };

    if (payload.action === "create") return await create(request, payload);
    if (payload.action === "switch") return await switchTo(request, payload);
    if (payload.action === "rename") return await rename(request, payload);
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

/** 开一个新家，并且立刻切过去。空的，什么都没有——这正是新家该有的样子。 */
async function create(request: Request, payload: { name?: string }) {
  const account = await requireAccount(request);
  const householdId = await createHousehold(account.id, cleanName(payload.name));
  await ensureHouseholdMembers(householdId);
  await setActiveHousehold(account.id, householdId);
  return Response.json({ ok: true, householdId });
}

/**
 * 换到另一个家。
 *
 * 先验 membership 再改指针，顺序不能反：这个 householdId 是请求里带上来的，
 * 不验就等于让任何人填一个别人家的 id 就把那家的数据看个遍。
 */
async function switchTo(request: Request, payload: { householdId?: string }) {
  const account = await requireAccount(request);
  const householdId = String(payload.householdId ?? "").trim();
  if (!householdId) throw new UserFacingError("没说要切到哪个家", 400);
  if (!(await membershipRole(account.id, householdId))) throw new UserFacingError("你不在这个家里", 403);
  await setActiveHousehold(account.id, householdId);
  return Response.json({ ok: true, householdId });
}

async function rename(request: Request, payload: { name?: string }) {
  const account = await requireOwner(request);
  await renameHousehold(account.householdId, cleanName(payload.name));
  return Response.json({ ok: true });
}

/**
 * 发一条邀请。
 *
 * 邮箱可以不填：不填就是「谁拿到链接谁能进」，方便直接发到家庭群里；
 * 填了就绑死，转错人也进不来。两种都有人需要，所以不替用户做选择。
 *
 * 只有管理者能发。让普通成员也能发，等于家里任何一个人都可以把外人领进来，
 * 而这个家的库存、采购记录、菜谱对进来的人是全开的。
 */
async function invite(request: Request, payload: { email?: string }) {
  const account = await requireOwner(request);
  await purgeExpiredInvites();
  const email = payload.email?.trim() ? normalizeEmail(payload.email) : null;
  const { token, expiresAt } = await createInvite(account.householdId, account.id, email);
  return Response.json({ ok: true, link: inviteLink(request, token), email, expiresAt });
}

/**
 * 接受邀请，加入对方的家。
 *
 * 加入是「多一个家」，不是「换一个家」：原来那个家还在自己的列表里，数据一行不动。
 * 以前这里要弹一个「换家之后就看不到原来的东西了」的确认框，现在不需要了——
 * 那个后果本身已经不存在。
 */
async function accept(request: Request, payload: { token?: string }) {
  const account = await requireAccount(request);
  const { householdId, hash } = await redeemInvite(String(payload.token ?? "").trim(), account.email);

  if (await membershipRole(account.id, householdId)) throw new UserFacingError("你已经在这个家里了", 400);

  await ensureHouseholdRow(householdId);
  await addMembership(account.id, householdId, "member");
  await markInviteAccepted(hash, account.id);
  await ensureHouseholdMembers(householdId);
  // 刚加进来的家直接切过去，省得人还要自己找一遍。
  await setActiveHousehold(account.id, householdId);
  return Response.json({ ok: true, householdId });
}

async function revoke(request: Request, payload: { tokenHash?: string }) {
  const account = await requireOwner(request);
  await revokeInvite(account.householdId, String(payload.tokenHash ?? ""));
  return Response.json({ ok: true });
}

/**
 * 把另一个成员也变成管理者。
 *
 * 下面几处「先把管理权交给别人」指的就是这个。没有它，唯一的 owner 就被
 * 永久困在这个家里——那是把安全检查变成了牢笼。
 */
async function promote(request: Request, payload: { userId?: string }) {
  const account = await requireOwner(request);
  const userId = String(payload.userId ?? "");
  if (!(await membershipRole(userId, account.householdId)))
    throw new UserFacingError("这个人不在你的家里", 404);
  await setMembershipRole(userId, account.householdId, "owner");
  return Response.json({ ok: true });
}

/**
 * 把一个成员请出去。
 *
 * 去掉的是他进这个家的资格，家里的数据一行不动。
 * 还要把他的「当前正在看」挪走——那个指针如果还指着这里，
 * 资格没了他照样读得到，墙就白砌了。
 */
async function remove(request: Request, payload: { userId?: string }) {
  const account = await requireOwner(request);
  const userId = String(payload.userId ?? "");
  if (userId === account.id) throw new UserFacingError("不能移除自己，想走请用「退出这个家」", 400);
  if (!(await membershipRole(userId, account.householdId)))
    throw new UserFacingError("这个人不在你的家里", 404);

  await removeMembership(userId, account.householdId);
  await repointToAnyHousehold(userId, account.householdId);
  return Response.json({ ok: true });
}

/**
 * 自己退出这个家。数据留给还在家里的人。
 *
 * 最后一个管理者走了，这个家就没人管了——数据还在，但谁也改不了设置、
 * 再也发不出邀请。所以拦下来，先把管理权交给别人。
 */
async function leave(request: Request) {
  const account = await requireAccount(request);
  const role = await membershipRole(account.id, account.householdId);
  if (!role) throw new UserFacingError("你不在这个家里", 400);

  const members = await accountsInHousehold(account.householdId);
  if (members.length > 1 && role === "owner" && (await ownerCount(account.householdId)) === 1)
    throw new UserFacingError("你是这个家目前唯一的管理者，先把管理权交给别人再离开", 400);

  await removeMembership(account.id, account.householdId);
  const householdId = await repointToAnyHousehold(account.id, account.householdId);
  return Response.json({ ok: true, householdId });
}
