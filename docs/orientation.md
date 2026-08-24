# 上手指南（写给接手的模型）

这份文档回答的是「怎么在这个仓库里动手」。

另外两份不要混：[`rebuild-manual.md`](rebuild-manual.md) 讲**为什么**——领域规则和已经付过代价的坑，换语言重写时也成立；[`README.zh-CN.md`](../README.zh-CN.md) 讲**是什么**，给外部读者看。这份讲**怎么做**，只对这个仓库、这台机器有效。

---

## 一、当前状态

线上是一个**真的有陌生用户在用**的站点，不是玩具：

```
https://home-stock-planner.mm10237207.workers.dev
3 个账号（其中 2 个不是部署者本人）· 3 个家庭 · 71 件库存 · 549 条优惠
```

**改动会直接影响真人的数据。** 部署者自己那 69 件库存是他家真实的东西，丢了没法重来（有 R2 自动备份，但那是最后一道防线，不是可以随便试的理由）。

技术栈：Cloudflare Workers + D1 + R2，vinext（Next.js App Router on Workers）+ React 19，TypeScript，无 ORM 手写 SQL。

---

## 二、三个必须先理解的设计

不理解这三条，改动会以很隐蔽的方式出错。

### 1. 住户是「指针」，不是「归属」

`users.household_id` 的含义是「这个人**现在正在看**哪个家」，不是「他属于哪个家」。谁能进哪个家由 `household_memberships`（多对多）决定。

这么设计是为了省下一百多条 SQL：`resolveHousehold()` 照样从这个指针取值，所有带 `household_id` 的业务查询一条都不用改，切换家庭就只是「验一下资格，改这个指针」。

**推论**：任何拿到 `household_id` 就去查数据的地方，都默认这个指针是可信的。所以撤销一个人的资格时**必须同时挪走他的指针**，否则他照样读得到。兜底在 `currentAccount()` 里（发现没有对应 membership 就自动挪走），别依赖调用点自己记得。

### 2. 建表只有一个来源

28 张表全部定义在 `app/api/_shared/schema.ts`，每个路由处理请求前调 `ensureSchema()`。**不要在别处写 `CREATE TABLE`** —— `schema-single-source.test.mjs` 会扫出来并指名道姓。

`ensureSchema` 用 `once()` 包着，每个 isolate 只跑一次。这有个反直觉的后果见第四节。

### 3. 守卫测试盯的是「源码长什么样」

217 个测试里有相当一部分不是行为测试，而是**用字符串匹配扫源码**的纪律检查。比如：

| 测试                       | 拦的是                                          |
| -------------------------- | ----------------------------------------------- |
| `household-scoping`        | 任何一条碰租户表却不带 `household_id` 的 SQL    |
| `household-membership`     | 用到请求里的 `household_id` 却没先验 membership |
| `sql-bindings`             | 占位符个数和 `.bind()` 参数个数对不上           |
| `schema-single-source`     | 在 `schema.ts` 之外建表                         |
| `shared-key-quota`         | 调模型却没走计数版取密钥函数                    |
| `error-handling`           | 把异常原文回给调用方                            |
| `stored-values-translated` | 存储值没过 `tv()` 就渲染                        |

**它们会因为你改了函数名或格式而假失败。** 这不是测试坏了，是它们靠字面量定位。遇到红灯先判断是「规则被破坏」还是「锚点失效」——两种都常见。改锚点时别顺手把断言意图也改软了。

锚点本身也容易选错：`indexOf("return Response.json({")` 会命中前面的提前返回，`lastIndexOf` 又会命中 catch 里的错误返回。锚要选得够具体。

反过来也要知道它们的**盲区**：没有任何一个测试真的启动服务发 HTTP 请求。它们能防住「有人删掉了那行检查」，防不住「那行检查逻辑本身写错了」。历史上 `storePreset` 只认写死的三家、`consumeInventory` 没传住户、`recipe_preferences` upsert 写错列，全是手工发请求才发现的。**改完关键路径要真的打一次请求。**

---

## 三、代码在哪

```
app/
  page.tsx                  库存主界面（很大，1900+ 行）
  PlannerPanel.tsx          预算、Flyer、购物清单
  RecipeWorkspace.tsx       菜谱、点菜、排餐、做饭记录
  inventoryUsage.ts         ★ 数量/百分比/单位换算，纯函数，改这里先读第五节
  flyerRecommendations.ts   ★ 补货推荐排序，纯函数
  i18n.ts                   中英字典（~850 条），存储值永远是中文
  api/_shared/schema.ts     ★ 全部建表，唯一来源
  api/_shared/openai.ts     ★ 密钥来源与 20 次共享额度
  api/_shared/household.ts  住户解析、指针自愈
  api/flyers/sync/          四条 flyer 读取路径
    pricesmart.ts             连锁自有结构化接口（只有这一家写了）
    flipp.ts                  Flipp 聚合平台，零 token，覆盖二十多家连锁
    visionFlyer.ts            读 flyer 图片（visionShape.ts 是可测的纯逻辑）
    flyerNaming.ts            英文商品名 → 中文名与分类，对照表，不调模型
docs/rebuild-manual.md      为什么（领域规则）
docs/multi-household-design.md  多住户设计，第十节是最终形态
```

