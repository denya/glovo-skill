# Glovo Skill and MCP

Open Claude and Codex integration for personalized live Glovo suggestions, saved delivery locations, stores, products and modifiers, authenticated order analysis, repeat planning, and real basket preparation. It has no checkout, payment, delivery-slot booking, or order-placement tool. Browser use is limited to explicit session bootstrap; every suggestion, location, catalog, history, research, repeat-plan, and basket operation uses Glovo HTTP APIs through MCP.

## Install in Claude Code

Requires current [Claude Code](https://code.claude.com/docs/en/setup), Node.js 18 or newer, and Google Chrome only if interactive login is needed.

```bash
claude plugin marketplace add denya/glovo-skill
claude plugin install glovo@denya-glovo
```

Reload Claude Code and inspect `/mcp` for `glovo`. The explicit `glovo_login` tool may open a dedicated Chrome login window for session bootstrap. Once saved, normal operations use the direct API. Claude Code stores session state at `${CLAUDE_PLUGIN_DATA}/session.json` with a `0700` parent directory and `0600` file.

Optional Google Maps quality evidence is configured after installation through `/plugin` -> **Installed** -> **Glovo** -> **Configure**. Leave it blank to use the complete personalized and Glovo-only path.

## Install in Claude Desktop

**[Download Glovo v0.2.1 for Claude Desktop (.mcpb)](https://github.com/denya/glovo-skill/releases/download/v0.2.1/glovo-skill-0.2.1.mcpb)**

[Release notes and checksum](https://github.com/denya/glovo-skill/releases/tag/v0.2.1)

SHA256: `1fa8c7b5b01fb5ff53ae5dcdfa21547941415378f17bb7c17d3362b8114102c3`

1. Download `glovo-skill-0.2.1.mcpb`.
2. Open Claude Desktop on macOS.
3. Go to **Settings -> Extensions -> Advanced settings -> Install Extension...**.
4. Select the MCPB and approve installation.
5. Optionally enter a restricted Google Maps Platform key when prompted.
6. Ask Claude to check Glovo authorization or make a read-only suggestion.

The Desktop package uses the same bundled `dist/server.mjs` runtime. It stores Glovo session state in `~/.glovo/session.json`, not in the bundle. To reproduce the package from source:

```bash
git clone https://github.com/denya/glovo-skill.git
cd glovo-skill
npm ci
npm run build
npm run validate:mcpb
npm run pack:mcpb
```

## Install in Codex

Codex uses the same local stdio MCP runtime and skill instructions:

```bash
git clone https://github.com/denya/glovo-skill.git ~/.local/share/glovo-skill
cd ~/.local/share/glovo-skill
npm ci
npm run build
codex mcp add glovo \
  --env GLOVO_SESSION_PATH="$HOME/.glovo/session.json" \
  -- node "$PWD/dist/server.mjs"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/glovo"
cp skills/glovo/SKILL.md "${CODEX_HOME:-$HOME/.codex}/skills/glovo/SKILL.md"
```

Restart Codex, then ask it to use Glovo. Optional Google enrichment can be added by registering `GOOGLE_MAPS_API_KEY` as another MCP environment value; do not put the key in the repository or a shared script.

## What You Can Ask

- "Pizza again: give me three live choices based on places I actually ordered from."
- "Try a new pizza from a high-quality place, with Google evidence if configured."
- "Use a favorite restaurant but suggest a different current item."
- "Show why each choice was selected, the history coverage, current price, availability, and required options."
- "Show my saved delivery locations and whether the current Glovo location matches one."
- "Find open supermarkets near the selected location and compare delivery minimums."
- "Browse a pharmacy or retail shop by category and show exact current sizes or packs without inventing variants."
- "Read my full order history and separate card-level venue statistics from detail-backed product statistics."
- "Resolve my previous order against the current catalog without changing the basket."
- "After I approve the exact product and modifiers, prepare the basket for my review."

`glovo_get_suggestions` accepts repeat, explore, or balanced intent and returns 3-5 labeled live choices. It never mutates the basket. The agent must use the separate product/options tools and obtain explicit approval before any basket change.

Suggestions keep an account-scoped private order-card cache beside the session file. Every request still refreshes Glovo from `offset=0` and follows exact cursors until it overlaps a known order; live stores, prices, availability, options, and all Google evidence remain uncached. Responses report cache mode, pages fetched, prior full-walk coverage, refresh time, and `stale:false`. Set `history_refresh=full` to force cursor exhaustion.

## Recommendation Evidence

Venue ranking uses all completed order cards and the validation-selected 5/20/80-event multi-scale recency model. On the untouched 137-order final window it achieved Precision@5 `0.083`, Recall@5 `0.416`, and NDCG@5 `0.271`; the popularity baseline reached Recall@5 `0.204` and NDCG@5 `0.160`. Selection used a contiguous 70/15/15 chronological split and the simplest model within one validation standard error.

This is holdout-supported evidence, not a claim of scientific proof. Product learning is deliberately disabled: only 15 orders had successful detail enrichment, which is insufficient for a defensible learned item model. Product choices therefore resolve against the current Glovo catalog, authenticated Easy Reorder, and Top Sellers, with required options re-fetched before presentation.

See [the aggregate evaluation and reproduction protocol](docs/RECOMMENDATION-EVALUATION.md). Run it against the authenticated card history without writing raw orders:

```bash
npm run eval:venues
```

## Optional Google Places

Google Places API (New) enriches only the final Glovo shortlist, normally at most five venues. Name and proximity must agree conservatively; ambiguous matches receive no Google attachment. Ratings use transparent Bayesian shrinkage with a 4.2 prior and weight 100 rather than raw averages. Google evidence is display-only and does not alter the backtested personalized rank.

Review text is fetched only when `include_google_reviews=true`, for at most three finalists. Responses preserve author attribution, review and Maps links, source notices, and Google's ordering caveat. The runtime does not persist ratings, reviews, or result payloads; it stores no Google data and uses an ephemeral request only.

No key is required. Without `GOOGLE_MAPS_API_KEY`, personalized Glovo suggestions still work and report that external quality evidence is unavailable. If enabling it:

- Restrict the key to **Places API (New)** and the environments that run this local MCP; rotate it if exposed.
- Review [API security guidance](https://developers.google.com/maps/api-security-best-practices), [usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing), and [current pricing](https://developers.google.com/maps/billing-and-pricing/pricing). Ratings/count fields and review details can trigger higher Places SKUs; review retrieval is therefore explicit.
- Preserve Google Maps attribution and source URIs under the [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies).
- Check the [Google Maps Platform EEA Terms](https://cloud.google.com/maps-platform/terms/maps-eea) if your billing account is in the EEA; terms and permitted use can differ.

[Maps Grounding Lite](https://developers.google.com/maps/ai/grounding-lite) can be installed separately for free-form place discovery, but it is not a dependency and does not replace the direct, bounded Places enrichment used here.

## Test the Local MCP

```bash
git clone https://github.com/denya/glovo-skill.git
cd glovo-skill
npm ci
npm run verify
claude --plugin-dir "$(pwd)"
```

`npm run verify` uses an empty temporary session for the guest MCP smoke, never invokes login, and never opens or navigates a browser. After an explicit login, the sanitized authenticated read smoke is:

```bash
npm run test:mcp:auth
```

## Tools

| Tool | Purpose | Auth |
| --- | --- | --- |
| `glovo_auth_status` / `glovo_login` | Check or explicitly bootstrap a saved session | Login only |
| `glovo_get_location` / `glovo_set_location` | Read or set local browsing-location headers | No |
| `glovo_search_locations` / `glovo_select_location` | Find and select a serviceable public location | No |
| `glovo_get_saved_locations` | Read saved delivery locations and current-match arguments | Yes |
| `glovo_browse_stores` / `glovo_get_store` / `glovo_get_store_menu` | Browse current restaurant, grocery, and retail stores and menus | No |
| `glovo_browse_store_catalog` | Follow an exact same-store menu content URI, with a truthful search fallback | Yes |
| `glovo_get_suggestions` | Produce personalized 3-5 current choices with optional Google evidence | Yes |
| `glovo_get_store_recommendations` / `glovo_get_store_order_options` | Read Easy Reorder, Top Sellers, fees, restrictions, and alternatives | Yes / No |
| `glovo_search_store_items` / `glovo_get_product` | Search current products and inspect required/optional modifiers | No |
| `glovo_get_purchase_history` / `glovo_get_order_stats` | Read cursor-correct card history and compact statistics | Yes |
| `glovo_get_order_items` / `glovo_analyze_order_history` | Inspect bounded detail-backed items, cadence, and coverage | Yes |
| `glovo_preview_reorder` / `glovo_plan_reorder` | Resolve a past order into current, reviewable candidates | Yes |
| `glovo_get_basket` | Read the current basket | Yes |
| `glovo_add_to_basket` / `glovo_set_quantity` / `glovo_remove_from_basket` | Mutate the real basket only after explicit approval | Yes |

## Capabilities and Boundaries

- All suggestion, search, location, product, history, stats, repeat-plan, and basket behavior is direct API traffic. It does not drive, tap, or scrape Chrome.
- History pagination starts at `offset=0` and follows `pagination.next.offset` exactly. It never numerically increments a cursor.
- Suggestions rank against a complete account-scoped order-card cache, refresh the newest cursor page on every call, and expose explicit freshness metadata. A forced full walk remains available. Product details remain a bounded, separately reported coverage layer.
- Restaurant, grocery, and retail surfaces share Glovo's API family. Catalog nodes are followed only through validated same-store content URIs; nodes without product tiles return an item-search fallback. Retail size or pack variants are never synthesized when Glovo exposes them only as separate named products.
- A previous purchase proves familiarity, not satisfaction. `known_liked_only` is used only when the user explicitly supplies that preference.
- Exploration is separate from the backtested repeat model. Novel candidates use current Glovo availability and count-aware Glovo quality; optional Google data remains clearly labeled external evidence.
- Every chosen product is re-fetched and must have `add_enabled=true`. Three product identifiers, the store category, and all required/optional modifier identities are preserved for later basket review.
- `glovo_plan_reorder` is read-only. Glovo exposes an order-summary navigation token, but no safe native basket-only reorder endpoint was proven, so this project does not guess one.
- Basket writes are real. Snapshot first, obtain explicit approval, verify each mutation, and restore on test failure.
- No checkout, payment, delivery-slot booking, or order-placement API is included.

## Verify a Checkout-Free Build

```bash
npm run verify
```

The gate builds the self-contained server, runs unit and contract tests, validates the Claude Code plugin and MCPB manifest, packs MCPB, runs guest MCP and isolated packaged-runtime smokes, audits dependencies, and scans for secrets and browser-boundary violations.

Reversible basket E2E remains separately dual-gated and is not run by release verification:

```bash
GLOVO_E2E_MUTATE=1 npm run live:e2e:mutate
```

MIT licensed. Independent project; not affiliated with, endorsed by, or sponsored by Glovo or Google.
