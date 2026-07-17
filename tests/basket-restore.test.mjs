import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import {
  assertMutationCompatible,
  basketFingerprint,
  canonicalBasketState,
  createBasketSnapshot,
  persistPrivateSnapshot,
  removePrivateSnapshot,
  withBasketRestore,
} from "../scripts/basket-safety.mjs";

function tempSnapshotDirs() {
  return readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("glovo-basket-")).sort();
}

const initialTempDirs = tempSnapshotDirs();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function line(id, quantity = 1, extra = {}) {
  return {
    ids: { basketProductId: `bp-${id}`, id: `p-${id}`, externalId: `e-${id}`, storeProductId: `sp-${id}` },
    quantity: { increments: quantity },
    name: `Product ${id}`,
    ...extra,
  };
}

function basket(storeId = "store-1", products = [line("original")]) {
  return {
    basketId: `basket-${storeId}`,
    basketVersion: 1,
    storeId,
    storeAddressId: `address-${storeId}`,
    handlingStrategy: "DELIVERY",
    products,
  };
}

class FakeBasketClient {
  constructor(raw) {
    this.raw = clone(raw);
    this.failGets = 0;
    this.failUpdates = 0;
    this.failRemoves = 0;
    this.failDeletes = 0;
    this.noResourceDeletes = 0;
    this.noResourceDeletesRemove = false;
    this.staleGlobalReadsAfterDelete = 0;
    this.pendingDeletedBasketId = null;
    this.getCalls = 0;
    this.globalGetCalls = 0;
    this.updateCalls = 0;
    this.removeCalls = 0;
    this.deleteCalls = 0;
  }

  find(storeId) {
    return this.raw.baskets.find((entry) => String(entry.storeId) === String(storeId));
  }

  async getBaskets() {
    this.globalGetCalls += 1;
    if (this.pendingDeletedBasketId && this.staleGlobalReadsAfterDelete <= 0) {
      this.raw.baskets = this.raw.baskets.filter((entry) => String(entry.basketId) !== String(this.pendingDeletedBasketId));
      this.pendingDeletedBasketId = null;
    }
    if (this.pendingDeletedBasketId && this.staleGlobalReadsAfterDelete > 0) this.staleGlobalReadsAfterDelete -= 1;
    return clone(this.raw);
  }

  async getBasketByStore(storeId) {
    this.getCalls += 1;
    if (this.failGets-- > 0) throw new Error("transient get failure");
    return clone(this.find(storeId) || null);
  }

  async updateBasketProducts(basketId, payload) {
    this.updateCalls += 1;
    if (this.failUpdates-- > 0) throw new Error("transient update failure");
    const index = this.raw.baskets.findIndex((entry) => entry.basketId === basketId);
    assert.notEqual(index, -1);
    this.raw.baskets[index] = {
      ...this.raw.baskets[index],
      ...clone(payload),
      basketId,
      basketVersion: this.raw.baskets[index].basketVersion + 1,
      products: clone(payload.products || []),
    };
    return clone(this.raw.baskets[index]);
  }

  async removeProducts(basketId, ids) {
    this.removeCalls += 1;
    if (this.failRemoves-- > 0) throw new Error("transient remove failure");
    const index = this.raw.baskets.findIndex((entry) => entry.basketId === basketId);
    assert.notEqual(index, -1);
    this.raw.baskets[index].products = this.raw.baskets[index].products.filter((entry) => !ids.includes(entry.ids?.basketProductId));
    return null;
  }

  async deleteBasket(basketId) {
    this.deleteCalls += 1;
    if (this.failDeletes-- > 0) throw new Error("transient delete failure");
    if (this.noResourceDeletes-- > 0) {
      if (this.noResourceDeletesRemove) this.raw.baskets = this.raw.baskets.filter((entry) => String(entry.basketId) !== String(basketId));
      throw new Error("NoResourceFoundException");
    }
    if (this.staleGlobalReadsAfterDelete > 0) {
      this.pendingDeletedBasketId = String(basketId);
      return null;
    }
    this.raw.baskets = this.raw.baskets.filter((entry) => String(entry.basketId) !== String(basketId));
    return null;
  }
}

const original = { baskets: [basket()] };
const changedNested = clone(original);
changedNested.baskets[0].products[0].quantity.increments = 2;
assert.notEqual(basketFingerprint(original, "test-salt"), basketFingerprint(changedNested, "test-salt"));

const snapshotFile = persistPrivateSnapshot(createBasketSnapshot(original));
assert.equal(statSync(snapshotFile.dir).mode & 0o777, 0o700);
assert.equal(statSync(snapshotFile.file).mode & 0o777, 0o600);
removePrivateSnapshot(snapshotFile);
assert.equal(existsSync(snapshotFile.file), false);

assert.throws(() => assertMutationCompatible(createBasketSnapshot({ baskets: [basket("other-store")] }), "store-1"), /cross-store/);
assert.throws(
  () => assertMutationCompatible(createBasketSnapshot({ baskets: [basket("store-1", [line("with-options", 1, { attributes: [{ attributeId: "a" }] })])] }), "store-1"),
  /option-bearing/,
);

