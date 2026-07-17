import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const matches = execFileSync("rg", ["-l", "import\\(\"playwright-core\"\\)|chromium\\.launch|newContext\\(|page\\.goto", "src", "scripts", "tests", "README.md", "skills", "--glob", "!dist/**"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => file !== "tests/browser-boundary.test.mjs")
  .sort();

assert.deepEqual(matches, ["src/auth/login.mjs"]);

const apiSource = readFileSync("src/glovo/api.mjs", "utf8");
assert.equal(apiSource.includes("await fetch("), false);
assert.equal((apiSource.match(/globalThis\.fetch/g) || []).length, 2);

console.log("browser-boundary.test: browser automation limited to user-initiated login/session bootstrap");
