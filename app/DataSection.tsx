"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { useAppSettings } from "./AppSettings";
import { fetchSnapshots, importSnapshot, snapshotUrl, type StoredSnapshot } from "./dataTransfer";
import { formatDateTime } from "./i18n";

/**
 * 数据的导出与导入。
 *
 * 导出是一个普通的 JSON 文件：没有专有格式、没有压缩。备份唯一重要的性质
 * 是「没有这个应用时也能被读懂」，所以宁可文件大一点。
 *
 * 导入分两种，界面上必须说清区别——它们的后果差得很远：
 *  - 合并：把文件里的物品加进来，现有的东西一件不动
 *  - 整份还原：先清空这个家，再按文件重建。删掉过的东西不会复活
 */
export function DataSection({ notify }: { notify: (message: string) => void }) {
  const { t, locale } = useAppSettings();
  const [busy, setBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);

  const reload = useCallback(async () => {
    try {
      setSnapshots(await fetchSnapshots());
    } catch {
      // 没登录或还没有过自动备份，这一块就不显示，不需要报错。
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  async function pick(event: ChangeEvent<HTMLInputElement>, mode: "merge" | "replace") {
    const file = event.target.files?.[0];
    // 同一个文件连选两次也要触发 change，所以每次都清空。
    event.target.value = "";
    if (!file) return;

    if (
      mode === "replace" &&
      !window.confirm(t("整份还原会先清空这个家现有的全部数据，再按文件重建。确定继续吗？"))
    )
      return;

    setBusy(true);
    try {
      const snapshot = JSON.parse(await file.text());
      const counts = await importSnapshot(mode, snapshot);
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      notify(t("已导入 {count} 条记录", { count: total }));
      // 数据全变了，页面上还留着导入前的内容。
      window.location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("导入失败"));
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <strong>{t("数据")}</strong>
      <p className="settings-note">{t("导出的是一个普通 JSON 文件，可以自己打开看。附件图片不在其中。")}</p>

      <div className="modal-actions">
        <a className="primary-button" href="/api/backup" download>
          {t("导出全部数据")}
        </a>
      </div>

      <div className="transfer-actions">
        <label className="secondary-button">
          {t("合并导入物品")}
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => pick(e, "merge")}
          />
        </label>
        <label className="secondary-button danger">
          {t("整份还原")}
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => pick(e, "replace")}
          />
        </label>
      </div>
      <p className="settings-note">{t("合并只加物品，现有的一件不动；整份还原会先清空再重建。")}</p>

      {snapshots.length > 0 && (
        <>
          <p className="settings-note snapshot-head">{t("自动备份（每 6 小时一份，保留最近 14 份）")}</p>
          <ul className="snapshot-list">
            {snapshots.map((snapshot) => (
              <li key={snapshot.key}>
                <span>
                  {formatDateTime(locale, snapshot.at)}
                  <small>{Math.round(snapshot.size / 1024)} KB</small>
                </span>
                <a href={snapshotUrl(snapshot.key)} download>
                  {t("下载")}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
