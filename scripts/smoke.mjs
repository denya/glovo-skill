import os from "node:os";
import path from "node:path";
import { GlovoClient, compactStoreWall, compactSearch } from "../src/glovo/api.mjs";

const sessionPath = process.env.GLOVO_SESSION_PATH || path.join(os.homedir(), ".glovo", "session.json");
const client = new GlovoClient(sessionPath).reload();

console.log("# auth status");
console.log(client.authStatus());

console.log("\n# groceries stores");
const stores = compactStoreWall(await client.browseStores({ categoryId: 4, limit: 5 }));
console.log(JSON.stringify(stores, null, 2).slice(0, 2500));

const first = stores.stores?.[0];
if (!first?.store_id || !first?.store_address_id) throw new Error("No store with store_address_id returned.");

console.log(`\n# search ${first.name}`);
const search = compactSearch(await client.searchStoreItems(first.store_id, first.store_address_id, "leche"), {
  storeId: first.store_id,
  storeAddressId: first.store_address_id,
  limit: 5,
});
console.log(JSON.stringify(search, null, 2).slice(0, 2500));

console.log("\nOK - Glovo live read-only smoke passed.");
