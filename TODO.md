# Glovo Skill Release TODO

## v0.2.1 Store Classes and Fast Suggestions

- [x] Map sanitized live restaurant, grocery, and non-food retail wall/search/catalog/product/fee/basket contracts at the current saved location.
- [x] Normalize only proven store-class gaps and return explicit unsupported-field reasons instead of guessed identifiers.
- [x] Preserve exact product, external, store-product, store-category, and option/variant identifiers through basket preparation contracts.
- [x] Add a private normalized order-card cache with exact-cursor incremental refresh, freshness metadata, corruption fallback, and no Google content.
- [x] Beat the 126-second baseline: cold full refresh took 108.87s; consecutive warm authenticated repeats took 5.92s and 5.16s with 946-card coverage and unchanged basket state.
- [x] Replace the stale local Codex v0.1.0 skill/extension without touching `~/.glovo/session.json`; register the current bundled MCP runtime.
- [x] Prove a fresh Codex configuration loads the current skill and full 27-tool surface with no browser and no v0.1.0 drift.
- [x] Run focused contracts, full verification, sanitized live reads, dependency/secret/privacy/no-browser gates, and exact session/basket checks.
- [ ] Bump aligned release metadata, commit, push, tag, publish MCPB/checksum, and install-test public Codex and Claude artifacts.

## v0.2.0 Suggestions

- [x] Add one read-only `glovo_get_suggestions` tool for repeat, explore, and balanced intents.
- [x] Rank familiar venues with the validation-selected multi-scale recency model; expose score components and full card-history coverage.
- [x] Resolve every proposed item against the current Glovo catalog and preserve required option groups for later review.
- [x] Keep product learning disabled until detailed-order coverage supports a real chronological holdout.
- [x] Add optional direct Google Places (New) enrichment for at most five finalists with strict field masks and conservative matching.
- [x] Degrade truthfully when `GOOGLE_MAPS_API_KEY` is absent or a place match is ambiguous.
- [x] Document the aggregate private-corpus evaluation without committing private orders, locations, or products.
- [x] Add deterministic repeat/explore/options/Google fallback and ambiguity tests.
- [x] Run checkout-free authenticated API-only suggestion E2E; do not mutate the basket.
- [x] Bump and align all runtime/package metadata to `0.2.0`.
- [x] Run full build, tests, MCP smoke, plugin/MCPB validation, audit, secret/privacy/no-browser checks, and isolated installs.
- [x] Commit, push, tag `v0.2.0`, publish the validated MCPB/checksum, then re-download and install-test the public artifact.

## Build

- [x] Create clean public repo from installed local extension source.
- [x] Add Claude Code plugin layout and validate with `claude plugin validate . --strict`.
- [x] Add MCPB manifest and validate/pack with `@anthropic-ai/mcpb`.
- [x] Replace legacy `dxt_version` manifest with MCPB `manifest_version: "0.3"` and correct author/repository/privacy metadata.
- [x] Keep session state outside repo/package under `${CLAUDE_PLUGIN_DATA}` or `~/.glovo`.
- [x] Harden session file to `0600` and session parent directory to `0700` on save/load migration.
- [x] Add missing read tools: API-only location search/select, authenticated saved delivery locations/current-location match, product option groups, full order pagination, order stats.
- [x] Add repeat/reorder surface as read-only preview with unsupported-line reasons.
- [x] Add authenticated Easy Reorder / Top Sellers research with current product identifiers.
- [x] Add store order-option pre-checks for delivery minimums, surcharges, restrictions, information, and alternatives.
- [x] Add bounded detail-backed history analysis with product frequency, cadence, customization, visible-spend, and truthful coverage.
- [x] Add read-only repeat planning that resolves old name-only lines to current candidates and routes approved items through existing product-option and basket tools.
- [x] Keep basket write tools explicit and no checkout/payment tools.

## Verification

- [x] Unit/contract tests for order cursor pagination, option payload validation, compact stats, and basket restore safety.
- [x] Contract tests prove `offset=0` then exact `pagination.next.offset`, repeated/empty cursor stopping, no numeric increment, and bounded 429 retry without real waiting.
- [x] Basket restore tests prove salted deep canonical fingerprints, private recovery snapshots, option-bearing original line refusal, bounded cleanup retry, failure after add/set restoration, and recovery-file deletion/preservation behavior.
- [x] Reorder preview test proves live-like order lines without product ids are refused for basket preparation.
- [x] Basket payload test proves distinct product id, external id, storeProductId, and nonzero storeCategoryId survive unchanged into create-basket payload; missing fields fail before POST.
- [x] Browser boundary/API transport tests prove Playwright is confined to login and direct API calls use explicit `globalThis.fetch`.
- [x] Packaged-runtime smoke verifies the MCPB/login-tool layout without launching or navigating a separate browser.
- [x] Location contract tests prove public autocomplete/resolve/serviceability URLs, no auth, capped compact output, saved-address read endpoint/auth behavior, and no-save on malformed or undeliverable locations.
- [x] Read-only live smoke: auth, stores, search, product details, order pagination.
- [x] MCP smoke exercises registered location and full-history/stats tools, not only client helpers.
- [x] Authenticated MCP smoke exercises store recommendations/order options, detail-backed analysis, and repeat planning without printing personal payloads.
- [x] Paced full-history analysis reached cursor exhaustion and bounded detail enrichment without 429.
- [x] Read-only live modifier preflight selects a currently open/available product instead of assuming pizza exists at every saved location.
- [x] Basket E2E: snapshot current basket, add pizza, set quantity, remove, verify exact restoration. Final run passed with PATCH-zero removal and exact salted fingerprint restore.
- [x] Modifier E2E: add a valid required-option product, verify basket, remove/restore. Final run passed with required options validated and selected customizations visible in the basket.
- [x] Dependency audit and secret/privacy scan.
- [x] Clean install from published GitHub repo and smoke once more from an isolated Claude config.

## Publish

- [x] MIT license and attribution.
- [x] README with install/auth/use commands and safety notes.
- [x] Local verified commit ready for public push.
- [x] Public GitHub repo created and final verified branch pushed under `denya`.
- [x] GitHub release `v0.1.1` published with verified Claude Desktop MCPB asset.
- [x] GitHub release `v0.1.2` published with the saved-location runtime tool and verified Claude Desktop MCPB asset.
- [x] Final local report: commit, feature matrix, E2E evidence, limitations, negative findings.
