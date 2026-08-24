# 006 · 版本化数据库迁移

- 状态：完成，待独立复核
- 日期：2026-08-24
- 目标：让数据库结构变化有可查询、不可悄悄改写的版本历史，并用真实旧 D1 验证升级路径。

## 1. 范围

本步骤完成：

- 新增全局表 `schema_migrations`，记录版本、名称、checksum 和应用时间。
- 建立 `MIGRATIONS` 顺序执行器；已记录版本会校验名称和 checksum。
- 数据库包含当前程序不认识的更高版本时，程序拒绝继续迁移，而不是让旧代码写入新结构。
- 多个 Worker isolate 同时记录同一版本时使用 `INSERT OR IGNORE`，写入后再次读取并核对内容。
- 用 `v1 versioned-migrations-baseline` 接管原先没有版本表的数据库。
- 增加一份真实旧结构 SQL 夹具，连续经历两次独立 Worker 冷启动后直接查询本地 D1。
- 部署和接手文档写明以后新增 v2、v3 的固定步骤与回滚边界。

本步骤没有：

- 连接、修改或部署生产 D1。
- 新增任何删除表、删除列或改写用户数据的 SQL。
- 把原有兼容升级搬进新迁移；历史补列与遗留结构清理仍保持原来的幂等执行方式。
- 实现 down migration 或自动数据库回滚。

## 2. 为什么 v1 是基线

线上数据库在引入版本表前已经经过多轮 `ensureSchema()`。如果现在把几十条历史补列和清理
伪装成一条新迁移，很难证明它与每个线上库的实际中间状态完全一致，也会把一次基础设施
改造变成高风险的生产结构重写。

所以 v1 只做一件事：现有兼容逻辑照常完成后，记录“这份库已经进入版本化时代”。它的
`apply` 是空操作，checksum 固定。下一次真实结构变化从 v2 开始。

历史兼容逻辑暂时继续幂等执行。这不是最终最省查询的形态，但它确保第一个版本化发布不
顺带改变生产清理行为。要退休这段逻辑，应等所有线上库都有 v1 后另做一次独立审计。

## 3. 不可变规则

`migrationHistory()` 在运行待处理版本前检查：

1. 数据库中的每个版本都必须在当前代码中存在；
2. 名称必须一致；
3. checksum 必须一致。

任何一条不成立都会抛内部错误，由现有 HTTP 边界记录并返回统一的 500 文案。迁移错误没有
使用 `UserFacingError`，因此表名、版本细节和数据库状态不会成为用户可见响应。

以后增加版本时：

1. `TABLES` 写最终结构，保证全新数据库不依赖历史偶然状态；
2. `MIGRATIONS` 末尾追加严格递增版本；
3. 升级函数只负责“上一版 → 当前版”，成功返回后 runner 才写迁移记录；
4. 已发布版本的名称、checksum 和执行内容不可修改；修正错误只能加下一版；
5. 扩展旧库夹具和行为断言，再跑两次冷启动。

## 4. 真实升级测试

`tests/integration/legacy-schema.sql` 故意建立一份缺少以下内容的旧库：

- session 的设备字段；
- inventory 的购买日期、余量百分比和 household 范围；
- users 的密码、锁定和角色字段；
- shopping、settings、recipe 等后加字段；
- flyer 的 `source_key`，并保留旧 `store_id`；
- 三张已经废弃的旧表。

`run-schema-migration-tests.mjs` 使用仅供测试的 Wrangler 配置把它装进临时本地 D1，然后：

1. 启动第一个隔离 Worker，用真实 `POST /api/auth` 触发 `ensureSchema()`；
2. 完全关闭 Worker；
3. 用同一 D1 启动第二个冷 isolate，再触发一次；
4. 关闭服务，使用 Wrangler 直接查询 SQLite 结果；
5. 手工插入程序不认识的 v99，再启动 Worker，确认真实 HTTP 请求只得到脱敏 500；
6. 删除整个临时状态目录。

