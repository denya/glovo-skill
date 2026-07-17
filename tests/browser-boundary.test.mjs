import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const executableRoots = ["src", "scripts", "tests"];
const executableExtensions = new Set([".js", ".mjs", ".cjs", ".json"]);
const loginFiles = new Set(["src/auth/login.mjs", "src/server.mjs", "scripts/login.mjs"]);

function walk(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const file = path.join(dir, name);
      if (file.includes(`${path.sep}dist${path.sep}`) || file.includes(`${path.sep}node_modules${path.sep}`)) return [];
      if (statSync(file).isDirectory()) return walk(file);
      return executableExtensions.has(path.extname(file)) ? [file] : [];
    })
    .sort();
}

const files = [...new Set([...executableRoots.flatMap(walk), "package.json"])]
  .filter((file) => file !== "tests/browser-boundary.test.mjs")
  .sort();

const rules = [
  {
    name: "Playwright import",
    pattern: /(?:import\s*\(\s*["']playwright-core["']|from\s+["']playwright-core["'])/,
    allow: new Set(["src/auth/login.mjs"]),
    blocked: ['await import("playwright-core")'],
  },
  {
    name: "browser launch",
    pattern: /\b(?:chromium|firefox|webkit)\s*\.\s*launch\s*\(/,
    allow: new Set(["src/auth/login.mjs"]),
    blocked: ["chromium.launch({ headless: false })"],
  },
  {
    name: "browser context/page navigation",
    pattern: /\b(?:browser\s*\.\s*newContext|context\s*\.\s*newPage|page\s*\.\s*goto)\s*\(/,
    allow: new Set(["src/auth/login.mjs"]),
    blocked: ['await page.goto("https://glovoapp.com")'],
  },
  {
    name: "login implementation import",
    pattern: /from\s+["'][^"']*auth\/login\.mjs["']|import\s*\([^)]*auth\/login\.mjs/,
    allow: loginFiles,
    blocked: ['import { runLogin } from "../src/auth/login.mjs"'],
  },
  {
    name: "runLogin invocation",
    pattern: /\brunLogin\s*\(/,
    allow: loginFiles,
    blocked: ["await runLogin(sessionPath)"],
  },
  {
    name: "MCP login tool call",
    pattern: /callTool\s*\(\s*\{[\s\S]{0,240}name\s*:\s*["']glovo_login["']/,
    allow: new Set(),
    blocked: ['await client.callTool({ name: "glovo_login", arguments: {} })'],
  },
  {
    name: "OS browser opener",
    pattern: /\b(?:osascript|open\s+-a|xdg-open|start\s+["'](?:Google Chrome|Chrome|Chromium)|tell\s+application\s+["']?(?:Google Chrome|Chrome|Chromium|Safari))/i,
    allow: new Set(),
    blocked: ['execFileSync("osascript", ["-e", "tell application \\"Google Chrome\\""])', "open -a 'Google Chrome'"],
  },
];

for (const rule of rules) {
  for (const sample of rule.blocked) assert.match(sample, rule.pattern, `${rule.name} regex self-test failed`);
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const rule of rules) {
    if (!rule.allow.has(file)) assert.equal(rule.pattern.test(text), false, `${file} violates ${rule.name}`);
  }
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (!/(^test|verify|check|smoke|e2e|live:e2e)/.test(name)) continue;
  assert.equal(/\b(?:npm\s+run\s+login|node\s+scripts\/login\.mjs|glovo_login|osascript|open\s+-a|xdg-open)\b/i.test(command), false, `${name} must not invoke login/browser`);
}

const apiSource = readFileSync("src/glovo/api.mjs", "utf8");
assert.equal(apiSource.includes("await fetch("), false);
assert.equal((apiSource.match(/globalThis\.fetch/g) || []).length, 2);

console.log("browser-boundary.test: browser automation limited to user-initiated login/session bootstrap");
