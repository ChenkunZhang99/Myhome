"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAppSettings } from "./AppSettings";
import {
  emptyHousehold,
  fetchHouseholdAccounts,
  HouseholdAccounts,
  inviteToHousehold,
  leaveHousehold,
  promoteMember,
  removeMember,
  revokeInvite,
} from "./householdAccounts";

/**
 * 家庭成员账号。
 *
 * 一家人各用各的账号，看的是同一份库存。加入靠邀请链接——不能让人在注册时
 * 自己填一个家庭编号，那等于谁都能进别人家。
 *
 * 这里的「成员」是能登录的账号，和做饭时用到的家庭成员称呼是两回事：
 * 家里的小孩和老人应该能被记成做饭的人、被点菜，但不该因此必须注册邮箱。
 */
export function HouseholdSection({ notify }: { notify: (message: string) => void }) {
  const { t } = useAppSettings();
  const [data, setData] = useState<HouseholdAccounts>(emptyHousehold);
  const [email, setEmail] = useState("");
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

  if (!loaded || !data.me) return null;

  const isOwner = data.role === "owner";
  const alone = data.members.length === 1;

  return (
    <div className="settings-section">
      <strong>{t("家庭账号")}</strong>
      <p className="settings-note">{t("家人用自己的账号登录，看到的是同一份库存、菜谱和采购记录。")}</p>

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
                    // 被移除的人会拿到一个全新的空家，这一步不可逆，问一句。
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

      {!alone && (
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("退出这个家？你会得到一个全新的空家，这里的数据留给其他人。")))
                void run(leaveHousehold, t("已退出这个家"));
            }}
          >
            {t("退出这个家")}
          </button>
        </div>
      )}
    </div>
  );
}
