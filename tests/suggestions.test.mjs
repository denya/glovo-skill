import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";
import {
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_PLACE_REVIEW_FIELD_MASK,
  compactGlobalStoreSearch,
  createGooglePlacesProvider,
  getSuggestions,
  matchGooglePlace,
  rankVenueHistory,
} from "../src/glovo/suggestions.mjs";

function productPath({ storeId, storeAddressId, productId, externalId, storeProductId, categoryId = "cat-1" }) {
  const params = new URLSearchParams({
    store_id: storeId,
    store_address_id: storeAddressId,
    product_id: productId,
    product_external_id: externalId,
    store_product_id: storeProductId,
    category_id: categoryId,
    search_id: "search-1",
  });
  return `/product?${params}`;
}

function storeCard({ storeId, addressId, name, rating = "4.6", votes = "300", open = "OPEN", position = "1" }) {
  const params = new URLSearchParams({
    store_id: storeId,
    shop_id: addressId,
    shop_availability_status: open,
  });
  return {
    type: "STORE_CARD_V2",
    actions: [
      { type: "PERSEUS_EVENT", data: { events: [{ data: { shopId: addressId, shopRating: rating, numberOfRatedOrders: votes, shopRankPosition: position } }] } },
      { type: "NAVIGATION", data: { path: `/store?${params}` } },
    ],
    data: { title: { text: { text: name } }, slug: name.toLowerCase().replaceAll(" ", "-") },
  };
}

function productTile({ storeId, addressId, productId, externalId, storeProductId, name, price = "EUR 12.00" }) {
  return {
    type: "PRODUCT_TILE",
    actions: [{ type: "NAVIGATION", data: { path: productPath({ storeId, storeAddressId: addressId, productId, externalId, storeProductId }) } }],
    data: { name: { text: name }, pricing: { finalPrice: price } },
  };
}

function carousel(addressId, products) {
  return {
    type: "CAROUSEL",
    actions: [{ type: "PERSEUS_EVENT", data: { events: [{ data: { shopId: addressId } }] } }],
    data: { elements: products },
  };
}

function globalSearch(stores) {
  return {
    data: {
      body: {
        data: {
          elements: stores.flatMap((store) => [
            storeCard(store),
            carousel(store.addressId, store.products.map((product) => productTile({
              storeId: store.storeId,
              addressId: store.addressId,
              ...product,
            }))),
          ]),
        },
      },
    },
  };
}

function productView(product, { required = false } = {}) {
  return {
    data: {
      metadata: {
        product: {
          id: product.productId,
          externalId: product.externalId,
          storeProductId: product.storeProductId,
          name: product.name,
          priceInfo: { displayText: product.price || "EUR 12.00" },
          attributeGroups: required ? [{
            id: "group-legacy",
            attributeGroupId: "group-stable",
            externalId: "group-external",
            name: "Size",
            minSelection: 1,
            attributes: [{ id: "option-legacy", attributeId: "option-stable", externalId: "option-external", name: "Large" }],
          }] : [],
        },
      },
      footer: { data: { elements: [{ data: { isEnabled: true } }] } },
    },
  };
}

function contentSection(collectionType, products) {
  return {
    data: {
      elements: products.map((product) => ({
        type: "PRODUCT_TILE",
        data: {
          id: product.productId,
          externalId: product.externalId,
          storeProductId: product.storeProductId,
          name: product.name,
          priceInfo: { displayText: product.price || "EUR 12.00" },
        },
        actions: [{ data: { events: [{ data: { collectionType, isOrderedBefore: collectionType === "Easy Reorder" } }] } }],
      })),
    },
  };
}

const products = {
  old: { productId: "product-1", externalId: "external-1", storeProductId: "store-product-1", name: "Pizza Margherita" },
  different: { productId: "product-2", externalId: "external-2", storeProductId: "store-product-2", name: "Pizza Diavola" },
  novel: { productId: "product-3", externalId: "external-3", storeProductId: "store-product-3", name: "Pizza Truffle" },
  third: { productId: "product-4", externalId: "external-4", storeProductId: "store-product-4", name: "Pizza Four Cheese" },
  fourth: { productId: "product-5", externalId: "external-5", storeProductId: "store-product-5", name: "Pizza Marinara" },
};

const liveRaw = globalSearch([
  { storeId: "store-1", addressId: "address-1", name: "Favorite Pizza", position: "1", products: [products.old] },
  { storeId: "store-2", addressId: "address-2", name: "New Pizza", position: "2", rating: "4.8", votes: "800", products: [products.novel] },
  { storeId: "store-3", addressId: "address-3", name: "Third Pizza", position: "3", products: [products.third] },
  { storeId: "store-4", addressId: "address-4", name: "Fourth Pizza", position: "4", products: [products.fourth] },
]);

