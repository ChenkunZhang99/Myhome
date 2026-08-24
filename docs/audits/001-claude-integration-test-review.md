# 001-claude · 对「真实 HTTP 集成测试基础」的独立复核

- 状态：完成
- 日期：2026-08-24
- 对象：[`001-integration-test-foundation.md`](001-integration-test-foundation.md)（提交 `5d49c26`）
- 结论：**核心主张全部成立。** 另做了原记录没有做的证伪验证，两条都复现成功。

## 1. 范围

本次复核完成：

- 逐条核对原记录第 4 节的验证证据。
- 执行原记录第 7 节留给下一位审计者的检查清单，其中第 2 条改用了更安全的方法（见第 5 节）。
- 补做两项**证伪**验证：故意破坏隔离、故意还原 schema 缺陷，确认测试真的会失败。

本次复核不做：

- 代码改动。除两次临时的破坏性实验外没有修改任何文件，实验后均已还原并确认 `git diff` 为空。
- 对 `002` 及之后审计记录的复核。
- Linux 环境验证（本机只有 Windows，见第 5 节）。

## 2. 逐条核对结果

| 原记录的主张                   | 核对方式                               | 结果                                                                    |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------- |
| 集成测试真的发 HTTP 请求       | `pnpm run test:integration`            | 通过，1/1                                                               |
| 不指向生产资源                 | 读 `tests/integration/wrangler.jsonc`  | `database_id` 为占位符 `0000…0001`，桶名为 `-integration`，均与生产不同 |
| 只跑本地，不连远端             | 读 `scripts/run-integration-tests.mjs` | `vinext dev` 绑 `127.0.0.1`，全文无 `--remote`                          |
| 不影响日常开发与生产构建       | 读 `vite.config.ts`                    | `configPath` 仅在 `HSP_INTEGRATION_TEST === "1"` 时切换                 |
| Worker 拿不到 `OPENAI_API_KEY` | 外部探测三个调模型接口（见第 3.3 节）  | 三条均返回 503「没有可用的密钥」，服务日志中无 `sk-` 串                 |
| 已接入 CI                      | 读 `.github/workflows/ci.yml`          | 位于 `pnpm test` 之后、lint 之前                                        |
| 临时目录会被清理               | 观察两次完整运行                       | `hsp-integration-*` 目录运行后消失                                      |

原记录第 4 节声称的数字，本机复现一致。

## 3. 证伪验证（原记录未做，是本次复核的主要增量）

「测试通过」和「测试什么都没测」在输出上无法区分。以下两项用来分辨。

### 3.1 故意破坏跨户隔离

去掉 `app/api/inventory/route.ts` 中 PATCH 路径上的住户条件：

```
-      FROM inventory_items WHERE household_id = ? AND id = ?
+      FROM inventory_items WHERE id = ?
```

运行 `pnpm run test:integration`，实际结果：

```
PATCH /api/inventory 200 in 13ms        ← 越权修改成功，本应是 404
[ELIFECYCLE] Command failed with exit code 1
```

**集成测试确实会因为隔离被破坏而失败。** 还原后重新运行，1/1 通过。

### 3.2 还原 schema 缺陷

把 `idx_flyer_price_history_item` 放回基础 `INDEXES` 数组（即修复前的位置），用全新数据库运行：

```
D1_ERROR: no such column: source_key at offset 89: SQLITE_ERROR
  at app/api/_shared/schema.ts:575:3
注册接口返回 500，测试失败
```

**原记录对这个缺陷的诊断准确。** 根因确认：`flyer_price_history.source_key` 定义在 `ADDED_COLUMNS` 里（`schema.ts` 第 433 行），而被移除的那个索引位于基础 `INDEXES`，与 `CREATE TABLE` 同批次执行，跑在 `ALTER TABLE` 补列**之前**。

**这里补充一条原记录写轻了的判断**：这不是「初始化中断」，而是**任何人从本仓库全新部署，第一个请求就会 500，站点完全起不来**。现存数据库（生产、本地开发）都躲过了它，因为它们在补列之前就已建好。修复前 217 个单元测试全绿，缺陷始终存在——这正好印证了原记录的结论：源码扫描与纯函数测试替代不了真实启动。

