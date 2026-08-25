"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useAppSettings } from "./AppSettings";

/**
 * 右下角悬浮相机：点开后可选「拍照识别」或「上传小票」。
 * 总览里原来的「快速录入」整块面板被这个入口替代。
 */
export function CaptureFab({
  onScan,
  onReceipt,
}: {
  onScan: () => void;
  onReceipt: () => void;
}) {
  const { t } = useAppSettings();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className={open ? "capture-fab open" : "capture-fab"} ref={root}>
      {open && (
        <div className="capture-fab-menu" id={menuId} role="menu">
          <button type="button" role="menuitem" onClick={() => choose(onScan)}>
            <Icon name="camera" />
            <span>{t("拍照识别")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onReceipt)}>
            <Icon name="receipt" />
            <span>{t("上传小票")}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="capture-fab-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-label={open ? t("关闭录入选项") : t("拍照或上传小票")}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="camera" />
      </button>
    </div>
  );
}
