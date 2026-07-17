import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";

function basket() {
  return {
    basketId: "basket/live id",
    basketVersion: 7,
    storeId: "store-1",
    handlingStrategy: "DELIVERY",
    products: [
      {
        ids: { basketProductId: "bp/live id", id: "product-1", storeProductId: "store-product-1", externalId: "external-1" },
        quantity: { increments: 2 },
      },
    ],
  };
}

for (const mode of ["removeFromBasket", "setQuantityZero"]) {
  const client = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
  const calls = [];
  client.getBasketByStore = async () => basket();
  client.removeProducts = async () => {
    calls.push({ kind: "delete" });
    throw new Error("child DELETE must not be used");
  };
  client.updateBasketProducts = async () => {
    calls.push({ kind: "put" });
    throw new Error("filtered PUT must not be used");
  };
  client.updateProductQuantity = async (basketId, payload) => {
    calls.push({ kind: "patch", basketId, payload });
    return { ok: true };
  };

  if (mode === "removeFromBasket") {
    await client.removeFromBasket({ storeId: "store-1", basketProductId: "bp/live id" });
  } else {
    await client.setQuantity({ storeId: "store-1", basketProductId: "bp/live id", quantity: 0 });
  }

  assert.deepEqual(calls, [
    {
      kind: "patch",
      basketId: "basket/live id",
      payload: {
        handlingStrategy: "DELIVERY",
        basketVersion: 7,
        products: [{ basketProductId: "bp/live id", quantity: 0 }],
      },
    },
  ]);
}

const pathClient = new GlovoClient("/tmp/unused", { session: { customerId: 123 } });
let callRecord;
pathClient.call = async (path, options) => {
  callRecord = { path, options };
  return null;
};
await pathClient.updateProductQuantity("basket/live id", {
  handlingStrategy: "DELIVERY",
  basketVersion: 7,
  products: [{ basketProductId: "bp/live id", quantity: 0 }],
});
assert.deepEqual(callRecord, {
  path: "/v1/authenticated/customers/123/baskets/basket%2Flive%20id/products/quantity",
  options: {
    method: "PATCH",
    auth: true,
    body: {
      handlingStrategy: "DELIVERY",
      basketVersion: 7,
      products: [{ basketProductId: "bp/live id", quantity: 0 }],
    },
  },
});

console.log("basket-remove.test: official quantity-zero removal contract passed");