class FakeClient {
  constructor() {
    this.details = new Map(Object.values(products).map((product) => [product.productId, product]));
  }

  authStatus() { return { signed_in: true, has_location: true }; }
  location() { return { latitude: "41.38", longitude: "2.17", cityCode: "BCN" }; }
  async getAllOrderCards() {
    return {
      orders: [
        { store: "Favorite Pizza", status: "DELIVERED" },
        { store: "Other Venue", status: "DELIVERED" },
        { store: "Favorite Pizza", status: "DELIVERED" },
      ],
      pages: [{}, {}],
      stopped_reason: "no_next_cursor",
    };
  }
  async searchStores() { return liveRaw; }
  async getStoreContent(storeId) {
    if (storeId !== "store-1") throw new Error("No personalized carousel");
    return { data: { body: [
      contentSection("Easy Reorder", [products.old]),
      contentSection("Top Sellers", [products.different]),
    ] } };
  }
  async searchStoreItems() { return { results: [] }; }
  async getProduct({ productId }) { return productView(this.details.get(String(productId)), { required: productId === "product-1" }); }
}

const compact = compactGlobalStoreSearch(liveRaw);
assert.equal(compact.count, 4);
assert.deepEqual(compact.stores[0].products[0], {
  product_id: "product-1",
  external_id: "external-1",
  store_product_id: "store-product-1",
  store_id: "store-1",
  store_address_id: "address-1",
  category_id: "cat-1",
  collection_id: undefined,
  collection_group_id: undefined,
  search_id: "search-1",
  name: "Pizza Margherita",
  price: "EUR 12.00",
  image: undefined,
  source: "global_search",
});

const apiCalls = [];
const api = new GlovoClient("/unused", { session: {} });
api.call = async (path, options) => { apiCalls.push({ path, options }); return {}; };
await api.searchStores("pizza & pasta");
assert.equal(apiCalls[0].path, "/v1/web/store_wall/search?searchQuery=pizza+%26+pasta");
assert.equal(apiCalls[0].options.method, "POST");
assert.equal(typeof apiCalls[0].options.body.searchContext.searchId, "string");

const ranked = rankVenueHistory([
  { store: "Recent", status: "DELIVERED" },
  { store: "Old", status: "DELIVERED" },
  { store: "Old", status: "DELIVERED" },
]);
assert.equal(ranked.venues.get("recent").last_order_age, 0);
assert.equal(ranked.venues.get("old").last_order_age, 1);

const repeat = await getSuggestions(new FakeClient(), {
  mode: "repeat",
  query: "pizza",
  itemMode: "repeat",
  qualityPreference: "personal",
  maxChoices: 3,
});
assert.equal(repeat.choices[0].label, "reliable_repeat");
assert.equal(repeat.choices[0].store.name, "Favorite Pizza");
assert.equal(repeat.choices[0].product.name, "Pizza Margherita");
assert.equal(repeat.choices[0].product.required_option_groups, 1);
assert.equal(repeat.choices[0].product.option_groups[0].required, true);
assert.equal(repeat.mutates_basket, false);
assert.equal(repeat.model.product_model.startsWith("not_promoted"), true);

const different = await getSuggestions(new FakeClient(), {
  mode: "repeat",
  query: "pizza",
  venueQuery: "Favorite Pizza",
  itemMode: "different",
  knownLikedOnly: true,
  qualityPreference: "personal",
  maxChoices: 3,
});
assert.equal(different.choices[0].product.name, "Pizza Diavola");
assert.equal(different.intent.known_liked_constraint, true);

const explore = await getSuggestions(new FakeClient(), {
  mode: "explore",
  query: "pizza",
  itemMode: "any",
  qualityPreference: "google",
  includeGoogle: true,
  maxChoices: 3,
}, {
  googleProvider: async ({ venueName }) => ({
    match_status: "matched",
    source: "Google Maps",
    place_id: `place-${venueName.length}`,
    rating: 4.7,
    user_rating_count: 500,
    google_maps_uri: "https://maps.google.test/place",
    ranking_effect: "display_only_not_backtested",
  }),
});
assert.equal(explore.choices[0].label, "new_high_rated_option");
assert.equal(explore.choices[0].store.name, "New Pizza");
assert.equal(explore.google_quality.enriched, 3);

