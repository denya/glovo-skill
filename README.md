# Glovo Skill and MCP

Open Claude integration for Glovo's live stores, menus, current reorder recommendations, product options, authenticated order analysis, saved delivery locations, and real basket preparation. It intentionally has no checkout, payment, delivery-slot booking, or order-placement tool. Browser use is limited to explicit session bootstrap; all location, store, product, history, research, reorder planning, and basket operations use Glovo HTTP APIs through MCP.

## Install in Claude Code

Requires current [Claude Code](https://code.claude.com/docs/en/setup), Node.js 18 or newer, and installed Google Chrome for optional login.

```bash
claude plugin marketplace add denya/glovo-skill
claude plugin install glovo@denya-glovo
```

Start or reload Claude Code, then inspect `/mcp` for the `glovo` server. The first account action can call `glovo_login`; that explicit customer login tool may open a dedicated Chrome login window only for session bootstrap. After a session is saved, normal operations use the direct API.

Claude Code stores session state in its private plugin-data directory via `${CLAUDE_PLUGIN_DATA}/session.json`; local development uses `~/.glovo/session.json`. Session files are written with mode `0600`.

## Install in Claude Desktop

Download the v0.1.2 installer:

**[Download Glovo v0.1.2 for Claude Desktop (.mcpb)](https://github.com/denya/glovo-skill/releases/download/v0.1.2/glovo-skill-0.1.2.mcpb)**

[Release notes and checksum](https://github.com/denya/glovo-skill/releases/tag/v0.1.2)

SHA256: `f3b4ac5dfab66ceeb121e0d74bebd6084e13887ce1d5cc3f616cca611ae35949`

1. Download `glovo-skill-0.1.2.mcpb` from the link above.
2. Open Claude Desktop on macOS.
3. Go to **Settings -> Extensions -> Advanced settings -> Install Extension...**.
4. Select `glovo-skill-0.1.2.mcpb` and approve the installation.
5. Ask Claude to use Glovo. Chrome opens only when account authorization is explicitly requested.

The Desktop package uses the same bundled `dist/server.mjs` runtime as Claude Code. Its manifest stores tokens and location headers in `~/.glovo/session.json` with private file permissions, not in the bundle.

To build the same package from source instead:

```bash
git clone https://github.com/denya/glovo-skill.git
cd glovo-skill
npm ci
npm run build
npm run validate:mcpb
npm run pack:mcpb
```

Install the generated `.mcpb` through **Settings -> Extensions -> Advanced settings -> Install Extension...**.

## What You Can Ask

Useful requests include:

- "Show my saved Glovo delivery locations and tell me whether the current one matches my saved home address."
- "Use this saved address as the Glovo location, then browse nearby supermarkets."
- "Find open grocery stores near the selected location."
- "Search a store menu for pizza and inspect required options before adding anything."
- "Show my current Easy Reorder products and this store's minimum basket, surcharge, and restrictions."
- "Show the product details and valid modifier choices for this item."
- "Read my complete Glovo order history and analyze product frequency, cadence, customizations, and top stores with explicit detail coverage."
- "Resolve my last order against current products, show unresolved lines, and re-check required options before adding anything."
- "Prepare this basket only after I approve each real basket mutation."

For private address matching, pass the address text at runtime to `glovo_get_saved_locations.match_text`. Do not commit or paste tokens, session files, or raw API payloads.

## Test the Local MCP

Build and verify without touching a real account:

```bash
git clone https://github.com/denya/glovo-skill.git
cd glovo-skill
npm ci
npm run verify
```

Run it as a local Claude Code plugin:

```bash
claude --plugin-dir "$(pwd)"
```

Then ask for Glovo. `npm run verify` never invokes login and never opens or navigates a browser. Authenticated smoke can be run after an explicit login:

```bash
npm run test:mcp:auth
```

For Claude Desktop, build the one-click local extension:

```bash
npm run pack:mcpb
```

## Tools

| Tool | Purpose | Auth |
| --- | --- | --- |
| `glovo_auth_status` / `glovo_login` | Check saved session or explicitly start session bootstrap | Login only |
| `glovo_get_location` / `glovo_set_location` | Read or set local browsing location headers | No |
| `glovo_search_locations` / `glovo_select_location` | Search public delivery locations and select a serviceable browsing location | No |
| `glovo_get_saved_locations` | Read saved delivery locations, infer the current saved-location match, and return explicit location args | Yes |
| `glovo_browse_stores` | Browse live Glovo stores for the configured location | No |
| `glovo_get_store` / `glovo_get_store_menu` | Inspect store details and menu nodes | No |
| `glovo_get_store_recommendations` | Read authenticated Easy Reorder or Top Sellers products with current identifiers | Yes |
| `glovo_get_store_order_options` | Read delivery minimums, surcharges, restrictions, store information, and alternatives | No |
| `glovo_search_store_items` / `glovo_get_product` | Search products and inspect required/optional modifiers | No |
| `glovo_get_purchase_history` / `glovo_get_order_stats` | Read order-history cursor pages and compact card-level stats | Yes |
| `glovo_get_order_items` / `glovo_analyze_order_history` | Inspect order items, pricing lines, product frequency, cadence, and coverage | Yes |
| `glovo_preview_reorder` / `glovo_plan_reorder` | Preview raw repeat support or resolve past lines to current catalog candidates | Yes |
| `glovo_get_basket` | Read current basket | Yes |
| `glovo_add_to_basket` / `glovo_set_quantity` / `glovo_remove_from_basket` | Mutate the real basket only after explicit user approval | Yes |

## Capabilities and Boundaries

- Saved delivery locations are read with `GET /customer_profile/api/v1/address_book/me/addresses` and filtered to Glovo's `SAVED_ADDRESS` entries.
- Public location search uses Glovo's address lookup APIs; saved-account location reads require authentication.
- Store search, product lookup, history, stats, reorder preview, basket reads, and basket writes are direct API calls. They do not drive, tap, or scrape Chrome.
- Authenticated store content exposes current Easy Reorder products with the three identifiers required by Glovo's basket contract. Guest content does not include that personalized section.
- Store order options are read-only pre-checks. They expose current delivery minimums, surcharges, restrictions, store information, and alternatives without entering checkout.
- Basket writes are real. Before basket tests or real edits, snapshot the current basket, mutate only after explicit approval, verify each stage, and restore on failure.
- Order history starts with `offset=0` and follows `pagination.next.offset` exactly. Do not numerically increment offsets.
- Full order details are quota-sensitive. `glovo_analyze_order_history` discovers cards first, enriches only a bounded recent subset, stops on 429, and reports card/detail coverage separately.
- Past details expose names, quantities, prices, customization text, and store identifiers but not stable current product IDs. `glovo_plan_reorder` resolves each line through authenticated Easy Reorder and bounded current-store search; every chosen candidate still goes through `glovo_get_product` for availability and option revalidation before an explicitly approved `glovo_add_to_basket` call.
- Glovo's web client exposes a `reorderUrn` navigation into order summary, but no direct basket-only native reorder endpoint/payload was proven. The MCP does not call that route or pretend it is safe.
- No checkout, payment, delivery-slot booking, or order-placement API is included.

## Verify a Checkout-Free Build

```bash
npm run verify
```

`npm run verify` builds the bundled server, runs unit and contract tests, validates the Claude Code plugin and MCPB manifest, packs MCPB, runs the guest MCP smoke, runs a no-browser packaged-runtime registration smoke, audits dependencies, and scans for secrets.

Reversible live basket E2E is intentionally dual-gated:

```bash
GLOVO_E2E_MUTATE=1 npm run live:e2e:mutate
```

The mutation E2E snapshots the current basket privately, refuses cross-store or unrestorable pre-existing lines, adds a selected product with required options, sets quantity, removes by official PATCH-zero quantity, and restores the exact original canonical basket state in `finally`.

MIT licensed. Independent project; not affiliated with, endorsed by, or sponsored by Glovo.
