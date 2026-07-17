# Recommendation Evaluation

## Decision

Glovo v0.2.0 uses the `multiscale_5_20_80` venue model for personalized repeat ranking. It sums purchase recency over 5, 20, and 80 order-event half-lives with weights `0.5`, `0.3`, and `0.2`.

The model was selected on validation only, using the simplest candidate within one standard error of the best validation NDCG@5. The final test window remained untouched until selection was complete.

| Final model | Precision@5 | Recall@5 | NDCG@5 | Repeat Recall@5 | Novel target share | Coverage@5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Popularity | 0.041 | 0.204 | 0.160 | 0.235 | 0.131 | 0.028 |
| Multi-scale recency 5/20/80 | 0.083 | 0.416 | 0.271 | 0.479 | 0.131 | 0.075 |

## Dataset Boundary

- Source snapshot: June 28, 2026.
- Captured order cards: 924.
- Usable completed venue orders: 910; canceled/invalid exclusions: 14.
- Chronological split: 637 train, 136 validation, 137 final test.
- Rolling-origin behavior: each held-out event is scored before it becomes history for the next event.
- Product details: 15 successfully detailed orders. This is too small for model selection or a production-quality claim.

All 910 usable cards support venue prediction. Card text is never treated as product ground truth. The runtime returns current products from live Glovo search, Easy Reorder, and Top Sellers instead of promoting an underpowered item model.

## Reproduce

Against the authenticated account, the command fetches full cursor-correct order cards and emits aggregate JSON only:

```bash
npm run eval:venues
```

To evaluate a private export with an `orders` array:

```bash
npm run eval:venues -- --input /private/path/orders.json --output /private/path/aggregate.json
```

The optional aggregate output is written as mode `0600`. The harness does not emit venue names, order IDs, addresses, coordinates, basket payloads, or tokens. Never add a private order export to this repository.

## Candidate Family

Validation compares popularity, previous-venue transitions, single-scale recency, 5/20/80 and 10/30/120 multi-scale recency, and small frequency/recency/transition hybrids. Evaluation is chronological, not randomly shuffled. Metrics include Precision@5, Recall@5, NDCG@5, catalog coverage, repeat recall, and novel-target share.

The runtime model is pinned to the validated snapshot decision. Running the harness later can reveal drift, but does not silently change production weights or consume the final holdout again.

## Limitations

- Older cards have reliable sequence order but not exact timestamps, so recency is measured in order events rather than elapsed days.
- A purchase indicates familiarity, not satisfaction.
- Novel venues cannot be predicted from personal repeat history; they are a separate live exploration lane.
- Product recommendation quality is not backtested at current detail coverage. A new product model requires a materially larger detailed corpus and a new untouched chronological holdout.
