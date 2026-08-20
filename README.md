# Home Stock Planner

[![CI](https://github.com/ChenkunZhang99/Myhome/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenkunZhang99/Myhome/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

Home Stock Planner is a bilingual household inventory application for Chinese-speaking families in Metro Vancouver, covering shopping, stocking, daily consumption, restocking suggestions and family meal planning.

The application runs on Cloudflare Workers, using D1 for structured data and R2 for item and recipe photos.

## Running locally

The local setup starts in demo mode and requires no API key or Cloudflare account. The demo data includes one household's inventory, its usual supermarkets and the current week's deals; features that would call a model return prepared results instead.

```bash
pnpm install
pnpm dev
```

## Features

### Inventory

Items support three levels of precision: a rough remaining percentage, a countable quantity, or an exact weight or volume. The distinction exists because half a bag of rice and ten eggs need to be recorded differently. Units follow Chinese conventions (把, 颗, 袋, 瓶, g, kg, ml, L), each item can carry a best-before date with a countdown, and packaging or label photos can be attached.

### Receipt scanning

After photographing a receipt, a model extracts item names, quantities and prices, then bigram similarity compares them against existing stock and proposes either adding a new item or merging into an existing one. Nothing is written to the database until the user confirms.

### Flyer comparison and restocking

The system reads the current week's deals from saved stores, matches them against items that are running low or already out, and ranks them by stock urgency, unit price and price history, within the household budget and a limit on how many stores to visit in one trip.

### Recipes and meal planning

Recipes are generated from current stock, prioritising items close to expiry, together with the week's deals. Each ingredient is labelled as already at home, worth buying on sale, or a pantry staple. Family members can request meals, meals are scheduled to specific dates, and cooking is logged with actual amounts and a rating.

## Implementation notes

### The restocking engine

The core logic lives in [`app/flyerRecommendations.ts`](app/flyerRecommendations.ts), with the full ruleset kept separately in [`docs/flyer-recommendation-rules.md`](docs/flyer-recommendation-rules.md). The rules are maintained outside the code because they describe judgement about groceries, which needs to be reviewed and revised on its own terms.

Four constraints matter most.

Product families stay isolated. 洗衣球 (laundry) and 洗碗球 (dishwasher) differ by a single character but substitute poorly for each other, so the rules forbid building a match on any single character such as 球, 液 or 肉.

A discount by itself is not sufficient grounds for a recommendation. A deal marked as an opportunity buy must additionally meet two conditions: the household already owns the same product, and the current price has reached a recorded low.

Each product is recommended once. When several stores discount the same item, the system keeps the lowest unit price and notes how many other stores also carry it. Showing two cards with identical content does not help anyone decide, and store comparison is the reason the feature exists.

The total number of recommendations is bounded by budget and store count, so that small savings do not end up scattered across several trips.

### How the inventory stays current

Inventory applications tend to fall out of date because nothing updates the data after it is entered. Two paths keep it moving here.

The first runs from purchase to stock. Ticking items off the shopping list happens immediately, because the user is usually walking through a supermarket and a confirmation dialog is unsuitable in that moment. Stocking is deferred until afterwards, in a single batch review that compares each item against existing stock. The `shopping_items` table therefore uses `checked` and `stocked` as separate fields for "bought" and "added to inventory".

The second runs from cooking to deduction. Logging a meal deducts its ingredients, calculating precisely where the units convert and declining to estimate where they do not ([`app/inventoryUsage.ts`](app/inventoryUsage.ts)):

| Recipe amount | Stock unit | Result                                                                                           |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| 300 g         | kg         | Deducts 0.3 kg; the remaining percentage falls proportionally (5kg at 100% becomes 4.7kg at 94%) |
| 2 个          | 枚         | Count units are interchangeable, so 10 eggs become 8                                             |
| 300 g         | 袋         | Not convertible, since the number of grams in a bag is unknown                                   |

The third case shaped the overall design. Grains and condiments are left untouched when conversion is impossible, because incorrectly telling someone the rice is gone causes more trouble than leaving the number alone for a while.

Every deduction saves a before and after snapshot. Undo restores from that snapshot, and skips any item that was edited in the meantime so the user's own changes are not overwritten.

### One file holds the schema

The definitions for all 22 tables, along with their indexes, added columns and backfills, live in [`app/api/_shared/schema.ts`](app/api/_shared/schema.ts). Every route calls the same `ensureSchema()` before handling a request.

The earlier arrangement had each route maintain the tables it happened to use. That caused two failures. In one, the planner route queried `purchase_records` while the statement creating that table sat in another route's initialiser, and the endpoint returned a 500. The second was quieter: the recipe workspace initialiser ran `DELETE FROM recipe_favorites`, a table only the recipes route created, so on a fresh database the page a visitor opened first determined whether anything broke.

SQL lives in strings, so neither the type checker nor the build can see problems of this kind. [`schema-single-source.test.mjs`](tests/schema-single-source.test.mjs) scans every SQL statement under `app/api`, extracts the tables being read and written, and compares them against the declared table names. A table with no creating statement fails the test and names the file and the table. The same test rejects any new `CREATE TABLE` written outside `schema.ts`.

`ensureSchema()` is wrapped in [`once()`](app/api/_shared/once.ts) so it runs once per isolate. Tables and indexes go out as a single `batch()`. Added columns run outside that batch, because their backfill statements need to see the column that was just added.

### Bilingual support

The dictionary and formatters live in [`app/i18n.ts`](app/i18n.ts) and currently hold 543 entries.

Categories, storage locations and stock levels are stored in Chinese, and those same strings participate in business logic: the matching engine groups product families by Chinese keywords, and the code contains comparisons such as `level === "已用完"`. Translating the stored values would break matching and require a data migration.

Translation is therefore split across two functions. `t()` handles interface copy, while `tv()` handles the display layer only, leaving the canonical Chinese in the database. Form submission values are excluded from translation, since a translated `<option>` value would write English into the database.

Both directions are enforced by tests.

[`stored-values-translated.test.mjs`](tests/stored-values-translated.test.mjs) fails when a stored field is rendered without passing through `tv()`, and also fails when a form value is wrapped in `tv()`.

[`no-stray-zero.test.mjs`](tests/no-stray-zero.test.mjs) covers a problem that already occurred once: SQLite boolean columns return `0` or `1`, and written as `{row.flag && <em/>}`, React renders the number 0 onto the page.

### Key handling

None of the endpoints check identity at present, which makes the server an unsuitable place to hold anyone's API key. Keys are stored in the visitor's own browser `localStorage` and passed with each request in a header. The server does not persist, echo or log them ([`app/aiSettings.ts`](app/aiSettings.ts), [`app/api/_shared/openai.ts`](app/api/_shared/openai.ts)).

The limitation of this approach is that the scheduled job has no browser to ask, so background flyer syncing still requires a key configured on the server.

### Image compression

Receipt photos are compressed below 1MB in the browser before upload ([`app/imageCompression.ts`](app/imageCompression.ts)). Phone photos usually run between 3 and 5MB and are rejected by the hosting platform with a 413. Compression reduces quality first and resolution only afterwards, because receipts are dense text and resolution is what keeps small print legible.

## Stack

|                |                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------- |
| Runtime        | Cloudflare Workers                                                                           |
| Framework      | [vinext](https://github.com/cloudflare/vinext) (Next.js App Router on Workers) with React 19 |
| Database       | Cloudflare D1 (SQLite), 22 tables, hand-written SQL                                          |
| Object storage | Cloudflare R2                                                                                |
| Scheduled work | Cron trigger, checking the flyer sync window every 6 hours                                   |
| Styling        | Tailwind 4                                                                                   |
| Model          | OpenAI Responses API with JSON Schema structured output, optional                            |

```
app/
  page.tsx                 Inventory screen
  PlannerPanel.tsx         Budget, flyers and shopping list
  RecipeWorkspace.tsx      Recipes, requests, meal plan and cooking log
  flyerRecommendations.ts  Restocking engine, pure functions with unit tests
  inventoryUsage.ts        Unit conversion and stock arithmetic, pure functions with unit tests
  imageCompression.ts      Client-side photo compression
  i18n.ts                  Chinese and English dictionary with localised formatters
  Modal.tsx                Shared dialog handling Esc, focus management and accessible labelling
  api/                     Server routes
  api/_shared/schema.ts    All 22 table definitions, the single source
worker/index.ts            Worker entry point and scheduled job
docs/                      Restocking rules specification
tests/                     48 tests
```

## Commands

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm typecheck` regenerates the Cloudflare binding types from `wrangler.jsonc` before running the type check. `pnpm test` builds first, then runs a render smoke test and unit tests over the pure logic. Lint currently reports no errors; three `react-hooks/set-state-in-effect` exemptions carry comments explaining why a separate data layer is not worth introducing at this size.

All four run on every push and pull request through [`.github/workflows/ci.yml`](.github/workflows/ci.yml), on a clean Ubuntu machine with the same pnpm and Node versions pinned. Running them there catches the case where a dependency is installed locally but missing from the lockfile.

## Deploying to your own Cloudflare account

```bash
pnpm exec wrangler d1 create home-stock-planner
pnpm exec wrangler r2 bucket create home-stock-uploads
```

Put the returned `database_id` into `wrangler.jsonc`, then configure the secret and deploy:

```bash
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm build && pnpm exec wrangler deploy
```

Cloudflare Images is optional. Without the `IMAGES` binding the image optimisation endpoint returns the original bytes and nothing else changes.

Note that none of the endpoints currently check identity, so any visitor can read and write the data and trigger the model-backed routes. Before deploying publicly, put Cloudflare Access in front of the site, or keep `DEMO_MODE=on` so visitors only ever see seeded data.

## Known tradeoffs

Tables are created at runtime, with no versioned migration history. A structural change shows up only as a diff to `app/api/_shared/schema.ts`, and rolling back to an earlier version means writing the reverse statements by hand. Once several environments need to advance their structure independently, this approach stops being enough.

There is no identity system. `household_members` are records in a table, and attribution for cooking and ratings is entered by the user.

vinext is at a beta stage (1.0.0-beta.2), so its API may change.

Only PriceSmart has a structured scraper. Other stores fall back to model-driven web search, which is noticeably less reliable.
