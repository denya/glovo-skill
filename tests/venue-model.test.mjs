import assert from "node:assert/strict";
import {
  MULTISCALE_VENUE_MODEL,
  VENUE_HOLDOUT_EVIDENCE,
  evaluateVenueModel,
  prepareVenueOrders,
  rankVenueHistory,
  runVenueEvaluation,
  temporalSplit,
} from "../src/glovo/venue-model.mjs";

const cards = Array.from({ length: 40 }, (_, index) => ({
  store: ["A", "A", "B", "A", "C"][index % 5],
  status: index === 5 ? "CANCELED" : "DELIVERED",
}));

const prepared = prepareVenueOrders(cards);
assert.equal(prepared.length, 39);
assert.equal(prepared[0].store, "c");
assert.deepEqual(Object.values(temporalSplit(prepared)).map((part) => part.length), [27, 6, 6]);

const history = rankVenueHistory([
  { store: "Recent", status: "DELIVERED" },
  { store: "Old", status: "DELIVERED" },
  { store: "Old", status: "DELIVERED" },
]);
assert.equal(history.venues.get("recent").last_order_age, 0);
assert.equal(history.venues.get("old").last_order_age, 1);
assert.ok(history.venues.get("recent").score > 0);

const split = temporalSplit(prepared);
const before = JSON.stringify(split.test);
const metrics = evaluateVenueModel([...split.train, ...split.validation], split.test, MULTISCALE_VENUE_MODEL);
assert.equal(metrics.events, 6);
assert.equal(JSON.stringify(split.test), before);

const evaluation = runVenueEvaluation(cards);
assert.equal(evaluation.split.selection_used_test_data, undefined);
assert.equal(evaluation.selection.selection_used_test_data, false);
assert.equal(evaluation.final_test.selected.events, 6);
assert.match(evaluation.selection.rule, /one standard error/);
assert.equal(evaluation.dataset.product_model, "not_evaluated_from_order_cards");

assert.deepEqual(
  {
    final_test_orders: VENUE_HOLDOUT_EVIDENCE.final_test_orders,
    recall_at_5: VENUE_HOLDOUT_EVIDENCE.recall_at_5,
    ndcg_at_5: VENUE_HOLDOUT_EVIDENCE.ndcg_at_5,
  },
  { final_test_orders: 137, recall_at_5: 0.4161, ndcg_at_5: 0.2712 },
);

console.log("venue-model.test: chronological split, rolling evaluation, and published evidence passed");
