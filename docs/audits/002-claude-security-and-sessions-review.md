# 002-claude · 对「安全响应头」与「登录设备与会话轮换」的独立复核

- 状态：完成
- 日期：2026-08-24
- 对象：[`002-security-headers.md`](002-security-headers.md)（提交 `9f7820a`）、[`003-session-management.md`](003-session-management.md)（提交 `94ffe3d`）
- 结论：**两份记录的技术主张全部成立。** 但发现一处覆盖缺口（已补测试）和一处记录表述问题（见第 5 节）。

## 1. 范围

本次复核完成：

- 核对 002、003 声称的实现与验证证据。
- 执行两份记录留给下一位审计者的检查清单中可在本机完成的部分。
- 补做三项**证伪**验证。
- **补写一条缺失的集成测试**（第 4.1 节），这是本次唯一的代码改动。
- 演练 003 的旧库迁移（其清单第 1 条）。

本次复核不做：

- 对 `004-pwa-installability.md` 的复核。
- 浏览器 DevTools 侧的 CSP 控制台检查、iframe 嵌入实验、移动端窄屏检查——这些需要人工交互。
- 部署。三个变更均未上线，是否发布由项目所有者决定（见第 5.1 节）。

## 2. 核对结果

### 002 · 安全响应头

| 主张                                   | 核对方式                             | 结果                                                   |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| 头在真实 HTTP 响应上生效               | `pnpm run test:integration`          | 通过；`/` 与 `/api/inventory` 均带全套头               |
| `next.config.ts` 的 `headers()` 无效   | 记录中已说明并弃用                   | 现实现位于 `worker/securityHeaders.ts`，由统一出口调用 |
| 生产不含 `unsafe-eval`、不开 WebSocket | 读 `securityHeaders.ts` 第 14 行     | `unsafe-eval` 由 `development` 三元控制，生产不注入    |
| `Set-Cookie` 不丢失                    | `tests/security-headers.test.mjs:30` | 有直接断言；集成测试中登录仍能拿到 Cookie，间接佐证    |
| localhost 与生产策略分离               | 读第 5 行 `isLocalHost`              | 按主机名判断，非按环境变量，行为可预测                 |
| 仍保留 `unsafe-inline`                 | 读第 14、15 行                       | 属实，记录第 6 节已如实披露                            |

### 003 · 登录设备与会话轮换

| 主张                                 | 核对方式                                 | 结果                                                     |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| 撤销按 `user_id + session_id` 双条件 | 读 `session.ts` 的 `revokeUserSession`   | 属实，SELECT 与 DELETE 都带两个条件                      |
| 不返回 `token_hash`                  | 读 `/api/sessions` GET                   | 只返回随机 `session_id`                                  |
| 索引排在补列之后                     | 检查 `idx_sessions_id` 所在数组          | 位于 `INDEXES_ON_ADDED_COLUMNS`，**没有重演 001 的错误** |
| 旧库补列能正确回填                   | 在旧结构本地库上实跑迁移（第 3.3 节）    | 11 条旧会话全部获得唯一 `session_id`，无空值             |
| 改密码使 D1 batch 原子提交           | 读 `auth/route.ts` 的 `setPassword` 分支 | 三条语句在同一个 `batch()` 内                            |
| 集成测试 2/2 通过                    | `pnpm run test:integration`              | 通过（复核时连同 004 共 3/3）                            |

## 3. 证伪验证

### 3.1 削弱安全响应头 → 测试红（002 有保护）

把 `X-Frame-Options` 的值从 `DENY` 改成 `SAMEORIGIN`：

```
✖ real HTTP requests enforce authentication and household isolation
ℹ pass 2  fail 1
```

**002 的断言有效。** 还原后恢复 3/3。

首次尝试是直接删掉整行，结果是编译失败而非断言失败——那不算有效证伪，因为它证明不了断言在起作用。改值才是正确做法，记录于此。

### 3.2 去掉跨账号撤销的 `user_id` 条件 → 测试**全绿**（003 无保护）

把 `revokeUserSession` 中 SELECT 与 DELETE 的 `user_id` 条件都去掉，即任何登录用户凭 `session_id` 就能撤销他人设备：

