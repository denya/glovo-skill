import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBasketState } from "./basket-safety.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suggestions = process.argv.includes("--suggestions");
const auth = process.argv.includes("--auth") || suggestions;
const tempSessionDir = auth ? null : mkdtempSync(`${os.tmpdir()}/glovo-mcp-smoke-`);
const sessionPath = auth ? process.env.GLOVO_SESSION_PATH : `${tempSessionDir}/session.json`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${root}/dist/server.mjs`],
  env: { ...process.env, ...(sessionPath ? { GLOVO_SESSION_PATH: sessionPath } : {}) },
  stderr: "inherit",
});

const client = new Client({ name: "glovo-test-harness", version: "0.0.1" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  const text = result.content?.map((c) => c.text).join("\n") ?? "";
  console.log(`\n# ${name}${result.isError ? " [isError]" : ""}`);
  if (result.isError) {
    console.log(JSON.stringify({ ok: false, message: text.replace(/\d/g, "#").slice(0, 160) }));
    return { result, text };
  }
  const parsed = JSON.parse(text || "{}");
  console.log(JSON.stringify(summarize(name, parsed), null, 2));
  return { result, text };
}

function summarize(name, parsed) {
  if (name === "glovo_auth_status") {
    return {
      ok: true,
      signed_in: Boolean(parsed.signed_in),
      access_token_valid: Boolean(parsed.access_token_valid),
      has_customer: Boolean(parsed.has_customer || parsed.customer_id != null),
      has_location: Boolean(parsed.has_location),
    };
  }
  if (name === "glovo_get_location") {
    return {
      ok: true,
      has_country: Boolean(parsed.countryCode),
      has_city: Boolean(parsed.cityCode),
      has_coordinates: parsed.latitude != null && parsed.longitude != null,
      has_device_context: Boolean(parsed.deviceUrn || parsed.perseusClientId || parsed.perseusSessionId),
    };
  }
  if (name === "glovo_get_saved_locations") {
    return {
      ok: true,
      count: parsed.count,
      has_selected_saved_location: Boolean(parsed.selected),
      has_default_saved_location: Boolean(parsed.default),
      has_current_location: Boolean(parsed.current_location?.country_code && parsed.current_location?.city_code),
      exposes_tokens: /token/i.test(JSON.stringify(parsed)),
    };
  }
  if (name === "glovo_search_locations") return { ok: true, count: parsed.count, has_place_ids: (parsed.results || []).every((entry) => Boolean(entry.place_id)), exposes_coordinates: JSON.stringify(parsed).includes("latitude") || JSON.stringify(parsed).includes("longitude") };
  if (name === "glovo_select_location") return { ok: true, selected: Boolean(parsed.selected), deliverable: Boolean(parsed.deliverable), has_city: Boolean(parsed.city_code), has_country: Boolean(parsed.country_code) };
  if (name === "glovo_browse_stores") return { ok: true, count: parsed.count, has_pagination: Boolean(parsed.pagination), category: parsed.category?.name || parsed.category?.title };
  if (name === "glovo_get_store_menu") return { ok: true, count: parsed.count, type: parsed.type };
  if (name === "glovo_browse_store_catalog") return { ok: true, count: parsed.count, sections: parsed.sections?.length || 0, has_search_fallback: Boolean(parsed.unsupported_reason), current_ids_complete: (parsed.products || []).every((product) => Boolean(product.product_id && product.external_id && product.store_product_id)) };
  if (name === "glovo_get_store_recommendations") return { ok: true, count: parsed.count, sections: parsed.sections?.length || 0, current_ids_complete: (parsed.products || []).every((product) => Boolean(product.product_id && product.external_id && product.store_product_id)), exposes_tokens: /token/i.test(JSON.stringify(parsed)) };
  if (name === "glovo_get_store_order_options") return { ok: true, fee_ranges: parsed.minimum_basket_ranges?.length || 0, restrictions: parsed.restrictions?.length || 0, store_information: parsed.store_information?.length || 0, similar_stores: parsed.similar_stores?.length || 0, checkout_free: /does not create a basket/i.test(parsed.boundary || "") };
  if (name === "glovo_search_store_items") return { ok: true, count: parsed.count, total: parsed.total };
  if (name === "glovo_get_suggestions") return {
    ok: true,
    choices: parsed.choices?.length || 0,
    order_cards: parsed.coverage?.order_cards_discovered,
    cursor_pages: parsed.coverage?.order_cursor_pages,
    cursor_stop: parsed.coverage?.order_cursor_stop,
    cache_status: parsed.coverage?.history_cache?.status,
    cache_mode: parsed.coverage?.history_cache?.mode,
    pages_fetched_this_call: parsed.coverage?.order_cursor_pages_fetched_this_call,
    stale: parsed.coverage?.history_cache?.stale,
    model: parsed.model?.name,
    holdout_orders: parsed.model?.holdout?.final_test_orders,
    products_revalidated: (parsed.choices || []).every((choice) => choice.product?.add_enabled === true),
    options_preserved: (parsed.choices || []).every((choice) => Array.isArray(choice.product?.option_groups)),
    google_available: Boolean(parsed.google_quality?.available),
    mutates_basket: Boolean(parsed.mutates_basket),
  };
  if (name === "glovo_get_purchase_history") return { ok: true, count: parsed.count, has_next_offset: parsed.next_offset != null, raw_shape: parsed.raw_shape };
  if (name === "glovo_get_order_items") return { ok: true, items: parsed.items?.length || 0, has_store_ids: Boolean(parsed.store_id && parsed.store_address_id), has_pricing_breakdown: Array.isArray(parsed.pricing_breakdown), native_reorder_allowed: Boolean(parsed.native_reorder_allowed) };
  if (name === "glovo_get_order_stats") return { ok: true, orders: parsed.orders, pages: parsed.discovery?.pages, stopped_reason: parsed.discovery?.stopped_reason, stores: parsed.stores };
  if (name === "glovo_analyze_order_history") return { ok: true, discovered_orders: parsed.coverage?.discovered_orders, detailed_orders: parsed.coverage?.detailed_orders, detail_rate_limited: Boolean(parsed.coverage?.detail_rate_limited), distinct_products: parsed.distinct_products, cadence_products: (parsed.top_products || []).filter((product) => product.average_interval_days != null).length };
  if (name === "glovo_get_basket") return { ok: true, basket_payload_present: parsed != null, products_count: parsed.products_count ?? parsed.baskets?.reduce((sum, basket) => sum + (basket.products?.length || 0), 0) };
  if (name === "glovo_preview_reorder") return { ok: true, items_count: parsed.items_count, can_prepare_basket: Boolean(parsed.can_prepare_basket), unsupported_reasons: parsed.unsupported_reasons || [] };
  if (name === "glovo_plan_reorder") return { ok: true, items_count: parsed.items_count, resolved_items: parsed.resolved_items, unresolved_items: parsed.unresolved_items, searches_used: parsed.searches_used, can_prepare_after_review: Boolean(parsed.can_prepare_after_review), mutates_basket: Boolean(parsed.mutates_basket) };
  return { ok: true, keys: Object.keys(parsed).sort() };
}

