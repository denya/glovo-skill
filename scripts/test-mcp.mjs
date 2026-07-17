import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const auth = process.argv.includes("--auth");
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
  const result = await client.callTool({ name, arguments: args });
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
  if (name === "glovo_search_locations") return { ok: true, count: parsed.count, has_place_ids: (parsed.results || []).every((entry) => Boolean(entry.place_id)), exposes_coordinates: JSON.stringify(parsed).includes("latitude") || JSON.stringify(parsed).includes("longitude") };
  if (name === "glovo_select_location") return { ok: true, selected: Boolean(parsed.selected), deliverable: Boolean(parsed.deliverable), has_city: Boolean(parsed.city_code), has_country: Boolean(parsed.country_code) };
  if (name === "glovo_browse_stores") return { ok: true, count: parsed.count, has_pagination: Boolean(parsed.pagination), category: parsed.category?.name || parsed.category?.title };
  if (name === "glovo_get_store_menu") return { ok: true, count: parsed.count, type: parsed.type };
  if (name === "glovo_search_store_items") return { ok: true, count: parsed.count, total: parsed.total };
  if (name === "glovo_get_purchase_history") return { ok: true, count: parsed.count, has_next_offset: parsed.next_offset != null, raw_shape: parsed.raw_shape };
  if (name === "glovo_get_order_stats") return { ok: true, orders: parsed.orders, pages: parsed.discovery?.pages, stopped_reason: parsed.discovery?.stopped_reason, stores: parsed.stores };
  if (name === "glovo_get_basket") return { ok: true, basket_payload_present: parsed != null, products_count: parsed.products_count ?? parsed.baskets?.reduce((sum, basket) => sum + (basket.products?.length || 0), 0) };
  if (name === "glovo_preview_reorder") return { ok: true, items_count: parsed.items_count, can_prepare_basket: Boolean(parsed.can_prepare_basket), unsupported_reasons: parsed.unsupported_reasons || [] };
  return { ok: true, keys: Object.keys(parsed).sort() };
}

await call("glovo_auth_status");
await call("glovo_get_location");
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
  const history = await call("glovo_get_purchase_history", { limit: 3 });
  const historyParsed = history.result.isError ? null : JSON.parse(history.text || "{}");
  const firstOrder = historyParsed?.orders?.[0];
  if (firstOrder?.order_id) await call("glovo_preview_reorder", { order_id: firstOrder.order_id });
  await call("glovo_get_order_stats", { max_pages: 2, page_delay_ms: 0 });
  await call("glovo_get_basket", {});
}

await client.close();
console.log("\nOK - MCP read-only test complete.");
