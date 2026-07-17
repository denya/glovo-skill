import assert from "node:assert/strict";
import { compactReorderPreview } from "../src/glovo/api.mjs";

const liveLike = compactReorderPreview({
  id: "order-1",
  storeId: 10,
  storeAddressId: 20,
  storeName: "Store",
  reorderData: { allowed: true, isAllowed: true },
  boughtProducts: [
    { name: "Item A", quantity: "2", price: "1.00 €" },
    { name: "Item B", quantity: "1", price: "3.00 €" },
  ],
});

assert.equal(liveLike.native_reorder_allowed, true);
assert.equal(liveLike.items_count, 2);
assert.equal(liveLike.can_prepare_basket, false);
assert.deepEqual(liveLike.unsupported_reasons, ["missing_product_identifier"]);
assert.equal(liveLike.items.every((item) => item.can_prepare_line === false), true);

const identified = compactReorderPreview({
  id: "order-2",
  storeId: 10,
  storeAddressId: 20,
  products: [
    { ids: { id: "p1", externalId: "e1", storeProductId: "sp1" }, name: "Item C", quantity: { increments: 1 } },
  ],
});

assert.equal(identified.can_prepare_basket, true);
assert.deepEqual(identified.unsupported_reasons, []);
assert.equal(identified.items[0].quantity, 1);

const optionBearing = compactReorderPreview({
  id: "order-3",
  storeId: 10,
  storeAddressId: 20,
  products: [
    { ids: { id: "p1" }, attributes: [{ attributeId: "a1" }], quantity: 1 },
  ],
});

assert.equal(optionBearing.can_prepare_basket, false);
assert.deepEqual(optionBearing.unsupported_reasons, ["option_payload_requires_live_revalidation"]);

console.log("reorder-preview.test: read-only repeat preview cases passed");