```
✔ PWA manifest ...
✔ real HTTP requests enforce authentication and household isolation
✔ password changes rotate sessions and users can revoke devices
ℹ pass 3  fail 0        ← 全绿
```

**这是本次复核的主要发现。** 003 的记录把这条边界写进了「给下一位审计者的检查清单」第 3 条，但没有写成测试，因此它当时没有任何自动化保护。

实际风险有限：`session_id` 是随机值，攻击者猜不到。但那道 `user_id` 检查存在的意义恰恰是「万一 ID 泄漏也无所谓」——没有测试守着，它可以在任何一次重构中被静悄悄拿掉，而全套测试仍然全绿。

### 3.3 旧库迁移演练（003 清单第 1 条）

本地开发库当时正是旧结构且含 11 条真实会话行。触发一次 `ensureSchema()` 后：

```
sessions 列：token_hash, user_id, kind, expires_at, created_at,
             session_id, last_seen_at, user_agent      ← 三列补齐

总数 11 · 唯一 session_id 11 · 空 id 0 · 空 last_seen_at 0
```

**补列与回填正确，唯一索引未因重复值失败。**

## 4. 本次的代码改动

### 4.1 补上跨账号撤销的集成测试

唯一的代码改动，直接关闭第 3.2 节发现的缺口。新增测试构造两个账号，让 A 拿着 B 的 `session_id` 调用 revoke：

- 断言返回 404。
- 断言 B 仍处于登录状态。
- 断言 B 的设备列表数量不变。

自身证伪：再次去掉 `user_id` 条件后，**只有这一条测试变红**，其余三条仍绿。说明它确实覆盖了此前无人覆盖的路径。

## 5. 两份记录的表述问题

### 5.1 「完成」容易被读成「已上线」——三个变更都还没部署

复核时生产仍停在 `53a16659`，即 002、003、004 之前的版本。对线上执行：

```bash
curl -sI https://home-stock-planner.mm10237207.workers.dev/ | grep -i "x-frame\|content-security\|strict-transport"
# 无输出：一个安全头都没有
```

两份记录的「安全边界」写了「没有连接生产服务」，与事实一致；但状态行的「完成」没有区分「实现并本地验证完成」和「已发布」。002 的清单第 1 条要求对线上 `curl -I`——在部署之前这条根本无法执行。

**建议**：状态约定中区分「本地完成」与「已发布」，或在记录中显式写明部署状态与提交号。

### 5.2 003 的验证证据未包含跨账号撤销

第 5 节列了 6 条 HTTP 断言，均为同账号内的行为。跨账号边界被降级到清单里。**把安全边界放进「建议下一位检查」而不是写成测试，等于该边界在被检查之前处于无保护状态。** 建议后续记录中，凡属权限边界的主张一律直接写测试。

## 6. 未能在本机完成的检查

- 002 清单第 2、3 条（浏览器走一遍功能看 CSP 是否误拦、外站 iframe 嵌入）需要人工交互。
- 003 清单第 5 条（手机 Safari 与桌面窄屏的设备列表布局）同上。
- 003 清单第 2 条（并发两次改密码）本次未做；D1 batch 是原子的，但两个并发 batch 的相对顺序未验证。
- 部署后仍需对线上做一次 `curl -I`，确认 Cloudflare 未覆盖这些响应头。

## 7. 给下一位审计者

1. 部署后立即执行 002 清单第 1 条；在此之前该条无法完成。
2. 重跑第 3.2 节的证伪，确认新测试仍会红——它是这条边界唯一的守卫。
3. 对 `revokeOthers` 和 `revokeAll` 也做一次跨账号证伪；本次只覆盖了 `revoke`。
4. 生产库有 8 条有效会话。部署 003 前先备份 D1，部署后立刻确认三个账号仍能登录、设备列表非空。
5. CSP 仍含 `script-src 'unsafe-inline'`。它降低 XSS 影响面，但不能替代输出转义；评估新功能时不要把它当成已有防护。

## 8. 复核所用命令

```bash
pnpm run test:integration     # 复核前 3/3，补测试后 4/4
npx tsc --noEmit              # 通过
curl -sI https://home-stock-planner.mm10237207.workers.dev/   # 确认线上尚无安全头
```

三次证伪实验的具体改法见第 3.1、3.2 节，均已还原，`git diff` 对相关文件为空。
