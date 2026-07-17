# Glovo API Hypotheses

- Order history pagination is cursor-based: start `offset=0`, then pass `pagination.next.offset` exactly. Numeric `offset += limit` repeats/loses pages.
- The order-list endpoint is cheap enough for full discovery; order-detail calls are quota-limited and must be optional enrichment.
- Product view responses contain enough option-group metadata to build add-to-basket payloads, but exact payload shape must be validated against basket API responses.
- Glovo may clear or isolate baskets by store; E2E must stop if the existing basket cannot be restored losslessly.
- Location switching is header/session-state based for browsing; switching location must not mutate an existing basket unless the user explicitly accepts the risk.
- Browser login can capture access and refresh tokens from OAuth responses; refresh can rotate tokens and must persist securely outside packaged code.
- Repeat/reorder is safe only as read-only preview unless order details expose stable current product and option identifiers. Live detail showed `boughtProducts` names/prices/quantities without product ids for the probed order, so basket rebuild is refused for unsupported lines.
- Claude marketplace plugin installs require a committed bundled runtime; they do not install npm dependencies from source.
- Session files can drift permissions after manual edits; secure load must migrate to `0600` and reject malformed token state.
