import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";

const missingStoreProduct = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingStoreProduct.getBasketByStore = async () => null;
missingStoreProduct.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingStoreProduct.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      externalId: "external-abc",
    }),
  /storeProductId is required/,
);

const missingCategory = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingCategory.getBasketByStore = async () => null;
missingCategory.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingCategory.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      productId: 12345,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
    }),
  /storeCategoryId is required/,
);

const missingProduct = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingProduct.getBasketByStore = async () => null;
missingProduct.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingProduct.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
    }),
  /productId is required/,
);

const missingExternal = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingExternal.getBasketByStore = async () => null;
missingExternal.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingExternal.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      storeProductId: "store-product-xyz",
    }),
  /externalId is required/,
);

const missingCustomizationField = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingCustomizationField.getBasketByStore = async () => {
  throw new Error("basket lookup should not be reached");
};
missingCustomizationField.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingCustomizationField.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
      selectedOptions: [{ group_id: 701, option_id: 801, quantity: 1 }],
      productView: {
        data: {
          metadata: {
            product: {
              attributeGroups: [
                {
                  id: 701,
                  attributeGroupId: "group-stable-701",
                  position: 3,
                  name: "Size",
                  min: 1,
                  max: 1,
                  attributes: [
                    {
                      id: 801,
                      attributeId: "option-stable-801",
                      externalId: "option-external-801",
                      name: "Medium",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    }),
  /Missing groupExternalId/,
);

const client = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
client.getBasketByStore = async () => null;
let captured;
client.call = async (_path, options) => {
  captured = options.body;
  return { ok: true };
};

await client.addToBasket({
  storeId: "store-1",
  storeAddressId: "address-1",
  storeCategoryId: 99,
  productId: 12345,
  externalId: "external-abc",
  storeProductId: "store-product-xyz",
  quantity: 2,
  selectedOptions: [{ group_id: 701, option_id: 801, quantity: 1 }],
  productView: {
    data: {
      metadata: {
        product: {
          attributeGroups: [
            {
              id: 701,
              attributeGroupId: "group-stable-701",
              externalId: "group-external-701",
              position: 3,
              name: "Size",
              min: 1,
              max: 1,
              attributes: [
                {
                  id: 801,
                  attributeId: "option-stable-801",
                  externalId: "option-external-801",
                  name: "Medium",
                },
              ],
            },
          ],
        },
      },
    },
  },
});

const product = captured.products[0];
assert.deepEqual(product.ids, {
  id: "12345",
  externalId: "external-abc",
  storeProductId: "store-product-xyz",
});
assert.equal("legacyId" in product.ids, false);
assert.notEqual(product.ids.id, product.ids.externalId);
assert.notEqual(product.ids.id, product.ids.storeProductId);
assert.notEqual(product.ids.externalId, product.ids.storeProductId);
assert.equal(product.quantity.increments, 2);
assert.deepEqual(product.customizations, [
  {
    ids: {
      groupLegacyId: 701,
      groupId: "group-stable-701",
      groupExternalId: "group-external-701",
      groupPosition: 3,
      legacyId: 801,
      id: "option-stable-801",
      externalId: "option-external-801",
    },
    name: "Medium",
    quantity: { increments: 1 },
    customizationName: "Medium",
    groupName: "Size",
  },
]);
assert.equal(product.attributes, undefined);
assert.equal(captured.storeCategoryId, 99);

const deleteClient = new GlovoClient("/tmp/unused", { session: { customerId: 123 } });
let deleteCall;
deleteClient.call = async (path, options) => {
  deleteCall = { path, options };
  return null;
};
await deleteClient.deleteBasket("basket/live id?x=1");
assert.deepEqual(deleteCall, {
  path: "/v1/authenticated/customers/123/baskets/basket%2Flive%20id%3Fx%3D1",
  options: {
    method: "DELETE",
    auth: true,
    allowNotFound: true,
  },
});

console.log("basket-payload.test: distinct identifiers, category, and customizations preserved");
