"use client";

import { readJson } from "./apiClient";

/**
 * 家庭成员账号。
 *
 * 和 household_members（做饭、点菜用的家庭成员称呼）不是一回事——
 * 这里的每一条都对应一个能登录的账号。
 */

export type HouseholdMemberAccount = {
  id: string;
  email: string;
  role: "owner" | "member";
  createdAt: string;
  lastSeenAt: string | null;
};

export type PendingInvite = { tokenHash: string; email: string | null; expiresAt: string };

export type HouseholdAccounts = {
  role: "owner" | "member";
  me: string;
  members: HouseholdMemberAccount[];
  invites: PendingInvite[];
};

export const emptyHousehold: HouseholdAccounts = { role: "member", me: "", members: [], invites: [] };

export async function fetchHouseholdAccounts(): Promise<HouseholdAccounts> {
  const response = await fetch("/api/household");
  const result = await readJson<HouseholdAccounts>(response);
  if (!response.ok) throw new Error(result.error || "家庭成员暂时读不出来");
  return {
    role: result.role ?? "member",
    me: result.me ?? "",
    members: result.members ?? [],
    invites: result.invites ?? [],
  };
}

async function post<T>(body: Record<string, unknown>) {
  const response = await fetch("/api/household", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readJson<T & { error?: string; needsConfirm?: boolean }>(response);
  if (!response.ok) {
    const error = new Error(result.error || "操作没有完成") as Error & { needsConfirm?: boolean };
    // 409 不是失败，是「需要你确认一件会有后果的事」。抛出去时带上这个标记，
    // 调用方才能弹确认框而不是报错。
    error.needsConfirm = Boolean(result.needsConfirm);
    throw error;
  }
  return result;
}

/** 邮箱留空表示谁拿到链接都能加入；填了就只有那个邮箱能用。 */
export function inviteToHousehold(email: string) {
  return post<{ link: string; expiresAt: string }>({ action: "invite", email });
}

export function acceptInvite(token: string, confirm = false) {
  return post<Record<string, never>>({ action: "accept", token, confirm });
}

export function revokeInvite(tokenHash: string) {
  return post<Record<string, never>>({ action: "revokeInvite", tokenHash });
}

export function promoteMember(userId: string) {
  return post<Record<string, never>>({ action: "promote", userId });
}

export function removeMember(userId: string) {
  return post<Record<string, never>>({ action: "remove", userId });
}

export function leaveHousehold() {
  return post<Record<string, never>>({ action: "leave" });
}

/**
 * 邀请链接形如 /?invite=xxx。取出令牌并把它从地址栏抹掉——
 * 和登录链接同样的道理，没必要留在浏览历史里。
 */
export function takeInviteTokenFromUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("invite")?.trim() ?? "";
  if (!token) return "";
  url.searchParams.delete("invite");
  window.history.replaceState(null, "", url.toString());
  return token;
}
