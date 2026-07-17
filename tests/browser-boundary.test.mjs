import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const matches = execFileSync("rg", ["-l", "import\\(\"playwright-core\"\\)|chromium\\.launch|newContext\\(|page\\.goto", "src", "scripts", "tests", "README.md", "skills", "--glob", "!dist/**"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => file !== "tests/browser-boundary.test.mjs")
  .sort();

assert.deepEqual(matches, ["src/auth/login.mjs"]);

console.log("browser-boundary.test: browser automation limited to login/session smoke");
