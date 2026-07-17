import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlovoClient, compactLocationSearch, compactSavedLocations } from "../src/glovo/api.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-location-"));
const file = path.join(dir, "session.json");
const client = new GlovoClient(file, { session: {} });
const calls = [];

client.call = async (url, options = {}) => {
  calls.push({ url, options });
  assert.equal(options.auth, undefined);
  assert.equal(options.body, undefined);
  if (url.startsWith("/v3/addresslookup/pub/address?")) {
    return {
      data: [
        { placeId: "p1", provider: "google", title: "One", subtitle: "Area", address: "hidden full address" },
        { placeId: "p2", provider: "google", title: "Two", secondaryText: "District", formattedAddress: "hidden formatted" },
        { placeId: "p3", provider: "google", title: "Three" },
        { placeId: "p4", provider: "google", title: "Four" },
        { placeId: "p5", provider: "google", title: "Five" },
        { placeId: "p6", provider: "google", title: "Six" },
      ],
    };
  }
  if (url === "/v3/addresslookup/pub/place%2Fwith%20spaces?provider=google") {
    return { data: { title: "Selected", latitude: 41.4, longitude: 2.17, countryCode: "ES", cityCode: "BCN", accuracy: 12 } };
  }
  if (url === "/customer_profile/api/v1/guest/address_book/delivery_point_info?latitude=41.4&longitude=2.17&countryCode=ES") {
    return { data: { valid: true, countryCode: "ES", cityCode: "BCN" } };
  }
  if (url === "/v3/addresslookup/pub/place-no-provider") {
    return { data: { title: "Bad", latitude: 999, longitude: 2.17, countryCode: "ES", cityCode: "BCN" } };
  }
  if (url === "/v3/addresslookup/pub/place-not-deliverable") {
    return { data: { title: "Not deliverable", latitude: 41.4, longitude: 2.17, countryCode: "ES", cityCode: "BCN" } };
  }
  throw new Error(`Unexpected URL: ${url}`);
};

assert.throws(() => client.searchAddresses("ab"), /at least 3/);
const searchRaw = await client.searchAddresses("carrer mallorca");
assert.equal(calls.at(-1).url, "/v3/addresslookup/pub/address?address=carrer+mallorca&allowFallback=true");
const search = compactLocationSearch(searchRaw, { limit: 9 });
assert.equal(search.count, 5);
assert.equal(search.results.length, 5);
assert.deepEqual(search.results[0], { place_id: "p1", provider: "google", title: "One", subtitle: "Area" });
assert.equal(JSON.stringify(search).includes("hidden"), false);

const selected = await client.selectLocation({ placeId: "place/with spaces", provider: "google" });
assert.deepEqual(selected, { selected: true, deliverable: true, title: "Selected", city_code: "BCN", country_code: "ES" });
assert.equal(calls.at(-2).url, "/v3/addresslookup/pub/place%2Fwith%20spaces?provider=google");
assert.equal(calls.at(-1).url, "/customer_profile/api/v1/guest/address_book/delivery_point_info?latitude=41.4&longitude=2.17&countryCode=ES");
assert.equal(JSON.parse(readFileSync(file, "utf8")).location.cityCode, "BCN");

const invalid = new GlovoClient(path.join(dir, "invalid-session.json"), { session: {} });
invalid.call = client.call;
const failed = await invalid.selectLocation({ placeId: "place-no-provider" });
assert.equal(failed.selected, false);
assert.equal(failed.reason, "invalid_resolved_location");
assert.throws(() => readFileSync(invalid.sessionPath, "utf8"));
assert.equal(calls.at(-1).url, "/v3/addresslookup/pub/place-no-provider");

const notDeliverable = new GlovoClient(path.join(dir, "not-deliverable-session.json"), { session: {} });
notDeliverable.call = async (url, options = {}) => {
  calls.push({ url, options });
  assert.equal(options.auth, undefined);
  assert.equal(options.body, undefined);
  if (url === "/v3/addresslookup/pub/place-not-deliverable") {
    return { data: { title: "Not deliverable", latitude: 41.4, longitude: 2.17, countryCode: "ES", cityCode: "BCN" } };
  }
  if (url === "/customer_profile/api/v1/guest/address_book/delivery_point_info?latitude=41.4&longitude=2.17&countryCode=ES") {
    return { data: { valid: false, countryCode: "ES", cityCode: "BCN" } };
  }
  throw new Error(`Unexpected URL: ${url}`);
};
const refused = await notDeliverable.selectLocation({ placeId: "place-not-deliverable" });
assert.deepEqual(refused, { selected: false, deliverable: false, title: "Not deliverable", city_code: "BCN", country_code: "ES", reason: "not_deliverable" });
assert.throws(() => readFileSync(notDeliverable.sessionPath, "utf8"));

const savedClient = new GlovoClient(path.join(dir, "saved-session.json"), {
  session: {
    expiresIn: 3600,
    createdAt: Date.now(),
    customerId: "customer-1",
    location: { countryCode: "ES", cityCode: "BCN", latitude: "41.4", longitude: "2.17" },
  },
});
savedClient.call = async (url, options = {}) => {
  calls.push({ url, options });
  assert.equal(url, "/customer_profile/api/v1/address_book/me/addresses");
  assert.equal(options.auth, true);
  assert.equal(options.body, undefined);
  return {
    data: {
      addresses: [
        {
          entryType: "SAVED_ADDRESS",
          title: "Home",
          subtitle: "Barcelona",
          apiToken: "must-not-leak",
          address: {
            id: "addr-1",
            addressLine: "Example Street 1",
            details: "2A",
            kind: "APARTMENT",
            tag: "HOME",
            cityName: "Barcelona",
            cityCode: "BCN",
            countryCode: "ES",
            latitude: 41.4,
            longitude: 2.17,
            fields: [{ type: "POSTAL_CODE", value: "08000" }],
            apiToken: "must-not-leak",
          },
        },
        {
          entryType: "RECENT_ADDRESS",
          title: "Recent",
          address: {
            id: "recent-1",
            addressLine: "Recent Street",
            cityCode: "BCN",
            countryCode: "ES",
            latitude: 41.5,
            longitude: 2.18,
          },
        },
        {
          entryType: "SAVED_ADDRESS",
          title: "Office",
          address: {
            id: "addr-2",
            addressLine: "Work Avenue 2",
            cityCode: "BCN",
            countryCode: "ES",
            latitude: 41.5,
            longitude: 2.18,
          },
        },
      ],
    },
  };
};
const saved = await savedClient.savedLocations({ matchText: "example street 08000" });
assert.equal(calls.at(-1).url, "/customer_profile/api/v1/address_book/me/addresses");
assert.equal(calls.at(-1).options.auth, true);
assert.equal(saved.count, 2);
assert.equal(saved.selected.id, "addr-1");
assert.equal(saved.current_location.selected_saved_location_id, "addr-1");
assert.equal(saved.matched.id, "addr-1");
assert.deepEqual(saved.matched.set_location_args, { country_code: "ES", city_code: "BCN", latitude: "41.4", longitude: "2.17" });
assert.equal(JSON.stringify(saved).includes("must-not-leak"), false);

const compacted = compactSavedLocations({ data: { addresses: [{ entryType: "SAVED_ADDRESS", address: { id: "addr-3", addressLine: "No codes" } }] } });
assert.equal(compacted.count, 1);
assert.equal(compacted.saved_locations[0].set_location_args, undefined);

rmSync(dir, { recursive: true, force: true });
console.log("location-contract.test: public location search/select contract passed");
