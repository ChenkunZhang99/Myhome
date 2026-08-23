"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAppSettings } from "./AppSettings";
import {
  createHousehold,
  emptyHousehold,
  fetchHouseholdAccounts,
  HouseholdAccounts,
  inviteToHousehold,
  leaveHousehold,
  promoteMember,
  removeMember,
  renameHousehold,
  revokeInvite,
  switchHousehold,
} from "./householdAccounts";

/**
 * 当前这个家里有谁，以及怎么把人请进来。
 *
 * 一家人各用各的账号，看的是同一份库存。加入靠邀请链接——不能让人在注册时
 * 自己填一个家庭编号，那等于谁都能进别人家。
 *
 * 接受邀请是「多一个家」而不是「换一个家」：进来的人原来那个家还在，
 * 两边的数据谁也没动，他在切换器里来回切。
 *
 * 发邀请和改名字只有管理者能做。让普通成员也能发，等于家里任何一个人
 * 都可以把外人领进来，而这个家的库存、采购记录、菜谱对进来的人是全开的。
 *
 * 这里的「成员」是能登录的账号，和做饭时用到的家庭成员称呼是两回事：
 * 家里的小孩和老人应该能被记成做饭的人、被点菜，但不该因此必须注册邮箱。
 *
 * 切换家庭在侧边栏底部也有一个入口，但那一块在窄屏上是隐藏的——
 * 手机是这个应用最主要的使用场景（人在超市里），所以这里必须再放一份，
 * 否则手机用户根本没有办法换到另一个家。
 */
export function HouseholdSection({ notify }: { notify: (message: string) => void }) {
  const { t } = useAppSettings();
  const [data, setData] = useState<HouseholdAccounts>(emptyHousehold);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await fetchHouseholdAccounts());
    } catch {
      // 没登录时这个接口会 401。那种情况下整块不显示，不需要报错。
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // 规则想要框架级的数据加载（SWR 之类）；为这一个列表引入一整套数据层不划算。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      await reload();
      notify(done);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("操作没有完成"));
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await inviteToHousehold(email.trim());
      setLink(result.link);
      setEmail("");
      await reload();
      notify(t("邀请链接已生成，发给家人即可"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("邀请没有生成"));
    } finally {
      setBusy(false);
    }
  }

  async function go(householdId: string) {
    if (householdId === data.householdId) return;
    setBusy(true);
    try {
      await switchHousehold(householdId);
      // 页面上几乎每一块数据都按家取，逐个刷新既啰嗦又容易漏。
      window.location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("切换失败"));
      setBusy(false);
    }
  }

  async function addHousehold() {
    const name = window.prompt(t("新家庭叫什么名字？"), t("我的家"));
    if (name === null) return;
    setBusy(true);
    try {
      await createHousehold(name.trim() || t("我的家"));
      window.location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("新建失败"));
      setBusy(false);
    }
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(() => renameHousehold(name.trim()), t("家庭名称已更新"));
    setName("");
  }

  if (!loaded || !data.me) return null;

  const isOwner = data.role === "owner";
  // 只剩自己、而且没有别的家可去，那就没有「退出」这回事——退到哪儿去呢。
  const canLeave = data.members.length > 1 || data.households.length > 1;

  return (
    <>
      <div className="settings-section">
        <strong>{t("我的家庭")}</strong>
        <p className="settings-note">{t("一个账号可以属于多个家，各自的库存和记录互不相通。")}</p>
        <ul className="member-list">
          {data.households.map((household) => (
            <li key={household.id}>
              <span className="member-who">
                <b>{household.name}</b>
                <small>
                  {household.role === "owner" ? t("管理者") : t("成员")}
                  {household.id === data.householdId && ` · ${t("正在查看")}`}
                </small>
              </span>
              {household.id !== data.householdId && (
                <span className="member-actions">
                  <button type="button" disabled={busy} onClick={() => void go(household.id)}>
                    {t("切换过去")}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={addHousehold}>
            {t("＋ 新建一个家庭")}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <strong>{t("家庭账号")}</strong>
        <p className="settings-note">
          {t("你现在在「{name}」。家人用自己的账号登录，看到的是同一份库存、菜谱和采购记录。", {
            name: data.householdName,
          })}
        </p>

        {isOwner && (
          <form onSubmit={saveName}>
            <label className="field full">
              <span>{t("家庭名称")}</span>
              <input
                type="text"
                value={name}
                maxLength={40}
                placeholder={data.householdName}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="secondary-button" disabled={busy || !name.trim()}>
                {t("改名")}
              </button>
            </div>
          </form>
        )}

        <ul className="member-list">
          {data.members.map((member) => (
            <li key={member.id}>
              <span className="member-who">
                <b>{member.email}</b>
                <small>
                  {member.role === "owner" ? t("管理者") : t("成员")}
                  {member.id === data.me && ` · ${t("你")}`}
                </small>
              </span>
              {isOwner && member.id !== data.me && (
                <span className="member-actions">
                  {member.role !== "owner" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => promoteMember(member.id), t("已设为管理者"))}
                    >
                      {t("设为管理者")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      // 他会被弹回自己的其他家庭，这里的数据从此看不到。问一句再动手。
                      if (
                        window.confirm(
                          t("把 {email} 移出这个家？他将看不到这里的数据。", { email: member.email }),
                        )
                      )
                        void run(() => removeMember(member.id), t("已移出"));
                    }}
                  >
                    {t("移出")}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>

        {data.invites.length > 0 && (
          <ul className="member-list pending">
            {data.invites.map((invite) => (
              <li key={invite.tokenHash}>
                <span className="member-who">
                  <b>{invite.email || t("任何拿到链接的人")}</b>
                  <small>{t("邀请待接受")}</small>
                </span>
                <span className="member-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => revokeInvite(invite.tokenHash), t("邀请已撤回"))}
                  >
                    {t("撤回")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {!isOwner && <p className="settings-note">{t("只有这个家的管理者可以邀请新成员。")}</p>}

        {isOwner && (
          <form onSubmit={send} className="invite-form">
            <label className="field full">
              <span>{t("邀请家人")}</span>
              <input
                type="email"
                value={email}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("家人的邮箱（可留空）")}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <p className="settings-note">
              {t("填了邮箱就只有那个邮箱能加入；留空则谁拿到链接都能加入，七天后失效。")}
            </p>
            {link && (
              <p className="settings-note invite-link">
                <code>{link}</code>
              </p>
            )}
            <div className="modal-actions">
              <button className="primary-button" disabled={busy}>
                {busy ? t("处理中…") : t("生成邀请链接")}
              </button>
            </div>
          </form>
        )}

        {canLeave && (
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("退出这个家？之后就看不到这里的数据了。你的其他家庭不受影响。")))
                  void run(leaveHousehold, t("已退出这个家"));
              }}
            >
              {t("退出这个家")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
