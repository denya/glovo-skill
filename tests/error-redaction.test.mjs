import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";

const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({
      error: {
        message: "The basket has no available products for storeId: 74507 and storeAddressId: 621231.",
        exceptionName: "PRODUCT_NOT_AVAILABLE",
        staticCode: "882172",
      },
    }),
  });

  const client = new GlovoClient("/tmp/unused", { session: { customerId: 666258 } });
  await assert.rejects(
    () => client.call("/v1/authenticated/customers/666258/baskets", { method: "POST", auth: false, body: {} }),
    (error) => {
      assert.match(error.message, /authenticated\/customers\/\[customer\]/);
      assert.match(error.message, /PRODUCT_NOT_AVAILABLE/);
      assert.doesNotMatch(error.message, /666258|74507|621231|882172/);
      assert.doesNotMatch(error.message, /The basket has no available products/);
      return true;
    },
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({
      error: {
        message: "No resource for basket basket-live-123 product ids bp-live-1,bp-live-2 customer 666258.",
        exceptionName: "NoResourceFoundException",
      },
    }),
  });

  await assert.rejects(
    () => client.call("/v1/authenticated/customers/666258/baskets/basket-live-123/products/bp-live-1,bp-live-2", { method: "DELETE", auth: false }),
    (error) => {
      assert.match(error.message, /authenticated\/customers\/\[customer\]\/baskets\/\[basket\]\/products\/\[products\]/);
      assert.match(error.message, /NoResourceFoundException/);
      assert.doesNotMatch(error.message, /666258|basket-live-123|bp-live-1|bp-live-2/);
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("error-redaction.test: authenticated paths and API bodies redacted");