断言覆盖：v1 只有一行且 checksum 为 64 位、session 列已补齐、空库存余量回填为 0、
默认 household 正确、membership 已生成、三张旧表已删除、三张 flyer 表已去掉 `store_id`
并拥有 `source_key`。失败路径还断言响应中不出现 schema、migration、version、checksum 或
伪造的版本号。

第一次测试曾因夹具把默认 household 写成 `default` 而失败；项目真实常量是
`household-default`。迁移结果正确，夹具随后改为使用真实历史值并重跑通过。

## 5. 涉及文件

- `app/api/_shared/schema.ts`：迁移表、v1 基线、历史校验、顺序执行与记录。
- `scripts/run-integration-tests.mjs`：现有 HTTP 测试通过后继续运行迁移套件。
- `scripts/run-schema-migration-tests.mjs`：临时旧 D1、两次冷启动和清理。
- `tests/integration/legacy-schema.sql`：无版本旧库夹具。
- `tests/integration/schema-migration.integration.mjs`：直接查询迁移后数据库。
- `tests/integration/schema-migration-guard.integration.mjs`：数据库版本过新时的真实 HTTP 脱敏失败。
- `tests/error-handling.test.mjs`：让不构造 Response 的 schema 模块保留内部错误；响应边界仍统一脱敏。
- `docs/deploy.md`、`docs/orientation.md`：新增版本与回滚操作说明。
- `README.md`、`README.zh-CN.md`：把“没有迁移历史”的旧说明改为当前真实取舍。

## 6. 验证证据

可复制命令：

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run format:check
pnpm run test:integration
```

2026-08-24 本机结果：

- 类型检查：通过。
- vinext 生产构建：通过。
- 单元/纯函数/源码守卫测试：224/224 通过。
- ESLint：0 error；10 个原有 warning。
- Prettier：通过。
- 原有 HTTP 集成测试：4/4 通过。
- 新增旧库迁移集成测试：4/4 通过。
- 旧库测试完成两次独立 Worker 冷启动，迁移版本仍只有一行。
- Cloudflare 发布 dry-run：通过；D1、R2 与 Assets 绑定正确，未上传。
- 测试使用临时本地 D1/R2 状态；未读取 `.dev.vars`，未连接生产数据库或外部 API。

## 7. 已知边界

- v1 是基线，不是把所有历史 schema 变化重写成完整迁移链；无法从 v0 逐版本重放项目全部历史。
- 历史兼容扫描仍在每个新 isolate 首次请求执行，后续可以在确认所有生产库已有 v1 后独立退休。
- runner 对迁移记录的并发写入做了核对，旧补列也容忍另一个 isolate 刚刚完成同一列；但本步骤没有对未来 v2 的并发 DDL 编写示例，新增迁移应优先使用 D1 `batch()` 和幂等 SQL。
- 没有自动 down migration。应用代码回滚到只认识更低 schema 的版本会主动失败，需要保留最新迁移历史的兼容回滚版本，或修复后向前发布。
- “数据库版本高于程序”已有故意损坏数据库的 HTTP 行为夹具；checksum 篡改仍未单独做第二份夹具。

## 8. 给下一位审计者的检查清单

1. 把 v1 checksum 临时改一位，确认第二次冷启动失败，且响应不包含 checksum、表名或 SQL。
2. 复核 v99 测试的服务端日志包含可定位原因，而 HTTP 响应仍只有统一文案。
3. 新增一个只用于审计分支的 v2（例如可回滚的测试表），验证 apply 成功后才写记录，失败时不写。
4. 并行启动两个指向同一份空 D1 的 Worker，确认只记录一行 v1。
5. 检查未来第一次真实 v2 是否同时修改了 `TABLES` 和旧库升级测试。
6. 生产部署前先确认最近备份可下载，再触发 `POST /api/auth {"action":"signOut"}`，随后只读查询迁移记录。
