import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";

const originalFetch = globalThis.fetch;
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

try {
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
} finally {
  globalThis.fetch = originalFetch;
}

console.log("error-redaction.test: authenticated paths and API bodies redacted");
