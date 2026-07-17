#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlovoClient } from "../src/glovo/api.mjs";
import { runVenueEvaluation } from "../src/glovo/venue-model.mjs";

function options(argv) {
  const parsed = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") parsed.input = path.resolve(argv[++index]);
    else if (argv[index] === "--output") parsed.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return parsed;
}

async function loadCards(input) {
  if (input) {
    const payload = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(payload?.orders)) throw new Error("Input must contain an orders array.");
    return { cards: payload.orders, source: "private_input_file", pagination: null };
  }
  const sessionPath = process.env.GLOVO_SESSION_PATH || path.join(os.homedir(), ".glovo", "session.json");
  const client = new GlovoClient(sessionPath).reload();
  if (!client.authStatus().signed_in) throw new Error("No authenticated Glovo session. Run glovo_login first.");
  const discovery = await client.getAllOrderCards({ limit: 15, pageDelayMs: 750, maxRetries: 6 });
  return {
    cards: discovery.orders,
    source: "authenticated_order_cards",
    pagination: {
      pages: discovery.pages.length,
      stopped_reason: discovery.stopped_reason,
      strategy: discovery.strategy,
    },
  };
}

const parsed = options(process.argv.slice(2));
const loaded = await loadCards(parsed.input);
const evaluation = runVenueEvaluation(loaded.cards, { newestFirst: true });
const aggregate = {
  generated_at: new Date().toISOString(),
  source: loaded.source,
  pagination: loaded.pagination,
  ...evaluation,
  privacy: "Aggregate metrics only. No order, venue, address, coordinate, basket, or token data is emitted.",
  product_boundary: "Order cards are not product ground truth. No product model is trained or evaluated here.",
};

const serialized = `${JSON.stringify(aggregate, null, 2)}\n`;
if (parsed.output) writeFileSync(parsed.output, serialized, { mode: 0o600 });
process.stdout.write(serialized);
