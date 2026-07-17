import { randomUUID } from "node:crypto";
import { loadSession, saveSession, tokenStatus } from "../auth/store.mjs";

export class AuthError extends Error {}
export class RateLimitError extends Error {}

const API = "https://api.glovoapp.com";
const WEB_VERSION = "v1.2476.1";
const DEFAULT_LOCATION = {
  countryCode: process.env.GLOVO_COUNTRY_CODE || "ES",
  cityCode: process.env.GLOVO_CITY_CODE || "BCN",
  latitude: process.env.GLOVO_LATITUDE || "41.3874",
  longitude: process.env.GLOVO_LONGITUDE || "2.1686",
  accuracy: "0",
  languageCode: process.env.GLOVO_LANGUAGE_CODE || "en",
};

export function defaultSessionBits() {
  const id = randomUUID();
  return {
    deviceUrn: `glv:device:${randomUUID()}`,
    perseusClientId: id,
    perseusSessionId: id,
    perseusSessionTimestamp: String(Date.now()),
  };
}

function asNumberIfNumeric(value) {
  if (value == null) return value;
  const str = String(value);
  return /^\d+$/.test(str) ? Number(str) : value;
}

function imageUrl(source) {
  if (!source) return undefined;
  if (/^https?:\/\//.test(source)) return source;
  return `https://glovo.dhmedia.io/image/${source}`;
}

function availability(value) {
  if (!value) return null;
  if (value.available === true || value.isAvailable === true || value.enabled === true || value.outOfStock === false) return true;
  if (value.available === false || value.isAvailable === false || value.enabled === false || value.disabled === true || value.soldOut === true || value.outOfStock === true) return false;
  const status = String(value.availability?.status ?? value.status ?? "").toUpperCase();
  if (["AVAILABLE", "OPEN", "ENABLED"].includes(status)) return true;
  if (["UNAVAILABLE", "CLOSED", "DISABLED", "SOLD_OUT"].includes(status)) return false;
  return null;
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v != null && v !== ""));
}

function productAddEnabled(data) {
  const elements = data?.data?.footer?.data?.elements ?? data?.footer?.data?.elements ?? [];
  for (const element of elements) {
    if (typeof element?.data?.isEnabled === "boolean") return element.data.isEnabled;
  }
  return null;
}

function safePath(path) {
  return path
    .replace(/\/authenticated\/customers\/[^/]+/g, "/authenticated/customers/[customer]")
    .replace(/\/baskets\/[^/]+\/products\/[^/]+/g, "/baskets/[basket]/products/[products]")
    .replace(/\/baskets\/[^/]+\/products/g, "/baskets/[basket]/products")
    .replace(/\/baskets\/[^/]+/g, "/baskets/[basket]");
}

function redactIdentifiers(text) {
  return String(text || "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:basket|product|store|address|customer|bp|sp|p|e)-[A-Za-z0-9_-]+\b/g, "[id]")
    .replace(/\d+/g, "#");
}

function safeErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.exceptionName || redactIdentifiers(parsed?.error?.staticCode || parsed?.error?.message) || "request_failed";
  } catch {
    return redactIdentifiers(text).slice(0, 180);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sleep = defaultSleep;

export function setSleepForTests(fn) {
  sleep = fn || defaultSleep;
}

function retryDelay(error, attempt) {
  if (error instanceof RateLimitError) return Math.min(15_000 * 2 ** attempt, 120_000);
  return Math.min(1000 * 2 ** attempt, 10_000);
}

export async function withRetry(fn, { maxRetries = 3, label = "glovo" } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const delay = retryDelay(error, attempt);
      console.error(JSON.stringify({ event: "retry", label, attempt: attempt + 1, delay_ms: delay, rate_limited: error instanceof RateLimitError }));
      await sleep(delay);
    }
  }
}

export class GlovoClient {
  constructor(sessionPath, { session = null } = {}) {
    this.sessionPath = sessionPath;
    this.session = session;
    this.bits = defaultSessionBits();
  }

  reload() {
    try {
      this.session = loadSession(this.sessionPath);
    } catch {
      this.session = null;
    }
    return this;
  }

  authStatus() {
    const status = tokenStatus(this.session);
    return {
      signed_in: Boolean(this.session?.refreshToken || status.valid),
      access_token_valid: status.valid,
      seconds_left: Math.max(0, Math.round(status.secondsLeft)),
      has_customer: Boolean(this.session?.customerId ?? this.session?.customer?.id),
      has_location: Boolean(this.session?.location?.cityCode || this.session?.location?.latitude),
    };
  }

  location() {
    return { ...DEFAULT_LOCATION, ...(this.session?.location || {}) };
  }

  setLocation(location) {
    const next = cleanObject({ ...(this.session?.location || {}), ...location });
    this.session = { ...(this.session || {}), location: next };
    saveSession(this.sessionPath, this.session);
    return this.location();
  }

  searchAddresses(address, { allowFallback = true } = {}) {
    if (String(address || "").trim().length < 3) throw new Error("Address search requires at least 3 characters.");
    const params = new URLSearchParams({ address: String(address), allowFallback: String(Boolean(allowFallback)) });
    return this.call(`/v3/addresslookup/pub/address?${params.toString()}`);
  }

  resolveAddress(placeId, provider) {
    if (!placeId) throw new Error("placeId is required.");
    const params = new URLSearchParams();
    if (provider) params.set("provider", String(provider));
    return this.call(`/v3/addresslookup/pub/${encodeURIComponent(placeId)}${params.toString() ? `?${params.toString()}` : ""}`);
  }

