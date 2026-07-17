# Glovo Claude Skill

Claude Code plugin and MCP server for Glovo. It can browse live stores, inspect menus and products, validate product modifiers, read authenticated order history with cursor pagination, and prepare a real basket. It does not expose checkout, payment, or order-placement tools.

## Install In Claude Code

```bash
claude plugin marketplace add denya/glovo-skill
claude plugin install glovo@denya-glovo
```

Then run `/reload-plugins` in Claude Code and inspect `/mcp` for the `glovo` server.

## Log In

Ask Claude to call `glovo_login`. A Chrome window opens only for Glovo sign-in/session establishment. Session state is saved under Claude plugin data via `${CLAUDE_PLUGIN_DATA}/session.json`; local development uses `~/.glovo/session.json`.

Session files are written with mode `0600`. Tokens, exact coordinates, order payloads, and basket payloads are not printed by the included smoke scripts.

## Claude Desktop MCPB

Build a Desktop package from this repo:

```bash
npm install
npm run build
npm run validate:mcpb
npm run pack:mcpb
```

Install the generated `.mcpb` in Claude Desktop. The package uses the same bundled `dist/server.mjs` runtime.

## Tools

| Tool | Purpose | Auth |
| --- | --- | --- |
| `glovo_get_location` / `glovo_set_location` | Read or set local browsing location headers | No |
| `glovo_browse_stores` | Browse live Glovo stores | No |
| `glovo_get_store` / `glovo_get_store_menu` | Inspect store details and menu nodes | No |
| `glovo_search_store_items` / `glovo_get_product` | Search products and inspect required/optional modifiers | No |
| `glovo_get_purchase_history` | Read one cursor page of order history | Yes |
| `glovo_get_order_stats` | Walk all order pages and return compact card-level stats | Yes |
| `glovo_get_order_items` | Read one order detail when available | Yes |
| `glovo_preview_reorder` | Read one order detail and report whether a safe basket rebuild is possible | Yes |
| `glovo_get_basket` | Read current basket | Yes |
| `glovo_add_to_basket` / `glovo_set_quantity` / `glovo_remove_from_basket` | Mutate the real basket only after explicit user approval | Yes |

Order history starts with `offset=0` and follows `pagination.next.offset` exactly. Do not numerically increment offsets.

## Verify

```bash
npm install
npm run build
npm test
npm run validate:plugin
npm run validate:mcpb
npm run test:mcp
npm audit --audit-level=high
npm run scan:secrets
```

Authenticated smoke:

```bash
npm run test:mcp:auth
```

Reversible live basket E2E is intentionally dual-gated:

```bash
GLOVO_E2E_MUTATE=1 npm run live:e2e:mutate
```

The mutation E2E snapshots the current basket privately, refuses cross-store or unrestorable pre-existing lines, adds a selected pizza product, sets quantity, removes it, and restores the exact original canonical basket state in `finally`.

Current live mutation status: basket restore safety is tested, and failed live add attempts left the basket unchanged, but Glovo returned `PRODUCT_NOT_AVAILABLE` after product-detail preflight. Do not treat add/set/remove E2E as passed until the add payload root cause is fixed and rerun.

## Safety Notes

- No checkout, payment, or order-placement API is included.
- Basket writes are real and should only be run after explicit confirmation.
- Browser automation is used only for login/session establishment. Store search, product lookup, history, stats, reorder preview, and basket operations use the Glovo API through MCP.
- The bundled login smoke proves the packaged runtime can open Chrome, but it uses a temporary session and short timeout.
- Full order details are rate-limited by Glovo; stats are based on card-level order pages unless detail enrichment is explicitly requested.
- Repeat/reorder is currently read-only preview. The live tested order detail exposed item names/prices/quantities but not stable current product identifiers, so automatic basket rebuild is refused for those lines.
