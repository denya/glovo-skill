export const MULTISCALE_VENUE_MODEL = Object.freeze({
  name: "multiscale_5_20_80",
  complexity: 3,
  frequency: 0,
  recency: 1,
  transition: 0,
  halfLife: 20,
  scales: [5, 20, 80],
  scaleWeights: [0.5, 0.3, 0.2],
});

export const VENUE_HOLDOUT_EVIDENCE = Object.freeze({
  source_snapshot: "2026-06-28",
  usable_orders: 910,
  train_orders: 637,
  validation_orders: 136,
  final_test_orders: 137,
  precision_at_5: 0.0832,
  recall_at_5: 0.4161,
  ndcg_at_5: 0.2712,
  repeat_recall_at_5: 0.479,
  novel_target_share: 0.1314,
  popularity_recall_at_5: 0.2044,
  popularity_ndcg_at_5: 0.1599,
});

export function normalizeVenue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isCancelled(order) {
  return /cancel/i.test(`${order?.status || ""} ${order?.total || ""}`);
}

export function prepareVenueOrders(cards = [], { newestFirst = true } = {}) {
  const prepared = cards
    .filter((order) => !isCancelled(order))
    .map((order, index) => ({
      store: normalizeVenue(order?.store ?? order?.store_name),
      displayName: order?.store ?? order?.store_name,
      historyIndex: Number(order?.history_index),
      sourceIndex: index,
    }))
    .filter((order) => order.store);
  if (prepared.every((order) => Number.isFinite(order.historyIndex))) {
    return prepared.sort((left, right) => right.historyIndex - left.historyIndex);
  }
  return newestFirst ? prepared.reverse() : prepared;
}

export function temporalSplit(orders, trainRatio = 0.7, validationRatio = 0.15) {
  if (!Array.isArray(orders) || orders.length < 3) throw new Error("At least 3 usable orders are required.");
  const trainEnd = Math.max(1, Math.floor(orders.length * trainRatio));
  const validationEnd = Math.max(trainEnd + 1, Math.floor(orders.length * (trainRatio + validationRatio)));
  return {
    train: orders.slice(0, trainEnd),
    validation: orders.slice(trainEnd, validationEnd),
    test: orders.slice(validationEnd),
  };
}

function modelCandidates() {
  const models = [
    { name: "popularity", complexity: 1, frequency: 1, recency: 0, transition: 0, halfLife: 50 },
    { name: "transition", complexity: 2, frequency: 0, recency: 0, transition: 1, halfLife: 50 },
    MULTISCALE_VENUE_MODEL,
    { name: "multiscale_10_30_120", complexity: 3, frequency: 0, recency: 1, transition: 0, halfLife: 30, scales: [10, 30, 120], scaleWeights: [0.5, 0.3, 0.2] },
  ];
  for (const halfLife of [10, 30, 100]) {
    models.push({ name: `recency_h${halfLife}`, complexity: 2, frequency: 0, recency: 1, transition: 0, halfLife });
    for (const [frequency, recency, transition] of [[0.6, 0.25, 0.15], [0.45, 0.35, 0.2], [0.4, 0.2, 0.4], [0.25, 0.35, 0.4]]) {
      models.push({ name: `hybrid_${frequency}_${recency}_${transition}_h${halfLife}`, complexity: 4, frequency, recency, transition, halfLife });
    }
  }
  return models;
}

function emptyState() {
  return { step: 0, previousStore: null, stores: new Map(), transitions: new Map() };
}

function ingest(state, order) {
  const store = state.stores.get(order.store) || { count: 0, occurrences: [], displayName: order.displayName };
  if (state.previousStore) {
    const next = state.transitions.get(state.previousStore) || new Map();
    next.set(order.store, (next.get(order.store) || 0) + 1);
    state.transitions.set(state.previousStore, next);
  }
  store.count += 1;
  store.occurrences.push(state.step);
  store.displayName = order.displayName || store.displayName;
  state.stores.set(order.store, store);
  state.previousStore = order.store;
  state.step += 1;
}

function recencyValue(occurrences, currentStep, model) {
  if (!model.scales) {
    const age = Math.max(0, currentStep - occurrences.at(-1));
    return 2 ** (-age / model.halfLife);
  }
  return occurrences.reduce((total, occurrence) => {
    const age = Math.max(0, currentStep - occurrence);
    return total + model.scales.reduce(
      (sum, scale, index) => sum + model.scaleWeights[index] * 2 ** (-age / scale),
      0,
    );
  }, 0);
}

function summedDecay(occurrences, currentStep, halfLife) {
  return occurrences.reduce(
    (sum, occurrence) => sum + 2 ** (-Math.max(0, currentStep - occurrence) / halfLife),
    0,
  );
}