{
  const client = new FakeBasketClient(original);
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "after-add" });
  const recoveryPath = persistPrivateSnapshot(snapshot);
  await assert.rejects(
    () =>
      withBasketRestore(client, snapshot, "store-1", async () => {
        client.find("store-1").products.push(line("added"));
        throw new Error("failure after add");
      }, { recoveryPath }),
    /failure after add/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.equal(client.updateCalls, 1);
  assert.equal(existsSync(recoveryPath.file), false);
}

{
  const client = new FakeBasketClient(original);
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "after-set" });
  await assert.rejects(
    () =>
      withBasketRestore(client, snapshot, "store-1", async () => {
        client.find("store-1").products.push(line("added", 2));
        client.find("store-1").products[0].quantity.increments = 3;
        throw new Error("failure after set");
      }),
    /failure after set/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
}

{
  const client = new FakeBasketClient({ baskets: [basket("other-store", [line("other")])] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "zero-parent-delete" });
  const recoveryPath = persistPrivateSnapshot(snapshot);
  await assert.rejects(
    () =>
      withBasketRestore(client, snapshot, "store-1", async () => {
        client.raw.baskets.push(basket("store-1", [line("added")]));
        throw new Error("failure during body");
      }, { recoveryPath }),
    /failure during body/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.equal(client.deleteCalls, 1);
  assert.equal(client.removeCalls, 0);
  assert.equal(client.getCalls, 0);
  assert.ok(client.find("other-store"));
  assert.equal(existsSync(recoveryPath.file), false);
}

{
  const client = new FakeBasketClient({ baskets: [] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "zero-empty-parent-delete" });
  await assert.rejects(
    () =>
      withBasketRestore(client, snapshot, "store-1", async () => {
        client.raw.baskets.push(basket("store-1", []));
        throw new Error("failure with empty parent");
      }),
    /failure with empty parent/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.equal(client.deleteCalls, 1);
  assert.equal(client.removeCalls, 0);
}

{
  const client = new FakeBasketClient({ baskets: [] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "stale-global-after-delete" });
  client.staleGlobalReadsAfterDelete = 1;
  const sleeps = [];
  await assert.rejects(
    () =>
      withBasketRestore(
        client,
        snapshot,
         "store-1",
         async () => {
          client.raw.baskets.push(basket("store-1", [line("added")]));
          throw new Error("failure with stale global read");
         },
        { retries: 3, sleep: (ms) => sleeps.push(ms) },
      ),
    /failure with stale global read/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(client.deleteCalls, 1);
  assert.equal(client.removeCalls, 0);
  assert.equal(client.getCalls, 0);
}

{
  const client = new FakeBasketClient(original);
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "cleanup-update-retry" });
  client.failUpdates = 1;
  const sleeps = [];
  await assert.rejects(
    () =>
      withBasketRestore(
        client,
        snapshot,
        "store-1",
        async () => {
          client.find("store-1").products.push(line("added"));
          throw new Error("failure before update cleanup");
        },
        { retries: 3, sleep: (ms) => sleeps.push(ms) },
      ),
    /failure before update cleanup/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(client.updateCalls, 2);
}

{
  const client = new FakeBasketClient({ baskets: [] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "no-resource-absent" });
  client.noResourceDeletes = 1;
  client.noResourceDeletesRemove = true;
  await assert.rejects(
    () =>
      withBasketRestore(client, snapshot, "store-1", async () => {
        client.raw.baskets.push(basket("store-1", [line("added")]));
        throw new Error("failure with no-resource absent");
      }),
    /failure with no-resource absent/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.equal(client.deleteCalls, 1);
  assert.equal(client.removeCalls, 0);
}

{
  const client = new FakeBasketClient({ baskets: [] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "delete-retry" });
  client.failDeletes = 1;
  const sleeps = [];
  await assert.rejects(
    () =>
      withBasketRestore(
        client,
        snapshot,
        "store-1",
        async () => {
          client.raw.baskets.push(basket("store-1", [line("added")]));
          throw new Error("failure during transient delete");
        },
        { retries: 3, sleep: (ms) => sleeps.push(ms) },
      ),
    /failure during transient delete/,
  );
  assert.deepEqual(canonicalBasketState(await client.getBaskets()), snapshot.canonical);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(client.deleteCalls, 2);
  assert.equal(client.removeCalls, 0);
}

{
  const client = new FakeBasketClient({ baskets: [] });
  const snapshot = createBasketSnapshot(await client.getBaskets(), { salt: "no-resource-persistent" });
  client.raw.baskets.push(basket("store-1", [line("added")]));
  client.noResourceDeletes = 99;
  const recoveryPath = persistPrivateSnapshot(snapshot);
  await assert.rejects(() => withBasketRestore(client, snapshot, "store-1", async () => {}, { retries: 2, sleep: () => {}, recoveryPath }), /RESTORE FAILED/);
  assert.equal(client.deleteCalls, 1);
  assert.equal(client.removeCalls, 0);
  assert.equal(existsSync(recoveryPath.file), true);
  removePrivateSnapshot(recoveryPath);
  assert.equal(existsSync(recoveryPath.file), false);
}

assert.deepEqual(tempSnapshotDirs(), initialTempDirs);
console.log("basket-restore.test: 13 safety cases passed");
