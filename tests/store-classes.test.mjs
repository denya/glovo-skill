import assert from "node:assert/strict";
import {
  GlovoClient,
  basketProduct,
  compactProductView,
  compactStoreContent,
  compactStoreWall,
} from "../src/glovo/api.mjs";

for (const fixture of [
  { categoryId: 1, storeClass: "restaurant" },
  { categoryId: 4, storeClass: "grocery" },
  { categoryId: 3, storeClass: "retail" },
]) {
  const wall = compactStoreWall({
    data: {
      category: { id: fixture.categoryId },
      stores: { entries: [{ id: `store-${fixture.categoryId}`, name: "Sample", addressId: `address-${fixture.categoryId}` }] },
    },
  });
  assert.equal(wall.stores[0].store_class, fixture.storeClass);
  assert.equal(wall.stores[0].category_id, fixture.categoryId);

  const product = basketProduct({
    productId: `product-${fixture.categoryId}`,
    externalId: `external-${fixture.categoryId}`,
    storeProductId: `store-product-${fixture.categoryId}`,
    quantity: 1,
  });
  assert.deepEqual(product.ids, {
    id: `product-${fixture.categoryId}`,
    externalId: `external-${fixture.categoryId}`,
    storeProductId: `store-product-${fixture.categoryId}`,
  });
}

const calls = [];
const client = new GlovoClient("/unused", { session: {} });
client.call = async (path, options) => { calls.push({ path, options }); return {}; };
await client.getStoreCatalog("store-1", "address-1", "/v3/stores/store-1/addresses/address-1/content/main?nodeType=DEEP_LINK&link=Pizza%20Menu");
assert.equal(calls[0].path, "/v3/stores/store-1/addresses/address-1/content/main?nodeType=DEEP_LINK&link=Pizza%20Menu");
assert.equal(calls[0].options.auth, true);
assert.throws(
  () => client.getStoreCatalog("store-1", "address-1", "/v3/stores/store-2/addresses/address-1/content/main"),
  /selected store and address/,
);
assert.throws(
  () => client.getStoreCatalog("store-1", "address-1", "https://example.test/catalog"),
  /Glovo API origin/,
);

const emptyCatalog = compactStoreContent({ data: { body: [{ type: "TEXT", data: {} }] } }, {
  storeId: "store-1",
  storeAddressId: "address-1",
});
assert.equal(emptyCatalog.count, 0);
assert.match(emptyCatalog.unsupported_reason, /item search/);

const variant = compactProductView({ data: { metadata: { product: {
  id: "retail-1",
  externalId: "retail-external",
  storeProductId: "retail-store-product",
  name: "Retail size 100 ml",
  isVariant: false,
  attributeGroups: [],
} }, footer: { data: { elements: [{ data: { isEnabled: true } }] } } } });
assert.equal(variant.variant_selection, "not_exposed");
assert.equal(variant.add_enabled, true);

const customized = compactProductView({ data: { metadata: { product: {
  id: "food-1",
  externalId: "food-external",
  storeProductId: "food-store-product",
  name: "Pizza",
  attributeGroups: [{
    id: "group-legacy",
    attributeGroupId: "group-id",
    externalId: "group-external",
    name: "Size",
    minSelection: 1,
    attributes: [{ id: "option-legacy", attributeId: "option-id", externalId: "option-external", name: "Large" }],
  }],
} }, footer: { data: { elements: [{ data: { isEnabled: true } }] } } } });
assert.equal(customized.variant_selection, "customizations");
assert.equal(customized.option_groups[0].required, true);

console.log("store-classes.test: restaurant, grocery, retail routing and identifiers passed");
