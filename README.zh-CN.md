# 家庭库存与采购规划

[English](README.md) | 中文

Home Stock Planner 是一个面向大温地区华人家庭的中英双语库存管理应用，覆盖采购、入库、日常消耗、补货建议和家庭排餐。

应用运行在 Cloudflare Workers 上，使用 D1 存储结构化数据，使用 R2 存储物品和菜谱图片。

## 本地运行

本地默认进入演示模式，不需要 API 密钥或 Cloudflare 账号。演示数据包含一户家庭的库存、常用超市和当周优惠；需要调用模型的功能会返回预置结果。

```bash
pnpm install
pnpm dev
```

## 功能

### 库存管理

物品支持三种记录精度：粗略余量、可数数量、精确重量或容量。这样区分是因为「半袋米」和「10 个鸡蛋」需要不同的记录方式。单位沿用中文习惯（把、颗、袋、瓶、g、kg、ml、L），每件物品可以记录保质期并显示倒计时，也可以上传包装或标签照片。

### 小票识别

拍摄购物小票后，模型抽取商品名称、数量和价格，再用 bigram 相似度与现有库存比对，为每一项给出「新增」或「合并到已有物品」的建议。用户确认之前不会写入任何数据。

### Flyer 比价与补货建议

系统读取收藏门店的当周优惠，与当前偏少或已用完的物品进行匹配，按缺货紧急度、单位价格和历史价格排序，并受家庭预算和「一次最多逛几家店」的限制。

### 菜谱与排餐

根据库存（临期食材优先）和当周优惠生成菜谱，食材会标注来源是家里已有、需要按优惠购买还是基础调料。家庭成员可以点菜，菜品排进具体日期，做完之后记录实际用量并打分。

## 实现说明

### 补货推荐引擎

核心逻辑在 [`app/flyerRecommendations.ts`](app/flyerRecommendations.ts)，完整规则单独写在 [`docs/flyer-recommendation-rules.md`](docs/flyer-recommendation-rules.md)。规则之所以脱离代码单独维护，是因为它们描述的是关于日用采购的判断，需要能被独立审阅和修改。

主要约束有四条：

产品族之间保持隔离。洗衣球和洗碗球只差一个字，但互相替代的效果很差，因此规则禁止依靠单个汉字（球、液、肉）建立匹配关系。

折扣本身不足以构成推荐理由。标记为「机会购买」的优惠，还必须满足家里已经拥有同款商品，并且当前价格达到已记录的低点。

同一件商品只推荐一次。当多家门店同时对同一商品打折时，系统保留单位价格最低的一家，并注明还有几家也在特价。展示两张内容相同的卡片无法帮助用户做决定，而跨店比价正是这个功能存在的意义。

推荐总量受预算和门店数量约束，避免为了少量差价分散到多家门店。

### 库存数据的更新路径

库存类应用容易失效，通常是因为数据录入之后没有任何机制继续更新它。这里有两条路径负责让数据保持流动。

第一条是采购到入库。勾选采购清单的操作是瞬时完成的，因为用户通常是在超市里边走边勾，此时弹出确认框并不合适。入库统一放到回家之后，在一张批量确认表中与现有库存逐项比对。因此 `shopping_items` 表用 `checked` 和 `stocked` 两个字段分别表示「已购买」和「已入库」。

第二条是做饭到扣减。记录一顿饭时会扣除对应食材，处理原则是单位能够换算时精确计算，无法换算时不做估计（[`app/inventoryUsage.ts`](app/inventoryUsage.ts)）：

| 菜谱用量 | 库存单位 | 处理结果                                                     |
| -------- | -------- | ------------------------------------------------------------ |
| 300 克   | kg       | 扣减 0.3 kg，余量百分比同比例下降（5kg 100% 变为 4.7kg 94%） |
| 2 个     | 枚       | 计数类单位互通，10 枚扣为 8 枚                               |
| 300 克   | 袋       | 无法换算，因为一袋装多少克是未知的                           |

第三种情况决定了整体设计。米面粮油和调味品在无法换算时默认不扣减，因为错误地告知用户大米已经用完，比暂时不更新数字造成的问题更大。

每次扣减都会保存改动前后的快照，撤销时按快照还原；如果某件物品在此期间被手动修改过，还原会跳过它，避免覆盖用户的操作。

### 双语实现

字典和格式化函数在 [`app/i18n.ts`](app/i18n.ts)，目前有 543 条词条。

分类、存放位置和库存等级在数据库中以中文存储，同时这些字符串也参与业务逻辑：匹配引擎按中文关键词划分产品族，代码中存在 `level === "已用完"` 这类判断。翻译存储值会破坏匹配逻辑，并且需要一次数据迁移。

因此翻译分为两个函数。`t()` 负责界面文案，`tv()` 只负责显示层，数据库中始终保留中文规范值。表单提交值不参与翻译，否则被翻译的 `<option>` value 会把英文写入数据库。

