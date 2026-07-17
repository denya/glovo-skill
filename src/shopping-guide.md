# Glovo Shopping Guide

Use Glovo read-only tools before changing a basket.

- Browse stores with `glovo_browse_stores`; category `4` is groceries and category `1` is food.
- Open a store with `glovo_get_store`, then use `glovo_get_store_menu`, `glovo_get_store_recommendations`, `glovo_get_store_order_options`, or `glovo_search_store_items`.
- For "again," "new," or "different item" requests, call `glovo_get_suggestions` first. It ranks familiar venues from full card history, resolves current products, reports coverage, and never changes the basket.
- Google quality is optional external evidence. Request review text only when the user explicitly asks, and preserve Google/author attribution.
- For repeat orders, call `glovo_plan_reorder`, inspect every chosen candidate with `glovo_get_product`, and reselect required options. The plan itself never changes the basket.
- To add an item, use IDs returned by search/product tools. Never invent `store_id`, `store_address_id`, `product_id`, `external_id`, or `store_product_id`.
- Basket tools mutate the real Glovo basket but do not checkout. The user reviews and pays in Glovo.
- If a tool says the session is missing or expired, run `glovo_login`.
