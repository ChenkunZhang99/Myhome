"use client";

import { useState } from "react";
import { useAppSettings } from "./AppSettings";
import { Modal } from "./Modal";

/**
 * 隐私说明与使用条款。
 *
 * 写在应用内而不是外链一份 PDF，是因为它要描述的就是这份代码的行为——
 * 存了什么、存在哪、谁看得见、怎么删掉。放在一起改，两边才不会走散。
 *
 * 内容刻意具体：泛泛的「我们重视您的隐私」对读的人没有任何信息量，
 * 而「密码只存 PBKDF2 哈希」「图片存在 R2，注销时一并删除」是可以被核对的。
 */

type Page = "privacy" | "terms" | null;

export function PolicySection() {
  const { t } = useAppSettings();
  const [page, setPage] = useState<Page>(null);

  return (
    <div className="settings-section">
      <strong>{t("隐私与条款")}</strong>
      <p className="settings-note">{t("这两份说明描述的就是这个应用的实际行为，不是一段模板。")}</p>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={() => setPage("privacy")}>
          {t("隐私说明")}
        </button>
        <button type="button" className="secondary-button" onClick={() => setPage("terms")}>
          {t("使用条款")}
        </button>
      </div>

      {page === "privacy" && (
        <Modal eyebrow={t("隐私")} title={t("隐私说明")} onClose={() => setPage(null)}>
          <div className="policy-body">
            <h4>{t("存了什么")}</h4>
            <ul>
              <li>{t("邮箱：用来登录和接收邀请。")}</li>
              <li>{t("密码：只保存 PBKDF2-HMAC-SHA256 哈希，原文不落库，服务端自己也读不回来。")}</li>
              <li>{t("你录入的内容：库存、采购记录、菜谱、购物清单、家庭成员称呼。")}</li>
              <li>{t("你上传的图片：小票与物品照片，存放在 Cloudflare R2。")}</li>
              <li>{t("会话凭据：HttpOnly cookie，60 天有效，浏览器脚本读不到。")}</li>
            </ul>

            <h4>{t("谁看得见")}</h4>
            <p>
              {t(
                "数据属于家庭，不属于个人。同一个家里的成员看到同一份数据；别的家庭看不到你的任何内容——每一条数据库查询都带着家庭标识，这一点由自动化测试守着。",
              )}
            </p>

            <h4>{t("会发给谁")}</h4>
            <p>
              {t(
                "使用小票识别、菜谱生成、Flyer 读取时，相关内容会发送给 OpenAI 处理。发出去的是这些功能所需的内容本身，不含你的邮箱。除此之外不向任何第三方提供数据，也不做广告或分析追踪。",
              )}
            </p>
            <p>
              {t(
                "如果你在设置里填了自己的 OpenAI 密钥，它只保存在你自己浏览器里，随请求发给服务端转发，服务端不落库、不回显、不写日志。",
              )}
            </p>

            <h4>{t("存多久")}</h4>
            <p>
              {t(
                "数据一直保留到你自己删除。系统每 6 小时做一次自动备份存入 R2，只保留最近 14 份，更旧的自动滚掉。",
              )}
            </p>

            <h4>{t("怎么拿走，怎么删掉")}</h4>
            <p>
              {t(
                "「数据」一节可以随时导出全部内容为 JSON。「账号」一节可以注销：只有你一个人的家庭会连同数据、图片和备份快照一起删除；还有其他成员的家庭会留给他们。",
              )}
            </p>

            <h4>{t("联系")}</h4>
            <p>{t("这是一个个人项目。有问题可以在代码仓库提 issue。")}</p>
          </div>
        </Modal>
      )}

      {page === "terms" && (
        <Modal eyebrow={t("条款")} title={t("使用条款")} onClose={() => setPage(null)}>
          <div className="policy-body">
            <h4>{t("这是什么")}</h4>
            <p>
              {t(
                "一个免费的个人项目，按现状提供，没有可用性承诺，也不保证数据不会丢失。重要的东西请自己导出一份留底。",
              )}
            </p>

            <h4>{t("模型功能的额度")}</h4>
            <p>
              {t(
                "每个家庭可以免费使用部署者的 OpenAI 额度 20 次，用于本站自身的功能：小票识别、菜谱生成、Flyer 读取与门店搜索。用完之后在设置里填自己的密钥即可继续。",
              )}
            </p>
            <p>
              {t(
                "这把密钥只在服务端使用，任何响应里都不会出现它，也不提供任何形式的代理转发——它只能通过本站的这几个功能兑现。",
              )}
            </p>

            <h4>{t("价格与优惠信息")}</h4>
            <p>
              {t(
                "Flyer 优惠来自超市公开发布的信息，其中一部分是从图片识别出来的，可能出错。以店内实际标价为准。",
              )}
            </p>

            <h4>{t("保质期与食品安全")}</h4>
            <p>{t("保质期提醒是根据你录入的日期算出来的辅助信息，不构成食品安全建议。")}</p>

            <h4>{t("你的责任")}</h4>
            <p>
              {t(
                "不要用它存放你不希望被同一个家庭的其他成员看到的内容。邀请链接谁拿到谁能进，请只发给你信任的人。",
              )}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