  reverseAddress({ latitude, longitude, allowFallback = true }) {
    if (latitude == null || longitude == null) throw new Error("latitude and longitude are required.");
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      allowFallback: String(Boolean(allowFallback)),
    });
    return this.call(`/v3/addresslookup/pub/coordinates?${params.toString()}`);
  }

  deliveryPointInfo({ latitude, longitude, countryCode }) {
    if (latitude == null || longitude == null) throw new Error("latitude and longitude are required.");
    if (!countryCode) throw new Error("countryCode is required.");
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      countryCode: String(countryCode),
    });
    return this.call(`/customer_profile/api/v1/guest/address_book/delivery_point_info?${params.toString()}`);
  }

  getSavedLocations() {
    return this.call("/customer_profile/api/v1/address_book/me/addresses", { auth: true });
  }

  async savedLocations({ matchText } = {}) {
    return compactSavedLocations(await this.getSavedLocations(), {
      currentLocation: this.location(),
      matchText,
    });
  }

  async selectLocation({ placeId, provider } = {}) {
    const resolvedRaw = await this.resolveAddress(placeId, provider);
    const resolved = compactResolvedLocation(resolvedRaw);
    if (!resolved.valid) return { selected: false, deliverable: false, title: resolved.title, city_code: null, country_code: null, reason: resolved.reason };

    const serviceRaw = await this.deliveryPointInfo({
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      countryCode: resolved.country_code,
    });
    const service = compactDeliveryPointInfo(serviceRaw);
    const cityCode = service.city_code || resolved.city_code;
    const countryCode = service.country_code || resolved.country_code;
    const deliverable = service.deliverable === true;
    if (!deliverable) return { selected: false, deliverable: false, title: resolved.title, city_code: cityCode || null, country_code: countryCode || null, reason: "not_deliverable" };
    if (!validLocationCodes({ countryCode, cityCode })) return { selected: false, deliverable: true, title: resolved.title, city_code: cityCode || null, country_code: countryCode || null, reason: "invalid_codes" };

    this.setLocation({
      countryCode,
      cityCode,
      latitude: String(resolved.latitude),
      longitude: String(resolved.longitude),
      accuracy: String(resolved.accuracy ?? 0),
    });
    return { selected: true, deliverable: true, title: resolved.title, city_code: cityCode, country_code: countryCode };
  }

  baseHeaders({ auth = false } = {}) {
    const location = this.location();
    const now = String(Date.now());
    const h = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Glovo-Api-Version": "14",
      "Glovo-App-Context": "web",
      "Glovo-App-Development-State": "prod",
      "Glovo-App-Platform": "web",
      "Glovo-App-Type": "customer",
      "Glovo-App-Version": location.appVersion || WEB_VERSION,
      "Glovo-Client-Info": location.clientInfo || `web-customer-web-react/${WEB_VERSION} project:customer-web`,
      "Glovo-Device-Urn": location.deviceUrn || this.session?.deviceUrn || this.bits.deviceUrn,
      "Glovo-Language-Code": location.languageCode || "en",
      "Glovo-Location-Country-Code": location.countryCode,
      "Glovo-Location-City-Code": location.cityCode,
      "Glovo-Delivery-Location-Latitude": String(location.latitude),
      "Glovo-Delivery-Location-Longitude": String(location.longitude),
      "Glovo-Delivery-Location-Timestamp": now,
      "Glovo-Delivery-Location-Accuracy": String(location.accuracy || "0"),
      "Glovo-Perseus-Client-Id": location.perseusClientId || this.session?.perseusClientId || this.bits.perseusClientId,
      "Glovo-Perseus-Session-Id": location.perseusSessionId || this.session?.perseusSessionId || this.bits.perseusSessionId,
      "Glovo-Perseus-Session-Timestamp": location.perseusSessionTimestamp || this.session?.perseusSessionTimestamp || this.bits.perseusSessionTimestamp,
      "Glovo-Perseus-Consent": location.perseusConsent || "essential_functional_marketing",
      "Glovo-Request-Id": randomUUID(),
      "Glovo-Request-TTL": "7500",
    };
    if (auth && this.session?.accessToken) h.Authorization = this.session.accessToken;
    return h;
  }

  async refresh() {
    if (!this.session?.refreshToken) throw new AuthError("Glovo session expired. Run glovo_login again.");
    const res = await globalThis.fetch(`${API}/oauth/refresh`, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ refreshToken: this.session.refreshToken }),
    });
    if (!res.ok) throw new AuthError(`Glovo refresh failed (${res.status}). Run glovo_login again.`);
    const data = await res.json();
    const c = data?.access?.accessToken ? data.access : data;
    this.session = {
      ...this.session,
      accessToken: c.accessToken,
      refreshToken: c.refreshToken || this.session.refreshToken,
      expiresIn: c.expiresIn,
      tokenType: c.tokenType || this.session.tokenType,
      scope: c.scope ?? this.session.scope ?? null,
      createdAt: Date.now(),
    };
    saveSession(this.sessionPath, this.session);
    return this.session.accessToken;
  }

  async ensureAuth() {
    if (!this.session) throw new AuthError("Not signed in yet. Run glovo_login first.");
    const status = tokenStatus(this.session);
    if (status.secondsLeft > 60) return this.session.accessToken;
    return this.refresh();
  }

  async call(path, { method = "GET", body, auth = false, allowNotFound = false } = {}) {
    if (auth) await this.ensureAuth();
    const res = await globalThis.fetch(`${API}${path}`, {
      method,
      headers: this.baseHeaders({ auth }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) {
      if (auth && this.session?.refreshToken) {
        await this.refresh();
        return this.call(path, { method, body, auth, allowNotFound });
      }
      throw new AuthError(`Glovo auth failed (${res.status}). Run glovo_login first.`);
    }
    if (res.status === 204 || (allowNotFound && res.status === 404)) return null;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      const message = `${method} ${safePath(path.split("?")[0])} -> ${res.status}: ${safeErrorBody(text)}`;
      const error = res.status === 429 ? new RateLimitError(message) : new Error(message);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  getMe() {
    return this.call("/v3/me", { auth: true });
  }

  browseStores({ categoryId = 4, offset = 0, limit = 50, filters = [], previousStoreIds = [], handlingType = "DELIVERY" } = {}) {
    const qs = new URLSearchParams({
      moduleId: "StoreFeeds",
      offset: String(offset),
      limit: String(limit),
      handlingType,
    });
    return this.call(`/v1/web/store_wall/category/${categoryId}?${qs}`, {
      method: "POST",
      body: { filters, previousStoreIds },
    });
  }

  searchStores(query) {
    const value = String(query || "").trim();
    if (!value) throw new Error("Store search query is required.");
    const params = new URLSearchParams({ searchQuery: value });
    return this.call(`/v1/web/store_wall/search?${params.toString()}`, {
      method: "POST",
      body: { searchContext: { searchId: randomUUID() } },
    });
  }

  getStore(store) {
    return this.call(`/v3/stores/${encodeURIComponent(store)}?includeClosed=true&includeDisabled=false`);
  }

  getStoreMenu(storeId, storeAddressId, { translation, consents } = {}) {
    const qs = new URLSearchParams();
    if (translation) qs.set("translation", translation);
    if (consents) qs.set("consents", consents);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.call(`/v3/stores/${storeId}/addresses/${storeAddressId}/node/store_menu${suffix}`);
  }

  getStoreContent(storeId, storeAddressId, { contentSlug, translation, consents, useV4 = true, auth = false } = {}) {
    const qs = new URLSearchParams();
    if (translation) qs.set("translation", translation);
    if (contentSlug) {
      qs.set("nodeType", "DEEP_LINK");
      qs.set("link", contentSlug);
    }
    if (consents) qs.set("consents", consents);
    const path = useV4
      ? `/v4/stores/${storeId}/addresses/${storeAddressId}/content/main`
      : `/v3/stores/${storeId}/addresses/${storeAddressId}/content`;
    return this.call(`${path}${qs.toString() ? `?${qs}` : ""}`, { auth });
  }

  getStoreCatalog(storeId, storeAddressId, contentUri, { auth = true } = {}) {
    const url = new URL(String(contentUri || ""), API);
    if (url.origin !== API) throw new Error("Catalog content URI must use the Glovo API origin.");
    const store = encodeURIComponent(String(storeId));
    const address = encodeURIComponent(String(storeAddressId));
    const prefixes = [3, 4].map((version) => `/v${version}/stores/${store}/addresses/${address}/content`);
    if (!prefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      throw new Error("Catalog content URI must belong to the selected store and address.");
    }
    return this.call(`${url.pathname}${url.search}`, { auth });
  }

  getStoreFees(storeId, storeAddressId) {
    return this.call(`/v1/stores/${storeId}/addresses/${storeAddressId}/node/store_fees`);
  }

  getStoreRestrictions(storeId, storeAddressId) {
    return this.call(`/v4/stores/${storeId}/addresses/${storeAddressId}/restrictions`);
  }

  getStoreInfo(storeId, storeAddressId, translation = "en") {
    return this.call(`/v3/stores/${storeId}/addresses/${storeAddressId}/store_info_screen?translation=${encodeURIComponent(translation)}`);
  }

  getSimilarStores(storeId, limit = 5) {
    const qs = new URLSearchParams({ limit: String(limit), storeId: String(storeId), city_changed: "false" });
    return this.call(`/v1/store-view/web/similar-stores?${qs}`);
  }

  searchStoreItems(storeId, storeAddressId, query) {
    const qs = new URLSearchParams({ query, searchId: randomUUID() });
    return this.call(`/v3/stores/${storeId}/addresses/${storeAddressId}/search?${qs}`);
  }

  getProduct({ storeId, storeAddressId, productId, externalId, categoryId, collectionId, collectionGroupId, searchId, quantity = 1 }) {
    const qs = new URLSearchParams();
    if (externalId) qs.set("productExternalId", externalId);
    return this.call(`/v4/stores/${storeId}/addresses/${storeAddressId}/products/${productId}/view${qs.toString() ? `?${qs}` : ""}`, {
      method: "POST",
      body: {
        editingMode: false,
        origin: "STORE",
        categoryId,
        collectionId,
        collectionGroupId,
        translation: null,
        searchId,
        trackingOrigin: null,
        quantity,
      },
    });
  }

  getBaskets() {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets`, { auth: true });
  }

  getBasketByStore(storeId) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/stores/${storeId}`, { auth: true, allowNotFound: true });
  }

  createBasket({ storeId, storeAddressId, storeCategoryId, product }) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    if (!storeCategoryId || Number(storeCategoryId) === 0) throw new Error("storeCategoryId is required for new basket creation.");
    return this.call(`/v1/authenticated/customers/${id}/baskets`, {
      method: "POST",
      auth: true,
      body: {
        products: [product],
        storeId: asNumberIfNumeric(storeId),
        storeAddressId: asNumberIfNumeric(storeAddressId),
        storeCategoryId: asNumberIfNumeric(storeCategoryId),
        handlingStrategy: "DELIVERY",
      },
    });
  }

  updateBasketProducts(basketId, payload) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${encodeURIComponent(basketId)}/products`, {
      method: "PUT",
      auth: true,
      body: payload,
    });
  }

  updateProductQuantity(basketId, payload) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${encodeURIComponent(basketId)}/products/quantity`, {
      method: "PATCH",
      auth: true,
      body: payload,
    });
  }

  deleteBasket(basketId) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${encodeURIComponent(basketId)}`, {
      method: "DELETE",
      auth: true,
      allowNotFound: true,
    });
  }

  async addToBasket({ storeId, storeAddressId, storeCategoryId, productId, externalId, storeProductId, quantity = 1, selectedOptions = [], productView = null }) {
    if (productView) validateSelectedOptions(productView, selectedOptions);
    const product = basketProduct({ productId, externalId, storeProductId, quantity, selectedOptions, productView });
    const basket = await this.getBasketByStore(storeId);
    if (!basket) return this.createBasket({ storeId, storeAddressId, storeCategoryId, product });
    const existing = findBasketProduct(basket, { productId, storeProductId });
    if (existing?.ids?.basketProductId) {
      return this.updateProductQuantity(basket.basketId, {
        handlingStrategy: basket.handlingStrategy || "DELIVERY",
        basketVersion: basket.basketVersion,
        products: [{ basketProductId: existing.ids.basketProductId, quantity: (existing.quantity?.increments || 0) + quantity }],
      });
    }
    return this.updateBasketProducts(basket.basketId, {
      ...basket,
      products: [...(basket.products || []), product],
    });
  }

  async setQuantity({ storeId, productId, storeProductId, basketProductId, quantity }) {
    const basket = await this.getBasketByStore(storeId);
    if (!basket?.basketId) throw new Error(`No active basket for store ${storeId}.`);
    const product = findBasketProduct(basket, { productId, storeProductId, basketProductId });
    const id = basketProductId || product?.ids?.basketProductId;
    if (!id) throw new Error("Product is not in the basket.");
    if (quantity <= 0) return this.updateProductQuantity(basket.basketId, {
      handlingStrategy: basket.handlingStrategy || "DELIVERY",
      basketVersion: basket.basketVersion,
      products: [{ basketProductId: id, quantity: 0 }],
    });
    return this.updateProductQuantity(basket.basketId, {
      handlingStrategy: basket.handlingStrategy || "DELIVERY",
      basketVersion: basket.basketVersion,
      products: [{ basketProductId: id, quantity }],
    });
  }

  async removeFromBasket({ storeId, productId, storeProductId, basketProductId }) {
    const basket = await this.getBasketByStore(storeId);
    if (!basket?.basketId) throw new Error(`No active basket for store ${storeId}.`);
    const product = findBasketProduct(basket, { productId, storeProductId, basketProductId });
    const id = basketProductId || product?.ids?.basketProductId;
    if (!id) throw new Error("Product is not in the basket.");
    return this.updateProductQuantity(basket.basketId, {
      handlingStrategy: basket.handlingStrategy || "DELIVERY",
      basketVersion: basket.basketVersion,
      products: [{ basketProductId: id, quantity: 0 }],
    });
  }

  getOrders({ offset = 0, limit = 15 } = {}) {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.call(`/v3/customer/orders-list?${params.toString()}`, { auth: true });
  }

  async getAllOrderCards({ limit = 15, maxPages = Infinity, pageDelayMs = 750, maxRetries = 6, stopOrderIds = null } = {}) {
    const pages = [];
    const orders = [];
    const seenCursors = new Set();
    const seenOrders = new Set();
    let cursor = 0;
    let stoppedReason = "unknown";
    while (pages.length < maxPages) {
      if (seenCursors.has(String(cursor))) {
        stoppedReason = "repeated_cursor";
        break;
      }
      seenCursors.add(String(cursor));
      const page = await withRetry(() => this.getOrders({ offset: cursor, limit: Math.min(limit, 15) }), { maxRetries, label: "orders-list" });
      const pageOrders = page?.orders ?? page?.data?.orders ?? page?.data ?? page?.elements ?? [];
      if (!Array.isArray(pageOrders) || !pageOrders.length) {
        stoppedReason = "empty_page";
        break;
      }
      let knownOrderSeen = false;
      for (const order of pageOrders) {
        const compact = compactOrder(order);
        const id = compact?.order_id;
        if (id && stopOrderIds?.has(String(id))) knownOrderSeen = true;
        if (!id || seenOrders.has(String(id))) continue;
        seenOrders.add(String(id));
        orders.push(compact);
      }
      const nextOffset = page?.pagination?.next?.offset ?? null;
      pages.push({ cursor, count: pageOrders.length, next_offset: nextOffset });
      if (knownOrderSeen) {
        stoppedReason = "known_order";
        break;
      }
      if (!nextOffset) {
        stoppedReason = "no_next_cursor";
        break;
      }
      if (String(nextOffset) === String(cursor)) {
        stoppedReason = "repeated_next_cursor";
        break;
      }
      cursor = nextOffset;
      if (pageDelayMs) await sleep(pageDelayMs);
    }
    if (pages.length >= maxPages && stoppedReason === "unknown") stoppedReason = "max_pages";
    return { orders, pages, count: orders.length, stopped_reason: stoppedReason, strategy: "order-id-cursor" };
  }

  getOrder(orderId) {
    return this.call(`/v3/customer/orders/${orderId}`, { auth: true });
  }

  async analyzeOrderHistory({ maxPages = Infinity, detailLimit = 10, pageDelayMs = 750, detailDelayMs = 1000 } = {}) {
    const discovery = await this.getAllOrderCards({ maxPages, pageDelayMs });
    const details = [];
    let errors = 0;
    let rateLimited = false;
    let attempts = 0;
    for (const order of discovery.orders.slice(0, Math.max(0, detailLimit))) {
      attempts += 1;
      try {
        details.push(await this.getOrder(order.order_id));
      } catch (error) {
        if (error instanceof RateLimitError) {
          rateLimited = true;
          break;
        }
        errors += 1;
      }
      if (detailDelayMs) await sleep(detailDelayMs);
    }
    return {
      ...orderAnalysisFromDetails(details),
      card_statistics: orderStatsFromCards(discovery.orders),
      coverage: {
        discovered_orders: discovery.orders.length,
        cursor_pages: discovery.pages.length,
        detail_limit: Math.max(0, detailLimit),
        detail_attempts: attempts,
        detailed_orders: details.length,
        detail_errors: errors,
        detail_rate_limited: rateLimited,
        stopped_reason: discovery.stopped_reason,
        strategy: discovery.strategy,
      },
    };
  }

  async planReorder(orderId, { maxSearches = 5, candidatesPerLine = 3 } = {}) {
    const order = await this.getOrder(orderId);
    const storeId = order?.storeId ?? order?.store?.id ?? order?.store?.storeId;
    const storeAddressId = order?.storeAddressId ?? order?.store?.addressId ?? order?.store?.storeAddressId;
    if (!storeId || !storeAddressId) return buildReorderPlan(order, new Map(), { maxSearches, searched: 0 });

    const content = await this.getStoreContent(storeId, storeAddressId, { auth: true });
    const pool = compactStoreContent(content, { kind: "easy_reorder", limit: 100 }).products;
    const lines = pastOrderLines(order);
    const candidates = new Map();
    let searched = 0;
    for (const [index, line] of lines.entries()) {
      let ranked = rankProductCandidates(line.name, pool, candidatesPerLine);
      if ((!ranked.length || ranked[0].match_score < 0.9) && searched < maxSearches && line.name) {
        searched += 1;
        const current = compactSearch(await this.searchStoreItems(storeId, storeAddressId, line.name), {
          storeId: String(storeId),
          storeAddressId,
          limit: 24,
        }).results.map((product) => ({ ...product, source: "store_search" }));
        ranked = rankProductCandidates(line.name, [...pool, ...current], candidatesPerLine);
      }
      candidates.set(index, ranked);
    }
    return buildReorderPlan(order, candidates, { maxSearches, searched });
  }
}

export function compactStore(entry) {
  if (!entry) return null;
  const id = entry.id ?? entry.storeId;
  const categoryId = entry.categoryId ?? entry.category?.id;
  const storeClass = storeClassFromCategoryId(categoryId);
  return {
    id: String(id),
    store_id: String(id),
    store_address_id: entry.metadata?.storeAddressId ?? entry.addressId ?? entry.storeAddressId,
    name: entry.title ?? entry.name,
    slug: entry.slug,
    category: entry.tag ?? entry.category,
    category_id: categoryId,
    ...(storeClass ? { store_class: storeClass } : {}),
    open: entry.open ?? entry.availability?.status === "OPEN",
    eta: entry.eta,
    distance: entry.distance,
    rating: entry.ratings?.score ?? entry.rating,
    votes: entry.ratings?.votes,
    delivery_fee: entry.deliveryFee?.effectiveFee ?? entry.deliveryFee?.baseFee ?? entry.deliveryFeeInfo?.fee,
    service_fee: entry.serviceFee,
    image: imageUrl(entry.image?.lightImage ?? entry.imageId),
    logo: imageUrl(entry.logo?.lightImage ?? entry.logoImageId),
    url: entry.slug ? `https://glovoapp.com/en/es/barcelona/stores/${entry.slug}` : undefined,
  };
}