这两个方向都由测试约束：

[`stored-values-translated.test.mjs`](tests/stored-values-translated.test.mjs) 会在库中字段直接渲染而未经过 `tv()` 时失败，也会在表单值被 `tv()` 包裹时失败。

[`no-stray-zero.test.mjs`](tests/no-stray-zero.test.mjs) 针对一个已经出现过的问题：SQLite 的布尔列返回 `0` 或 `1`，写成 `{row.flag && <em/>}` 时，React 会把数字 0 渲染到页面上。

### 密钥处理

当前所有接口都没有身份校验，因此服务端不适合保管任何人的 API 密钥。密钥保存在使用者自己浏览器的 `localStorage` 中，随每次请求通过请求头传递，服务端不落库、不回显、也不写入日志（[`app/aiSettings.ts`](app/aiSettings.ts)、[`app/api/_shared/openai.ts`](app/api/_shared/openai.ts)）。

这种方式的限制是定时任务没有浏览器可以询问，因此后台自动同步 flyer 仍然需要在服务端配置密钥。

### 图片压缩

小票照片在上传前会在浏览器中压缩到 1MB 以内（[`app/imageCompression.ts`](app/imageCompression.ts)）。手机拍摄的照片通常在 3 到 5MB，会被托管平台以 413 拒绝。压缩时优先降低画质，其次才降低分辨率，因为小票是文字密集的图像，分辨率直接影响小字的识别效果。

## 技术栈

|          |                                                                                            |
| -------- | ------------------------------------------------------------------------------------------ |
| 运行时   | Cloudflare Workers                                                                         |
| 框架     | [vinext](https://github.com/cloudflare/vinext)（Next.js App Router on Workers）与 React 19 |
| 数据库   | Cloudflare D1（SQLite），22 张表，手写 SQL                                                 |
| 对象存储 | Cloudflare R2                                                                              |
| 定时任务 | Cron Trigger，每 6 小时检查一次 flyer 同步窗口                                             |
| 样式     | Tailwind 4                                                                                 |
| 模型     | OpenAI Responses API，使用 JSON Schema 结构化输出，可选                                    |

```
app/
  page.tsx                 库存主界面
  PlannerPanel.tsx         预算、flyer 与采购清单
  RecipeWorkspace.tsx      菜谱、点菜、排餐与做饭记录
  flyerRecommendations.ts  补货推荐引擎，纯函数，有单元测试
  inventoryUsage.ts        单位换算与库存增减，纯函数，有单元测试
  imageCompression.ts      客户端图片压缩
  i18n.ts                  中英字典与本地化格式化
  Modal.tsx                共享对话框，处理 Esc 关闭、焦点管理与无障碍标注
  api/                     服务端路由
worker/index.ts            Worker 入口与定时任务
docs/                      补货规则规格
tests/                     38 个测试
```

## 命令

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm typecheck` 会先从 `wrangler.jsonc` 重新生成 Cloudflare 绑定类型，然后执行类型检查。`pnpm test` 先构建，再运行渲染冒烟测试和纯逻辑单元测试。Lint 当前没有错误，其中三处 `react-hooks/set-state-in-effect` 豁免都附有注释，说明在当前规模下引入独立数据层并不划算。

## 部署到自己的 Cloudflare 账号

```bash
pnpm exec wrangler d1 create home-stock-planner
pnpm exec wrangler r2 bucket create home-stock-uploads
```

把返回的 `database_id` 填入 `wrangler.jsonc`，然后配置密钥并部署：

```bash
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm build && pnpm exec wrangler deploy
```

Cloudflare Images 是可选的。不配置 `IMAGES` 绑定时，图片优化端点会直接返回原图，其余行为不变。

需要注意的是，当前所有接口都没有身份校验，任何访问者都可以读写数据并触发调用模型的路由。部署到公网之前，应当在整站前面配置 Cloudflare Access，或者保持 `DEMO_MODE=on` 让访问者只能看到演示数据。

## 已知取舍

建表存在两套路径。运行时通过 `CREATE TABLE IF NOT EXISTS` 以及 `PRAGMA` 守卫的补列语句建表，而 `db/schema.ts` 和 `drizzle/` 目前只描述表结构，不参与实际查询。统一到迁移方案是待办项。

没有身份体系。`household_members` 只是数据表中的记录，做饭和评分的归属由用户自行填写。

vinext 处于 beta 阶段（1.0.0-beta.2），API 可能发生变动。

只有 PriceSmart 实现了结构化抓取，其余门店依赖模型的网页搜索降级方案，可靠性明显更低。

「预计还可使用 N 天」目前仍是按紧急度取的固定值（0、3、10、30）。做饭扣减库存的功能上线后已经具备真实的消耗数据，但这部分计算尚未实现。
