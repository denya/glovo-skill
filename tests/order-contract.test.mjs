import assert from "node:assert/strict";
import {
  GlovoClient,
  RateLimitError,
  buildReorderPlan,
  compactOrderDetail,
  compactStoreContent,
  compactStoreOrderOptions,
  orderAnalysisFromDetails,
  orderStatsFromCards,
  productMatchScore,
  setSleepForTests,
} from "../src/glovo/api.mjs";

const orders = [
  { order_id: "3", store: "Pizza", total: "12,50 €" },
  { order_id: "2", store: "Pizza", total: "10.00 €", detail_source: "detail" },
  { order_id: "1", store: "Bakery", total: "Refunded" },
];

assert.deepEqual(orderStatsFromCards(orders), {
  orders: 3,
  detailed_orders: 1,
  card_only_orders: 2,
  stores: 2,
  parseable_visible_totals: 2,
  visible_total_amount: 22.5,
  top_stores: [
    { store: "Pizza", orders: 2, visible_total_amount: 22.5, parseable_visible_totals: 2 },
    { store: "Bakery", orders: 1, visible_total_amount: 0, parseable_visible_totals: 0 },
  ],
});

const sleeps = [];
setSleepForTests((ms) => {
  sleeps.push(ms);
});

const client = new GlovoClient("/tmp/unused", { session: {} });
const cursors = [];
let firstPageAttempts = 0;
client.getOrders = async ({ offset }) => {
  cursors.push(offset);
  if (offset === 0 && firstPageAttempts++ === 0) throw new RateLimitError("429");
  if (offset === 0) return { pagination: { next: { offset: "A" } }, orders: [{ orderId: "1", content: { title: "One" }, footer: { left: { data: "1,00 €" } } }] };
  if (offset === "A") return { pagination: { next: { offset: "B" } }, orders: [{ orderId: "2", content: { title: "Two" }, footer: { left: { data: "2,00 €" } } }] };
  if (offset === "B") return { pagination: { next: { offset: "B" } }, orders: [{ orderId: "3", content: { title: "Three" }, footer: { left: { data: "3,00 €" } } }] };
  throw new Error(`unexpected cursor ${offset}`);
};

const discovery = await client.getAllOrderCards({ pageDelayMs: 0, maxRetries: 2 });
assert.deepEqual(cursors, [0, 0, "A", "B"]);
assert.equal(sleeps[0], 15000);
assert.equal(discovery.count, 3);
assert.equal(discovery.stopped_reason, "repeated_next_cursor");
assert.deepEqual(discovery.pages.map((p) => p.cursor), [0, "A", "B"]);

const empty = new GlovoClient("/tmp/unused", { session: {} });
empty.getOrders = async ({ offset }) => {
  assert.equal(offset, 0);
  return { orders: [] };
};
assert.equal((await empty.getAllOrderCards({ pageDelayMs: 0 })).stopped_reason, "empty_page");

const storeContent = {
  data: {
    body: [
      {
        type: "CAROUSEL",
        data: {
          title: "Order again",
          slug: "easy-reorder",
          elements: [
            {
              type: "PRODUCT_TILE",
              data: { id: 1, externalId: "external-1", storeProductId: "store-product-1", name: "Whole Milk", outOfStock: false, priceInfo: { displayText: "1.50 EUR" } },
              actions: [{ data: { events: [{ data: { collectionType: "EasyReorder", isOrderedBefore: "true" } }] } }],
            },
          ],
        },
      },
      {
        type: "CAROUSEL",
        data: {
          title: "Popular",
          elements: [
            {
              type: "PRODUCT_TILE",
              data: { id: 2, externalId: "external-2", storeProductId: "store-product-2", name: "Bread", outOfStock: true },
              actions: [{ data: { events: [{ data: { collectionType: "TopSellers", isOrderedBefore: "false" } }] } }],
            },
          ],
        },
      },
    ],
  },
};

const easy = compactStoreContent(storeContent, { kind: "easy_reorder" });
assert.equal(easy.count, 1);
assert.deepEqual(easy.products[0], {
  id: "1",
  product_id: "1",
  external_id: "external-1",
  store_product_id: "store-product-1",
  name: "Whole Milk",
  price: "1.50 EUR",
  amount: undefined,
  image: undefined,
  sponsored: undefined,
  restricted: undefined,
  available: true,
  quantity_limit: undefined,
  description: undefined,
  collection_type: "EasyReorder",
  ordered_before: true,
  source: "easy_reorder",
});
assert.equal(compactStoreContent(storeContent, { kind: "top_sellers" }).products[0].available, false);

