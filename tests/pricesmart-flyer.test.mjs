import assert from "node:assert/strict";
import test from "node:test";
import { parsePriceSmartDeals } from "../app/api/flyers/sync/pricesmart.ts";

test("reads PriceSmart's official embedded promotion price and Vancouver dates", () => {
  const state = {
    search: {
      productCardDictionary: {
        4548: {
          sku: "4548",
          name: "Broccoli - Crowns, Fresh",
          sellBy: "eachunit",
          categories: [{ categoryBreadcrumb: "Grocery/Fruits & Vegetables/Fresh Vegetables" }],
          unitOfPrice: { abbreviation: "lb", label: "Pound", type: "pound" },
          tprPrice: {
            active: true,
            effectiveFrom: "2026-08-13T07:00:00Z",
            effectiveUntil: "2026-08-20T04:59:00Z",
            wholePrice: 1.79,
          },
        },
      },
    },
  };
  const html = `<script>window.__PRELOADED_STATE__=${JSON.stringify(state)};window.next=true;</script>`;
  assert.deepEqual(parsePriceSmartDeals(html, "2026-08-14", "America/Vancouver"), [
    {
      itemName: "西兰花",
      category: "蔬菜水果",
      price: 1.79,
      regularPrice: null,
      unit: "lb",
      validFrom: "2026-08-13",
      validTo: "2026-08-19",
      sourceUrl: "https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials",
    },
  ]);
});

test("drops inactive and expired PriceSmart promotions", () => {
  const state = {
    search: {
      productCardDictionary: {
        old: {
          name: "Old deal",
          unitOfPrice: { type: "each" },
          tprPrice: {
            active: true,
            effectiveFrom: "2026-08-01T07:00:00Z",
            effectiveUntil: "2026-08-08T04:59:00Z",
            wholePrice: 2,
          },
        },
        inactive: {
          name: "Inactive deal",
          unitOfPrice: { type: "each" },
          tprPrice: {
            active: false,
            effectiveFrom: "2026-08-13T07:00:00Z",
            effectiveUntil: "2026-08-20T04:59:00Z",
            wholePrice: 2,
          },
        },
      },
    },
  };
  const html = `<script>window.__PRELOADED_STATE__=${JSON.stringify(state)};</script>`;
  assert.deepEqual(parsePriceSmartDeals(html, "2026-08-14", "America/Vancouver"), []);
});
