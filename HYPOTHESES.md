# Glovo API Hypotheses

## v0.2.1 Store Classes and Fast Suggestions

- Resolved: restaurant, grocery, and non-food retail walls share store cards, search, product-view, fee, and basket envelopes. They differ in wall category, menu depth, main-content collections, and whether category content exposes product tiles.
- Resolved: current product detail remains the authoritative source for the three product ids and option selections across every store class; store detail remains authoritative for nonzero `storeCategoryId`. Live restaurant, grocery, and retail products all exposed complete ids, though grocery/retail ids were not always pairwise distinct, so completeness rather than distinctness is the invariant.
- Resolved: grocery and retail menu actions return complete same-store content URIs. The existing `contentSlug` path incorrectly nested those URIs as query values; a bounded same-store URI route is the only new catalog path needed.
- Resolved: sampled retail products exposed exact pack/size in the product name, `isVariant=false`, and no selectable option groups. Report variant selection as not exposed and require an exact live product; do not invent shade/size identifiers.
- Resolved: a private normalized order-card cache preserves complete venue-model evidence while every incremental refresh starts at `offset=0`, follows exact `pagination.next.offset`, and stops only after a known order overlap. Cold full refresh took 108.87s; the first warm authenticated repeat took 5.92s with the same 946 cards and live product revalidation.
- Revised: history is account-scoped, not location-scoped. Always refresh the newest order page by exact cursor and keep live store/product availability location-specific and uncached; no freshness window is needed.
- Negative decision: never use a TTL-only cache hit or stale-on-network-error fallback. A warm call must contact Glovo and fail truthfully if freshness cannot be established.
- Negative decision: do not create a generic commerce/store adapter hierarchy. Shared Glovo API envelopes stay shared; only proven response-shape branches earn normalization code.
- Negative decision: do not promote a product model. The 15-detail corpus remains underpowered and separate from full card-level venue evidence.

## v0.2.0 Suggestions

- Resolved: full cursor-correct order cards support personalized venue ranking, but not learned item ranking. Product choices come from current live Glovo catalogs until detail coverage grows.
- Resolved: multi-scale venue recency at 5/20/80 order-event half-lives was the simplest model within one validation standard error and materially beat popularity on the untouched final window.
- Resolved: repeat and exploration are separate objectives. Familiar venues use private history evidence; novel venues use live availability and optional external quality evidence.
- Resolved: one structured MCP intent maps natural requests into mode, keywords, known-liked, quality, novelty, and choice count without shipping a second natural-language parser.
- Resolved by contract tests: Google Places enrichment is optional and ephemeral, starts after Glovo candidate generation, enriches at most five, persists nothing, and refuses ambiguous name/location matches.
- Negative decision: Bayesian-shrunk Google quality is returned as a labeled display component, not used to rerank, because no Google weight has chronological validation and a rating is not proof of personal satisfaction.

- Order history pagination is cursor-based: start `offset=0`, then pass `pagination.next.offset` exactly. Numeric `offset += limit` repeats/loses pages.
- The order-list endpoint is cheap enough for full discovery; order-detail calls are quota-limited and must be optional enrichment.
- Product view responses contain enough option-group metadata to build add-to-basket payloads, but exact payload shape must be validated against basket API responses.
- Glovo may clear or isolate baskets by store; E2E must stop if the existing basket cannot be restored losslessly.
- Location switching is header/session-state based for browsing; switching location must not mutate an existing basket unless the user explicitly accepts the risk.
- Saved delivery locations are an authenticated read-only address-book resource; selecting one for browsing remains an explicit local-header update unless Glovo's current web API proves a safe account-level switch endpoint.
- Browser login can capture access and refresh tokens from OAuth responses; refresh can rotate tokens and must persist securely outside packaged code.
- Past details do not expose stable current product identifiers, but authenticated store content adds an `EasyReorder` carousel with current product/external/store-product IDs. A repeat plan can safely resolve candidates there, then use bounded store search for gaps; every chosen line still requires live product/option validation and explicit basket approval.
- Glovo's web client builds an order-summary URL with `reorderUrn`, but no direct basket-only native reorder endpoint/payload is present in the audited public chunks. Do not call or claim native reorder until a current direct API contract is proven.
- Store minimum-basket fees, restrictions, store information, and similar stores are public read-only pre-check APIs and can support new-basket research without entering checkout.
- Claude marketplace plugin installs require a committed bundled runtime; they do not install npm dependencies from source.
- Session files can drift permissions after manual edits; secure load must migrate to `0600` and reject malformed token state.
