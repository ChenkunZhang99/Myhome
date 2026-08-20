"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useAppSettings } from "./AppSettings";

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

type ModalProps = {
  onClose: () => void;
  title: string;
  eyebrow?: string;
  /** 追加到 `.modal` 上的类名，用于控制宽度等。 */
  className?: string;
  /** 追加到遮罩层上的类名，用于叠放层级。 */
  backdropClassName?: string;
  /** 需要自定义头部布局时传入；标题仍由 `title` 提供给辅助技术。 */
  head?: ReactNode;
  children: ReactNode;
};

/**
 * 全站统一的对话框。
 *
 * 之前每个弹窗都各写一遍 backdrop，结果是：按 Esc 关不掉、焦点不进对话框、
 * 而且 backdrop 那个 `<div>` 挂了鼠标事件却没有键盘等价物。这里一次性解决：
 *  - Esc 关闭，作为「点背景关闭」真正的键盘等价物
 *  - 打开时把焦点移进对话框，关闭时还给原来的元素
 *  - backdrop 标记为 role="presentation"，表明它只是装饰层
 */
export function Modal({ onClose, title, eyebrow, className, backdropClassName, head, children }: ModalProps) {
  const { t } = useAppSettings();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // 只在挂载时跑一次：依赖 onClose 会让每次重渲染都重新抢焦点，用户就没法打字了。
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className={backdropClassName ? `modal-backdrop ${backdropClassName}` : "modal-backdrop"}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {head ?? (
          <div className="modal-head">
            <div>
              {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
              <h2 id={titleId}>{title}</h2>
            </div>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
              ×
            </button>
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
