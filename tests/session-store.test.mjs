import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSession, saveSession } from "../src/auth/store.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-session-"));
const file = path.join(dir, "session.json");

saveSession(file, { location: { cityCode: "BCN" } });
assert.equal(statSync(file).mode & 0o777, 0o600);
assert.equal(JSON.parse(readFileSync(file, "utf8")).location.cityCode, "BCN");

writeFileSync(file, JSON.stringify({ location: { cityCode: "MAD" } }));
chmodSync(file, 0o644);
assert.notEqual(statSync(file).mode & 0o777, 0o600);
assert.equal(loadSession(file).location.cityCode, "MAD");
assert.equal(statSync(file).mode & 0o777, 0o600);

writeFileSync(file, JSON.stringify({ accessToken: { nope: true } }));
assert.throws(() => loadSession(file), /Malformed Glovo session/);
