import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OPTION_FIELDS = ["attributes", "selectedAttributes", "modifiers", "options", "customizations"];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalId(value) {
  return value == null ? null : String(value);
}

export function normalizeBaskets(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.baskets || raw?.data?.baskets || [];
}

function basketHasProducts(basket) {
  return (basket?.products || []).length > 0;
}

function lineHasOptions(line) {
  return OPTION_FIELDS.some((field) => line?.[field] != null);
}

function canRestoreLine(line) {
  const ids = line?.ids || {};
  return Boolean(ids.basketProductId && (ids.id || ids.storeProductId || ids.externalId) && Number.isFinite(Number(line?.quantity?.increments)));
}

function canonicalLine(line) {
  const ids = line?.ids || {};
  const selectedOptions = Object.fromEntries(
    OPTION_FIELDS.filter((field) => line?.[field] != null).map((field) => [field, stableValue(line[field])]),
  );
  return stableValue({
    basket_product_id: canonicalId(ids.basketProductId),
    product_id: canonicalId(ids.id),
    external_id: canonicalId(ids.externalId),
    store_product_id: canonicalId(ids.storeProductId),
    legacy_id: canonicalId(ids.legacyId),
    name: line?.name ?? line?.productName ?? null,
    quantity: Number(line?.quantity?.increments ?? 0),
    selected_options: selectedOptions,
  });
}

export function canonicalBasketState(raw) {
  return normalizeBaskets(raw)
    .map((basket) => ({
      basket_id: canonicalId(basket.basketId),
      store_id: canonicalId(basket.storeId),
      store_address_id: canonicalId(basket.storeAddressId),
      handling_strategy: basket.handlingStrategy || null,
      lines: (basket.products || [])
        .map(canonicalLine)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort((a, b) => `${a.store_id}:${a.basket_id}`.localeCompare(`${b.store_id}:${b.basket_id}`));
}

export function basketFingerprint(raw, salt) {
  return createHash("sha256")
    .update(`${salt}\n${JSON.stringify(canonicalBasketState(raw))}`)
    .digest("hex");
}

export function createBasketSnapshot(raw, { salt = randomBytes(16).toString("hex") } = {}) {
  const rawClone = clone(raw);
  return {
    salt,
    raw: rawClone,
    canonical: canonicalBasketState(rawClone),
    fingerprint: basketFingerprint(rawClone, salt),
  };
}

export function persistPrivateSnapshot(snapshot) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-basket-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "snapshot.json");
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(snapshot));
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
  return { dir, file };
}

export function removePrivateSnapshot(recoveryPath) {
  if (!recoveryPath?.dir) return;
  rmSync(recoveryPath.dir, { recursive: true, force: true });
}

function findBasket(raw, storeId) {
  return normalizeBaskets(raw).find((basket) => String(basket.storeId) === String(storeId));
}

function isNoResourceFound(error) {
  return /NoResourceFoundException|NO_RESOURCE_FOUND|No resource found|not found/i.test(String(error?.message || error));
}

export function assertMutationCompatible(snapshot, storeId) {
  const baskets = normalizeBaskets(snapshot.raw);
  const nonEmpty = baskets.some(basketHasProducts);
  const originalStore = findBasket(snapshot.raw, storeId);
  if (nonEmpty && !basketHasProducts(originalStore)) {
    throw new Error("Refusing cross-store mutation: existing basket is non-empty and selected test store differs.");
  }
  const unrestorable = (originalStore?.products || []).filter((line) => lineHasOptions(line) || !canRestoreLine(line));
  if (unrestorable.length) {
    throw new Error("Refusing mutation: existing basket lines cannot be restored losslessly, including option-bearing lines.");
  }
}

async function restoreOnce(client, snapshot, storeId, { deletedBasketIds }) {
  const originalStore = findBasket(snapshot.raw, storeId);
  const current = await client.getBaskets();
  const currentStore = findBasket(current, storeId);

  if (basketHasProducts(originalStore)) {
    if (!currentStore?.basketId) throw new Error("Original basket disappeared; cannot restore it safely.");
    await client.updateBasketProducts(currentStore.basketId, {
      ...currentStore,
      products: clone(originalStore.products || []),
    });
  } else if (originalStore) {
    if (!currentStore?.basketId) throw new Error("Original empty basket disappeared; cannot restore it safely.");
    await client.updateBasketProducts(currentStore.basketId, {
      ...currentStore,
      products: clone(originalStore.products || []),
    });
  } else {
    if (currentStore?.basketId) await deleteSelectedStoreBasket(client, currentStore.basketId, deletedBasketIds);
  }

  const after = await readCanonicalMatch(client, snapshot);
  return { fingerprint: basketFingerprint(after, snapshot.salt) };
}

async function deleteSelectedStoreBasket(client, basketId, deletedBasketIds) {
  const key = String(basketId);
  if (deletedBasketIds.has(key)) return;
  try {
    await client.deleteBasket(basketId);
    deletedBasketIds.add(key);
  } catch (error) {
    if (!isNoResourceFound(error)) throw error;
    deletedBasketIds.add(key);
  }
}

async function readCanonicalMatch(client, snapshot) {
  const last = await client.getBaskets();
  if (JSON.stringify(canonicalBasketState(last)) === JSON.stringify(snapshot.canonical)) return last;
  throw new Error("Basket canonical state still differs after restore.");
}

export async function restoreBaskets(client, snapshot, storeId, { retries = 3, delayMs = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  const deletedBasketIds = new Set();
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await restoreOnce(client, snapshot, storeId, { deletedBasketIds });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await sleep(delayMs * 2 ** attempt);
    }
  }
  const error = new Error(`RESTORE FAILED: ${lastError?.message || "unknown basket restore error"}`);
  error.cause = lastError;
  throw error;
}

export async function withBasketRestore(client, snapshot, storeId, fn, options = {}) {
  let result;
  let bodyError;
  let restore;
  try {
    result = await fn();
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      restore = await restoreBaskets(client, snapshot, storeId, options);
      removePrivateSnapshot(options.recoveryPath);
    } catch (restoreError) {
      if (options.recoveryPath?.file) restoreError.recoveryPath = options.recoveryPath.file;
      throw restoreError;
    }
  }
  if (bodyError) throw bodyError;
  return { result, restore };
}
