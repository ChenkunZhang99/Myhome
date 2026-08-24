"use client";

import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useAppSettings } from "./AppSettings";
import { FEEDBACK_HUB_URL } from "./feedback";

export function OnboardingGuide({
  onClose,
  onAdd,
  onReceipt,
  onStores,
  onSettings,
}: {
  onClose: () => void;
  onAdd: () => void;
  onReceipt: () => void;
  onStores: () => void;
  onSettings: () => void;
}) {
  const { t } = useAppSettings();

  function continueWith(action: () => void) {
    onClose();
    action();
  }

  return (
    <Modal
      className="onboarding-modal"
      eyebrow={t("第一次使用")}
      title={t("三步把这个家建起来")}
      onClose={onClose}
    >
      <p className="onboarding-intro">
        {t("不用一次录完整个家。先加入最常用、最容易忘买或最容易过期的东西，之后边用边补。")}
      </p>

      <ol className="onboarding-steps">
        <li>
          <span className="onboarding-number">1</span>
          <div>
            <strong>{t("先录一批真实库存")}</strong>
            <p>{t("东西少就手动添加；刚买完一大袋时，直接拍小票更快。")}</p>
            <div className="onboarding-actions">
              <button className="primary-button compact" onClick={() => continueWith(onAdd)}>
                <Icon name="add" /> {t("手动添加")}
              </button>
              <button className="secondary-button compact" onClick={() => continueWith(onReceipt)}>
                <Icon name="receipt" /> {t("上传小票")}
              </button>
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-number">2</span>
          <div>
            <strong>{t("收藏真正会去的门店")}</strong>
            <p>{t("填好地区并收藏常去门店后，Flyer 推荐才会只看与你有关的优惠。")}</p>
            <button className="secondary-button compact" onClick={() => continueWith(onStores)}>
              <Icon name="deals" /> {t("去设置门店")}
            </button>
          </div>
        </li>
        <li>
          <span className="onboarding-number">3</span>
          <div>
            <strong>{t("按需补全家庭设置")}</strong>
            <p>{t("可以邀请家人、设置语言和 AI；这些都不是开始记录库存的前置条件。")}</p>
            <button className="secondary-button compact" onClick={() => continueWith(onSettings)}>
              <Icon name="settings" /> {t("打开家庭设置")}
            </button>
          </div>
        </li>
      </ol>

      <div className="onboarding-footer">
        <span>{t("遇到不清楚或不好用的地方？")}</span>
        <a href={FEEDBACK_HUB_URL} target="_blank" rel="noreferrer">
          {t("告诉我们")} ↗
        </a>
      </div>
    </Modal>
  );
}
