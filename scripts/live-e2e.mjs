import os from "node:os";
import path from "node:path";
import { GlovoClient, compactBasket, compactProductView, compactSearch, storeCategoryIdFromStore, validateSelectedOptions, withRetry } from "../src/glovo/api.mjs";
import { assertMutationCompatible, createBasketSnapshot, persistPrivateSnapshot, withBasketRestore } from "./basket-safety.mjs";

const sessionPath = process.env.GLOVO_SESSION_PATH || path.join(os.homedir(), ".glovo", "session.json");
const mutate = process.argv.includes("--mutate");
const preflightOnly = process.argv.includes("--preflight");
const mutationEnv = process.env.GLOVO_E2E_MUTATE === "1";
const client = new GlovoClient(sessionPath).reload();

async function findProduct(query) {
  const wall = await withRetry(() => client.browseStores({ categoryId: 1, limit: 30 }), { maxRetries: 2, label: "live-e2e-browse" });
  const stores = (wall?.data?.stores?.entries || []).filter((s) => s.metadata?.storeAddressId && (s.open === true || s.availability?.status === "OPEN"));
  for (const store of stores) {
    const search = await withRetry(() => client.searchStoreItems(store.id ?? store.storeId, store.metadata.storeAddressId, query), { maxRetries: 2, label: "live-e2e-search" });
    const products = compactSearch(search, { storeId: String(store.id ?? store.storeId), storeAddressId: store.metadata.storeAddressId, limit: 50 }).results;
    const product = products.find((candidate) => candidate.available !== false && candidate.external_id && candidate.store_product_id);
    if (product) return { store, product };
  }
  throw new Error(`No product found for ${query}`);
}

const pizza = await findProduct("pizza");
const storeId = String(pizza.store.id ?? pizza.store.storeId);
const storeAddressId = pizza.store.metadata.storeAddressId;
const storeDetail = await withRetry(() => client.getStore(storeId), { maxRetries: 2, label: "live-e2e-store-detail" });
const storeCategoryId = storeCategoryIdFromStore(storeDetail);
const productId = pizza.product.id ?? pizza.product.product_id ?? pizza.product.productId;
const externalId = pizza.product.external_id ?? pizza.product.externalId ?? pizza.product.productExternalId;
const storeProductId = pizza.product.store_product_id ?? pizza.product.storeProductId;
const productView = await withRetry(() => client.getProduct({ storeId, storeAddressId, productId, externalId }), { maxRetries: 2, label: "live-e2e-product" });
const repeatedProductView = await withRetry(() => client.getProduct({ storeId, storeAddressId, productId, externalId }), { maxRetries: 2, label: "live-e2e-product-repeat" });
const compactProduct = compactProductView(productView);
const productViewStoreProductId = compactProduct.store_product_id;
const requiredOptions = selectRequiredOptions(compactProduct);
const candidate = {
  open_store: true,
  current_available: compactProduct.add_enabled === true,
  has_product_id: Boolean(productId),
  has_external_id: Boolean(externalId),
  has_store_product_id: Boolean(storeProductId && productViewStoreProductId),
  has_store_category_id: Boolean(storeCategoryId && Number(storeCategoryId) !== 0),
  fresh_ids_match_search: String(compactProduct.product_id) === String(productId) && String(compactProduct.external_id) === String(externalId) && String(productViewStoreProductId) === String(storeProductId),
  has_required_option_choices: requiredOptions.length > 0,
  repeated_product_detail_ok: Boolean(compactProductView(repeatedProductView).product_id),
};
console.log(JSON.stringify({ event: "read_e2e", store_found: Boolean(storeId), product_found: Boolean(productId), option_groups: compactProduct.option_groups?.length || 0, required_option_groups: requiredOptions.length }));
console.log(JSON.stringify({ event: "candidate_preflight", ...candidate }));

function assertCandidate(candidate) {
  const failed = Object.entries(candidate).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length) throw new Error(`Candidate preflight failed: ${failed.join(", ")}`);
}

function selectRequiredOptions(product) {
  return (product.option_groups || [])
    .filter((group) => group.required)
    .map((group) => {
      const option = group.options?.[0];
      if (!option?.id) throw new Error(`Required option group ${group.id} has no selectable options.`);
      return { group_id: group.id, option_id: option.id, quantity: Math.max(1, group.min || 1) };
    });
}

function originalContainsProduct(snapshot, storeId, productId, externalId) {
  const basket = (snapshot.raw?.baskets || snapshot.raw || []).find((entry) => String(entry.storeId) === String(storeId));
  return (basket?.products || []).some((line) => {
    const ids = line.ids || {};
    return String(ids.id) === String(productId) || (externalId && String(ids.externalId) === String(externalId));
  });
}