标 ★ 的是改动风险最高的。

---

## 四、环境陷阱（这一节能省你几十分钟）

### heredoc 会吃掉反斜杠

用 `cat > x.mjs <<'EOF'` 写脚本时，`\s` `\d` `\/` `\n` 有可能被吃掉一层，变成 `s` `d` `/` 换行。**这是这个环境里最高频的坑**，开发期间反复出现过五次以上：一次差点让菜谱去重把标题里的字母 s 全删掉，一次让邮编判断从 `[A-Z][0-9][A-Z]` 变成永远匹配不上的 `[A-Z]d[A-Z]`，还有一次就发生在往这份文档里写这一段的时候。

对策：

- 需要正则的地方尽量改用 `String.includes()`
- 非用不可时改用字符过滤：`[...s].filter(c => c >= "0" && c <= "9")`
- 换行用 `String.fromCharCode(10)`
- 复杂内容直接用 Write 工具写文件，别过 shell

### `ensureSchema` 每 isolate 只跑一次

刚部署完新表，**立刻查数据库会看不到**。要先发一个真正会走到 `ensureSchema()` 的请求：`GET /api/auth` 在没有 cookie 时会提前返回，用 `POST /api/auth {"action":"signOut"}`。

### 部署前要先停本地 dev server

`pnpm run release` 会先 build 再上传，dev server 占着 `dist/` 会出问题。停法：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

### 在 Node 里 import 应用代码

`app/inventoryUsage.ts` 这类纯模块可以直接测：

```bash
node --experimental-strip-types -e 'import { adjustQuantity } from "file:///C:/Users/29740/Desktop/home-stock-planner/app/inventoryUsage.ts"; ...'
```

Windows 上**必须用 `file://` URL**，相对路径和 `C:/` 都会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

但 `app/api/_shared/*` 大多 import 了 `cloudflare:workers`，Node 解析不了。**这就是为什么纯逻辑要拆出去**——`visionShape.ts` 从 `visionFlyer.ts` 拆出来就是为了能被测到，`recipeShape.ts` 同理。写新模块时如果里面有值得测的纯逻辑，一开始就拆。

### commit message 只能写英文

一个中文字都不行。风格照仓库已有的：一行、祈使句、句首大写、结尾不加句号。

万一写成中文并且推了：逐个 `git cherry-pick --no-commit <sha> && git commit -m "English"` 重放到新分支，用 `git diff --quiet` 校验内容一字未变，再 `--force-with-lease`。**`git filter-branch` 会被权限分类器拦下**，别走那条路。

### 生产测试数据用 `@e2e.test`

线上验证要建账号时，邮箱一律用 `xxx@e2e.test`。**验完一定要清**——线上有真实用户，别留垃圾。

```sql
-- npx wrangler d1 execute home-stock-planner --remote --file cleanup.sql -y
-- 顺序要紧：先按 membership 反查出这些账号的家，逐表删完，最后才删 membership 本身
DELETE FROM inventory_items   WHERE household_id IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM household_stores  WHERE household_id IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM household_settings WHERE household_id IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM household_members WHERE household_id IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM ai_quota          WHERE household_id IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM households        WHERE id           IN (SELECT household_id FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test'));
DELETE FROM household_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');
DELETE FROM sessions              WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');
DELETE FROM users WHERE email LIKE '%@e2e.test';
```

清完对一眼：`SELECT email FROM users;` 应当只剩真实用户。

---

## 五、数量和百分比：唯一一条规则

每件物品同时记 `quantity` 和 `remaining_percent`。它们不能矛盾，由同一条规则互推：

```
满量 = 当前数量 ÷ (当前百分比 ÷ 100)
```

**满量不存在任何地方**，每次现算。三个函数（`adjustQuantity`、`adjustRemaining`、`restock`）必须对满量用同一个定义，有测试钉着「减 1 个」和「减 25%」在满量 4 上落到同一处。

```
4 个 100%  −1  →  3 个 75%
4 个 100%  +1  →  5 个 100%   （满量变成 5）
5 个 100%  −1  →  4 个 80%    （新满量的五分之四）
```

