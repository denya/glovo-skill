---
name: glovo
description: Use the local Glovo MCP server to browse live Glovo supermarkets/restaurants, search store items, inspect product options, read authenticated order history, and prepare baskets. Use when the user asks about Glovo products, food delivery, grocery stores, order history, or basket filling.
---

# Glovo

This skill wraps the bundled `glovo` MCP server.

## Safety

- Do not checkout, pay, place an order, or submit payment details; the server exposes no checkout tool.
- Do not add, remove, set quantity, repeat, or reorder unless the user explicitly asks for a real basket change.
- Use `glovo_preview_reorder` for repeat/reorder requests first. It is read-only and reports unsupported lines; do not rebuild a basket from past orders unless a future prepare tool explicitly validates live products and options.
- Before basket tests or real basket edits, snapshot the current basket and restore it exactly.
- Session state lives in plugin data or `~/.glovo/session.json`; never print or commit it.
- Browser automation is allowed only for optional `glovo_login` / session establishment. Do not drive, tap, or scrape Chrome for store search, product lookup, order history, stats, reorder preview, basket operations, or E2E verification; use `GlovoClient` API/MCP HTTP tools with the saved access/refresh token.

## Read-Only Flow

Use read-only tools first:

- `glovo_auth_status`
- `glovo_login`
- `glovo_get_location`
- `glovo_set_location`
- `glovo_search_locations`
- `glovo_select_location`
- `glovo_browse_stores`
- `glovo_get_store`
- `glovo_get_store_menu`
- `glovo_search_store_items`
- `glovo_get_product`
- `glovo_get_purchase_history`
- `glovo_get_order_items`
- `glovo_preview_reorder`
- `glovo_get_order_stats`

## Order History Pagination

`glovo_get_purchase_history` uses Glovo's order-id cursor pagination. Start with `offset: 0`, then pass the returned `next_offset` as the next call's `offset` until `next_offset` is empty or repeats. Do not increment the offset numerically; small numeric offsets can be ignored by the API and return the first page again.

For full history, use `glovo_get_order_stats` first. It persists discovery before optional detail enrichment and paces detail calls to avoid hammering Glovo's quota-limited endpoint.
