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
npx wrangler secret put RESEND_API_KEY     # 不配则登录链接只打到日志
npx wrangler secret put LOGIN_FROM_EMAIL
npx wrangler secret put OPENAI_API_KEY     # 不配则小票识别等功能不可用
```

`REQUIRE_HOUSEHOLD=on` 和 `DEMO_MODE=off` 已经写在 `wrangler.jsonc` 的 `vars` 里。
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

不需要手工跑迁移。`ensureSchema()` 在每个请求上执行，幂等，会补齐缺失的表和列——
**部署新代码就等于迁移了线上库**。

它的边界要知道：

- 加表、加列、加索引：自动
- 改列名、拆表、需要转换数据：做不到，得先写一次性脚本
- 没有回滚。发出去的 schema 变更收不回来

因为它只进不退，**代码回退是安全的**：旧代码不认识新列，只是忽略，不会炸。

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
