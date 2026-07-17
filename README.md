# Glovo Claude Skill

Claude Code plugin and MCP server for Glovo. It can browse live stores, inspect menus and products, validate product modifiers, read authenticated order history with cursor pagination, and prepare a real basket. It does not expose checkout, payment, or order-placement tools.

## Install In Claude Code

```bash
claude plugin marketplace add denya/glovo-skill
claude plugin install glovo@denya-glovo
```

Then run `/reload-plugins` in Claude Code and inspect `/mcp` for the `glovo` server.

## Log In

Ask Claude to call `glovo_login` only when session bootstrap or refresh truly needs browser sign-in. That explicit tool may open a dedicated Chrome login window for session establishment; automated verification never calls it and does not open or navigate a browser. Session state is saved under Claude plugin data via `${CLAUDE_PLUGIN_DATA}/session.json`; local development uses `~/.glovo/session.json`.

Session files are written with mode `0600`. Tokens, exact coordinates, order payloads, and basket payloads are not printed by the included smoke scripts. After login, all store, product, history, stats, reorder, and basket work is API-only through `GlovoClient` HTTP calls using the saved access/refresh token.

## Claude Desktop MCPB

After a release is published, download [`glovo-skill.mcpb`](https://github.com/denya/glovo-skill/releases/latest/download/glovo-skill.mcpb), open it, and approve the extension in Claude Desktop. The package uses the same bundled `dist/server.mjs` runtime.

To build the Desktop package from source instead:

```bash
npm install
npm run build
npm run validate:mcpb
npm run pack:mcpb
```

Install the generated `.mcpb` in Claude Desktop.

## Tools

| Tool | Purpose | Auth |
| --- | --- | --- |
| `glovo_get_location` / `glovo_set_location` | Read or set local browsing location headers | No |
| `glovo_search_locations` / `glovo_select_location` | Search public delivery locations and select a serviceable browsing location | No |
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
npm run verify
```

`npm run verify` builds the bundled server, runs unit/contract tests, validates the Claude Code plugin and MCPB manifest, packs MCPB, runs the guest MCP smoke, runs a no-browser packaged-runtime/login-tool registration smoke, audits dependencies, and scans for secrets.

Authenticated smoke:

```bash
npm run test:mcp:auth
```

Reversible live basket E2E is intentionally dual-gated:

```bash
GLOVO_E2E_MUTATE=1 npm run live:e2e:mutate
```

The mutation E2E snapshots the current basket privately, refuses cross-store or unrestorable pre-existing lines, adds a selected pizza product, sets quantity, removes it, and restores the exact original canonical basket state in `finally`.

Current live mutation status: passed. Final controlled run used API-only Glovo calls, selected required modifiers, added the item, verified selected customizations, set quantity to 2, removed by official PATCH-zero quantity, verified the line absent in store/global basket reads, and restored the exact original salted basket fingerprint. Post-check showed `0` baskets / `0` lines and no recovery snapshots.

## Safety Notes

- No checkout, payment, or order-placement API is included.
- Basket writes are real and should only be run after explicit confirmation.
- Browser use is limited to session bootstrap or refresh. API research can observe the user's already-authenticated Chrome tabs when truly needed; the explicit `glovo_login` tool may open a dedicated Chrome login window. Store search, product lookup, history, stats, reorder preview, basket operations, and E2E verification use Glovo API HTTP calls through MCP, never browser navigation, tapping, or scraping.
- The packaged-runtime smoke does not launch Chrome. It proves the shipped layout starts with `NODE_PATH` empty, includes the login/runtime support files, registers `glovo_login`, and reads auth status against an empty temporary session.
- Full order details are rate-limited by Glovo; stats are based on card-level order pages unless detail enrichment is explicitly requested.
- Repeat/reorder is currently read-only preview. The live tested order detail exposed item names/prices/quantities but not stable current product identifiers, so automatic basket rebuild is refused for those lines.