### 3.3 密钥缺席的外部探测

在与集成测试相同的环境（`HSP_INTEGRATION_TEST=1` + 独立临时状态目录）启动服务，注册一个 `@e2e.test` 账号后依次请求：

```
503  POST /api/recipes          {"error":"还没有可用的 OpenAI 密钥，请在设置里填上你自己的"}
503  POST /api/recipes/draft    {"error":"还没有可用的 OpenAI 密钥，请在设置里填上你自己的"}
503  POST /api/planner          {"type":"discoverStores","postalCode":"M5V 2T6"} → 同上
服务日志中是否出现 sk- 串：否
```

首次探测时误用了 `V3J 1N4`，返回 200，一度被记为可疑。实际原因是**片区缓存命中**——预设门店由 `SEEDS` 写入 `flyer_source_areas`，V3J 在全新库上就已存在，该路径根本不调用模型。换成未缓存的 `M5V 2T6` 才会真正走到模型调用。这是探针设计失误，不是被审计代码的问题，记录于此以免下一位重蹈。

## 4. 安全边界

- 未连接远程 D1、R2 或任何 Cloudflare 生产资源。
- 未访问 OpenAI、Flipp 或其他外部服务；所有 AI 接口在探测中均因缺少密钥而提前返回。
- 两次破坏性实验只涉及 `app/api/inventory/route.ts` 与 `app/api/_shared/schema.ts`，均以文件副本还原，还原后 `git diff --stat` 对该文件为空。
- 未新增任何暴露环境绑定或密钥状态的接口（见第 5 节第一条）。
- 探测用账号一律使用 `@e2e.test` 域名，且只存在于随运行创建、随运行删除的临时数据库中。

## 5. 与原记录检查清单的偏差

**第 7.2 条建议「在测试路由中临时读取环境绑定」以验证密钥不存在，本次没有采用。** 为验证而临时新增一个报告密钥状态的接口，本身引入了新的暴露面，并依赖「记得删掉」这一人为步骤。改用第 3.3 节的外部探测，结论等价而不留痕迹。**建议后续记录不再推荐这种做法。**

**第 7.4 条要求在 Windows 与 Linux 各运行一次，本次只验证了 Windows。** Linux 侧仍待复核，但 CI 运行在 Ubuntu 上，可视为持续性的部分覆盖。

## 6. 原记录的已知不足之外，本次新发现

**集成测试跑的是 Miniflare，不是真实 Workers runtime。** 原记录第 6 节提到「使用的是开发服务器，不是 `dist/server` 包」，但没有点明二者的行为差异。这个项目恰好在这类差异上踩过坑：`once()` 的每 isolate 语义、免费版 10ms CPU 上限、全局作用域禁止随机数（曾导致部署报 10021）。这些在 Miniflare 下都不会暴露。**集成测试绿灯不等于部署后可用**，部署后仍需真实请求验证。

## 7. 给下一位审计者

1. 在 Linux 上跑一次 `pnpm run test:integration`，确认进程与临时目录清理同样成立。
2. 重跑第 3.1 节的证伪实验（换一条路径，例如 DELETE 或列表查询），确认覆盖面不止 PATCH 一处。
3. 关注 CI 时长与端口竞争——原记录第 7.5 条提出的窗口期尚未被观测到，但也尚未被排除。
4. **当前仓库有多个改动同时在进行。** 本次复核期间工作区从「安全响应头」变为「会话管理」（`sessions` 表新增 `session_id`/`last_seen_at`/`user_agent`，新增 `app/api/sessions/`）。用文件副本做还原时可能覆盖他人正在编辑的内容——本次未造成损失属侥幸。**并行改动建议分支隔离。**

## 8. 复核所用命令

```bash
pnpm run test:integration     # 1/1 通过
pnpm test                     # 220/220 通过（复核当时，含他人在途改动）
npx tsc --noEmit              # 通过
```

证伪实验的具体改法见第 3.1、3.2 节，两处均可原样复现。