function findTestLine(compact) {
  return (compact?.lines || []).find((line) =>
    String(line.product_id) === String(productId) ||
    String(line.external_id) === String(externalId) ||
    String(line.store_product_id) === String(storeProductId)
  );
}

function assertLineAbsentFromGlobal(raw) {
  const baskets = Array.isArray(raw) ? raw : raw?.baskets || raw?.data?.baskets || [];
  const selected = baskets.find((basket) => String(basket.storeId) === String(storeId));
  const compact = compactBasket(selected);
  if (findTestLine(compact)) throw new Error("Removed test product is still visible in global basket state.");
  return true;
}

async function waitForStage(stage, predicate) {
  return withRetry(async () => {
    const result = await predicate();
    if (!result) throw new Error(`Stage ${stage} state not visible yet.`);
    return result;
  }, { maxRetries: 2, label: `live-e2e-stage-${stage}` });
}

if (preflightOnly) {
  assertCandidate(candidate);
  console.log(JSON.stringify({ event: "candidate_preflight_ok", all_true: true }));
  process.exit(0);
}

if (!mutate) {
  console.log(JSON.stringify({ event: "skip_mutation", reason: "pass --mutate to run reversible basket E2E" }));
  process.exit(0);
}

if (!mutationEnv) {
  throw new Error("Mutation safety gate: set GLOVO_E2E_MUTATE=1 together with --mutate.");
}

assertCandidate(candidate);

const original = await client.getBaskets();
const snapshot = createBasketSnapshot(original);
assertMutationCompatible(snapshot, storeId);
if (originalContainsProduct(snapshot, storeId, productId, externalId)) {
  throw new Error("Refusing mutation: selected test product already exists in the original basket.");
}
const recoveryPath = persistPrivateSnapshot(snapshot);
const originalBaskets = Array.isArray(original) ? original : original?.baskets || [];
console.log(JSON.stringify({ event: "snapshot", baskets: originalBaskets.length, fingerprint: snapshot.fingerprint, private_snapshot: true }));

await withBasketRestore(client, snapshot, storeId, async () => {
  const freshProductView = await withRetry(() => client.getProduct({ storeId, storeAddressId, productId, externalId }), { maxRetries: 2, label: "live-e2e-product-before-add" });
  const freshCompact = compactProductView(freshProductView);
  if (freshCompact.add_enabled !== true) throw new Error("Selected product add button is not enabled before add.");
  if (String(freshCompact.store_product_id) !== String(storeProductId)) throw new Error("Fresh product identifiers no longer match search result.");
  validateSelectedOptions(freshProductView, requiredOptions);
  await client.addToBasket({ storeId, storeAddressId, storeCategoryId, productId, externalId, storeProductId: freshCompact.store_product_id, quantity: 1, selectedOptions: requiredOptions, productView: freshProductView });
  const basketLine = await waitForStage("add", async () => {
    const line = findTestLine(compactBasket(await client.getBasketByStore(storeId)));
    if (!line?.basket_product_id || !line.has_selected_options) return null;
    return line;
  });
  console.log(JSON.stringify({ event: "stage_add", line_present: true, selected_customizations: true }));
  await client.setQuantity({ storeId, basketProductId: basketLine.basket_product_id, quantity: 2 });
  const setLine = await waitForStage("set", async () => {
    const line = findTestLine(compactBasket(await client.getBasketByStore(storeId)));
    if (!line?.basket_product_id || Number(line?.quantity) !== 2) return null;
    return line;
  });
  console.log(JSON.stringify({ event: "stage_set", quantity_two: true, id_rotated: String(setLine.basket_product_id) !== String(basketLine.basket_product_id) }));
  await client.removeFromBasket({ storeId, basketProductId: setLine.basket_product_id });
  await waitForStage("remove", async () => !findTestLine(compactBasket(await client.getBasketByStore(storeId))));
  await waitForStage("remove-global", async () => assertLineAbsentFromGlobal(await client.getBaskets()));
  console.log(JSON.stringify({ event: "stage_remove", line_absent_store: true, line_absent_global: true }));
  console.log(JSON.stringify({ event: "mutation_e2e", pizza_add_set_remove: true, required_options_validated: true, basket_options_represented: true }));
}, { recoveryPath }).then(({ restore }) => {
  console.log(JSON.stringify({ event: "restore_ok", fingerprint: restore.fingerprint }));
}).catch((error) => {
  if (error.recoveryPath) console.error(JSON.stringify({ event: "restore_failed_recovery_snapshot", path: error.recoveryPath }));
  throw error;
});
