# Glovo Shopping Guide

Use Glovo read-only tools before changing a basket.

- Browse stores with `glovo_browse_stores`; category `4` is groceries and category `1` is food.
- Open a store with `glovo_get_store`, then use `glovo_get_store_menu` or `glovo_search_store_items`.
- To add an item, use IDs returned by search/product tools. Never invent `store_id`, `store_address_id`, `product_id`, `external_id`, or `store_product_id`.
- Basket tools mutate the real Glovo basket but do not checkout. The user reviews and pays in Glovo.
- If a tool says the session is missing or expired, run `glovo_login`.
