import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GlovoClient,
  AuthError,
  compactStore,
  compactStoreWall,
  compactLocationSearch,
  compactSavedLocations,
  compactMenu,
  compactSearch,
  compactProductView,
  compactBasket,
  compactOrder,
  compactOrderDetail,
  compactReorderPreview,
  storeCategoryIdFromStore,
  orderStatsFromCards,
} from "./glovo/api.mjs";
import { runLogin } from "./auth/login.mjs";
import SHOPPING_GUIDE from "./shopping-guide.md";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = process.env.GLOVO_SESSION_PATH || path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".glovo"), "session.json");

function getClient() {
  return new GlovoClient(SESSION_PATH).reload();
}

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

function tool(handler) {
  return async (args) => {
    try {
      return await handler(args, getClient());
    } catch (e) {
      if (e instanceof AuthError) return fail(e.message);
      if (e?.code === "ENOENT") return fail("Not signed in yet. Run glovo_login first.");
      return fail(`Error: ${e.message}`);
    }
  };
}

const INSTRUCTIONS = `Use Glovo read-only tools before mutating the real basket.

Do not checkout or pay. Basket tools only prepare the user's real Glovo basket for later human review.
If auth is missing or expired, call glovo_login and let the user sign in in the browser.`;

const server = new McpServer({ name: "glovo", version: "0.1.2" }, { instructions: INSTRUCTIONS });

server.registerTool(
  "glovo_get_shopping_guide",
  {
    title: "Shopping guide",
    description: "Return the Glovo shopping playbook and safety rules. Call this before changing a basket.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: SHOPPING_GUIDE }] }),
);

server.registerTool(
  "glovo_auth_status",
  {
    title: "Auth status",
    description: "Check whether a Glovo session is available and whether the access token is currently valid.",
    inputSchema: {},
  },
  tool(async (_args, c) => json(c.authStatus())),
);

server.registerTool(
  "glovo_get_location",
  {
    title: "Get location",
    description: "Read the current Glovo browsing location headers. Does not mutate baskets.",
    inputSchema: {},
  },
  tool(async (_args, c) => json(c.location())),
);

server.registerTool(
  "glovo_set_location",
  {
    title: "Set location",
    description: "Set the local browsing location headers. This does not clear baskets, but changing stores may make an existing basket incompatible.",
    inputSchema: {
      country_code: z.string().min(2).max(2).optional(),
      city_code: z.string().min(2).optional(),
      latitude: z.union([z.string(), z.number()]).optional(),
      longitude: z.union([z.string(), z.number()]).optional(),
      language_code: z.string().min(2).optional(),
    },
  },
  tool(async (args, c) => json(c.setLocation({
    countryCode: args.country_code,
    cityCode: args.city_code,
    latitude: args.latitude,
    longitude: args.longitude,
    languageCode: args.language_code,
  }))),
);

server.registerTool(
  "glovo_get_saved_locations",
  {
    title: "Get saved delivery locations",
    description: "Read authenticated saved Glovo delivery locations and identify the current saved-location match. Read-only; does not change location headers or baskets.",
    inputSchema: {
      match_text: z.string().min(3).optional().describe("Optional private address text to match against saved locations. Not persisted."),
    },
  },
  tool(async ({ match_text }, c) => json(compactSavedLocations(await c.getSavedLocations(), { currentLocation: c.location(), matchText: match_text }))),
);

server.registerTool(
  "glovo_search_locations",
  {
    title: "Search locations",
    description: "Search public Glovo delivery locations by text. Returns only place id, provider, title, and subtitle.",
    inputSchema: {
      query: z.string().min(3).describe("Address or place text. Minimum 3 characters."),
      limit: z.number().int().min(1).max(5).optional().describe("Maximum suggestions returned. Default 5."),
    },
  },
  tool(async ({ query, limit }, c) => json(compactLocationSearch(await c.searchAddresses(query), { limit: limit ?? 5 }))),
);

server.registerTool(
  "glovo_select_location",
  {
    title: "Select location",
    description: "Resolve a public location suggestion, check guest delivery serviceability, and persist only valid browsing location headers.",
    inputSchema: {
      place_id: z.string().min(1).describe("Place id from glovo_search_locations."),
      provider: z.string().min(1).optional().describe("Provider from glovo_search_locations, if present."),
    },
  },
  tool(async ({ place_id, provider }, c) => json(await c.selectLocation({ placeId: place_id, provider }))),
);

server.registerTool(
  "glovo_login",
  {
    title: "Log in to Glovo",
    description: "Open Chrome for Glovo sign-in and save the local session for order history and basket tools.",
    inputSchema: {
      timeout_ms: z.number().int().min(1).max(300000).optional().describe("Maximum login wait. Defaults to five minutes; test harnesses may use a short timeout."),
    },
  },
  async ({ timeout_ms }) => {
    try {
      const r = await runLogin(SESSION_PATH, { timeoutMs: timeout_ms ?? 5 * 60_000 });
      return json({ signed_in: true, has_customer: Boolean(r.customerId), days_left: Number((r.daysLeft || 0).toFixed(3)), has_location: r.hasLocation });
    } catch (e) {
      const msg = /Cannot find (package|module) '?playwright/.test(e.message)
        ? "the browser component (Playwright) is not available to this server yet."
        : e.message;
      return fail(`Login failed: ${msg}`);
    }
  },
);

server.registerTool(
  "glovo_browse_stores",
  {
    title: "Browse stores",
    description: "Browse live Glovo stores for the configured location. category_id 4 = groceries, 1 = food/restaurants.",
    inputSchema: {
      category_id: z.number().int().optional().describe("Glovo category id. Default 4 (groceries); use 1 for food."),
      offset: z.number().int().min(0).optional().describe("Pagination offset. Default 0."),
      limit: z.number().int().min(1).max(50).optional().describe("Page size. Default 24, max 50."),
      previous_store_ids: z.array(z.union([z.string(), z.number()])).optional().describe("Store ids already returned, for pagination."),
    },
  },
  tool(async ({ category_id, offset, limit, previous_store_ids }, c) => {
    const data = await c.browseStores({
      categoryId: category_id ?? 4,
      offset: offset ?? 0,
      limit: limit ?? 24,
      previousStoreIds: (previous_store_ids || []).map(String),
    });
    return json(compactStoreWall(data));
  }),
);

server.registerTool(
  "glovo_get_store",
  {
    title: "Get store",
    description: "Get details for a Glovo store by slug or id, including store_id and store_address_id when available.",
    inputSchema: {
      store: z.union([z.string(), z.number()]).describe("Store slug or id, e.g. 'condis-bcn' or 324846."),
    },
  },
  tool(async ({ store }, c) => json(compactStore(await c.getStore(store)))),
);

server.registerTool(
  "glovo_get_store_menu",
  {
    title: "Get store menu",
    description: "Return a compact recursive menu/category list for a store.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      store_address_id: z.union([z.string(), z.number()]),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum menu nodes returned. Default 80."),
    },
  },
  tool(async ({ store_id, store_address_id, limit }, c) => json(compactMenu(await c.getStoreMenu(store_id, store_address_id), limit ?? 80))),
);

