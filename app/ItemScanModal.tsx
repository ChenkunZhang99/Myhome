"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useAppSettings } from "./AppSettings";
import { readJson } from "./apiClient";
import { withAiHeaders } from "./aiSettings";
import { compressImage, formatBytes } from "./imageCompression";
import { dayIn, detectTimeZone } from "./dateTime";

const categories = [
  "蔬菜水果",
  "肉类海鲜",
  "乳品蛋类",
  "米面粮油",
  "调味品",
  "冷冻食品",
  "零食饮料",
  "清洁用品",
  "洗护用品",
  "其他",
];
const locations = ["冰箱", "冷冻柜", "厨房储物柜", "卫生间", "洗衣房", "其他"];

type Alternative = { name: string; category: string; identityConfidence: number };
export type ScannedItem = {
  tempId: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  identityConfidence: number;
  expiryDate: string | null;
  expiryConfidence: number;
  expiryUncertain: boolean;
  expiryGuesses: string[];
  reason: string;
  alternatives: Alternative[];
  selected: boolean;
};
type ScanDraft = {
  purchaseDate: string;
  imageQuality: "clear" | "blurry" | "dark" | "partial";
  needsChoice: boolean;
  items: ScannedItem[];
};

function splitDate(value: string | null | undefined) {
  const [year = "", month = "", day = ""] = value?.split("-") ?? [];
  return { year, month, day };
}