export function storeClassFromCategoryId(categoryId) {
  const id = Number(categoryId);
  if (id === 1) return "restaurant";
  if (id === 4) return "grocery";
  if (id === 3) return "retail";
  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.predictions)) return value.predictions;
  if (Array.isArray(value?.addresses)) return value.addresses;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data?.results)) return value.data.results;
  if (Array.isArray(value?.data?.predictions)) return value.data.predictions;
  if (Array.isArray(value?.data?.addresses)) return value.data.addresses;
  return [];
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "");
}

export function compactLocationSearch(data, { limit = 5 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 5, 1), 5);
  const results = asArray(data).slice(0, max).map((entry) => ({
    place_id: firstValue(entry.placeId, entry.place_id, entry.id),
    provider: firstValue(entry.provider, entry.source),
    title: firstValue(entry.title, entry.mainText, entry.primaryText, entry.name, entry.description),
    subtitle: firstValue(entry.subtitle, entry.secondaryText),
  })).filter((entry) => entry.place_id && entry.title);
  return {
    count: results.length,
    results,
  };
}

function coordinatePair(data) {
  const src = data?.data ?? data;
  const location = src?.geometry?.location ?? src?.location ?? src?.coordinates ?? src?.coordinate ?? {};
  return {
    latitude: Number(firstValue(src?.latitude, src?.lat, location.latitude, location.lat)),
    longitude: Number(firstValue(src?.longitude, src?.lon, src?.lng, location.longitude, location.lon, location.lng)),
  };
}

