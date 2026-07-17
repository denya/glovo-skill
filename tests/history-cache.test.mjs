import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCachedOrderCards } from "../src/glovo/history-cache.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-history-cache-"));
const cacheFile = path.join(dir, "history-cache.json");
const calls = [];
let response = {
  orders: [{ order_id: "3" }, { order_id: "2" }, { order_id: "1" }],
  pages: [{ cursor: 0 }, { cursor: "next" }],
  stopped_reason: "no_next_cursor",
  strategy: "order-id-cursor",
};
const client = {
  sessionPath: path.join(dir, "session.json"),
  session: { customerId: "private-customer" },
  async getAllOrderCards(options) {
    calls.push(options);
    return response;
  },
};

chmodSync(dir, 0o755);
const cold = await getCachedOrderCards(client, { cacheFile, pageDelayMs: 0, now: () => Date.UTC(2026, 0, 1) });
assert.equal(cold.cache.status, "missing_rebuilt");
assert.equal(cold.cache.mode, "full");
assert.equal(statSync(dir).mode & 0o777, 0o700);
assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
assert.equal(readFileSync(cacheFile, "utf8").includes("private-customer"), false);

response = {
  orders: [{ order_id: "4" }, { order_id: "3" }, { order_id: "2" }],
  pages: [{ cursor: 0 }],
  stopped_reason: "known_order",
  strategy: "order-id-cursor",
};
const warm = await getCachedOrderCards(client, { cacheFile, pageDelayMs: 0, now: () => Date.UTC(2026, 0, 2) });
assert.equal(calls[1].stopOrderIds.has("3"), true);
assert.deepEqual(warm.orders.map((order) => order.order_id), ["4", "3", "2", "1"]);
assert.equal(warm.cache.status, "hit_refreshed");
assert.equal(warm.cache.pages_fetched, 1);
assert.equal(warm.cache.full_cursor_pages_at_last_full_refresh, 2);
assert.equal(warm.cache.stale, false);

writeFileSync(cacheFile, "{broken", { mode: 0o600 });
response = { orders: [{ order_id: "5" }], pages: [{ cursor: 0 }], stopped_reason: "no_next_cursor", strategy: "order-id-cursor" };
const rebuilt = await getCachedOrderCards(client, { cacheFile, pageDelayMs: 0 });
assert.equal(rebuilt.cache.status, "corrupt_rebuilt");
assert.deepEqual(rebuilt.orders.map((order) => order.order_id), ["5"]);

const wrongAccount = JSON.parse(readFileSync(cacheFile, "utf8"));
wrongAccount.account_hash = "wrong";
writeFileSync(cacheFile, JSON.stringify(wrongAccount), { mode: 0o600 });
const isolated = await getCachedOrderCards(client, { cacheFile, pageDelayMs: 0 });
assert.equal(isolated.cache.status, "account_mismatch_rebuilt");

const forced = await getCachedOrderCards(client, { cacheFile, pageDelayMs: 0, refresh: "full" });
assert.equal(forced.cache.status, "forced_full");

response = { orders: [{ order_id: "new-only" }], pages: [{ cursor: 0 }], stopped_reason: "repeated_next_cursor", strategy: "order-id-cursor" };
await assert.rejects(
  getCachedOrderCards(client, { cacheFile, pageDelayMs: 0 }),
  /did not reach a known order or cursor exhaustion/,
);
const preserved = JSON.parse(readFileSync(cacheFile, "utf8"));
assert.equal(preserved.orders.some((order) => order.order_id === "5"), true);

writeFileSync(cacheFile, "{broken", { mode: 0o600 });
await assert.rejects(
  getCachedOrderCards(client, { cacheFile, pageDelayMs: 0 }),
  /Full history refresh stopped before cursor exhaustion/,
);

rmSync(dir, { recursive: true, force: true });
console.log("history-cache.test: cold, warm, corrupt, account isolation, forced refresh, and incomplete-walk refusal passed");