存满量会坏在第三行：加一次再减一次又报 100%，一件用过的东西悄悄变回满的。

写入端 `reconcileStock()` 守着另一半：任一为 0 则两者都归 0。曾经分开验，`{quantity: 5, remainingPercent: 0}` 能存进库。

---

## 六、Flyer 读取：四条路，按顺序试

| 顺序 | 方式         | 模型开销 | 现状                       |
| ---- | ------------ | -------- | -------------------------- |
| 1    | 连锁自有接口 | 无       | 只有 PriceSmart 写了       |
| 2    | Flipp        | 无       | 覆盖二十多家连锁，主力     |
| 3    | 视觉读图     | 一次     | 亚洲超市（flyer 是整张图） |
| 4    | 模型网页搜索 | 一次     | 兜底，最不可靠             |

要点：

- **Flipp 用的是 `/flipp/flyers` + `/flipp/flyers/{id}` 两步**，不是 `/items/search`。后者是搜索接口，空查询返回默认推荐（实测全是 IKEA、RONA），不是杂货。
- Flipp 只认**完整六位邮编**，给 FSA（前三位）会回 422，所以要补成 `V3J0A1`。
- **Flipp 是无文档接口**，所有失败返回空数组不抛异常，每次读取记日志（`scope: "flyers.flipp"`，含 `raw`/`kept` 条数）——它失效的样子是优惠悄悄变少，不是报错。
- 视觉读图**不稳定**：同一张图跑两次 18 项里只有 6 项一致。所以它读出来的标 `vision` 可信度，界面显示「图片识别，到店核对」。**不要把它和结构化来源混成一个可信度。**
- 整份 flyer 都存（上限 300/店）。曾经只留 18 条，等于在匹配库存**之前**扔掉 87%——而匹配发生在浏览器里。

---

## 七、动手流程

```bash
pnpm dev                    # 本地，用 .dev.vars，连本地 D1
pnpm typecheck              # 会先重新生成 wrangler 绑定类型
pnpm test                   # 会先 build
pnpm run lint               # 10 条 warning 是既有的，0 error 才算过
npx prettier --check .
```

**四步全绿才能部署。** 开发期间发生过一次「测试红着就部署」，别重复。

```bash
pnpm run release            # build + wrangler deploy
```

部署后**去线上真打一次请求**验证，别只看部署成功。

提交按文件路径分组，一行英文 commit，做完一项就推。

---

## 八、已知缺口

按优先级，都还没做：

1. **限流** —— 全库没有任何限流。20 次额度堵住了最花钱的路，但零成本路径（Flipp、数据库写入）仍然敞着。
2. **错误监控** —— 没有 Sentry 之类。陌生人遇到 500，除非正在跑 `wrangler tail` 否则不知道。现有日志已经是结构化 JSON（`scope` 字段），接出去成本很低。
3. **HTTP 集成覆盖仍然很窄** —— 已有真实服务测试守住注册、会话生命周期和库存跨户隔离，但邀请、附件、注销、Flyer、菜谱和备份还没有走真实 HTTP。
4. **门店目录只进不出** —— 按邮编搜出来的店永远留着，错地址无处举报。
5. **PWA manifest** —— 手机不能加到主屏，而这是个「站在超市里用」的应用。
6. **发信服务未配** —— 没有 `RESEND_API_KEY`，忘记密码 = 永久锁死。界面已经如实说明并隐藏了那个入口。
7. **JS 渲染 + 不在 Flipp 的门店** 没有任何读取方式覆盖（目前实际数量为 0，先别投入）。

最近关闭：

- **真实 HTTP 测试基础** —— 隔离的本地 D1/R2、身份和跨户库存场景已进入 CI；见 [`audits/001-integration-test-foundation.md`](audits/001-integration-test-foundation.md)。
- **安全响应头** —— Worker 统一出口已加 CSP、HSTS、X-Frame-Options 等策略；见 [`audits/002-security-headers.md`](audits/002-security-headers.md)。
- **会话管理** —— 改密码会原子轮换会话，用户可以查看设备并逐个、批量退出；见 [`audits/003-session-management.md`](audits/003-session-management.md)。

---

## 九、判断一个改动做得对不对

来自 `rebuild-manual.md`，但值得在这里重复：

**标准是「有没有减少做饭那个人的决策负担」。** 增加录入负担而不减少决策负担的功能，方向就是错的。

以及一条这个项目反复验证过的：**宁可少给一条信息，也不要给一条错的。** 一个读错的价格会让人白跑一趟超市，比不提这条优惠更糟。视觉读图的可信度标签、Flipp 的对照表宁可保留英文原名、单位换不出来就不扣库存，都是同一条原则的不同面。
