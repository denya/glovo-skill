import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { loadPrivateJson, savePrivateJson } from "../auth/store.mjs";

const CACHE_VERSION = 1;

function accountHash(client) {
  const id = client.session?.customerId ?? client.session?.customer?.id;
  return id == null ? null : createHash("sha256").update(String(id)).digest("hex");
}

function cachePath(client, override) {
  if (override) return override;
  return client.sessionPath ? join(dirname(client.sessionPath), "history-cache.json") : null;
}

function cacheAgeSeconds(cache, now) {
  const updated = Date.parse(cache?.updated_at || "");
  return Number.isFinite(updated) ? Math.max(0, Math.round((now - updated) / 1000)) : null;
}

function validateCache(cache, hash) {
  if (cache?.version !== CACHE_VERSION || !Array.isArray(cache?.orders) || cache?.complete !== true) return "corrupt";
  if (cache.account_hash !== hash) return "account_mismatch";
  return null;
}

function uniqueOrders(orders) {
  const seen = new Set();
  return orders.filter((order) => {
    const id = order?.order_id == null ? null : String(order.order_id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isCompleteDiscovery(discovery) {
  return ["no_next_cursor", "empty_page"].includes(discovery.stopped_reason);
}

function mergeOrders(fresh, cached) {
  const cachedIndex = new Map(cached.map((order, index) => [String(order.order_id), index]));
  const overlapIndexes = fresh.map((order) => cachedIndex.get(String(order.order_id))).filter(Number.isInteger);
  if (!overlapIndexes.length) return uniqueOrders(fresh);
  return uniqueOrders([...fresh, ...cached.slice(Math.max(...overlapIndexes) + 1)]);
}

function publicMetadata({ status, mode, age, discovery, fullPages, refreshedAt }) {
  return {
    status,
    mode,
    stale: false,
    age_before_refresh_seconds: age,
    refreshed_at: refreshedAt,
    pages_fetched: discovery.pages.length,
    full_cursor_pages_at_last_full_refresh: fullPages,
  };
}

export async function getCachedOrderCards(client, {
  refresh = "incremental",
  cacheFile,
  pageDelayMs = 750,
  maxRetries = 4,
  now = () => Date.now(),
} = {}) {
  const hash = accountHash(client);
  const file = cachePath(client, cacheFile);
  if (!hash || !file) {
    const discovery = await client.getAllOrderCards({ limit: 15, pageDelayMs, maxRetries });
    return {
      ...discovery,
      cache: publicMetadata({ status: "disabled", mode: "full", age: null, discovery, fullPages: discovery.pages.length, refreshedAt: null }),
    };
  }

  let cache = null;
  let invalidReason = null;
  try {
    cache = loadPrivateJson(file);
    invalidReason = validateCache(cache, hash);
  } catch (error) {
    invalidReason = error?.code === "ENOENT" ? "missing" : "corrupt";
  }

  const fullRefresh = refresh === "full" || invalidReason;
  if (fullRefresh) {
    const discovery = await client.getAllOrderCards({ limit: 15, pageDelayMs, maxRetries });
    if (!isCompleteDiscovery(discovery)) throw new Error(`Full history refresh stopped before cursor exhaustion (${discovery.stopped_reason}).`);
    const refreshedAt = new Date(now()).toISOString();
    savePrivateJson(file, {
      version: CACHE_VERSION,
      account_hash: hash,
      updated_at: refreshedAt,
      complete: true,
      full_cursor_pages: discovery.pages.length,
      orders: discovery.orders,
    });
    const status = refresh === "full" && !invalidReason ? "forced_full" : `${invalidReason}_rebuilt`;
    return {
      ...discovery,
      cache: publicMetadata({ status, mode: "full", age: cacheAgeSeconds(cache, now()), discovery, fullPages: discovery.pages.length, refreshedAt }),
    };
  }

  const knownOrderIds = new Set(cache.orders.map((order) => String(order.order_id)));
  const discovery = await client.getAllOrderCards({ limit: 15, pageDelayMs, maxRetries, stopOrderIds: knownOrderIds });
  if (discovery.stopped_reason !== "known_order" && !isCompleteDiscovery(discovery)) {
    throw new Error(`Incremental history refresh did not reach a known order or cursor exhaustion (${discovery.stopped_reason}).`);
  }
  const orders = discovery.stopped_reason === "known_order"
    ? mergeOrders(discovery.orders, cache.orders)
    : uniqueOrders(discovery.orders);
  const refreshedAt = new Date(now()).toISOString();
  savePrivateJson(file, {
    ...cache,
    updated_at: refreshedAt,
    orders,
  });
  return {
    ...discovery,
    orders,
    count: orders.length,
    cache: publicMetadata({
      status: discovery.stopped_reason === "known_order" ? "hit_refreshed" : "cache_replaced_after_no_overlap",
      mode: "incremental",
      age: cacheAgeSeconds(cache, now()),
      discovery,
      fullPages: cache.full_cursor_pages,
      refreshedAt,
    }),
  };
}
