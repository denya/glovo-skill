# Glovo Skill Release TODO

## Build

- [x] Create clean public repo from installed local extension source.
- [x] Add Claude Code plugin layout and validate with `claude plugin validate . --strict`.
- [x] Add MCPB manifest and validate/pack with `@anthropic-ai/mcpb`.
- [x] Replace legacy `dxt_version` manifest with MCPB `manifest_version: "0.3"` and correct author/repository/privacy metadata.
- [x] Keep session state outside repo/package under `${CLAUDE_PLUGIN_DATA}` or `~/.glovo`.
- [x] Add missing read tools: location discovery/switching, product option groups, full order pagination, order stats.
- [x] Add repeat/reorder surface as read-only preview with unsupported-line reasons.
- [x] Keep basket write tools explicit and no checkout/payment tools.

## Verification

- [x] Unit/contract tests for order cursor pagination, option payload validation, compact stats, and basket restore safety.
- [x] Contract tests prove `offset=0` then exact `pagination.next.offset`, repeated/empty cursor stopping, no numeric increment, and bounded 429 retry without real waiting.
- [x] Basket restore tests prove salted deep canonical fingerprints, private recovery snapshots, option-bearing original line refusal, bounded cleanup retry, failure after add/set restoration, and recovery-file deletion/preservation behavior.
- [x] Reorder preview test proves live-like order lines without product ids are refused for basket preparation.
- [x] Read-only live smoke: auth, stores, search, product details, order pagination.
- [x] MCP smoke exercises registered location and full-history/stats tools, not only client helpers.
- [ ] Basket E2E: snapshot current basket, add pizza, set quantity, remove, verify exact restoration. Blocked on Glovo add payload/identifier root cause after repeated `PRODUCT_NOT_AVAILABLE`.
- [ ] Modifier E2E: add a valid required-option product, verify basket, remove/restore. Blocked on same add payload/identifier root cause.
- [x] Dependency audit and secret/privacy scan.
- [ ] Clean install from published GitHub repo and smoke once more.

## Publish

- [x] MIT license and attribution.
- [x] README with install/auth/use commands and safety notes.
- [ ] Public GitHub repo under `denya`.
- [ ] Final report: URL, commit, feature matrix, E2E evidence, limitations, negative findings.
