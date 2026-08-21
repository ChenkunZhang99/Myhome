# 多住户改造设计

当前的数据模型假设全世界只有一户人家：22 张表里没有任何租户键，3 张表的主键写死为 `1`，成员 id 写死为 `member-me`。这份文档描述怎么把它改成能同时服务多户，以及为什么这样改。

**范围**：数据模型与查询作用域。不包含登录鉴权——但第一节说明鉴权将来接在哪里。

---

## 一、租户 id 从哪来

整个改造里，真正昂贵的是「每一条查询都带上租户」这件事，涉及 **165 条 SQL** 中的 121 条。而「怎么知道当前是哪一户」只是一个函数。

把两者分开，是这份设计的核心：

```
resolveHousehold(request) → householdId
```

**第一阶段的实现**：从请求头或 cookie 读取一个格式合法的 id，读不到就回落到默认住户。这保持了今天的行为——单机自用的人什么都不用配。

**将来接鉴权时**：只有这个函数改，121 条查询一条都不用动。

这是唯一需要「以后再说」的部分，其余全部现在做完。

---

## 二、表分成三层

划分依据是一个问题：**这份数据换一户人家看，还是不是同一份？**

### A 层 · 全局（不带租户键）

| 表                    | 说明                                             |
| --------------------- | ------------------------------------------------ |
| `flyer_sources`       | 新增。可自动同步的门店主数据，来自代码里的预设表 |
| `flyer_deals`         | 改为挂 `source_key`，不再挂某一户的门店行        |
| `flyer_deal_metadata` | 跟随 deal                                        |
| `flyer_price_history` | 改为按 `source_key` 累积                         |
| `flyer_sync_settings` | 同步本身变成全局任务，不再属于某一户             |

大统华本周的优惠，对所有人是同一份。**这是整个设计里最重要的一条。**

### B 层 · 租户（带 `household_id`）

| 域   | 表                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 基础 | `household_settings`、`household_members`、`recipe_preferences`                                                         |
| 库存 | `inventory_items`、`inventory_attachments`、`purchase_records`                                                          |
| 菜谱 | `recipe_catalog`、`recipe_attachments`、`recipe_cook_history`、`recipe_ratings`、`recipe_activity_log`、`meal_requests` |
| 采购 | `shopping_items`、`flyer_match_rules`、`flyer_recommendation_feedback`                                                  |
| 门店 | `household_stores`（新增，取代 `stores`）                                                                               |

### C 层 · 本阶段删除

`recipe_suggestions`、`recipe_favorites`。它们已经零写入方，只剩建表语句和一次性回填。

---

## 三、门店为什么要拆

现在的 `stores` 表混了两种东西，而它们的归属完全不同：

```
预设门店   id = store-pricesmart-lougheed   有 source_key   可自动同步
手工门店   id = 随机 UUID                   无 source_key   不能同步
```

预设门店的 id 已经是确定性的，来自代码里的 `lougheedStores`。也就是说**全局身份这个概念本来就存在**，只是没有被表结构表达出来。

拆开之后：

- `flyer_sources`（全局）持有可同步门店的身份、抓取地址、格式
- `household_stores`（租户）表达「这户人家关注哪些门店」，`source_key` 为空的就是手工门店

手工门店不参与同步，所以留在租户层是正确的。

---

## 四、成本模型的变化

这是拆分带来的实际收益。

**现在**：优惠挂在某一户的门店行上。100 户都收藏了大统华，同一份 flyer 就要被解析 100 次，结果完全相同。定时任务每 6 小时遍历「收藏的门店」，模型调用量随用户数线性增长。

**改完**：按「来源 + 本周」解析一次，所有人共享。

```
模型成本   O(住户数 × 门店数)  →  O(门店数)
```

用户越多，单位成本越低。这一条决定了这个产品在商业上能不能成立，所以它必须和租户改造一起做——先做租户再回头拆 flyer，等于把 29 条 flyer 相关的 SQL 改两遍。

---

## 五、迁移