function rankedRows(state, model) {
  if (!state.stores.size) return [];
  const maxCount = Math.max(...[...state.stores.values()].map((store) => store.count));
  const transitions = state.transitions.get(state.previousStore) || new Map();
  const maxTransition = Math.max(1, ...transitions.values());
  const rows = [...state.stores.entries()].map(([key, store]) => ({
    key,
    displayName: store.displayName,
    count: store.count,
    frequency: store.count / maxCount,
    recency: recencyValue(store.occurrences, state.step, model),
    transition: (transitions.get(key) || 0) / maxTransition,
    lastOrderAge: state.step - store.occurrences.at(-1) - 1,
  }));
  const maxRecency = Math.max(1e-9, ...rows.map((row) => row.recency));
  return rows
    .map((row) => ({
      ...row,
      score: model.frequency * row.frequency
        + model.recency * (row.recency / maxRecency)
        + model.transition * row.transition,
    }))
    .sort((left, right) => right.score - left.score || right.count - left.count || left.key.localeCompare(right.key));
}

export function rankVenueHistory(newestFirstCards = [], model = MULTISCALE_VENUE_MODEL) {
  const orders = prepareVenueOrders(newestFirstCards, { newestFirst: true });
  const state = emptyState();
  orders.forEach((order) => ingest(state, order));
  const venues = new Map(rankedRows(state, model).map((row) => [row.key, {
    name: row.displayName,
    order_count: row.count,
    last_order_age: row.lastOrderAge,
    raw_score: row.recency,
    score: row.score,
    short: summedDecay(state.stores.get(row.key).occurrences, state.step, 5),
    medium: summedDecay(state.stores.get(row.key).occurrences, state.step, 20),
    long: summedDecay(state.stores.get(row.key).occurrences, state.step, 80),
  }]));
  return { cards: orders.length, venues };
}

function standardError(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function rounded(value, digits = 4) {
  return Number((value || 0).toFixed(digits));
}

export function evaluateVenueModel(trainOrders, evaluationOrders, model, topK = 5) {
  const state = emptyState();
  trainOrders.forEach((order) => ingest(state, order));
  const observations = [];
  const recommended = new Set();
  let hits = 0;
  let repeatEvents = 0;
  let repeatHits = 0;
  let novelEvents = 0;
  for (const order of evaluationOrders) {
    const known = state.stores.has(order.store);
    const ranked = rankedRows(state, model).slice(0, topK).map((row) => row.key);
    ranked.forEach((store) => recommended.add(store));
    const rank = ranked.indexOf(order.store);
    const hit = rank >= 0;
    hits += Number(hit);
    novelEvents += Number(!known);
    if (known) {
      repeatEvents += 1;
      repeatHits += Number(hit);
    }
    observations.push(hit ? 1 / Math.log2(rank + 2) : 0);
    ingest(state, order);
  }
  const count = Math.max(1, evaluationOrders.length);
  return {
    events: evaluationOrders.length,
    precision_at_5: rounded(hits / count / topK),
    recall_at_5: rounded(hits / count),
    ndcg_at_5: rounded(observations.reduce((sum, value) => sum + value, 0) / count),
    ndcg_at_5_se: standardError(observations) == null ? null : rounded(standardError(observations)),
    repeat_recall_at_5: rounded(repeatHits / Math.max(1, repeatEvents)),
    novel_target_share: rounded(novelEvents / count),
    catalog_coverage_at_5: rounded(recommended.size / Math.max(1, state.stores.size)),
  };
}

function selectWithinOneStandardError(rows) {
  const best = [...rows].sort((left, right) => right.metrics.ndcg_at_5 - left.metrics.ndcg_at_5)[0];
  const threshold = best.metrics.ndcg_at_5 - (best.metrics.ndcg_at_5_se || 0);
  return [...rows]
    .filter((row) => row.metrics.ndcg_at_5 >= threshold)
    .sort((left, right) => left.model.complexity - right.model.complexity
      || right.metrics.ndcg_at_5 - left.metrics.ndcg_at_5
      || left.model.name.localeCompare(right.model.name))[0];
}

export function runVenueEvaluation(cards, { newestFirst = true } = {}) {
  const orders = prepareVenueOrders(cards, { newestFirst });
  const split = temporalSplit(orders);
  const candidates = modelCandidates();
  const validation = candidates.map((model) => ({
    model,
    metrics: evaluateVenueModel(split.train, split.validation, model),
  }));
  const selected = selectWithinOneStandardError(validation);
  const trainPlusValidation = [...split.train, ...split.validation];
  const baseline = candidates[0];
  return {
    dataset: {
      captured_orders: cards.length,
      usable_venue_orders: orders.length,
      excluded_cancelled_or_invalid: cards.length - orders.length,
      unique_venues: new Set(orders.map((order) => order.store)).size,
      product_model: "not_evaluated_from_order_cards",
    },
    split: {
      strategy: "70/15/15 chronological holdout",
      train_orders: split.train.length,
      validation_orders: split.validation.length,
      final_test_orders: split.test.length,
      rolling_updates_after_scoring: true,
    },
    selection: {
      model: selected.model,
      validation: selected.metrics,
      rule: "simplest model within one standard error of best validation NDCG@5",
      selection_used_test_data: false,
    },
    final_test: {
      popularity: evaluateVenueModel(trainPlusValidation, split.test, baseline),
      selected: evaluateVenueModel(trainPlusValidation, split.test, selected.model),
    },
  };
}
