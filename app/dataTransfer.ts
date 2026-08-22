"use client";

import { readJson } from "./apiClient";

export type StoredSnapshot = { key: string; size: number; at: string };

export async function fetchSnapshots(): Promise<StoredSnapshot[]> {
  const response = await fetch("/api/backup?list=1");
  const result = await readJson<{ snapshots: StoredSnapshot[] }>(response);
  if (!response.ok) throw new Error(result.error || "读不到自动备份");
  return result.snapshots ?? [];
}

export function snapshotUrl(key: string) {
  return `/api/backup?snapshot=${encodeURIComponent(key)}`;
}

export async function importSnapshot(mode: "merge" | "replace", snapshot: unknown) {
  const response = await fetch("/api/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, snapshot }),
  });
  const result = await readJson<{ counts: Record<string, number> }>(response);
  if (!response.ok) throw new Error(result.error || "导入失败");
  return result.counts ?? {};
}