server.registerTool(
  "glovo_search_store_items",
  {
    title: "Search store items",
    description: "Search products/items inside a specific Glovo store. Use ids from glovo_browse_stores or glovo_get_store.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      store_address_id: z.union([z.string(), z.number()]),
      query: z.string().describe("Search text, e.g. 'leche', 'pizza', 'water'."),
      limit: z.number().int().min(1).max(50).optional().describe("Default 24."),
    },
  },
  tool(async ({ store_id, store_address_id, query, limit }, c) => {
    const data = await c.searchStoreItems(store_id, store_address_id, query);
    return json(compactSearch(data, { storeId: String(store_id), storeAddressId: store_address_id, limit: limit ?? 24 }));
  }),
);

server.registerTool(
  "glovo_get_product",
  {
    title: "Get product",
    description: "Get product details from a store. Use product ids returned by glovo_search_store_items.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      store_address_id: z.union([z.string(), z.number()]),
      product_id: z.union([z.string(), z.number()]),
      external_id: z.union([z.string(), z.number()]).optional(),
      category_id: z.union([z.string(), z.number()]).optional(),
      quantity: z.number().int().min(1).optional(),
    },
  },
  tool(async ({ store_id, store_address_id, product_id, external_id, category_id, quantity }, c) =>
    json(compactProductView(await c.getProduct({ storeId: store_id, storeAddressId: store_address_id, productId: product_id, externalId: external_id, categoryId: category_id, quantity: quantity ?? 1 }))),
  ),
);

server.registerTool(
  "glovo_get_basket",
  {
    title: "Get basket",
    description: "Read the current authenticated Glovo basket. If store_id is provided, read that store basket.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]).optional(),
    },
  },
  tool(async ({ store_id }, c) => {
    if (store_id) return json(compactBasket(await c.getBasketByStore(store_id)));
    return json(await c.getBaskets());
  }),
);

server.registerTool(
  "glovo_get_purchase_history",
  {
    title: "Purchase history",
    description: "Read authenticated Glovo order history. Pagination is cursor-based: start with offset 0, then pass the returned next_offset value.",
    inputSchema: {
      offset: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]).optional().describe("Order-id cursor. Default 0; use the returned next_offset for the next page."),
      limit: z.number().int().min(1).max(50).optional().describe("Default 15; Glovo currently caps order-history pages at 15."),
    },
  },
  tool(async ({ offset, limit }, c) => {
    const cursor = offset ?? 0;
    const data = await c.getOrders({ offset: cursor, limit: limit ?? 15 });
    const orders = data?.orders ?? data?.data?.orders ?? data?.data ?? data?.elements ?? [];
    const pagination = data?.pagination ?? null;
    return json({
      raw_shape: Array.isArray(orders) ? "array" : typeof orders,
      cursor,
      count: Array.isArray(orders) ? orders.length : undefined,
      next_offset: pagination?.next?.offset ?? null,
      pagination,
      orders: Array.isArray(orders) ? orders.map(compactOrder) : data,
    });
  }),
);

