import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const inventoryItems = sqliteTable("inventory_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  location: text("location").notNull().default("未分类"),
  precision: text("precision").notNull().default("quantity"),
  quantity: real("quantity").notNull().default(1),
  unit: text("unit").notNull().default("件"),
  remainingPercent: integer("remaining_percent").notNull().default(100),
  level: text("level").notNull().default("充足"),
  purchaseDate: text("purchase_date"),
  expiryDate: text("expiry_date"),
  /** 开封日。牛奶未开封能放两周，开了三天就得喝完，酱料腌菜同理。 */
  openedDate: text("opened_date"),
  /** 开封后的可用天数，与 expiryDate 取更早的那个作为实际到期日。 */
  openedShelfLifeDays: integer("opened_shelf_life_days"),
  note: text("note").notNull().default(""),
  source: text("source").notNull().default("manual"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const inventoryAttachments = sqliteTable(
  "inventory_attachments",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_inventory_attachments_item_id").on(table.itemId)],
);

export const householdSettings = sqliteTable("household_settings", {
  id: integer("id").primaryKey().default(1),
  city: text("city").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  foodBudget: real("food_budget").notNull().default(0),
  householdBudget: real("household_budget").notNull().default(0),
  maxStores: integer("max_stores").notNull().default(2),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const recipePreferences = sqliteTable("recipe_preferences", {
  id: integer("id").primaryKey().default(1),
  allergies: text("allergies").notNull().default(""),
  avoidFoods: text("avoid_foods").notNull().default(""),
  dislikes: text("dislikes").notNull().default(""),
  notes: text("notes").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const stores = sqliteTable(
  "stores",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    address: text("address").notNull().default(""),
    sourceKey: text("source_key"),
    flyerUrl: text("flyer_url").notNull().default(""),
    flyerFormat: text("flyer_format").notNull().default("manual"),
    lastSyncedAt: text("last_synced_at"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_stores_source_key").on(table.sourceKey)],
);

export const flyerDeals = sqliteTable(
  "flyer_deals",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id").notNull(),
    itemName: text("item_name").notNull(),
    category: text("category").notNull().default("其他"),
    price: real("price").notNull(),
    regularPrice: real("regular_price"),
    unit: text("unit").notNull().default("件"),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to").notNull(),
    source: text("source").notNull().default("manual"),
    sourceUrl: text("source_url").notNull().default(""),
    sourceFingerprint: text("source_fingerprint"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_flyer_deals_valid_to").on(table.validTo),
    index("idx_flyer_deals_store_source").on(table.storeId, table.source),
  ],
);

export const flyerSyncSettings = sqliteTable("flyer_sync_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  intervalHours: integer("interval_hours").notNull().default(24),
  nextSyncAt: text("next_sync_at"),
  lastStartedAt: text("last_started_at"),
  lastCompletedAt: text("last_completed_at"),
  lastStatus: text("last_status").notNull().default("never"),
  lastMessage: text("last_message").notNull().default("尚未自动同步"),
  dealsImported: integer("deals_imported").notNull().default(0),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const flyerDealMetadata = sqliteTable("flyer_deal_metadata", {
  dealId: text("deal_id").primaryKey(),
  itemKey: text("item_key").notNull().default(""),
  packageQuantity: real("package_quantity"),
  packageUnit: text("package_unit").notNull().default(""),
  confidence: text("confidence").notNull().default("medium"),
  verifiedAt: text("verified_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  isSaved: integer("is_saved", { mode: "boolean" }).notNull().default(false),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const flyerPriceHistory = sqliteTable(
  "flyer_price_history",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id").notNull(),
    storeId: text("store_id").notNull(),
    itemKey: text("item_key").notNull(),
    itemName: text("item_name").notNull(),
    price: real("price").notNull(),
    regularPrice: real("regular_price"),
    unit: text("unit").notNull().default("件"),
    packageQuantity: real("package_quantity"),
    packageUnit: text("package_unit").notNull().default(""),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to").notNull(),
    observedAt: text("observed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_flyer_price_history_item_store").on(table.itemKey, table.storeId, table.observedAt),
    index("idx_flyer_price_history_deal").on(table.dealId),
  ],
);

export const flyerMatchRules = sqliteTable(
  "flyer_match_rules",
  {
    id: text("id").primaryKey(),
    inventoryName: text("inventory_name").notNull(),
    dealPattern: text("deal_pattern").notNull(),
    category: text("category").notNull().default(""),
    matchKind: text("match_kind").notNull().default("substitute"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_flyer_match_rules_pattern").on(table.dealPattern, table.active)],
);

export const flyerRecommendationFeedback = sqliteTable(
  "flyer_recommendation_feedback",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id"),
    itemPattern: text("item_pattern").notNull().default(""),
    storeId: text("store_id"),
    action: text("action").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_flyer_feedback_action_pattern").on(table.action, table.itemPattern)],
);

export const shoppingItems = sqliteTable(
  "shopping_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    quantity: real("quantity").notNull().default(1),
    unit: text("unit").notNull().default("件"),
    category: text("category").notNull().default("其他"),
    checked: integer("checked", { mode: "boolean" }).notNull().default(false),
    stocked: integer("stocked", { mode: "boolean" }).notNull().default(false),
    source: text("source").notNull().default("manual"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_shopping_items_checked").on(table.checked)],
);

export const recipeSuggestions = sqliteTable("recipe_suggestions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  reason: text("reason").notNull().default(""),
  origin: text("origin").notNull().default("库存优先"),
  icon: text("icon").notNull().default("🍲"),
  cookTime: text("cook_time").notNull().default("30 分钟"),
  difficulty: text("difficulty").notNull().default("简单"),
  servings: integer("servings").notNull().default(2),
  ingredientsJson: text("ingredients_json").notNull().default("[]"),
  stepsJson: text("steps_json").notNull().default("[]"),
  generatedAt: text("generated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const recipeFavorites = sqliteTable(
  "recipe_favorites",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    reason: text("reason").notNull().default(""),
    origin: text("origin").notNull().default("库存优先"),
    icon: text("icon").notNull().default("🍲"),
    cookTime: text("cook_time").notNull().default("30 分钟"),
    difficulty: text("difficulty").notNull().default("简单"),
    servings: integer("servings").notNull().default(2),
    ingredientsJson: text("ingredients_json").notNull().default("[]"),
    stepsJson: text("steps_json").notNull().default("[]"),
    favoritedAt: text("favorited_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_favorites_favorited_at").on(table.favoritedAt)],
);

export const recipeCatalog = sqliteTable(
  "recipe_catalog",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    reason: text("reason").notNull().default(""),
    origin: text("origin").notNull().default("家庭自建"),
    icon: text("icon").notNull().default("🍲"),
    cookTime: text("cook_time").notNull().default("30 分钟"),
    difficulty: text("difficulty").notNull().default("简单"),
    servings: integer("servings").notNull().default(2),
    ingredientsJson: text("ingredients_json").notNull().default("[]"),
    stepsJson: text("steps_json").notNull().default("[]"),
    tagsJson: text("tags_json").notNull().default("[]"),
    mealTypesJson: text("meal_types_json").notNull().default("[]"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
    isCustom: integer("is_custom", { mode: "boolean" }).notNull().default(false),
    cookedCount: integer("cooked_count").notNull().default(0),
    lastCookedAt: text("last_cooked_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_catalog_updated_at").on(table.updatedAt)],
);

export const recipeAttachments = sqliteTable(
  "recipe_attachments",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_attachments_recipe_id").on(table.recipeId)],
);

export const householdMembers = sqliteTable("household_members", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull().default("🙂"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const mealRequests = sqliteTable(
  "meal_requests",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    memberId: text("member_id").notNull(),
    desiredFrom: text("desired_from"),
    desiredTo: text("desired_to"),
    mealType: text("meal_type").notNull().default(""),
    priority: text("priority").notNull().default("想吃"),
    servings: integer("servings").notNull().default(2),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("candidate"),
    scheduledDate: text("scheduled_date"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_meal_requests_status_date").on(table.status, table.scheduledDate)],
);

export const recipeCookHistory = sqliteTable(
  "recipe_cook_history",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    requestId: text("request_id"),
    cookedDate: text("cooked_date").notNull(),
    mealType: text("meal_type").notNull().default(""),
    servings: integer("servings").notNull().default(2),
    cookMemberId: text("cook_member_id").notNull(),
    notes: text("notes").notNull().default(""),
    consumptionJson: text("consumption_json").notNull().default("[]"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_cook_history_recipe_date").on(table.recipeId, table.cookedDate)],
);

export const recipeRatings = sqliteTable(
  "recipe_ratings",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    memberId: text("member_id").notNull(),
    rating: integer("rating").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_ratings_recipe_id").on(table.recipeId)],
);

export const recipeActivityLog = sqliteTable(
  "recipe_activity_log",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id"),
    memberId: text("member_id"),
    action: text("action").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_recipe_activity_log_created_at").on(table.createdAt)],
);

/**
 * 每次购买的价格明细。来源是小票识别或入库时手填。
 * 有了它，预算才能和真实花费比较，也才能判断某个 flyer 价是不是真的划算。
 */
export const purchaseRecords = sqliteTable(
  "purchase_records",
  {
    id: text("id").primaryKey(),
    /** 关联到库存物品；物品被删掉后记录仍保留，用于历史统计。 */
    inventoryId: text("inventory_id"),
    name: text("name").notNull(),
    category: text("category").notNull().default("其他"),
    quantity: real("quantity").notNull().default(1),
    unit: text("unit").notNull().default("件"),
    /** 实付单价。小票上有折扣时记折后价。 */
    unitPrice: real("unit_price").notNull().default(0),
    /** 原价，仅在小票能读出折扣时才有值。 */
    regularUnitPrice: real("regular_unit_price"),
    /** 该行实付总额，等于 unitPrice × quantity，但以小票为准。 */
    lineTotal: real("line_total").notNull().default(0),
    store: text("store").notNull().default(""),
    purchaseDate: text("purchase_date").notNull(),
    source: text("source").notNull().default("receipt"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_purchase_records_date").on(table.purchaseDate),
    index("idx_purchase_records_name").on(table.name),
  ],
);

/** 邮件提醒设置。没填邮箱就什么都不发。 */
export const notificationSettings = sqliteTable("notification_settings", {
  id: integer("id").primaryKey().default(1),
  email: text("email").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** 本地时间的发送小时（0-23），定时任务每 6 小时检查一次是否到点。 */
  sendHour: integer("send_hour").notNull().default(8),
  /** 上次成功发送的日期，用来保证一天只发一封。 */
  lastSentDate: text("last_sent_date"),
  lastStatus: text("last_status").notNull().default("never"),
  lastMessage: text("last_message").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