function locationCode(data, keys) {
  const src = data?.data ?? data;
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], src);
    if (value != null && value !== "") return String(value).toUpperCase();
  }
  return null;
}

function validCoordinates({ latitude, longitude }) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function validLocationCodes({ countryCode, cityCode }) {
  return /^[A-Z]{2}$/.test(String(countryCode || "")) && /^[A-Z0-9_-]{2,}$/i.test(String(cityCode || ""));
}

export function compactResolvedLocation(data) {
  const src = data?.data ?? data ?? {};
  const coords = coordinatePair(src);
  const countryCode = locationCode(src, ["countryCode", "country_code", "country.code", "address.countryCode"]);
  const cityCode = locationCode(src, ["cityCode", "city_code", "city.code", "address.cityCode"]);
  const title = firstValue(src.title, src.name, src.description, src.formattedAddress, src.address);
  const valid = validCoordinates(coords) && /^[A-Z]{2}$/.test(String(countryCode || ""));
  return {
    valid,
    reason: valid ? undefined : "invalid_resolved_location",
    title,
    country_code: countryCode,
    city_code: cityCode,
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: Number(firstValue(src.accuracy, src.location?.accuracy, 0)),
  };
}

export function compactDeliveryPointInfo(data) {
  const src = data?.data ?? data ?? {};
  const deliverable = firstValue(src.valid, src.deliverable, src.isDeliverable, src.serviceable, src.isServiceable, src.deliveryAvailable, src.isValid);
  return {
    deliverable: deliverable === true || String(deliverable).toLowerCase() === "true",
    country_code: locationCode(src, ["countryCode", "country_code", "country.code", "address.countryCode"]),
    city_code: locationCode(src, ["cityCode", "city_code", "city.code", "address.cityCode"]),
  };
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryMatches(haystack, query) {
  const h = normalizeMatchText(haystack);
  const q = normalizeMatchText(query);
  if (!h || !q) return false;
  if (h.includes(q)) return true;
  const tokens = [...new Set(q.split(" ").filter((token) => token.length > 1))];
  return tokens.length > 0 && tokens.every((token) => h.includes(token));
}

function numberClose(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.00001;
}

function currentMatchesAddress(current, address) {
  if (!address) return false;
  const countryMatch = !current.countryCode || !address.countryCode || String(current.countryCode).toUpperCase() === String(address.countryCode).toUpperCase();
  const cityMatch = !current.cityCode || !address.cityCode || String(current.cityCode).toUpperCase() === String(address.cityCode).toUpperCase();
  const coordMatch =
    (numberClose(current.latitude, address.latitude) && numberClose(current.longitude, address.longitude)) ||
    (numberClose(current.latitude, address.originalLatitude) && numberClose(current.longitude, address.originalLongitude));
  return countryMatch && cityMatch && coordMatch;
}

function savedAddressEntries(data) {
  const entries = data?.data?.addresses ?? data?.addresses ?? asArray(data);
  return entries
    .filter((entry) => entry?.entryType ? entry.entryType === "SAVED_ADDRESS" : entry?.address)
    .map((entry) => ({ entry, address: entry.address ?? entry }))
    .filter(({ address }) => address && typeof address === "object");
}

function locationArgsFromAddress(address) {
  const countryCode = firstValue(address.countryCode, address.country_code);
  const cityCode = firstValue(address.cityCode, address.city_code);
  const latitude = firstValue(address.latitude, address.lat);
  const longitude = firstValue(address.longitude, address.lon, address.lng);
  if (!validLocationCodes({ countryCode, cityCode }) || !validCoordinates({ latitude: Number(latitude), longitude: Number(longitude) })) return null;
  return {
    country_code: String(countryCode).toUpperCase(),
    city_code: String(cityCode).toUpperCase(),
    latitude: String(latitude),
    longitude: String(longitude),
  };
}

function compactSavedLocation(entry, address, { currentLocation = {}, matchText } = {}) {
  const locationArgs = locationArgsFromAddress(address);
  const searchable = [
    entry.title,
    entry.subtitle,
    address.addressLine,
    address.details,
    address.tag,
    address.kind,
    address.cityName,
    address.cityCode,
    address.countryCode,
    ...(Array.isArray(address.fields) ? address.fields.map((field) => field?.value) : []),
  ].filter(Boolean).join(" ");
  const explicitDefault = firstValue(entry.isDefault, entry.default, entry.defaultAddress, address.isDefault, address.default, address.defaultAddress);
  return cleanObject({
    id: address.id == null ? undefined : String(address.id),
    label: firstValue(entry.title, address.tag, address.kind),
    subtitle: firstValue(entry.subtitle, address.cityName),
    address_line: address.addressLine,
    details: address.details,
    kind: address.kind,
    tag: address.tag,
    city: address.cityName,
    country_code: locationArgs?.country_code ?? (address.countryCode ? String(address.countryCode).toUpperCase() : undefined),
    city_code: locationArgs?.city_code ?? (address.cityCode ? String(address.cityCode).toUpperCase() : undefined),
    latitude: locationArgs?.latitude,
    longitude: locationArgs?.longitude,
    selected: currentMatchesAddress(currentLocation, address),
    default: explicitDefault === true || String(explicitDefault).toLowerCase() === "true",
    matches_query: matchText ? queryMatches(searchable, matchText) : undefined,
    set_location_args: locationArgs,
  });
}

export function compactSavedLocations(data, { currentLocation = {}, matchText } = {}) {
  const savedLocations = savedAddressEntries(data).map(({ entry, address }) => compactSavedLocation(entry, address, { currentLocation, matchText }));
  const selected = savedLocations.find((location) => location.selected) || null;
  const defaultLocation = savedLocations.find((location) => location.default) || null;
  const matched = matchText ? savedLocations.find((location) => location.matches_query) || null : null;
  return {
    count: savedLocations.length,
    current_location: cleanObject({
      country_code: currentLocation.countryCode,
      city_code: currentLocation.cityCode,
      latitude: currentLocation.latitude == null ? undefined : String(currentLocation.latitude),
      longitude: currentLocation.longitude == null ? undefined : String(currentLocation.longitude),
      selected_saved_location_id: selected?.id ?? null,
    }),
    selected,
    default: defaultLocation,
    matched,
    saved_locations: savedLocations,
  };
}

export function compactStoreWall(data) {
  const stores = data?.data?.stores ?? data?.stores ?? {};
  const category = data?.data?.category ?? data?.category;
  const categoryId = category?.id ?? category?.categoryId;
  return {
    pagination: stores.pagination,
    count: stores.entries?.length ?? 0,
    stores: (stores.entries || []).map((entry) => compactStore(categoryId == null ? entry : { ...entry, categoryId: entry.categoryId ?? categoryId })),
    category,
    widgets: data?.data?.widgets?.map((w) => ({ id: w.id, title: w.title, template_id: w.templateId })),
  };
}

export function compactMenu(menu, limit = 80) {
  const result = [];
  const walk = (items = [], depth = 0, parent = []) => {
    for (const item of items) {
      if (result.length >= limit) return;
      result.push({
        name: item.name,
        slug: item.slug,
        depth,
        path: [...parent, item.name].filter(Boolean).join(" > "),
        content_uri: item.action?.data?.path,
        tracking: item.tracking,
      });
      walk(item.elements || [], depth + 1, [...parent, item.name]);
    }
  };
  walk(menu?.data?.elements || menu?.elements || []);
  return { type: menu?.type, count: result.length, sections: result };
}

export function compactItem(p, extra = {}) {
  if (!p) return null;
  return {
    id: String(p.id ?? p.productId),
    product_id: String(p.id ?? p.productId),
    external_id: p.externalId ?? p.productExternalId,
    store_product_id: p.storeProductId,
    name: p.name,
    price: p.priceInfo?.displayText ?? (p.price != null ? `€${Number(p.price).toFixed(2)}` : undefined),
    amount: p.priceInfo?.amount ?? p.price,
    image: p.imageUrl || imageUrl(p.imageId),
    sponsored: p.sponsored,
    restricted: p.restricted,
    available: availability(p),
    quantity_limit: p.quantityLimit,
    ...(p.categoryId != null ? { category_id: p.categoryId } : {}),
    ...extra,
  };
}

export function compactSearch(data, { storeId, storeAddressId, limit = 24 } = {}) {
  const products = (data?.results || []).flatMap((r) => r.products || []);
  return {
    total: data?.totalProducts ?? products.length,
    count: Math.min(products.length, limit),
    results: products.slice(0, limit).map((p) => compactItem(p, { store_id: storeId, store_address_id: storeAddressId })),
  };
}

function productEventData(element) {
  return (element?.actions || [])
    .flatMap((action) => action?.data?.events || [])
    .map((event) => event?.data)
    .find((data) => data?.collectionType || data?.isOrderedBefore) || {};
}

function contentKind(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

export function compactStoreContent(data, { kind = "all", limit = 40, storeId, storeAddressId } = {}) {
  const wanted = contentKind(kind);
  let remaining = Math.max(1, Math.min(Number(limit) || 40, 100));
  const sections = [];
  for (const section of data?.data?.body || data?.body || []) {
    const elements = section?.data?.elements || [];
    const productElements = elements.filter((element) => element?.type === "PRODUCT_TILE" && element?.data);
    if (!productElements.length) continue;
    const firstEvent = productEventData(productElements[0]);
    const collectionType = firstValue(firstEvent.collectionType, section?.data?.tracking?.collectionType, section?.data?.title, "products");
    const normalizedType = contentKind(collectionType);
    if (wanted !== "all" && wanted !== normalizedType) continue;
    const products = productElements.slice(0, remaining).map((element) => {
      const event = productEventData(element);
      return compactItem(element.data, {
        ...(storeId != null ? { store_id: String(storeId) } : {}),
        ...(storeAddressId != null ? { store_address_id: storeAddressId } : {}),
        description: element.data.description,
        collection_type: firstValue(event.collectionType, collectionType),
        ordered_before: String(event.isOrderedBefore).toLowerCase() === "true",
        source: normalizedType === "easyreorder" ? "easy_reorder" : normalizedType === "topsellers" ? "top_sellers" : "store_content",
      });
    });
    remaining -= products.length;
    sections.push({
      type: section.type,
      title: section.data?.title,
      slug: section.data?.slug,
      collection_type: collectionType,
      products,
    });
    if (!remaining) break;
  }
  const products = sections.flatMap((section) => section.products);
  return {
    kind,
    count: products.length,
    sections,
    products,
    ...(products.length ? {} : { unsupported_reason: "This content node exposes no product tiles. Use store item search for the live catalog." }),
  };
}

export function compactStoreOrderOptions({ fees, restrictions, info, similar }) {
  const feeData = fees?.data ?? fees ?? {};
  const similarStores = similar?.stores ?? similar?.data?.stores ?? [];
  return {
    handling_strategy: "DELIVERY",
    fee_information: feeData.feesInformation?.plainText,
    minimum_basket_ranges: (feeData.ranges || []).map((range) => cleanObject({
      lower_bound: range.lowerBound,
      upper_bound: range.upperBound,
      upper_bound_text: range.upperBoundInfo?.displayText,
      surcharge: range.surchargeInfo?.displayText,
      surcharge_strategy: range.surchargeStrategy,
      description: range.plainText,
      success_text: range.successText,
    })),
    restrictions_title: restrictions?.title,
    restrictions: (restrictions?.restrictions || []).map((restriction) => cleanObject({
      id: restriction.id,
      text: restriction.text ?? restriction.description,
      link: restriction.hyperlink?.url,
    })),
    store_information: (info?.sections || []).map((section) => cleanObject({
      type: section.type,
      text: section.data?.text ?? section.data?.label ?? section.data?.title,
    })).filter((section) => section.text),
    similar_stores: similarStores.map(compactStore),
    boundary: "Read-only pre-check. This does not create a basket, enter checkout, book a slot, pay, or place an order.",
  };
}

export function compactProductView(data) {
  const meta = data?.data?.metadata?.product ?? data?.metadata?.product ?? data?.product ?? data;
  const addEnabled = productAddEnabled(data);
  const optionGroups = optionGroupsFromProduct(data);
  return {
    ...compactItem({
    id: meta?.id,
    externalId: meta?.externalId,
    storeProductId: meta?.storeProductId,
    categoryId: meta?.categoryId,
    name: meta?.name,
    priceInfo: meta?.priceInfo,
    imageUrl: meta?.imageUrl,
    imageId: meta?.imageId,
    sponsored: meta?.sponsored,
    restricted: meta?.restricted,
    }),
    available: addEnabled,
    add_enabled: addEnabled,
    is_variant: meta?.isVariant ?? null,
    variant_selection: optionGroups.length ? "customizations" : meta?.isVariant === true ? "separate_catalog_product" : "not_exposed",
    option_groups: optionGroups,
    required_sections: data?.data?.actions?.primary?.events?.flatMap((e) => e?.data?.requiredSections || []) || [],
  };
}

export function compactBasket(basket) {
  if (!basket) return { products_count: 0, lines: [] };
  return {
    basket_id: basket.basketId,
    basket_version: basket.basketVersion,
    store_id: basket.storeId,
    store_address_id: basket.storeAddressId,
    products_count: (basket.products || []).reduce((sum, p) => sum + (p.quantity?.increments || 0), 0),
    total: basket.basketPrice?.final?.formatted ?? basket.basketPrice?.final?.major,
    lines: (basket.products || []).map((p) => ({
      basket_product_id: p.ids?.basketProductId,
      product_id: p.ids?.id,
      external_id: p.ids?.externalId,
      store_product_id: p.ids?.storeProductId,
      name: p.name ?? p.productName,
      quantity: p.quantity?.increments,
      price: p.price?.final?.formatted ?? p.price?.final?.major,
      image: p.imageUrl,
      selected_options_count: basketLineOptionCount(p),
      has_selected_options: basketLineOptionCount(p) > 0,
    })),
  };
}

export function compactOrder(o) {
  if (!o) return null;
  const cardItems = (o.content?.body || [])
    .map((entry) => entry?.data ?? entry?.text ?? "")
    .filter(Boolean)
    .flatMap((text) => String(text).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    order_id: o.id ?? o.orderId ?? o.orderCode,
    store: o.storeName ?? o.store?.name ?? o.providerName ?? o.content?.title,
    status: o.status ?? o.orderStatus,
    date: o.creationTime ?? o.createdAt ?? o.orderTime ?? o.deliveredAt,
    total: o.total?.formatted ?? o.totalAmount ?? o.price ?? o.footer?.left?.data,
    items: (o.products || o.orderProducts || o.items || []).slice(0, 5).map((p) => p.name ?? p.productName ?? p.title).concat(cardItems).slice(0, 5),
    url: (o.id ?? o.orderId) ? `https://glovoapp.com/en/profile/past-orders/${o.id ?? o.orderId}` : undefined,
  };
}

export function compactOrderDetail(o) {
  if (!o) return null;
  const lines = pastOrderLines(o);
  const date = orderDate(o);
  return {
    order_id: o.id ?? o.orderId ?? o.orderCode,
    store: o.storeName ?? o.store?.name ?? o.providerName,
    store_id: o.storeId ?? o.store?.id,
    store_address_id: o.storeAddressId ?? o.store?.addressId,
    store_slug: o.storeSlug ?? o.store?.slug,
    status: o.status ?? o.orderStatus ?? o.currentStatus?.type,
    date: date == null ? null : new Date(date).toISOString(),
    total: o.total?.formatted ?? o.totalAmount ?? o.price,
    handling_strategy: o.handlingStrategy?.type ?? o.handlingStrategy,
    native_reorder_allowed: Boolean(o.reorderData?.allowed || o.reorderData?.isAllowed || o.isRemake),
    can_go_to_store: Boolean(o.canGoToStore),
    refunded: Boolean(o.refunded),
    items: lines.map((p) => ({
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      customizations: p.customizations,
      free_product: p.free_product,
      promotion: p.promotion,
    })),
    pricing_breakdown: (o.pricingBreakdown?.lines || []).map((line) => cleanObject({ type: line.type, description: line.description, amount: line.amount, final_amount: line.finalAmount, note: line.note })),
  };
}

function pastOrderLines(o) {
  const lines = o?.boughtProducts || o?.products || o?.orderProducts || o?.items || o?.order?.products || [];
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    raw: line,
    name: line?.name ?? line?.productName ?? line?.title ?? null,
    quantity: Number.parseFloat(String(line?.quantity?.increments ?? line?.quantity ?? line?.amount ?? 1).replace(",", ".")) || 1,
    price: line?.price?.formatted ?? line?.price ?? null,
    customizations: line?.customizationsDescription ?? line?.description ?? null,
    free_product: Boolean(line?.freeProduct),
    promotion: line?.promotionDescription ?? null,
  }));
}

