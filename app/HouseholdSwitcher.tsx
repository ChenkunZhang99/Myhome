"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppSettings } from "./AppSettings";
import {
  createHousehold,
  emptyHousehold,
  fetchHouseholdAccounts,
  HouseholdAccounts,
  switchHousehold,
} from "./householdAccounts";

/**
 * 侧边栏底部的家庭切换器。
 *
 * 一个人可以同时属于几个家——自己家、爸妈家。切换的入口必须一直在视线里，
 * 因为「我现在看的是哪个家的库存」是每一次操作的前提：在爸妈家的库存里
 * 减掉一瓶酱油，是一个不容易发现、又不容易撤销的错误。
 *
 * 所以这里显示的是当前家的名字，而不是一个通用的「我的家庭」。
 *
 * 切换之后整页重载。页面上几乎每一块数据都按家取，逐个刷新既啰嗦又容易漏，
 * 而这个动作本来就不频繁。
 */
export function HouseholdSwitcher({ notify }: { notify: (message: string) => void }) {
  const { t, tv } = useAppSettings();
  const [data, setData] = useState<HouseholdAccounts>(emptyHousehold);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setData(await fetchHouseholdAccounts());
    } catch {
      // 没登录时这个接口 401，那就什么也不显示。
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function go(householdId: string) {
    if (householdId === data.householdId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await switchHousehold(householdId);
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

  if (!data.me) return null;

  const name = data.householdName || t("我们的家");
  const count = data.members.length;

  return (
    <div className="home-profile" ref={box}>
      <button
        type="button"
        className="home-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("当前在{name}，点击切换家庭", { name })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden="true">
          {name.slice(0, 1)}
        </span>
        <span className="nav-label">
          <strong>{tv(name)}</strong>
          <small>
            {t("{count} 人", { count })}
            {data.role === "owner" ? ` · ${t("管理者")}` : ` · ${t("成员")}`}
          </small>
        </span>
      </button>

      {open && (
        <div className="home-menu" role="menu">
          {data.households.map((household) => (
            <button
              key={household.id}
              type="button"
              role="menuitemradio"
              aria-checked={household.id === data.householdId}
              className={household.id === data.householdId ? "active" : ""}
              disabled={busy}
              onClick={() => void go(household.id)}
            >
              <b>{tv(household.name)}</b>
              <small>{household.role === "owner" ? t("管理者") : t("成员")}</small>
            </button>
          ))}
          <button type="button" role="menuitem" className="add" disabled={busy} onClick={addHousehold}>
            {t("＋ 新建一个家庭")}
          </button>
        </div>
      )}
    </div>
  );
}
