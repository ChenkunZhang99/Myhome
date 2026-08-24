# 001 · 真实 HTTP 集成测试基础

- 状态：完成，待独立复核
- 日期：2026-08-24
- 目标：让测试真正启动本地 Worker、发送 HTTP 请求，并保证测试数据与日常开发和生产环境隔离。

## 1. 范围

本步骤完成：

- 新增可重复运行的 HTTP 集成测试入口。
- 每次运行使用全新的临时 D1 和 R2 状态目录。
- 测试 Worker 不绑定项目根目录 `.dev.vars` 中的 OpenAI 密钥。
- 覆盖匿名访问、密码注册、会话 Cookie、库存写入，以及两个家庭之间的读取、修改、删除隔离。
- 把集成测试加入 GitHub Actions CI。
- 修复集成测试发现的全新数据库初始化错误。

本步骤不处理：

- 通用限流、AI 配额绕过、邮箱验证、密码哈希强度和密码锁定拒绝服务；这些是项目所有者明确暂缓的事项。
- 浏览器端 UI 测试、所有 API 路由的完整集成覆盖、真实 Cloudflare 生产环境测试。

## 2. 改动

| 文件                                               | 作用                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `scripts/run-integration-tests.mjs`                | 分配空闲端口和临时目录，启动本地 vinext/Miniflare，运行测试后只终止自己创建的进程并清理临时状态。                      |
| `tests/integration/wrangler.jsonc`                 | 测试专用 D1/R2 配置。文件放在子目录，Wrangler 不会发现项目根目录的 `.dev.vars`；空的 `secrets.required` 是第二道防线。 |
| `tests/integration/auth-household.integration.mjs` | 通过真实 HTTP 验证身份和家庭数据隔离。文件不用 `.test.mjs` 后缀，避免被纯测试命令脱离服务器直接执行。                  |
| `vite.config.ts`                                   | 只有 `HSP_INTEGRATION_TEST=1` 时才选测试配置和临时持久化目录，普通开发和生产构建路径不变。                             |
| `package.json`                                     | 新增 `pnpm run test:integration`。                                                                                     |
| `.github/workflows/ci.yml`                         | 原测试之后增加真实 HTTP 集成测试。                                                                                     |
| `app/api/_shared/schema.ts`                        | 修复新库建表顺序：不再在补 `source_key` 列之前创建依赖该列的旧索引，并删除被新索引取代的重复索引。                     |
| `docs/audits/README.md`                            | 规定后续每一步审计记录的格式。                                                                                         |

## 3. 集成测试发现并修复的问题

第一次运行不是测试代码失败，而是注册接口返回 500：

```text
D1_ERROR: no such column: source_key
```

原因是 `flyer_price_history.source_key` 属于兼容旧库的补列，但旧索引 `idx_flyer_price_history_item` 被放在补列之前创建。全新数据库第一次执行 `ensureSchema()` 时会先建不含该列的表，随后立即用该列建索引，因此初始化中断。

处理方式：

- 从基础 `INDEXES` 删除旧索引。
- 保留补列后创建的规范索引 `idx_flyer_price_history_source`。
- 将旧索引加入 `DROPPED_INDEXES`，已有数据库下次初始化时会清理重复索引。

这个问题说明原有源码扫描和纯函数测试无法替代真实服务启动测试。

## 4. 验证证据

可复制命令：

```bash
pnpm run test:integration
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

2026-08-24 本机结果：

- HTTP 集成测试：1/1 通过。
- 原测试套件：217/217 通过。
- vinext 生产构建：通过。
- TypeScript / Wrangler 类型检查：通过。
- ESLint：0 error，10 个原有 warning。
- Prettier：通过。

集成测试覆盖的关键断言：

1. 未登录读取 `/api/inventory` 返回 401。
2. 注册会签发会话 Cookie，`/api/auth` 能读回当前账号。
3. 家庭 A 创建的库存只对家庭 A 可见。
4. 家庭 B 看不到家庭 A 的物品。
5. 家庭 B 按已知 ID 修改或删除家庭 A 的物品均返回 404。
6. 越权尝试后，家庭 A 的物品仍存在。

## 5. 安全边界

- 不连接 Cloudflare 远程 D1 或 R2。
- 每次运行创建独立系统临时目录，结束后删除；设置 `HSP_KEEP_INTEGRATION_STATE=1` 才会保留以便调查。
- 测试配置目录中没有 `.dev.vars`，且 `secrets.required` 为空，因此 Worker 不会收到 `OPENAI_API_KEY`。
- 测试没有访问 AI、邮件或 Flyer 外部服务。
- Windows 清理进程时只对 runner 自己启动并记录 PID 的进程树执行 `taskkill`，不按端口或进程名清理。

## 6. 已知不足

- 当前只有一条端到端场景，尚未覆盖邀请、切换家庭、附件 R2、账号注销、Flyer、菜谱和备份接口。
- 使用的是 vinext 开发服务器，不是部署后的 `dist/server` 包。
- CI 能阻止新错误进入 `main`，但当前发布仍由本地手工执行；自动部署和 staging 尚未建立。
- 现有 10 个 ESLint warning 尚未处理，其中包括 Hook 依赖和 `<img>` 性能提示。
- 用户明确暂缓的安全问题仍然存在，不能把本步骤理解成“安全整改已完成”。

## 7. 给下一位审计者的检查清单

1. 确认 `tests/integration/wrangler.jsonc` 的相对路径不会意外指向生产资源。
2. 在测试路由中临时读取环境绑定，独立验证 `OPENAI_API_KEY` 确实不存在；验证后不要保留暴露密钥状态的接口。
3. 故意删除库存查询中的 `household_id` 条件，确认集成测试会失败，然后还原。
4. 在 Windows 与 Linux 各运行一次，确认服务器进程和临时目录均能清理。
5. 检查 CI 总时长和偶发端口竞争；runner 虽动态分配端口，但从释放端口到启动服务之间仍有很小的竞争窗口。