await call("glovo_auth_status");
await call("glovo_get_location");
if (suggestions) {
  const basketBefore = await call("glovo_get_basket", {});
  if (basketBefore.result.isError) throw new Error("Could not snapshot basket before suggestion smoke.");
  const canonicalBefore = canonicalBasketState(JSON.parse(basketBefore.text || "[]"));
  const result = await call("glovo_get_suggestions", {
    mode: "repeat",
    query: "pizza",
    item_mode: "repeat",
    quality_preference: "personal",
    max_choices: 3,
    include_google_quality: false,
  });
  if (result.result.isError) process.exitCode = 3;
  else {
    const parsed = JSON.parse(result.text || "{}");
    if ((parsed.choices?.length || 0) < 3 || parsed.mutates_basket !== false) {
      throw new Error("Suggestion smoke did not return three checkout-free choices.");
    }
  }
  const basketAfter = await call("glovo_get_basket", {});
  if (basketAfter.result.isError) throw new Error("Could not verify basket after suggestion smoke.");
  const canonicalAfter = canonicalBasketState(JSON.parse(basketAfter.text || "[]"));
  if (JSON.stringify(canonicalAfter) !== JSON.stringify(canonicalBefore)) {
    throw new Error("Suggestion smoke changed the authenticated basket.");
  }
  console.log(JSON.stringify({ basket_unchanged: true }));
  await client.close();
  console.log("\nOK - MCP suggestion test complete.");
  process.exit(process.exitCode || 0);
}
await call("glovo_search_locations", { query: "carrer mallorca", limit: 3 });
const browse = await call("glovo_browse_stores", { category_id: 4, limit: 5 });
if (browse.result.isError) {
  console.log(JSON.stringify({ event: "reachability", ok: false, stage: "browse_stores" }));
  await client.close();
  process.exit(2);
}
const stores = JSON.parse(browse.text).stores || [];
const first = stores[0];
if (!first?.store_id || !first?.store_address_id) throw new Error("No store returned for MCP search test.");
const menu = await call("glovo_get_store_menu", { store_id: first.store_id, store_address_id: first.store_address_id, limit: 10 });
if (menu.result.isError) console.log(JSON.stringify({ event: "reachability", ok: false, stage: "store_menu" }));
const search = await call("glovo_search_store_items", { store_id: first.store_id, store_address_id: first.store_address_id, query: "leche", limit: 5 });
if (search.result.isError) console.log(JSON.stringify({ event: "reachability", ok: false, stage: "store_search" }));

