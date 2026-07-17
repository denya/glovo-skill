# Glovo Skill Release TODO

## Build

- [x] Create clean public repo from installed local extension source.
- [x] Add Claude Code plugin layout and validate with `claude plugin validate . --strict`.
- [x] Add MCPB manifest and validate/pack with `@anthropic-ai/mcpb`.
- [x] Replace legacy `dxt_version` manifest with MCPB `manifest_version: "0.3"` and correct author/repository/privacy metadata.
- [x] Keep session state outside repo/package under `${CLAUDE_PLUGIN_DATA}` or `~/.glovo`.
- [x] Harden session file to `0600` and session parent directory to `0700` on save/load migration.
- [x] Add missing read tools: API-only location search/select, product option groups, full order pagination, order stats.
- [x] Add repeat/reorder surface as read-only preview with unsupported-line reasons.
- [x] Keep basket write tools explicit and no checkout/payment tools.

## Verification

- [x] Unit/contract tests for order cursor pagination, option payload validation, compact stats, and basket restore safety.
- [x] Contract tests prove `offset=0` then exact `pagination.next.offset`, repeated/empty cursor stopping, no numeric increment, and bounded 429 retry without real waiting.
- [x] Basket restore tests prove salted deep canonical fingerprints, private recovery snapshots, option-bearing original line refusal, bounded cleanup retry, failure after add/set restoration, and recovery-file deletion/preservation behavior.
- [x] Reorder preview test proves live-like order lines without product ids are refused for basket preparation.
- [x] Basket payload test proves distinct product id, external id, storeProductId, and nonzero storeCategoryId survive unchanged into create-basket payload; missing fields fail before POST.
- [x] Browser boundary/API transport tests prove Playwright is confined to login and direct API calls use explicit `globalThis.fetch`.
- [x] Packaged-runtime smoke verifies the MCPB/login-tool layout without launching or navigating a separate browser.
- [x] Location contract tests prove public autocomplete/resolve/serviceability URLs, no auth, capped compact output, and no-save on malformed or undeliverable locations.
- [x] Read-only live smoke: auth, stores, search, product details, order pagination.
- [x] MCP smoke exercises registered location and full-history/stats tools, not only client helpers.
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
- [x] Final local report: commit, feature matrix, E2E evidence, limitations, negative findings.