function orderDate(order) {
  const value = firstValue(order?.creationTime, order?.createdAt, order?.orderTime, order?.deliveredAt, order?.currentStatus?.creationTime);
  if (value == null) return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedProductName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(\d)\s+([a-z])\b/g, "$1$2")
    .trim();
}

export function productMatchScore(left, right) {
  const a = normalizedProductName(left);
  const b = normalizedProductName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 5) return 0.9;
  const aa = new Set(a.split(" ").filter(Boolean));
  const bb = new Set(b.split(" ").filter(Boolean));
  const overlap = [...aa].filter((token) => bb.has(token)).length;
  return Number((overlap / new Set([...aa, ...bb]).size).toFixed(3));
}

function rankProductCandidates(name, products, limit) {
  const seen = new Set();
  return products
    .map((product) => ({ ...product, match_score: productMatchScore(name, product.name) }))
    .filter((product) => {
      const key = `${product.product_id}|${product.external_id}|${product.store_product_id}`;
      if (!product.match_score || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match_score - a.match_score || String(a.name).localeCompare(String(b.name)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 3, 5)));
}

export function buildReorderPlan(order, candidatesByLine = new Map(), { maxSearches = 0, searched = 0 } = {}) {
  const preview = compactReorderPreview(order);
  const items = pastOrderLines(order).map((line, index) => {
    const candidates = candidatesByLine.get(index) || [];
    const best = candidates[0];
    const resolved = Boolean(best?.match_score >= 0.9 && best.product_id && best.external_id && best.store_product_id && best.available !== false);
    return {
      index,
      previous_name: line.name,
      previous_quantity: line.quantity,
      previous_customizations: line.customizations,
      requires_option_reselection: Boolean(line.customizations),
      resolved_current_product: resolved,
      requires_live_product_check: resolved,
      candidates,
    };
  });
  return {
    order_id: preview.order_id,
    store: preview.store,
    store_id: order?.storeId ?? order?.store?.id ?? null,
    store_address_id: order?.storeAddressId ?? order?.store?.addressId ?? null,
    native_reorder_allowed: preview.native_reorder_allowed,
    items_count: items.length,
    resolved_items: items.filter((item) => item.resolved_current_product).length,
    unresolved_items: items.filter((item) => !item.resolved_current_product).length,
    searches_used: searched,
    search_limit: maxSearches,
    can_prepare_after_review: items.length > 0 && items.every((item) => item.resolved_current_product),
    mutates_basket: false,
    next_step: "Inspect each selected candidate with glovo_get_product, reselect required options, obtain explicit approval, then call glovo_add_to_basket. This plan never places an order.",
    items,
  };
}

export function orderAnalysisFromDetails(details, { maxProducts = 50 } = {}) {
  const products = new Map();
  const seenOrders = new Set();
  for (const [orderIndex, order] of details.entries()) {
    const date = orderDate(order);
    for (const line of pastOrderLines(order)) {
      const key = normalizedProductName(line.name);
      if (!key) continue;
      const current = products.get(key) || { name: line.name, orders: 0, quantity: 0, dates: [], visible_line_amount: 0, parseable_line_amounts: 0, customizations: new Map() };
      const orderKey = `${order?.id ?? order?.orderId ?? orderIndex}|${key}`;
      if (!seenOrders.has(orderKey)) current.orders += 1;
      seenOrders.add(orderKey);
      current.quantity += line.quantity;
      if (date != null) current.dates.push(date);
      const amount = parseMoney(line.price);
      if (amount != null) {
        current.visible_line_amount += amount;
        current.parseable_line_amounts += 1;
      }
      if (line.customizations) current.customizations.set(line.customizations, (current.customizations.get(line.customizations) || 0) + 1);
      products.set(key, current);
    }
  }
  const topProducts = [...products.values()].map((product) => {
    const dates = [...new Set(product.dates)].sort((a, b) => a - b);
    const intervals = dates.slice(1).map((date, index) => (date - dates[index]) / 86_400_000).sort((a, b) => a - b);
    const middle = Math.floor(intervals.length / 2);
    const median = !intervals.length ? null : intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
    return {
      product: product.name,
      orders: product.orders,
      quantity: Number(product.quantity.toFixed(3)),
      first_order_at: dates.length ? new Date(dates[0]).toISOString() : null,
      last_order_at: dates.length ? new Date(dates.at(-1)).toISOString() : null,
      average_interval_days: intervals.length ? Number((intervals.reduce((sum, value) => sum + value, 0) / intervals.length).toFixed(1)) : null,
      median_interval_days: median == null ? null : Number(median.toFixed(1)),
      parseable_visible_line_amounts: product.parseable_line_amounts,
      visible_line_amount: Number(product.visible_line_amount.toFixed(2)),
      top_customizations: [...product.customizations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, orders]) => ({ name, orders })),
    };
  }).sort((a, b) => b.orders - a.orders || b.quantity - a.quantity || a.product.localeCompare(b.product)).slice(0, Math.max(1, maxProducts));
  return {
    analyzed_orders: details.length,
    distinct_products: products.size,
    top_products: topProducts,
    limitation: "Product cadence and customization statistics cover only successfully enriched order details; card-only orders are excluded from item analysis.",
  };
}