现有数据就是一户人家，全部归到一个固定 id。

**加列**：`ALTER TABLE ... ADD COLUMN household_id TEXT NOT NULL DEFAULT 'household-default'`。带默认值的加列会把已有行一次填好，不需要单独的回填语句。

**拆门店**：`stores` 里有 `source_key` 的行 → 建 `flyer_sources` 记录 + `household_stores` 订阅；没有 `source_key` 的行 → 只建 `household_stores`。

**优惠改挂来源**：`flyer_deals.store_id` 通过 `stores` 换成 `source_key`。

**成员 id 不迁移**。`member-me` 和 `member-family` 这两个固定 id 只需要不再出现在种子语句里——新住户改用随机 id。已有的行保留原 id，因为它们本来就是唯一的字符串，而 `meal_requests`、`recipe_ratings`、`recipe_cook_history` 都在引用它们。**动它们要连带改三张表，不动则零风险。**

---

## 六、分库纪律

单库多租户能用到 10GB。按现在实测的每户约 272KB、活跃住户估计每年约 5MB 计算，够 2000 户·年——足以验证产品是否成立。

但**必须从第一天就守住能拆分的前提**，否则将来迁移就是重写而不是搬运：

1. 每张 B 层表都有 `household_id`
2. 每一条读写 B 层表的语句都带 `household_id`
3. 不存在跨住户的查询

第 3 条是能分库的唯一前提，也是最容易在某次「临时查一下」时被破坏的。

**靠测试守住，不靠记性。** 做法与已有的 `schema-single-source.test.mjs` 一致：扫描 `app/api` 下所有 SQL 字面量，凡是提到 B 层表却不含 `household_id` 的语句即判失败，并指出文件和表名。建表模块与迁移语句是显式豁免项。

---

## 七、实施顺序

拆成七步，每一步都能独立通过测试并发布。中途停下也不会留下坏掉的状态：没改到的表暂时按今天的方式工作。

| 步骤 | 内容                                                                             | 约涉及语句 |
| ---- | -------------------------------------------------------------------------------- | ---------- |
| 1    | `resolveHousehold` 解析器 + 纪律测试（先让测试失败）                             | —          |
| 2    | 基础域：settings、members、preferences                                           | 14         |
| 3    | 库存域：items、attachments、purchase_records                                     | 36         |
| 4    | 菜谱域：catalog、attachments、cook_history、ratings、activity_log、meal_requests | 55         |
| 5    | 采购域：shopping_items、match_rules、feedback                                    | 16         |
| 6    | flyer 分层：拆门店、优惠改挂来源、同步转全局                                     | 38         |
| 7    | 删除两张遗留表，移除回填                                                         | 6          |

第 1 步先把测试写好并让它红着，后面每一步都在减少失败项——**改动进度是可度量的**，不靠感觉。

---

## 八、几个需要留意的点

**定时同步的时区。** 同步变成全局之后就没有「某一户的时区」了。优惠的有效期是门店当地的日期，所以应当跟随 `flyer_sources` 记录的门店时区，而不是任何一户人家的设置。这需要给 `flyer_sources` 加一个时区字段。

**演示数据的播种。** 现在的判断是「库存为空就播种」，改造后要变成「这户人家的库存为空」，否则第二户人家永远拿不到演示数据。

**附件的对象键。** R2 的 key 目前是 `inventory/{itemId}/{attachmentId}`。itemId 已经是 UUID，全局唯一，不需要加住户前缀。但删除时的清理必须同样带上住户作用域，避免删到别人的文件。

---

## 九、明确不做的事

**不做鉴权。** 第一节的解析器就是将来的接入点，届时不需要改任何查询。

**不迁 Durable Object。** 每住户一个 DO 在架构上更好，但那是把刚统一的数据层重写一遍。10GB 足够验证产品，且纪律守住之后迁移是机械工作。

**不引入 ORM。** 手写 SQL 在这个规模下没有问题，而且纪律测试正是靠扫描 SQL 字面量实现的。