assert.deepEqual(compactStoreOrderOptions({
  fees: { data: { feesInformation: { plainText: "Fees vary" }, ranges: [{ lowerBound: 0, upperBound: 10, upperBoundInfo: { displayText: "10 EUR" }, surchargeInfo: { displayText: "2 EUR" }, surchargeStrategy: "MBS" }] } },
  restrictions: { title: "Restrictions", restrictions: [{ id: "r1", text: "No alcohol" }] },
  info: { sections: [{ type: "TEXT", data: { text: "Open daily" } }] },
  similar: { stores: [{ id: 3, name: "Alternative", open: true }] },
}), {
  handling_strategy: "DELIVERY",
  fee_information: "Fees vary",
  minimum_basket_ranges: [{ lower_bound: 0, upper_bound: 10, upper_bound_text: "10 EUR", surcharge: "2 EUR", surcharge_strategy: "MBS" }],
  restrictions_title: "Restrictions",
  restrictions: [{ id: "r1", text: "No alcohol" }],
  store_information: [{ type: "TEXT", text: "Open daily" }],
  similar_stores: [{ id: "3", store_id: "3", store_address_id: undefined, name: "Alternative", slug: undefined, category: undefined, category_id: undefined, open: true, eta: undefined, distance: undefined, rating: undefined, votes: undefined, delivery_fee: undefined, service_fee: undefined, image: undefined, logo: undefined, url: undefined }],
  boundary: "Read-only pre-check. This does not create a basket, enter checkout, book a slot, pay, or place an order.",
});

const detailFixture = {
  id: 10,
  storeId: 20,
  storeAddressId: 30,
  storeName: "Market",
  currentStatus: { type: "DELIVERED", creationTime: Date.UTC(2026, 0, 1) },
  reorderData: { allowed: true },
  boughtProducts: [{ name: "Whole Milk", quantity: "2", price: "3.00 EUR", customizationsDescription: "Cold", freeProduct: false }],
  pricingBreakdown: { lines: [{ type: "TOTAL", description: "Total", amount: "3.00 EUR" }] },
};
const compactDetail = compactOrderDetail(detailFixture);
assert.equal(compactDetail.items.length, 1);
assert.equal(compactDetail.items[0].customizations, "Cold");
assert.equal(compactDetail.status, "DELIVERED");
assert.equal(compactDetail.native_reorder_allowed, true);
assert.equal(compactDetail.pricing_breakdown[0].amount, "3.00 EUR");

const analysis = orderAnalysisFromDetails([
  detailFixture,
  { ...detailFixture, id: 11, currentStatus: { type: "DELIVERED", creationTime: Date.UTC(2026, 0, 11) }, boughtProducts: [{ name: "Whole milk", quantity: "1", price: "1.50 EUR" }] },
  { ...detailFixture, id: 12, currentStatus: { type: "DELIVERED", creationTime: Date.UTC(2026, 0, 31) }, boughtProducts: [{ name: "Whole Milk", quantity: "1", price: "1.50 EUR" }] },
]);
assert.equal(analysis.analyzed_orders, 3);
assert.equal(analysis.distinct_products, 1);
assert.equal(analysis.top_products[0].orders, 3);
assert.equal(analysis.top_products[0].quantity, 4);
assert.equal(analysis.top_products[0].average_interval_days, 15);
assert.equal(analysis.top_products[0].median_interval_days, 15);
assert.equal(productMatchScore("Whole Milk 1L", "whole milk 1 l"), 1);
assert.equal(productMatchScore("Milk", "Bread"), 0);

const resolvedPlan = buildReorderPlan(detailFixture, new Map([[0, [{ product_id: "1", external_id: "external-1", store_product_id: "store-product-1", name: "Whole Milk", available: true, match_score: 1 }]]]));
assert.equal(resolvedPlan.can_prepare_after_review, true);
assert.equal(resolvedPlan.items[0].requires_option_reselection, true);
assert.equal(resolvedPlan.mutates_basket, false);

const planner = new GlovoClient("/tmp/unused", { session: {} });
planner.getOrder = async () => detailFixture;
planner.getStoreContent = async (_storeId, _storeAddressId, options) => {
  assert.equal(options.auth, true);
  return storeContent;
};
planner.searchStoreItems = async () => {
  throw new Error("exact Easy Reorder match should avoid fallback search");
};
const planned = await planner.planReorder(10, { maxSearches: 2 });
assert.equal(planned.resolved_items, 1);
assert.equal(planned.searches_used, 0);

const analysisClient = new GlovoClient("/tmp/unused", { session: {} });
analysisClient.getAllOrderCards = async () => ({ orders: [{ order_id: 1, store: "Market" }, { order_id: 2, store: "Market" }], pages: [{ cursor: 0 }], stopped_reason: "no_next_cursor", strategy: "order-id-cursor" });
analysisClient.getOrder = async (id) => {
  if (id === 2) throw new RateLimitError("429");
  return detailFixture;
};
const partialAnalysis = await analysisClient.analyzeOrderHistory({ pageDelayMs: 0, detailDelayMs: 0 });
assert.equal(partialAnalysis.coverage.detailed_orders, 1);
assert.equal(partialAnalysis.coverage.detail_attempts, 2);
assert.equal(partialAnalysis.coverage.detail_rate_limited, true);
assert.equal(partialAnalysis.coverage.discovered_orders, 2);

setSleepForTests();

console.log("order-contract.test: cursor, research, reorder planning, and bounded detail analysis passed");
