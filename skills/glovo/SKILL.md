---
name: glovo
description: Use the local Glovo MCP server for personalized live suggestions, Glovo stores and products, authenticated order analysis, repeat planning, and explicitly approved basket preparation.
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
- Store or product research: confirm the intended location first, then use `glovo_browse_stores`, `glovo_get_store`, and `glovo_get_store_menu`. Follow only an exact returned `content_uri` with `glovo_browse_store_catalog`; if it reports no product tiles, use `glovo_search_store_items`. This route supports restaurants, groceries, and retail shops without inventing variants. Finish with `glovo_get_product`, recommendations, and order-option checks as needed.
- Natural recommendation requests: map the request into `glovo_get_suggestions` intent. Use `repeat` for "again," `explore` for "new," and `balanced` when both are acceptable; pass food keywords, an explicit liked-venue constraint only when the user supplies it, desired item mode, novelty tolerance, and 3-5 choices. The tool is read-only and returns live products with history coverage, cache freshness, and required options. Default incremental history refresh still checks the newest Glovo page; use `history_refresh=full` only when a forced cursor-exhaustion refresh is needed.
- External quality evidence: request Google quality only when useful and configured. Request Google review text only when the user explicitly asks; preserve source links/author attribution and state when matching is ambiguous or the key is unavailable.
- Required product options: inspect `glovo_get_product`, choose valid required modifiers from the returned groups, and never synthesize product, store product, category, or modifier IDs.
- Order history or stats: use `glovo_get_order_stats` for full card discovery, `glovo_get_order_items` for one detail, and `glovo_analyze_order_history` for bounded detail-backed product frequency, cadence, customization, and visible-spend analysis. State card/detail coverage.
- Repeat/reorder: use `glovo_preview_reorder`, then `glovo_plan_reorder` to resolve past names to current catalog candidates. Inspect every selected candidate with `glovo_get_product`, reselect required options, obtain explicit approval, then use the existing basket tools. Do not use the unproven `reorderUrn` order-summary route.
- Suggestion to basket: after the user chooses a `glovo_get_suggestions` result, inspect that exact product again with `glovo_get_product`, select valid required options, snapshot `glovo_get_basket`, obtain explicit approval, mutate through the basket tools, and verify. Suggestions themselves must never change the basket.
- Basket preparation: read `glovo_get_basket`, inspect product/options, snapshot the current basket, obtain explicit approval, mutate via `glovo_add_to_basket` / `glovo_set_quantity` / `glovo_remove_from_basket`, verify the basket, and restore on test failure.

## Read-Only Default

Use read-only tools first:

`glovo_auth_status`, `glovo_get_location`, `glovo_get_saved_locations`, `glovo_search_locations`, `glovo_select_location`, `glovo_browse_stores`, `glovo_get_suggestions`, `glovo_get_store`, `glovo_get_store_menu`, `glovo_browse_store_catalog`, `glovo_get_store_recommendations`, `glovo_get_store_order_options`, `glovo_search_store_items`, `glovo_get_product`, `glovo_get_purchase_history`, `glovo_get_order_items`, `glovo_preview_reorder`, `glovo_plan_reorder`, `glovo_get_order_stats`, and `glovo_analyze_order_history`.

## Order History Pagination

`glovo_get_purchase_history` uses Glovo's order-id cursor pagination. Start with `offset: 0`, then pass the returned `next_offset` as the next call's `offset` until `next_offset` is empty or repeats. Do not increment the offset numerically; small numeric offsets can be ignored by the API and return the first page again.

For full history, use `glovo_get_order_stats` first. It persists discovery before optional detail enrichment and paces detail calls to avoid hammering Glovo's quota-limited endpoint.