export function compactReorderPreview(o) {
  if (!o) return { can_prepare_basket: false, items: [], unsupported_reasons: ["Order detail was empty."] };
  const storeId = o.storeId ?? o.store?.id ?? o.store?.storeId;
  const storeAddressId = o.storeAddressId ?? o.store?.addressId ?? o.store?.storeAddressId;
  const lines = o.boughtProducts || o.products || o.orderProducts || o.items || o.order?.products || [];
  const items = (Array.isArray(lines) ? lines : []).map((line, index) => {
    const ids = line?.ids || {};
    const productId = line?.id ?? line?.productId ?? line?.product?.id ?? ids.id;
    const externalId = line?.externalId ?? line?.productExternalId ?? ids.externalId;
    const storeProductId = line?.storeProductId ?? ids.storeProductId;
    const optionCount = basketLineOptionCount(line);
    const reasons = [];
    if (!storeId) reasons.push("missing_store_id");
    if (!storeAddressId) reasons.push("missing_store_address_id");
    if (!productId && !storeProductId && !externalId) reasons.push("missing_product_identifier");
    if (optionCount) reasons.push("option_payload_requires_live_revalidation");
    return {
      index,
      name: line?.name ?? line?.productName ?? line?.title ?? null,
      quantity: Number.parseInt(String(line?.quantity?.increments ?? line?.quantity ?? line?.amount ?? 1), 10) || 1,
      has_product_identifier: Boolean(productId || storeProductId || externalId),
      has_selected_options: optionCount > 0,
      can_prepare_line: reasons.length === 0,
      unsupported_reasons: reasons,
    };
  });
  const unsupportedReasons = [...new Set(items.flatMap((item) => item.unsupported_reasons))];
  if (!items.length) unsupportedReasons.push("order_detail_has_no_product_lines");
  return {
    order_id: o.id ?? o.orderId ?? o.orderCode ?? o.code,
    store: o.storeName ?? o.store?.name ?? o.providerName ?? null,
    native_reorder_allowed: Boolean(o.reorderData?.allowed || o.reorderData?.isAllowed || o.isRemake),
    can_go_to_store: Boolean(o.canGoToStore),
    has_store_id: Boolean(storeId),
    has_store_address_id: Boolean(storeAddressId),
    items_count: items.length,
    can_prepare_basket: items.length > 0 && items.every((item) => item.can_prepare_line),
    unsupported_reasons: unsupportedReasons,
    limitation: unsupportedReasons.length
      ? "Read-only preview only. This order detail does not expose enough stable current product/option identifiers for a lossless basket rebuild."
      : "Preview has candidate identifiers, but any future basket preparation must revalidate live product availability and options before mutating the basket.",
    items,
  };
}