function joinDate(year: string, month: string, day: string) {
  if (!year && !month && !day) return null;
  if (!year || !month || !day) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function qualityLabel(
  quality: ScanDraft["imageQuality"],
  t: (text: string, vars?: Record<string, string | number>) => string,
) {
  if (quality === "blurry") return t("照片有点糊");
  if (quality === "dark") return t("照片偏暗");
  if (quality === "partial") return t("没拍全包装");
  return t("照片比较清楚");
}

export function ItemScanModal({
  preferredCategory,
  onClose,
  onSaved,
  notify,
}: {
  preferredCategory: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  notify: (message: string) => void;
}) {
  const { t, tv } = useAppSettings();
  const [preview, setPreview] = useState<{
    url: string;
    name: string;
    size: number;
    originalSize: number;
    file: File;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ScanDraft | null>(null);
  const [step, setStep] = useState<"capture" | "choose" | "confirm">("capture");

  function close() {
    if (analyzing || saving) return;
    if (preview) URL.revokeObjectURL(preview.url);
    onClose();
  }

  async function pickPhoto(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setDraft(null);
    setStep("capture");
    if (!picked) return;
    setCompressing(true);
    try {
      const { file, originalSize } = await compressImage(picked);
      setPreview({
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        originalSize,
        file,
      });
    } catch {
      setPreview({
        url: URL.createObjectURL(picked),
        name: picked.name,
        size: picked.size,
        originalSize: picked.size,
        file: picked,
      });
    } finally {
      setCompressing(false);
    }
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) return;
    const form = new FormData();
    form.set("photo", preview.file, preview.name);
    form.set("preferredCategory", preferredCategory === "全部" ? "" : preferredCategory);
    setAnalyzing(true);
    try {
      const response = await fetch("/api/items/scan", { method: "POST", headers: withAiHeaders(), body: form });
      const data = await readJson<ScanDraft>(response);
      if (!response.ok) throw new Error(data.error || t("物品照片识别失败"));
      const items = data.items ?? [];
      if (!items.length) throw new Error(t("照片里没有识别到可用的物品"));
      setDraft({
        purchaseDate: data.purchaseDate || dayIn(detectTimeZone()),
        imageQuality: data.imageQuality,
        needsChoice: data.needsChoice,
        items,
      });
      setStep(data.needsChoice ? "choose" : "confirm");
      notify(
        data.needsChoice
          ? t("照片不太确定，请先选出最像的物品")
          : t("识别到 {count} 件物品，请确认保质期", { count: items.length }),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : t("物品照片识别失败"));
    } finally {
      setAnalyzing(false);
    }
  }

  function updateItem(tempId: string, changes: Partial<ScannedItem>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.tempId === tempId ? { ...item, ...changes } : item)),
          }
        : current,
    );
  }

  function chooseIdentity(item: ScannedItem, name: string, category: string) {
    updateItem(item.tempId, { name, category });
  }

  function goConfirm() {
    if (!draft) return;
    const chosen = draft.items.filter((item) => item.selected);
    if (!chosen.length) {
      notify(t("请至少选择一件要加入库存的物品"));
      return;
    }
    setStep("confirm");
  }

  async function saveSelected() {
    if (!draft) return;
    const chosen = draft.items.filter((item) => item.selected);
    if (!chosen.length) {
      notify(t("请至少选择一件要加入库存的物品"));
      return;
    }
    setSaving(true);
    try {
      for (const item of chosen) {
        const response = await fetch("/api/inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: item.name,
            category: item.category,
            location: item.location,
            precision: "quantity",
            quantity: item.quantity,
            unit: item.unit,
            remainingPercent: 100,
            level: "充足",
            purchaseDate: draft.purchaseDate,
            expiryDate: item.expiryDate,
            source: "photo-scan",
          }),
        });
        const data = await readJson<Record<string, never>>(response);
        if (!response.ok) throw new Error(data.error || t("保存失败"));
      }
      await onSaved();
      if (preview) URL.revokeObjectURL(preview.url);
      notify(t("已加入 {count} 件物品，购买日期记为今天", { count: chosen.length }));
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : t("保存失败"));
    } finally {
      setSaving(false);
    }
  }

  const title =
    step === "choose" ? t("这可能是哪一种？") : step === "confirm" ? t("确认后加入库存") : t("拍包装扫保质期");

  return (
    <Modal className="receipt-modal item-scan-modal" eyebrow={t("拍照识别")} title={title} onClose={close}>
      {step === "capture" && (
        <form className="receipt-upload-form" onSubmit={analyze}>
          <div className={preview ? "receipt-upload-box has-preview" : "receipt-upload-box"}>
            {compressing ? (
              <>
                <span>◌</span>
                <strong>{t("正在压缩照片…")}</strong>
                <p>{t("上传前会先压到 1MB 以内，避免超出大小限制。")}</p>
              </>
            ) : preview ? (
              <>
                <img className="receipt-preview" src={preview.url} alt={t("已选择的物品照片")} />
                <small className="receipt-file-meta">
                  {preview.name} · {formatBytes(preview.size)}
                  {preview.originalSize > preview.size
                    ? ` · ${t("已从 {before} 压缩", { before: formatBytes(preview.originalSize) })}`
                    : ""}
                </small>
              </>
            ) : (
              <>
                <Icon name="camera" />
                <strong>{t("拍包装正面，尽量带上日期")}</strong>
                <p>
                  {t(
                    "系统会先判断清不清晰。看不准时会列出可能的物品让你挑，看清了再读保质期。购买日期默认记为今天。",
                  )}
                </p>
              </>
            )}
            <div className="receipt-pickers">
              <label className="receipt-capture">
                <span>{t("拍照")}</span>
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} />
              </label>
              <label>
                <span>{preview ? t("重新选择") : t("选择照片")}</span>
                <input
                  name="photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={pickPhoto}
                />
              </label>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={close}>
              {t("取消")}
            </button>
            <button className="primary-button" disabled={compressing || analyzing || !preview}>
              {analyzing ? t("正在识别照片…") : t("开始识别")}
            </button>
          </div>
        </form>
      )}

      {draft && step === "choose" && (
        <>
          <p className="scan-quality">
            <strong>{qualityLabel(draft.imageQuality, t)}</strong>
            <span>{t("先选出最像的一种，不确定的日期下一步再改。")}</span>
          </p>
          <div className="scan-choice-list">
            {draft.items.map((item) => {
              const options = [
                { name: item.name, category: item.category, identityConfidence: item.identityConfidence },
                ...item.alternatives,
              ];
              return (
                <article key={item.tempId} className={item.selected ? "scan-choice" : "scan-choice skipped"}>
                  <label className="scan-keep">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(event) => updateItem(item.tempId, { selected: event.target.checked })}
                    />
                    {t("加入库存")}
                  </label>
                  {item.reason && <small className="scan-reason">{item.reason}</small>}
                  <div className="scan-options" role="radiogroup" aria-label={t("可能的物品")}>
                    {options.map((option) => {
                      const active = item.name === option.name && item.category === option.category;
                      return (
                        <button
                          key={`${option.name}-${option.category}`}
                          type="button"
                          className={active ? "scan-option active" : "scan-option"}
                          aria-pressed={active}
                          disabled={!item.selected}
                          onClick={() => chooseIdentity(item, option.name, option.category)}
                        >
                          <strong>{tv(option.name)}</strong>
                          <small>
                            {tv(option.category)} · {Math.round(option.identityConfidence * 100)}%
                          </small>
                        </button>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setStep("capture")}>
              {t("重新拍照")}
            </button>
            <button className="primary-button" onClick={goConfirm}>
              {t("下一步")}
            </button>
          </div>
        </>
      )}

      {draft && step === "confirm" && (
        <>
          <p className="scan-quality">
            <strong>{t("购买日期记为今天")} · {draft.purchaseDate}</strong>
            <span>{t("保质期来自包装，看不清的可以改。")}</span>
          </p>
          <div className="scan-confirm-list">
            {draft.items
              .filter((item) => item.selected)
              .map((item) => {
                const expiry = splitDate(item.expiryDate);
                return (
                  <article key={item.tempId} className="scan-confirm">
                    <label className="field full">
                      <span>{t("物品名称")}</span>
                      <input
                        value={item.name}
                        onChange={(event) => updateItem(item.tempId, { name: event.target.value })}
                      />
                    </label>
                    <div className="field-grid">
                      <label className="field">
                        <span>{t("种类")}</span>
                        <select
                          value={item.category}
                          onChange={(event) => updateItem(item.tempId, { category: event.target.value })}
                        >
                          {categories.map((name) => (
                            <option key={name} value={name}>
                              {tv(name)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>{t("存放位置")}</span>
                        <select
                          value={item.location}
                          onChange={(event) => updateItem(item.tempId, { location: event.target.value })}
                        >
                          {locations.map((name) => (
                            <option key={name} value={name}>
                              {tv(name)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>{t("数量")}</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={item.quantity}
                          onChange={(event) => updateItem(item.tempId, { quantity: Number(event.target.value) })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("计数单位")}</span>
                        <input
                          value={item.unit}
                          onChange={(event) => updateItem(item.tempId, { unit: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field full" role="group" aria-label={t("保质期（可选）")}>
                      <span>
                        {t("保质期（可选）")}
                        {item.expiryUncertain ? ` · ${t("日期不太确定")}` : ""}
                      </span>
                      <div className="date-parts">
                        <label className="date-part">
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1900"
                            max="2100"
                            placeholder="2026"
                            value={expiry.year}
                            onChange={(event) =>
                              updateItem(item.tempId, {
                                expiryDate: joinDate(event.target.value, expiry.month, expiry.day),
                              })
                            }
                            aria-label={t("保质期年份")}
                          />
                          <b>{t("年")}</b>
                        </label>
                        <label className="date-part">
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max="12"
                            placeholder="08"
                            value={expiry.month}
                            onChange={(event) =>
                              updateItem(item.tempId, {
                                expiryDate: joinDate(expiry.year, event.target.value, expiry.day),
                              })
                            }
                            aria-label={t("保质期月份")}
                          />
                          <b>{t("月")}</b>
                        </label>
                        <label className="date-part">
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max="31"
                            placeholder="14"
                            value={expiry.day}
                            onChange={(event) =>
                              updateItem(item.tempId, {
                                expiryDate: joinDate(expiry.year, expiry.month, event.target.value),
                              })
                            }
                            aria-label={t("保质期日期")}
                          />
                          <b>{t("日")}</b>
                        </label>
                      </div>
                      {item.expiryGuesses.length > 0 && (
                        <div className="scan-date-guesses">
                          {item.expiryGuesses.map((guess) => (
                            <button
                              key={guess}
                              type="button"
                              className={item.expiryDate === guess ? "filter-chip active" : "filter-chip"}
                              onClick={() => updateItem(item.tempId, { expiryDate: guess, expiryUncertain: false })}
                            >
                              {guess}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setStep(draft.needsChoice ? "choose" : "capture")}
            >
              {t("上一步")}
            </button>
            <button className="primary-button" onClick={saveSelected} disabled={saving}>
              {saving ? t("正在写入库存…") : t("确认并加入库存")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
