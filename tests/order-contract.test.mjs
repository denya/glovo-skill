import assert from "node:assert/strict";
import { GlovoClient, RateLimitError, orderStatsFromCards, setSleepForTests } from "../src/glovo/api.mjs";

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

setSleepForTests();