server.registerTool(
  "glovo_get_order_items",
  {
    title: "Order items",
    description: "Read details/items for one past Glovo order.",
    inputSchema: {
      order_id: z.union([z.string(), z.number()]).describe("Order id from glovo_get_purchase_history."),
    },
  },
  tool(async ({ order_id }, c) => json(compactOrderDetail(await c.getOrder(order_id)))),
);

server.registerTool(
  "glovo_preview_reorder",
  {
    title: "Preview reorder",
    description: "Read one past order and report whether it can be safely rebuilt into a basket. This never mutates the basket or places an order.",
    inputSchema: {
      order_id: z.union([z.string(), z.number()]).describe("Order id from glovo_get_purchase_history."),
    },
  },
  tool(async ({ order_id }, c) => json(compactReorderPreview(await c.getOrder(order_id)))),
);

server.registerTool(
  "glovo_get_order_stats",
  {
    title: "Order statistics",
    description: "Walk full order-history cursor pagination and return compact card-only statistics. Detail enrichment is intentionally separate.",
    inputSchema: {
      max_pages: z.number().int().min(1).optional(),
      page_delay_ms: z.number().int().min(0).max(10000).optional(),
    },
  },
  tool(async ({ max_pages, page_delay_ms }, c) => {
    const discovery = await c.getAllOrderCards({ maxPages: max_pages ?? Infinity, pageDelayMs: page_delay_ms ?? 750 });
    return json({ ...orderStatsFromCards(discovery.orders), discovery: { pages: discovery.pages.length, stopped_reason: discovery.stopped_reason, strategy: discovery.strategy } });
  }),
);

server.registerTool(
  "glovo_add_to_basket",
  {
    title: "Add to basket",
    description: "Add a product to the real Glovo basket. Do not call unless the user explicitly asks for a real basket change.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      store_address_id: z.union([z.string(), z.number()]),
      store_category_id: z.union([z.string(), z.number()]).optional(),
      product_id: z.union([z.string(), z.number()]),
      external_id: z.union([z.string(), z.number()]).optional(),
      store_product_id: z.union([z.string(), z.number()]).optional(),
      quantity: z.number().int().min(1).optional(),
      selected_options: z.array(z.object({
        group_id: z.union([z.string(), z.number()]),
        option_id: z.union([z.string(), z.number()]),
        quantity: z.number().int().min(1).optional(),
      })).optional().describe("Selected modifier options. Use option_group ids from glovo_get_product."),
      validate_options: z.boolean().optional().describe("Fetch product details and validate required/optional modifiers before adding. Default true when selected_options are supplied."),
    },
  },
  tool(async (args, c) => {
    const productView = args.validate_options === false && !args.selected_options?.length
      ? null
      : await c.getProduct({ storeId: args.store_id, storeAddressId: args.store_address_id, productId: args.product_id, externalId: args.external_id, quantity: args.quantity ?? 1 });
    const compactProduct = productView ? compactProductView(productView) : null;
    const storeCategoryId = args.store_category_id ?? storeCategoryIdFromStore(await c.getStore(args.store_id));
    return json(compactBasket(await c.addToBasket({
      storeId: args.store_id,
      storeAddressId: args.store_address_id,
      storeCategoryId,
      productId: args.product_id,
      externalId: args.external_id ?? compactProduct?.external_id,
      storeProductId: args.store_product_id ?? compactProduct?.store_product_id,
      quantity: args.quantity ?? 1,
      selectedOptions: args.selected_options || [],
      productView,
    })));
  }),
);

server.registerTool(
  "glovo_set_quantity",
  {
    title: "Set quantity",
    description: "Set exact product quantity in the real Glovo basket. Quantity 0 removes it. Do not call unless explicitly requested.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      product_id: z.union([z.string(), z.number()]).optional(),
      store_product_id: z.union([z.string(), z.number()]).optional(),
      basket_product_id: z.string().optional(),
      quantity: z.number().int().min(0),
    },
  },
  tool(async ({ store_id, product_id, store_product_id, basket_product_id, quantity }, c) =>
    json(compactBasket(await c.setQuantity({ storeId: store_id, productId: product_id, storeProductId: store_product_id, basketProductId: basket_product_id, quantity }))),
  ),
);

server.registerTool(
  "glovo_remove_from_basket",
  {
    title: "Remove from basket",
    description: "Remove one product from the real Glovo basket. Do not call unless explicitly requested.",
    inputSchema: {
      store_id: z.union([z.string(), z.number()]),
      product_id: z.union([z.string(), z.number()]).optional(),
      store_product_id: z.union([z.string(), z.number()]).optional(),
      basket_product_id: z.string().optional(),
    },
  },
  tool(async ({ store_id, product_id, store_product_id, basket_product_id }, c) =>
    json(compactBasket(await c.removeFromBasket({ storeId: store_id, productId: product_id, storeProductId: store_product_id, basketProductId: basket_product_id }))),
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("glovo MCP server ready (read + basket writes; no checkout)");
