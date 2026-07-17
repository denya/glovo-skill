---
name: glovo
description: Use the local Glovo MCP server to browse live Glovo supermarkets/restaurants, search store items, inspect product options, read authenticated order history, and prepare baskets. Use when the user asks about Glovo products, food delivery, grocery stores, order history, or basket filling.
---

# Glovo

This skill wraps the bundled `glovo` MCP server.

## Safety

- Do not checkout, pay, place an order, or submit payment details; the server exposes no checkout tool.
- Do not add, remove, set quantity, repeat, or reorder unless the user explicitly asks for a real basket change.
- Session state lives in plugin data or `~/.glovo/session.json`; never print or commit it.
- Browser automation is allowed only for optional `glovo_login` / session establishment. Do not drive, tap, or scrape Chrome for store search, product lookup, order history, stats, reorder preview, basket operations, or E2E verification; use `GlovoClient` API/MCP HTTP tools with the saved access/refresh token.

## Route the Task

- Authentication or expired tokens: use `glovo_auth_status`, then `glovo_login` only if the saved session cannot be refreshed.
- Saved delivery address or "use my home/current address": use `glovo_get_saved_locations` first. If the user gives private address text, pass it as runtime-only `match_text`; do not write it into files. If the user wants to use a saved address, call `glovo_set_location` only with the explicit `set_location_args` returned by the saved-location tool.
- Public address discovery: use `glovo_search_locations` and `glovo_select_location`.
- Store or product search: confirm the intended location first, then use `glovo_browse_stores`, `glovo_get_store`, `glovo_get_store_menu`, `glovo_search_store_items`, and `glovo_get_product`.
- Required product options: inspect `glovo_get_product`, choose valid required modifiers from the returned groups, and never synthesize product, store product, category, or modifier IDs.
- Order history or stats: use `glovo_get_purchase_history`, `glovo_get_order_items`, and `glovo_get_order_stats`.
- Repeat/reorder: use `glovo_preview_reorder` first. It is read-only and reports unsupported lines; do not rebuild a basket from past orders unless live products/options are validated and the user explicitly approves.
- Basket preparation: read `glovo_get_basket`, inspect product/options, snapshot the current basket, obtain explicit approval, mutate via `glovo_add_to_basket` / `glovo_set_quantity` / `glovo_remove_from_basket`, verify the basket, and restore on test failure.

## Read-Only Default

Use read-only tools first:

`glovo_auth_status`, `glovo_get_location`, `glovo_get_saved_locations`, `glovo_search_locations`, `glovo_select_location`, `glovo_browse_stores`, `glovo_get_store`, `glovo_get_store_menu`, `glovo_search_store_items`, `glovo_get_product`, `glovo_get_purchase_history`, `glovo_get_order_items`, `glovo_preview_reorder`, and `glovo_get_order_stats`.

## Order History Pagination

`glovo_get_purchase_history` uses Glovo's order-id cursor pagination. Start with `offset: 0`, then pass the returned `next_offset` as the next call's `offset` until `next_offset` is empty or repeats. Do not increment the offset numerically; small numeric offsets can be ignored by the API and return the first page again.

For full history, use `glovo_get_order_stats` first. It persists discovery before optional detail enrichment and paces detail calls to avoid hammering Glovo's quota-limited endpoint.
