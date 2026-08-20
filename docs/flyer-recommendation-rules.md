---
name: flyer-stock-recommender
description: Rank current supermarket flyer deals against household inventory and explain targeted or category-level replenishment recommendations. Use for low-stock deal matching, household-supply restocking, meat or produce category replenishment, flyer overlap planning, and adding reviewed recommendations to a shopping list.
---

# Flyer Stock Recommender

Generate reviewable replenishment recommendations from current inventory and valid flyer deals.

## Workflow

1. Use only saved or favorite stores and deals whose validity window includes the planning date.
2. Normalize Chinese and English product names, package sizes, and common unit aliases before matching.
3. Assign stock urgency: 已用完 > 即将用完 > 偏少 > 充足. Treat quantity zero as 已用完 and expose an editable estimated-days-left explanation.
4. Classify the relationship as a targeted match (same product), substitute match (same product family or a saved manual rule), or category match (category opportunity). Keep 洗衣用品 and 洗碗用品 in separate families.
5. Classify the decision as 必须补货, 建议补货, or 机会购买. Opportunity purchases require the household to already own the same product and a strong discount or recorded historical low.
6. Normalize package sizes and compare unit prices. Keep the original flyer pricing unit visible and editable.
7. Rank by decision tier, match specificity, stock urgency, discount depth, price history, and how soon the flyer ends.
8. Recommend each product only once. When the same product is on sale at several stores, keep the lowest unit price and note how many other stores also carry it. Two identical cards give the household nothing to choose between, and comparing stores is the whole point.
9. Apply household food and supply budgets, then select the highest-value stores without exceeding maxStores. Show the common validity window when one exists.
10. Show source URL, confidence, last verification time, historical average/low, and a short reason tied to inventory evidence.
11. Allow confirmation actions: add to list, save deal, edit and remember the match, ignore once, suppress the product family, or create recipes from a food deal.

## Product-family rules

- 洗碗：洗碗球、洗碗块、洗碗凝珠、洗碗粉、洗洁精
- 洗衣：洗衣球、洗衣凝珠、洗衣液、洗衣粉
- 纸品：卫生纸、厕纸、纸巾、厨房纸
- Meat subfamilies may match exactly; otherwise fall back to the 肉类海鲜 category.
- Require a product-family match for 清洁用品 and 洗护用品; do not fall back across those whole categories.
- Do not match on generic characters such as 球、液、肉 alone.

## Guardrails

- Do not recommend a sufficient item merely because it is discounted.
- Do not compare product quality or invent a regular price.
- Mark fuzzy matches as suggestions and keep them editable.
- Never change inventory or add a shopping-list item without user confirmation.
- Prefer one useful store trip over tiny savings spread across many stores when store limits are available.
- Preserve manual match rules, suppression feedback, saved deals, and price history in durable household storage.
- A background refresh must obey enabled state and next-sync time, and must retain previously verified still-valid data when a store cannot be read.
