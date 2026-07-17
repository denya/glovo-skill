# Glovo API Hypotheses

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
