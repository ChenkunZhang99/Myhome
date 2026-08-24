# 上线到 Cloudflare

本地开发用 Miniflare 模拟，不需要账号。这份文档只讲把它变成一个真正在线的实例。

## 为什么是 Cloudflare 而不是别处

这个项目从底层就绑在 Cloudflare 上：145 处 `env.DB`（D1）、22 处 D1 专有的
`.batch()`、10 处 `env.UPLOADS`（R2）、一个 Cron Trigger。换成别家意味着重写整个
数据层，而不是改一个部署目标。

## 一次性准备

需要 Cloudflare 账号。**免费版就够**——密码哈希的轮数已经按免费版的
10ms CPU 上限调过（见 `app/api/_shared/password.ts`）。

```bash
npx wrangler login
npx wrangler d1 create home-stock-planner
npx wrangler r2 bucket create home-stock-uploads
```

`d1 create` 会打印一个 `database_id`，把它填进 `wrangler.jsonc` 里替换占位符
`00000000-0000-4000-8000-000000000000`。**这个 id 不是机密**，可以提交。

### 密钥

只有真正的机密走 `secret put`，它们不会出现在版本库里：

```bash
npx wrangler secret put RESEND_API_KEY     # 可选。不配则登录链接只打到日志，注册走「邮箱+密码」那条路
npx wrangler secret put LOGIN_FROM_EMAIL
npx wrangler secret put OPENAI_API_KEY     # 不配则小票识别等功能不可用
```

`REQUIRE_HOUSEHOLD=on`、`DEMO_MODE=off` 和 `OPEN_SIGNUP=on` 已经写在 `wrangler.jsonc` 的 `vars` 里。
`OPEN_SIGNUP=on` 表示谁都能自己注册，各自拿到一个空的家；服务端那把 `OPENAI_API_KEY`
只对 `AI_HOUSEHOLD`（默认是第一个账号接管的默认住户）有效，别人要用模型功能得填自己的。
放在提交进版本库的配置里而不是留成手工步骤，是因为忘记设 `REQUIRE_HOUSEHOLD`
的后果是任何人都能读到这个家的全部库存——那种错误不该靠记性来防。

## 发布

```bash
pnpm run release
```

它会先构建再上传。想先看看会传什么、绑定对不对，而不真的上传：

```bash
pnpm run release:check
```

（脚本叫 `release` 不叫 `deploy`，因为 `pnpm deploy` 是 pnpm 自己的内置命令。）

## 数据库迁移

不需要手工跑迁移。`ensureSchema()` 在请求进入数据库路径时执行，
`schema_migrations` 会记录已经成功应用的版本。当前版本是：

- `v1 versioned-migrations-baseline`：给原先没有版本表的线上库建立基线
- v1 以前的补列、回填和遗留结构清理仍保持原来的幂等逻辑；它们完整跑完后才记 v1
- 后续结构变化从 v2 开始，按版本顺序执行，并在成功后记录版本、名称和 checksum

新增 v2、v3 时必须同时做四件事：

1. 修改 `TABLES`，让全新数据库直接得到最新结构
2. 在 `MIGRATIONS` 末尾追加新版本，负责把上一版升级到这一版
3. 给版本写固定 checksum；已上线版本的名称、checksum 和执行内容永远不能改
4. 扩展 `legacy-schema.sql` 与迁移集成测试，至少覆盖旧库升级和第二次冷启动

`pnpm run test:integration` 会真的创建一份旧 D1，连续启动两次 Worker，再直接查询
迁移记录、回填结果和遗留结构。只扫描源码不算迁移测试。

迁移仍然没有自动 down migration。结构变更上线前要确认最近一次备份可用；失败时优先
修复并向前发布。数据库一旦记下 v2，只有 v1 的旧程序会主动拒绝继续运行，避免旧代码
在不认识的新结构上悄悄写坏数据。若需要回滚应用代码，回滚版本也必须保留同一份迁移
历史和最新 schema 兼容性。

## 把数据搬上去

第一次部署之后线上是空的。用应用自己的导出/导入：

1. 本地 齿轮 → 数据 → **导出全部数据**
2. 打开线上地址，用你的邮箱登录（**第一个账号会接管默认住户**）
3. 齿轮 → 数据 → **整份还原** → 选刚才导出的文件

## 备份

线上的自动备份跟着那个每 6 小时的 cron 走，写进 R2，每个家滚动保留 14 份，
在 齿轮 → 数据 里可以下载。

本地的另有一条：

```bash
pnpm backup                       # 存到 backups/
node scripts/backup-db.mjs D:/某处  # 存到别处，比如网盘目录
```

## 发布流程

一份代码，两个版本：

```
本地 pnpm dev  →  测试通过  →  pnpm run release  →  线上
```

两边的数据库是分开的，本地怎么折腾都碰不到线上那份。要拿真实数据做测试，
从线上导出再在本地整份还原，而不是反过来。