if (auth) {
  for (const categoryId of [1, 4, 3]) {
    const classBrowse = await call("glovo_browse_stores", { category_id: categoryId, limit: 5 });
    const classStores = classBrowse.result.isError ? [] : JSON.parse(classBrowse.text || "{}").stores || [];
    const classStore = classStores.find((store) => store.open !== false && store.store_id && store.store_address_id);
    if (!classStore) continue;
    const classMenu = await call("glovo_get_store_menu", { store_id: classStore.store_id, store_address_id: classStore.store_address_id, limit: 20 });
    const contentUri = classMenu.result.isError ? null : JSON.parse(classMenu.text || "{}").sections?.find((section) => section.content_uri)?.content_uri;
    if (contentUri) await call("glovo_browse_store_catalog", {
      store_id: classStore.store_id,
      store_address_id: classStore.store_address_id,
      content_uri: contentUri,
      limit: 5,
    });
  }
  await call("glovo_get_saved_locations", {});
  const history = await call("glovo_get_purchase_history", { limit: 3 });
  const historyParsed = history.result.isError ? null : JSON.parse(history.text || "{}");
  const firstOrder = historyParsed?.orders?.[0];
  if (firstOrder?.order_id) {
    await call("glovo_preview_reorder", { order_id: firstOrder.order_id });
    const detail = await call("glovo_get_order_items", { order_id: firstOrder.order_id });
    const detailParsed = detail.result.isError ? null : JSON.parse(detail.text || "{}");
    if (detailParsed?.store_id && detailParsed?.store_address_id) {
      await call("glovo_get_store_recommendations", { store_id: detailParsed.store_id, store_address_id: detailParsed.store_address_id, kind: "easy_reorder", limit: 10 });
      await call("glovo_get_store_order_options", { store_id: detailParsed.store_id, store_address_id: detailParsed.store_address_id, similar_limit: 3 });
      await call("glovo_plan_reorder", { order_id: firstOrder.order_id, max_searches: 2, candidates_per_line: 2 });
    }
  }
  await call("glovo_get_order_stats", { max_pages: 2, page_delay_ms: 0 });
  await call("glovo_analyze_order_history", { max_pages: 1, detail_limit: 2, page_delay_ms: 0, detail_delay_ms: 750 });
  await call("glovo_get_basket", {});
}

await client.close();
console.log("\nOK - MCP read-only test complete.");
