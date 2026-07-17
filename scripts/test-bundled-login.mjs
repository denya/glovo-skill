import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "glovo-bundled-login-"));
mkdirSync(path.join(tempRoot, "dist"), { recursive: true });
copyFileSync(path.join(root, "dist", "server.mjs"), path.join(tempRoot, "dist", "server.mjs"));
for (const file of ["package.json", "browsers.json", "manifest.json", "README.md", "LICENSE"]) {
  copyFileSync(path.join(root, file), path.join(tempRoot, file));
}
const sessionDir = path.join(tempRoot, "session");
mkdirSync(sessionDir);
const sessionPath = path.join(sessionDir, "session.json");
const serverPath = process.argv[2] || path.join(tempRoot, "dist", "server.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    NODE_PATH: "",
    GLOVO_SESSION_PATH: sessionPath,
  },
  stderr: "inherit",
});

const client = new Client({ name: "glovo-bundled-login-smoke", version: "0.0.1" });
await client.connect(transport);

try {
  const result = await client.callTool({ name: "glovo_login", arguments: { timeout_ms: 1 } });
  const text = result.content?.map((c) => c.text).join("\n") ?? "";
  const expectedTimeout = result.isError && /No Glovo login token detected in time/.test(text);
  const signedIn = !result.isError && JSON.parse(text || "{}").signed_in === true;
  if (!expectedTimeout && !signedIn) {
    throw new Error(`Bundled login smoke did not reach Chrome login flow: ${text.replace(/\d/g, "#").slice(0, 180)}`);
  }
  console.log(JSON.stringify({ ok: true, bundled_login_runtime: true, completed_login: signedIn, node_path_empty: true }));
} finally {
  await client.close();
}