export function basketProduct({ productId, externalId, storeProductId, quantity = 1, selectedOptions = [], productView = null }) {
  if (!productId) throw new Error("productId is required for basket product payloads.");
  if (!externalId) throw new Error("externalId is required for basket product payloads.");
  if (!storeProductId) throw new Error("storeProductId is required for basket product payloads.");
  const product = {
    ids: {
      id: String(productId),
      externalId: String(externalId),
      storeProductId: String(storeProductId),
    },
    quantity: { increments: quantity },
  };
  const customizations = customizationPayload(productView, selectedOptions);
  if (customizations.length) product.customizations = customizations;
  return product;
}

export function storeCategoryIdFromStore(store) {
  return store?.categoryId ?? store?.data?.categoryId ?? store?.store?.categoryId ?? null;
}

function requireValue(value, label) {
  if (value == null || value === "") throw new Error(`Missing ${label} for customization payload.`);
  return value;
}

export function customizationPayload(productView, selectedOptions = []) {
  if (!selectedOptions.length) return [];
  if (!productView) throw new Error("productView is required for customization payloads.");
  const groups = optionGroupsFromProduct(productView);
  return selectedOptions.map((selected) => {
    const groupId = String(selected.group_id ?? selected.attributeGroupId ?? selected.groupId);
    const optionId = String(selected.option_id ?? selected.attributeId ?? selected.id);
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Unknown option group ${groupId}.`);
    const option = group.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new Error(`Unknown option ${optionId} for group ${groupId}.`);
    const ids = {
      groupLegacyId: requireValue(group.groupLegacyId, "groupLegacyId"),
      groupId: requireValue(group.groupId, "groupId"),
      groupExternalId: requireValue(group.groupExternalId, "groupExternalId"),
      groupPosition: requireValue(group.groupPosition, "groupPosition"),
      legacyId: requireValue(option.legacyId, "legacyId"),
      externalId: requireValue(option.externalId, "externalId"),
    };
    if (option.optionId != null && option.optionId !== "") ids.id = option.optionId;
    return {
      ids,
      name: option.name,
      quantity: { increments: selected.quantity ?? 1 },
      customizationName: option.name,
      groupName: group.name,
    };
  });
}

export function findBasketProduct(basket, { productId, storeProductId, basketProductId }) {
  return (basket?.products || []).find((p) => {
    const ids = p.ids || {};
    return (
      (basketProductId && ids.basketProductId === String(basketProductId)) ||
      (productId && ids.id === String(productId)) ||
      (storeProductId && ids.storeProductId === String(storeProductId))
    );
  });
}

export function optionGroupsFromProduct(data) {
  const product = data?.data?.metadata?.product ?? data?.metadata?.product ?? data?.product ?? data;
  const requiredIds = new Set((data?.data?.actions?.primary?.events || [])
    .flatMap((event) => event?.data?.requiredSections || [])
    .flatMap((section) => [section?.id, section?.sectionId, section?.attributeGroupId, section?.externalId, section])
    .filter((value) => value != null && typeof value !== "object")
    .map(String));
  return (product?.attributeGroups || product?.optionGroups || []).map((group) => {
    const options = group.attributes || group.options || group.values || [];
    const id = String(group.id ?? group.attributeGroupId ?? group.externalId);
    return {
      id,
      groupLegacyId: group.id,
      groupId: group.attributeGroupId,
      groupExternalId: group.externalId,
      groupPosition: group.position,
      name: group.name,
      required: Boolean(group.required || group.minSelection === 1 || group.minSelections > 0 || group.min > 0 || requiredIds.has(id) || requiredIds.has(String(group.externalId))),
      min: group.minSelection ?? group.minSelections ?? group.min ?? 0,
      max: group.maxSelection ?? group.maxSelections ?? group.max ?? null,
      options: options.map((option) => ({
        id: String(option.id ?? option.attributeId ?? option.externalId),
        legacyId: option.id,
        optionId: option.attributeId,
        externalId: option.externalId,
        name: option.name,
        price: option.priceInfo?.displayText ?? option.price?.formatted ?? option.price,
      })),
    };
  });
}

export function validateSelectedOptions(productView, selectedOptions = []) {
  const groups = optionGroupsFromProduct(productView);
  const selectedByGroup = new Map();
  for (const option of selectedOptions) {
    const groupId = String(option.group_id ?? option.attributeGroupId ?? option.groupId);
    const optionId = String(option.option_id ?? option.attributeId ?? option.id);
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`Unknown option group ${groupId}.`);
    if (!group.options.some((o) => o.id === optionId)) throw new Error(`Unknown option ${optionId} for group ${groupId}.`);
    selectedByGroup.set(groupId, (selectedByGroup.get(groupId) || 0) + (option.quantity ?? 1));
  }
  for (const group of groups) {
    const count = selectedByGroup.get(group.id) || 0;
    if (group.required && count < (group.min || 1)) throw new Error(`Missing required option group: ${group.name || group.id}.`);
    if (group.max != null && count > group.max) throw new Error(`Too many options for group: ${group.name || group.id}.`);
  }
  return true;
}

function basketLineOptionCount(line) {
  return ["attributes", "selectedAttributes", "modifiers", "options", "customizations"]
    .map((key) => line?.[key])
    .filter(Boolean)
    .reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 1), 0);
}

export function orderStatsFromCards(orders) {
  const byStore = new Map();
  let visibleTotal = 0;
  let parseableTotals = 0;
  let detailedOrders = 0;
  for (const order of orders) {
    const store = order.store || "Unknown store";
    const amount = parseMoney(order.total);
    const cur = byStore.get(store) || { orders: 0, visible_total_amount: 0, parseable_visible_totals: 0 };
    cur.orders += 1;
    if (amount != null) {
      cur.visible_total_amount += amount;
      cur.parseable_visible_totals += 1;
      visibleTotal += amount;
      parseableTotals += 1;
    }
    byStore.set(store, cur);
    if (order.detail_source === "detail") detailedOrders += 1;
  }
  return {
    orders: orders.length,
    detailed_orders: detailedOrders,
    card_only_orders: orders.length - detailedOrders,
    stores: byStore.size,
    parseable_visible_totals: parseableTotals,
    visible_total_amount: Number(visibleTotal.toFixed(2)),
    top_stores: [...byStore.entries()]
      .sort((a, b) => b[1].orders - a[1].orders || b[1].visible_total_amount - a[1].visible_total_amount || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([store, v]) => ({ store, orders: v.orders, visible_total_amount: Number(v.visible_total_amount.toFixed(2)), parseable_visible_totals: v.parseable_visible_totals })),
  };
}

function parseMoney(value) {
  if (value == null) return null;
  const match = String(value).replace(/\u00a0/g, " ").match(/-?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}
