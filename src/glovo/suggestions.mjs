import {
  compactProductView,
  compactSearch,
  compactStoreContent,
  withRetry,
} from "./api.mjs";
import {
  MULTISCALE_VENUE_MODEL,
  VENUE_HOLDOUT_EVIDENCE,
  normalizeVenue,
  rankVenueHistory,
} from "./venue-model.mjs";

export { normalizeVenue, rankVenueHistory } from "./venue-model.mjs";

export const GOOGLE_PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.businessStatus",
  "places.attributions",
].join(",");

export const GOOGLE_PLACE_REVIEW_FIELD_MASK = "id,reviews,attributions";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function bool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").toLowerCase();
  if (["true", "open", "available"].includes(normalized)) return true;
  if (["false", "closed", "unavailable"].includes(normalized)) return false;
  return null;
}

function text(value) {
  return value?.text?.text ?? value?.text ?? value?.label ?? value;
}

function actionParams(actions = []) {
  const path = actions.find((action) => action?.type === "NAVIGATION" && action?.data?.path)?.data?.path;
  if (!path) return new URLSearchParams();
  try {
    return new URL(path, "https://glovo.invalid").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function eventData(entry) {
  return (entry?.actions || [])
    .flatMap((action) => action?.data?.events || [])
    .map((event) => event?.data)
    .find((data) => data && typeof data === "object") || {};
}

function compactGlobalProduct(element) {
  const params = actionParams(element?.actions);
  const data = element?.data || {};
  const productId = params.get("product_id");
  const externalId = params.get("product_external_id");
  const storeProductId = params.get("store_product_id");
  if (!productId || !externalId || !storeProductId) return null;
  return {
    product_id: productId,
    external_id: externalId,
    store_product_id: storeProductId,
    store_id: params.get("store_id"),
    store_address_id: params.get("store_address_id"),
    category_id: params.get("category_id") || undefined,
    collection_id: params.get("collection_id") || undefined,
    collection_group_id: params.get("collection_group_id") || undefined,
    search_id: params.get("search_id") || undefined,
    name: text(data.name),
    price: data.pricing?.finalPrice,
    image: data.thumbnail?.image,
    source: "global_search",
  };
}

export function compactGlobalStoreSearch(raw) {
  const elements = raw?.data?.body?.data?.elements ?? raw?.body?.data?.elements ?? [];
  const stores = [];
  const byShopId = new Map();
  const byStoreId = new Map();

  for (const element of elements) {
    if (element?.type === "STORE_CARD_V2") {
      const data = element.data || {};
      const tracking = eventData(element);
      const params = actionParams(element.actions);
      const storeId = params.get("store_id");
      const shopId = params.get("shop_id") || tracking.shopId;
      if (!storeId || !shopId || !text(data.title)) continue;
      const rating = number(tracking.shopRating);
      const votes = number(tracking.numberOfRatedOrders);
      const store = {
        store_id: storeId,
        store_address_id: shopId,
        name: text(data.title),
        slug: data.slug,
        open: bool(params.get("shop_availability_status") || tracking.shopAvailabilityStatus || tracking.shopIsOpen),
        rating,
        votes,
        search_position: number(tracking.shopRankPosition ?? tracking.shopPosition) ?? stores.length + 1,
        image: data.imagePath,
        products: [],
      };
      stores.push(store);
      byShopId.set(String(shopId), store);
      byStoreId.set(String(storeId), store);
      continue;
    }

    if (element?.type !== "CAROUSEL") continue;
    const products = (element?.data?.elements || []).map(compactGlobalProduct).filter(Boolean);
    if (!products.length) continue;
    const trackingShopId = eventData(element).shopId;
    const store = byShopId.get(String(trackingShopId))
      || byStoreId.get(String(products[0].store_id));
    if (!store) continue;
    if (products[0].store_address_id) store.store_address_id = products[0].store_address_id;
    store.products.push(...products);
  }

  return { count: stores.length, stores };
}

function normalizedRating(value) {
  const parsed = number(value);
  if (parsed == null) return null;
  return parsed > 5 ? Math.min(5, parsed / 20) : Math.max(0, parsed);
}

function shrunkQuality(rating, count, { prior = 4.2, priorWeight = 100 } = {}) {
  const normalized = normalizedRating(rating);
  const votes = Math.max(0, number(count) || 0);
  if (normalized == null) return null;
  return (votes * normalized + priorWeight * prior) / (votes + priorWeight);
}

function queryRelevance(name, query) {
  const haystack = normalizeVenue(name);
  const tokens = normalizeVenue(query).split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
}

function attachHistory(stores, history) {
  const liveNameCounts = new Map();
  for (const store of stores) {
    const key = normalizeVenue(store.name);
    liveNameCounts.set(key, (liveNameCounts.get(key) || 0) + 1);
  }
  return stores.map((store) => {
    const key = normalizeVenue(store.name);
    const historical = liveNameCounts.get(key) === 1 ? history.venues.get(key) : null;
    return {
      ...store,
      familiar: Boolean(historical),
      history: historical || null,
      glovo_quality: shrunkQuality(store.rating, store.votes),
    };
  });
}

function sortFamiliar(left, right) {
  return (right.history?.score || 0) - (left.history?.score || 0)
    || (right.glovo_quality || 0) - (left.glovo_quality || 0)
    || left.search_position - right.search_position;
}

function sortExplore(left, right) {
  return (right.glovo_quality || 0) - (left.glovo_quality || 0)
    || left.search_position - right.search_position;
}

function selectStores(stores, { mode, maxChoices, noveltyTolerance, knownLikedOnly }) {
  const familiar = stores.filter((store) => store.familiar).sort(sortFamiliar);
  const novel = stores.filter((store) => !store.familiar).sort(sortExplore);
  if (knownLikedOnly || mode === "repeat") return [...familiar, ...(knownLikedOnly ? [] : novel)].slice(0, maxChoices * 3);
  if (mode === "explore") return [...novel, ...familiar].slice(0, maxChoices * 3);
  const novelTarget = Math.max(1, Math.min(maxChoices - 1, Math.round(maxChoices * noveltyTolerance)));
  const selected = [...familiar.slice(0, maxChoices - novelTarget), ...novel.slice(0, novelTarget)];
  const selectedIds = new Set(selected.map((store) => `${store.store_id}:${store.store_address_id}`));
  return [...selected, ...stores.filter((store) => !selectedIds.has(`${store.store_id}:${store.store_address_id}`))].slice(0, maxChoices * 3);
}

function chooseProduct(products, query, { excludeNames = new Set() } = {}) {
  return [...products]
    .filter((product) => product?.product_id && product?.external_id && product?.store_product_id)
    .filter((product) => !excludeNames.has(normalizeVenue(product.name)))
    .map((product) => ({ product, relevance: queryRelevance(product.name, query) }))
    .filter(({ relevance }) => relevance > 0)
    .sort((left, right) => right.relevance - left.relevance)[0]?.product || null;
}

async function resolveProduct(client, store, intent) {
  let easyReorder = [];
  let topSellers = [];
  if (store.familiar || intent.itemMode !== "any") {
    try {
      const content = await client.getStoreContent(store.store_id, store.store_address_id, { auth: true });
      easyReorder = compactStoreContent(content, { kind: "easy_reorder", limit: 40 }).products
        .map((product) => ({ ...product, store_id: store.store_id, store_address_id: store.store_address_id }));
      topSellers = compactStoreContent(content, { kind: "top_sellers", limit: 40 }).products
        .map((product) => ({ ...product, store_id: store.store_id, store_address_id: store.store_address_id }));
    } catch {
      // Personalized carousels are optional; the public catalog remains usable.
    }
  }

  const easyNames = new Set(easyReorder.map((product) => normalizeVenue(product.name)));
  const orderedPools = intent.itemMode === "repeat"
    ? [easyReorder, store.products, topSellers]
    : intent.itemMode === "different"
      ? [topSellers, store.products, easyReorder]
      : [store.products, topSellers, easyReorder];
  let candidate = null;
  for (const pool of orderedPools) {
    candidate = chooseProduct(pool, intent.query, {
      excludeNames: intent.itemMode === "different" ? easyNames : new Set(),
    });
    if (candidate) break;
  }

  if (!candidate) {
    try {
      const searched = compactSearch(await withRetry(
        () => client.searchStoreItems(store.store_id, store.store_address_id, intent.query),
        { maxRetries: 2, label: "suggestion-store-search" },
      ), {
        storeId: store.store_id,
        storeAddressId: store.store_address_id,
        limit: 12,
      }).results;
      candidate = chooseProduct(searched, intent.query, {
        excludeNames: intent.itemMode === "different" ? easyNames : new Set(),
      });
    } catch {
      return null;
    }
  }
  if (!candidate) return null;

  try {
    const detail = compactProductView(await withRetry(() => client.getProduct({
      storeId: store.store_id,
      storeAddressId: store.store_address_id,
      productId: candidate.product_id,
      externalId: candidate.external_id,
      categoryId: candidate.category_id,
      collectionId: candidate.collection_id,
      collectionGroupId: candidate.collection_group_id,
      searchId: candidate.search_id,
    }), { maxRetries: 2, label: "suggestion-product" }));
    if (detail.add_enabled !== true) return null;
    return {
      ...detail,
      store_id: store.store_id,
      store_address_id: store.store_address_id,
      category_id: candidate.category_id,
      source: candidate.source || "store_search",
      required_option_groups: (detail.option_groups || []).filter((group) => group.required).length,
    };
  } catch {
    return null;
  }
}

function distanceMeters(left, right) {
  const lat1 = number(left?.latitude);
  const lon1 = number(left?.longitude);
  const lat2 = number(right?.latitude);
  const lon2 = number(right?.longitude);
  if ([lat1, lon1, lat2, lon2].some((value) => value == null)) return null;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nameAgreement(left, right) {
  const a = normalizeVenue(left);
  const b = normalizeVenue(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aa = new Set(a.split(" "));
  const bb = new Set(b.split(" "));
  const intersection = [...aa].filter((token) => bb.has(token)).length;
  return intersection / new Set([...aa, ...bb]).size;
}

export function matchGooglePlace(venueName, location, places = []) {
  const ranked = places
    .map((place) => ({
      place,
      name_score: nameAgreement(venueName, place?.displayName?.text),
      distance_meters: distanceMeters(location, place?.location),
    }))
    .filter((entry) => entry.place?.businessStatus !== "CLOSED_PERMANENTLY")
    .filter((entry) => entry.name_score >= 0.85 && entry.distance_meters != null && entry.distance_meters <= 5_000)
    .sort((left, right) => right.name_score - left.name_score || left.distance_meters - right.distance_meters);
  if (!ranked.length) return { status: "no_match" };
  if (ranked[1]
    && ranked[0].name_score === ranked[1].name_score
    && ranked[1].distance_meters - ranked[0].distance_meters < 1_000) {
    return { status: "ambiguous" };
  }
  return { status: "matched", ...ranked[0] };
}

export function createGooglePlacesProvider(apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 7_500 } = {}) {
  if (!apiKey) return null;
  return async ({ venueName, location, cityCode, includeReviews = false, reviewLimit = 3 }) => {
    const center = { latitude: number(location?.latitude), longitude: number(location?.longitude) };
    const body = {
      textQuery: [venueName, cityCode].filter(Boolean).join(" "),
      pageSize: 3,
      ...(center.latitude == null || center.longitude == null ? {} : {
        locationBias: { circle: { center, radius: 3_000 } },
      }),
    };
    const response = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Google Places search failed (${response.status}).`);
    const data = await response.json();
    const match = matchGooglePlace(venueName, location, data?.places || []);
    if (match.status !== "matched") return { match_status: match.status };
    const place = match.place;
    const quality = shrunkQuality(place.rating, place.userRatingCount);
    let reviews = null;
    let reviewAttributions = [];
    let reviewStatus = includeReviews ? "unavailable" : "not_requested";
    if (includeReviews) {
      try {
        const detailsResponse = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(place.id)}`, {
          headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": GOOGLE_PLACE_REVIEW_FIELD_MASK,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (detailsResponse.ok) {
          const details = await detailsResponse.json();
          reviews = (details?.reviews || []).slice(0, Math.max(1, Math.min(3, reviewLimit))).map((review) => ({
            text: review?.text?.text,
            language_code: review?.text?.languageCode,
            publish_time: review?.publishTime,
            relative_publish_time: review?.relativePublishTimeDescription,
            rating: number(review?.rating),
            google_maps_uri: review?.googleMapsUri,
            author_attribution: review?.authorAttribution ? {
              display_name: review.authorAttribution.displayName,
              uri: review.authorAttribution.uri,
              photo_uri: review.authorAttribution.photoUri,
            } : null,
          }));
          reviewAttributions = details?.attributions || [];
          reviewStatus = "returned";
        }
      } catch {
        reviewStatus = "unavailable";
      }
    }
    return {
      match_status: "matched",
      source: "Google Maps",
      place_id: place.id,
      display_name: place.displayName?.text,
      rating: number(place.rating),
      user_rating_count: number(place.userRatingCount),
      count_aware_quality: rounded(quality),
      quality_prior: { rating: 4.2, weight: 100 },
      business_status: place.businessStatus,
      google_maps_uri: place.googleMapsUri,
      attributions: [...(place.attributions || []), ...reviewAttributions],
      reviews,
      reviews_status: reviewStatus,
      review_notice: includeReviews
        ? "Google selects and orders returned reviews; they may not be representative. Preserve author attribution and Google Maps links when displaying them."
        : null,
      review_policy: includeReviews ? "https://developers.google.com/maps/documentation/places/web-service/policies" : null,
      match_basis: "normalized venue name plus proximity to the selected Glovo location",
      ranking_effect: "display_only_not_backtested",
    };
  };
}

function historyEvidence(history) {
  if (!history) return { familiar: false, venue_orders: 0, recency_score: 0 };
  return {
    familiar: true,
    venue_orders: history.order_count,
    last_order_event_age: history.last_order_age,
    recency_score: rounded(history.score),
    components: {
      half_life_5: rounded(history.short),
      half_life_20: rounded(history.medium),
      half_life_80: rounded(history.long),
      weights: MULTISCALE_VENUE_MODEL.scaleWeights,
    },
  };
}

function labelFor(store, index) {
  if (!store.familiar) return store.glovo_quality == null ? "new_live_option" : "new_high_rated_option";
  if (index === 0) return "reliable_repeat";
  return "familiar_alternative";
}

function reasonFor(store, product, intent) {
  const reasons = [];
  if (store.familiar) reasons.push(`Previously ordered from this venue ${store.history.order_count} time(s); ranked by the validated multi-scale recency model.`);
  else reasons.push("Not found in the card-level venue history; included as a separate live-catalog exploration option.");
  reasons.push(`Glovo currently exposes ${product.name} at ${product.price || "a live catalog price"}.`);
  if (product.required_option_groups) reasons.push(`${product.required_option_groups} required option group(s) must be selected before a basket add.`);
  if (intent.itemMode === "different") reasons.push("The resolver excluded current Easy Reorder names where that authenticated carousel was available.");
  return reasons;
}

export async function getSuggestions(client, input, {
  googleApiKey = process.env.GOOGLE_MAPS_API_KEY,
  googleProvider = null,
} = {}) {
  const intent = {
    mode: input.mode || "balanced",
    query: String(input.query || "").trim(),
    venueQuery: String(input.venueQuery || "").trim(),
    itemMode: input.itemMode || "any",
    knownLikedOnly: Boolean(input.knownLikedOnly),
    qualityPreference: input.qualityPreference || "balanced",
    noveltyTolerance: Math.max(0, Math.min(1, Number(input.noveltyTolerance ?? 0.4))),
    maxChoices: Math.max(3, Math.min(5, Number(input.maxChoices ?? 5))),
    includeGoogle: Boolean(input.includeGoogle),
    includeGoogleReviews: Boolean(input.includeGoogleReviews),
  };
  if (!intent.query) throw new Error("Suggestion query is required.");
  const auth = client.authStatus();
  if (!auth.signed_in) throw new Error("Suggestions require an authenticated Glovo session for order history.");
  if (!auth.has_location) throw new Error("Select or confirm a Glovo delivery location before requesting suggestions.");

  const [discovery, liveRaw] = await Promise.all([
    client.getAllOrderCards({ limit: 15, pageDelayMs: 750, maxRetries: 4 }),
    withRetry(() => client.searchStores(intent.query), { maxRetries: 2, label: "suggestion-global-search" }),
  ]);
  const history = rankVenueHistory(discovery.orders);
  const live = compactGlobalStoreSearch(liveRaw);
  const venueNeedle = normalizeVenue(intent.venueQuery);
  const openStores = live.stores.filter((store) => store.open !== false);
  const candidates = attachHistory(
    venueNeedle ? openStores.filter((store) => normalizeVenue(store.name).includes(venueNeedle)) : openStores,
    history,
  );
  const ordered = selectStores(candidates, intent);
  const choices = [];
  for (const store of ordered) {
    if (choices.length >= intent.maxChoices) break;
    const product = await resolveProduct(client, store, intent);
    if (!product) continue;
    choices.push({
      label: labelFor(store, choices.length),
      store: {
        store_id: store.store_id,
        store_address_id: store.store_address_id,
        name: store.name,
        slug: store.slug,
        open: store.open,
        glovo_rating: normalizedRating(store.rating),
        glovo_rating_count: store.votes,
        glovo_count_aware_quality: rounded(store.glovo_quality),
        search_position: store.search_position,
      },
      product,
      personalized_evidence: historyEvidence(store.history),
      reasons: reasonFor(store, product, intent),
      google_maps: null,
    });
  }

  const shouldUseGoogle = intent.includeGoogle || intent.includeGoogleReviews || intent.qualityPreference === "google";
  const provider = googleProvider || createGooglePlacesProvider(googleApiKey);
  const googleSummary = {
    requested: shouldUseGoogle,
    available: Boolean(provider),
    enriched: 0,
    ambiguous_or_unmatched: 0,
    failures: 0,
    ranking_effect: "none; Google evidence is not part of the backtested venue model",
    reviews_requested: intent.includeGoogleReviews,
    review_venues_enriched: 0,
  };
  if (shouldUseGoogle && provider) {
    for (const [index, choice] of choices.slice(0, 5).entries()) {
      try {
        const google = await provider({
          venueName: choice.store.name,
          location: client.location(),
          cityCode: client.location().cityCode,
          includeReviews: intent.includeGoogleReviews && index < 3,
          reviewLimit: 3,
        });
        if (google?.match_status === "matched") {
          choice.google_maps = google;
          googleSummary.enriched += 1;
          if (google.reviews_status === "returned") googleSummary.review_venues_enriched += 1;
        } else {
          googleSummary.ambiguous_or_unmatched += 1;
        }
      } catch {
        googleSummary.failures += 1;
      }
    }
  }

  return {
    intent: {
      mode: intent.mode,
      query: intent.query,
      venue_query: intent.venueQuery || null,
      item_mode: intent.itemMode,
      known_liked_constraint: intent.knownLikedOnly,
      quality_preference: intent.qualityPreference,
      novelty_tolerance: intent.noveltyTolerance,
      max_choices: intent.maxChoices,
      google_reviews_requested: intent.includeGoogleReviews,
    },
    model: {
      name: "venue-multi-scale-recency-5-20-80",
      level: "venue",
      evidence: "chronological rolling-origin backtest with untouched final holdout",
      evidence_scope: "aggregate benchmark from one private account; not a universal quality guarantee",
      holdout: VENUE_HOLDOUT_EVIDENCE,
      product_model: "not_promoted; the benchmark had only 15 detailed orders",
    },
    coverage: {
      order_cards_discovered: discovery.orders.length,
      order_cursor_pages: discovery.pages.length,
      order_cursor_stop: discovery.stopped_reason,
      venue_model_orders: history.cards,
      live_store_candidates: candidates.length,
      resolved_live_products: choices.length,
      product_detail_history_orders_used_for_ranking: 0,
      benchmark_detailed_orders: 15,
      product_ranking_source: "live Glovo catalog plus Easy Reorder/Top Sellers when available; no learned product model",
    },
    choices,
    google_quality: provider
      ? googleSummary
      : { ...googleSummary, reason: "GOOGLE_MAPS_API_KEY is not configured; Glovo and personalized evidence remain available." },
    limitations: [
      "Order cards support venue prediction across full cursor discovery; product history covers only a bounded 15-order detailed subset.",
      "A past order proves familiarity, not satisfaction. known_liked_only is honored only as an explicit user constraint.",
      "Exploration ordering is a transparent live-catalog heuristic, not the backtested repeat model.",
      "Current product availability and required options are re-fetched; the suggestion tool never changes the basket.",
    ],
    mutates_basket: false,
  };
}
