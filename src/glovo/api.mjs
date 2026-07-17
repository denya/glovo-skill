import { randomUUID } from "node:crypto";
import { loadSession, saveSession, tokenStatus } from "../auth/store.mjs";

export class AuthError extends Error {}
export class RateLimitError extends Error {}

const API = "https://api.glovoapp.com";
const WEB_VERSION = "v1.2368.1";
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
  if (value.available === true || value.isAvailable === true || value.enabled === true) return true;
  if (value.available === false || value.isAvailable === false || value.enabled === false || value.disabled === true || value.soldOut === true) return false;
  const status = String(value.availability?.status ?? value.status ?? "").toUpperCase();
  if (["AVAILABLE", "OPEN", "ENABLED"].includes(status)) return true;
  if (["UNAVAILABLE", "CLOSED", "DISABLED", "SOLD_OUT"].includes(status)) return false;
  return null;
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v != null && v !== ""));
}

function safePath(path) {
  return path.replace(/\/authenticated\/customers\/[^/]+/g, "/authenticated/customers/[customer]");
}

function safeErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.exceptionName || parsed?.error?.staticCode || parsed?.error?.message?.replace(/\d+/g, "#") || "request_failed";
  } catch {
    return String(text || "").replace(/\d+/g, "#").slice(0, 180);
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
    const res = await fetch(`${API}/oauth/refresh`, {
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
    const res = await fetch(`${API}${path}`, {
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

  getStoreContent(storeId, storeAddressId, { contentSlug, translation, consents, useV4 = true } = {}) {
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
    return this.call(`${path}${qs.toString() ? `?${qs}` : ""}`);
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
    return this.call(`/v1/authenticated/customers/${id}/baskets`, {
      method: "POST",
      auth: true,
      body: {
        products: [product],
        storeId: asNumberIfNumeric(storeId),
        storeAddressId: asNumberIfNumeric(storeAddressId),
        storeCategoryId: asNumberIfNumeric(storeCategoryId ?? 0),
        handlingStrategy: "DELIVERY",
      },
    });
  }

  updateBasketProducts(basketId, payload) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${basketId}/products`, {
      method: "PUT",
      auth: true,
      body: payload,
    });
  }

  updateProductQuantity(basketId, payload) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${basketId}/products/quantity`, {
      method: "PATCH",
      auth: true,
      body: payload,
    });
  }

  removeProducts(basketId, basketProductIds) {
    const id = this.session?.customerId || this.session?.customer?.id;
    if (!id) throw new AuthError("No customer id in Glovo session. Run glovo_login again.");
    return this.call(`/v1/authenticated/customers/${id}/baskets/${basketId}/products/${basketProductIds.join(",")}`, {
      method: "DELETE",
      auth: true,
    });
  }

  async addToBasket({ storeId, storeAddressId, storeCategoryId, productId, externalId, storeProductId, quantity = 1, selectedOptions = [], productView = null }) {
    if (productView) validateSelectedOptions(productView, selectedOptions);
    const product = basketProduct({ productId, externalId, storeProductId, quantity, selectedOptions });
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
    if (quantity <= 0) return this.removeProducts(basket.basketId, [id]);
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
    return this.removeProducts(basket.basketId, [id]);
  }

  getOrders({ offset = 0, limit = 15 } = {}) {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.call(`/v3/customer/orders-list?${params.toString()}`, { auth: true });
  }

  async getAllOrderCards({ limit = 15, maxPages = Infinity, pageDelayMs = 750, maxRetries = 6 } = {}) {
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
      for (const order of pageOrders) {
        const compact = compactOrder(order);
        const id = compact?.order_id;
        if (!id || seenOrders.has(String(id))) continue;
        seenOrders.add(String(id));
        orders.push(compact);
      }
      const nextOffset = page?.pagination?.next?.offset ?? null;
      pages.push({ cursor, count: pageOrders.length, next_offset: nextOffset });
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
}

export function compactStore(entry) {
  if (!entry) return null;
  const id = entry.id ?? entry.storeId;
  return {
    id: String(id),
    store_id: String(id),
    store_address_id: entry.metadata?.storeAddressId ?? entry.addressId ?? entry.storeAddressId,
    name: entry.title ?? entry.name,
    slug: entry.slug,
    category: entry.tag ?? entry.category,
    category_id: entry.categoryId,
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

export function compactStoreWall(data) {
  const stores = data?.data?.stores ?? data?.stores ?? {};
  return {
    pagination: stores.pagination,
    count: stores.entries?.length ?? 0,
    stores: (stores.entries || []).map(compactStore),
    category: data?.data?.category,
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

export function compactProductView(data) {
  const meta = data?.data?.metadata?.product ?? data?.metadata?.product ?? data?.product ?? data;
  return {
    ...compactItem({
    id: meta?.id,
    externalId: meta?.externalId,
    storeProductId: meta?.storeProductId,
    name: meta?.name,
    priceInfo: meta?.priceInfo,
    imageUrl: meta?.imageUrl,
    imageId: meta?.imageId,
    sponsored: meta?.sponsored,
    restricted: meta?.restricted,
    }),
    option_groups: optionGroupsFromProduct(data),
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
  const lines = o.products || o.orderProducts || o.items || o.order?.products || [];
  return {
    order_id: o.id ?? o.orderId ?? o.orderCode,
    store: o.storeName ?? o.store?.name ?? o.providerName,
    status: o.status ?? o.orderStatus,
    date: o.creationTime ?? o.createdAt ?? o.orderTime ?? o.deliveredAt,
    total: o.total?.formatted ?? o.totalAmount ?? o.price,
    items: lines.map((p) => ({
      name: p.name ?? p.productName ?? p.title,
      quantity: p.quantity ?? p.amount,
      price: p.price?.formatted ?? p.price,
      description: p.description,
    })),
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

export function basketProduct({ productId, externalId, storeProductId, quantity = 1, selectedOptions = [] }) {
  const product = {
    ids: {
      id: String(productId),
      externalId: String(externalId ?? storeProductId ?? productId),
      legacyId: String(productId),
      storeProductId: String(storeProductId ?? externalId ?? productId),
    },
    quantity: { increments: quantity },
  };
  const attrs = selectedOptions.map((o) => cleanObject({
    attributeGroupId: String(o.group_id ?? o.attributeGroupId ?? o.groupId),
    attributeId: String(o.option_id ?? o.attributeId ?? o.id),
    quantity: o.quantity ?? 1,
  }));
  if (attrs.length) product.attributes = attrs;
  return product;
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
      name: group.name,
      required: Boolean(group.required || group.minSelection === 1 || group.minSelections > 0 || group.min > 0 || requiredIds.has(id) || requiredIds.has(String(group.externalId))),
      min: group.minSelection ?? group.minSelections ?? group.min ?? 0,
      max: group.maxSelection ?? group.maxSelections ?? group.max ?? null,
      options: options.map((option) => ({
        id: String(option.id ?? option.attributeId ?? option.externalId),
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