const noGoogle = await getSuggestions(new FakeClient(), {
  mode: "balanced",
  query: "pizza",
  qualityPreference: "google",
  includeGoogle: true,
  maxChoices: 3,
}, { googleApiKey: "" });
assert.equal(noGoogle.google_quality.available, false);
assert.match(noGoogle.google_quality.reason, /not configured/);
assert.equal(noGoogle.choices.length, 3);

let implicitGoogleCalls = 0;
const implicitGoogle = await getSuggestions(new FakeClient(), {
  mode: "balanced",
  query: "pizza",
  maxChoices: 3,
}, { googleProvider: async () => { implicitGoogleCalls += 1; return { match_status: "matched" }; } });
assert.equal(implicitGoogleCalls, 0);
assert.equal(implicitGoogle.google_quality.requested, false);

const reviewFlags = [];
const reviewCap = await getSuggestions(new FakeClient(), {
  mode: "explore",
  query: "pizza",
  includeGoogleReviews: true,
  maxChoices: 4,
}, { googleProvider: async ({ includeReviews }) => {
  reviewFlags.push(includeReviews);
  return { match_status: "matched", reviews_status: includeReviews ? "returned" : "not_requested" };
} });
assert.deepEqual(reviewFlags, [true, true, true, false]);
assert.equal(reviewCap.google_quality.review_venues_enriched, 3);

const ambiguous = matchGooglePlace("Same Pizza", { latitude: 41.38, longitude: 2.17 }, [
  { id: "a", displayName: { text: "Same Pizza" }, location: { latitude: 41.381, longitude: 2.17 }, businessStatus: "OPERATIONAL" },
  { id: "b", displayName: { text: "Same Pizza" }, location: { latitude: 41.382, longitude: 2.17 }, businessStatus: "OPERATIONAL" },
]);
assert.equal(ambiguous.status, "ambiguous");

const googleRequests = [];
const provider = createGooglePlacesProvider("secret-key", {
  fetchImpl: async (url, options) => {
    googleRequests.push({ url, options });
    if (url.includes("/places/place-1")) return {
      ok: true,
      json: async () => ({
        attributions: [{ provider: "Review Provider" }],
        reviews: [{
          text: { text: "Carefully prepared.", languageCode: "en" },
          rating: 5,
          publishTime: "2026-01-01T00:00:00Z",
          relativePublishTimeDescription: "6 months ago",
          googleMapsUri: "https://maps.google.test/review-1",
          authorAttribution: { displayName: "Reviewer", uri: "https://maps.google.test/profile" },
        }],
      }),
    };
    return {
      ok: true,
      json: async () => ({ places: [{
        id: "place-1",
        displayName: { text: "Favorite Pizza" },
        location: { latitude: 41.381, longitude: 2.17 },
        rating: 4.6,
        userRatingCount: 700,
        googleMapsUri: "https://maps.google.test/place-1",
        businessStatus: "OPERATIONAL",
        attributions: [{ provider: "Example" }],
      }] }),
    };
  },
});
const google = await provider({ venueName: "Favorite Pizza", location: { latitude: 41.38, longitude: 2.17 }, cityCode: "BCN", includeReviews: true });
assert.equal(googleRequests[0].url, "https://places.googleapis.com/v1/places:searchText");
assert.equal(googleRequests[0].options.method, "POST");
assert.equal(googleRequests[0].options.headers["X-Goog-FieldMask"], GOOGLE_PLACES_FIELD_MASK);
assert.equal(googleRequests[0].options.headers["X-Goog-Api-Key"], "secret-key");
assert.equal("Authorization" in googleRequests[0].options.headers, false);
assert.deepEqual(Object.keys(JSON.parse(googleRequests[0].options.body)).sort(), ["locationBias", "pageSize", "textQuery"]);
assert.equal(googleRequests[1].url, "https://places.googleapis.com/v1/places/place-1");
assert.equal(googleRequests[1].options.headers["X-Goog-FieldMask"], GOOGLE_PLACE_REVIEW_FIELD_MASK);
assert.equal("Authorization" in googleRequests[1].options.headers, false);
assert.equal(google.source, "Google Maps");
assert.equal(google.ranking_effect, "display_only_not_backtested");
assert.equal(google.reviews_status, "returned");
assert.equal(google.reviews[0].author_attribution.display_name, "Reviewer");
assert.match(google.review_notice, /Google selects and orders/);
assert.deepEqual(google.attributions, [{ provider: "Example" }, { provider: "Review Provider" }]);

console.log("suggestions.test: 8 intent/provider scenarios and exact API contracts passed");
