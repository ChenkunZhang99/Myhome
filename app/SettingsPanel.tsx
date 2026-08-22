"use client";

import { FormEvent, useState } from "react";
import { AccountSection } from "./AccountSection";
import { HouseholdSection } from "./HouseholdSection";
import { useAppSettings } from "./AppSettings";
import { Modal } from "./Modal";
import { clearAiSettings, maskKey, readAiSettings, writeAiSettings } from "./aiSettings";
import { localeLabels, locales } from "./i18n";

/**
 * 账号、语言切换与自带密钥设置。
 * 密钥输入框始终以密码形式呈现，已保存的密钥只显示掩码，永远不回填明文。
 */
export function SettingsPanel({
  onClose,
  notify,
}: {
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const { t, locale, setLocale, ai } = useAppSettings();
  const [draftKey, setDraftKey] = useState("");
  // 这个面板只在用户点开后才渲染（不参与服务端渲染），所以可以直接惰性读取本地设置。
  const [draftModel, setDraftModel] = useState(() => readAiSettings().model);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const apiKey = draftKey.trim();
    // 留空表示「不改动已保存的密钥」，只更新模型。
    writeAiSettings({ apiKey: apiKey || ai.apiKey, model: draftModel.trim() });
    setDraftKey("");
    notify(apiKey ? t("密钥已保存到这台设备") : t("设置已更新"));
    onClose();
  }

  function remove() {
    clearAiSettings();
    setDraftKey("");
    setDraftModel("");
    notify(t("密钥已从这台设备清除"));
  }

  return (
    <Modal className="settings-modal" eyebrow={t("设置")} title={t("账号与偏好")} onClose={onClose}>
      <AccountSection notify={notify} />
      <HouseholdSection notify={notify} />

      <div className="settings-section">
        <strong>{t("语言")}</strong>
        <div className="locale-switch" role="group" aria-label={t("语言")}>
          {locales.map((option) => (
            <button
              key={option}
              type="button"
              className={option === locale ? "active" : ""}
              aria-pressed={option === locale}
              onClick={() => setLocale(option)}
            >
              {localeLabels[option]}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={save} className="settings-section">
        <strong>{t("AI 设置")}</strong>
        <p className="settings-note">
          {t(
            "小票识别、Flyer 自动读取和菜谱生成需要 OpenAI 密钥。密钥只保存在这台设备的浏览器里，每次请求直接发给本站后端转发，服务端不会存储或显示它。",
          )}
        </p>
        <div className={ai.apiKey ? "settings-status ok" : "settings-status"}>
          <span />
          <p>
            <b>{ai.apiKey ? t("已配置") : t("未配置")}</b>
            <small>
              {ai.apiKey
                ? maskKey(ai.apiKey)
                : t("当前为演示模式：需要模型的功能返回内置示例数据，不产生任何费用。")}
            </small>
          </p>
        </div>
        <label className="field full">
          <span>{t("模型密钥")}</span>
          <input
            type="password"
            value={draftKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={ai.apiKey ? t("留空则不修改已保存的密钥") : "sk-..."}
            onChange={(event) => setDraftKey(event.target.value)}
          />
        </label>
        <label className="field full">
          <span>{t("模型")}</span>
          <input
            value={draftModel}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("留空使用默认模型")}
            onChange={(event) => setDraftModel(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          {ai.apiKey && (
            <button type="button" className="secondary-button danger" onClick={remove}>
              {t("清除密钥")}
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="primary-button">{t("保存")}</button>
        </div>
      </form>
    </Modal>
  );
}
