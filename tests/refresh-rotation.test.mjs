import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlovoClient } from "../src/glovo/api.mjs";
import { saveSession } from "../src/auth/store.mjs";

function jwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `Bearer ${header}.${payload}.sig`;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-refresh-"));
const file = path.join(dir, "session.json");
const oldRefresh = "refresh-old";
const newAccess = jwt(Math.floor(Date.now() / 1000) + 3600);
const newRefresh = "refresh-new";

saveSession(file, {
  accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
  refreshToken: oldRefresh,
  customerId: 123,
  location: { cityCode: "BCN", latitude: "0", longitude: "0" },
});

const originalFetch = globalThis.fetch;
let refreshCalls = 0;
globalThis.fetch = async (url, options) => {
  refreshCalls += 1;
  assert.match(String(url), /\/oauth\/refresh$/);
  assert.equal(JSON.parse(options.body).refreshToken, oldRefresh);
  return {
    ok: true,
    status: 200,
    json: async () => ({ accessToken: newAccess, refreshToken: newRefresh, expiresIn: 3600, tokenType: "Bearer" }),
  };
};

try {
  const client = new GlovoClient(file).reload();
  await client.ensureAuth();
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(refreshCalls, 1);
  assert.equal(persisted.accessToken, newAccess);
  assert.equal(persisted.refreshToken, newRefresh);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.endsWith(".tmp")), []);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("refresh-rotation.test: refresh rotation persisted at 0600");
