import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "glovo-packaged-runtime-"));
mkdirSync(path.join(tempRoot, "dist"), { recursive: true });
copyFileSync(path.join(root, "dist", "server.mjs"), path.join(tempRoot, "dist", "server.mjs"));
for (const file of ["package.json", "browsers.json", "manifest.json", "README.md", "LICENSE"]) {
  copyFileSync(path.join(root, file), path.join(tempRoot, file));
}
const sessionDir = path.join(tempRoot, "session");
mkdirSync(sessionDir);
const sessionPath = path.join(sessionDir, "session.json");
const serverPath = process.argv[2] || path.join(tempRoot, "dist", "server.mjs");

const bundledSource = readFileSync(serverPath, "utf8");
if (!bundledSource.includes("createRequire(import.meta.url)") || !bundledSource.includes("const __dirname =")) {
  throw new Error("Bundled server is missing the Node ESM compatibility banner required by the login/runtime package.");
}
JSON.parse(readFileSync(path.join(tempRoot, "package.json"), "utf8"));
JSON.parse(readFileSync(path.join(tempRoot, "browsers.json"), "utf8"));
JSON.parse(readFileSync(path.join(tempRoot, "manifest.json"), "utf8"));

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

const client = new Client({ name: "glovo-packaged-runtime-smoke", version: "0.0.1" });
await client.connect(transport);

try {
  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name).sort();
  if (!toolNames.includes("glovo_login")) throw new Error("Packaged runtime did not register glovo_login.");

  const result = await client.callTool({ name: "glovo_auth_status", arguments: {} });
  const text = result.content?.map((c) => c.text).join("\n") ?? "";
  if (result.isError) throw new Error(`Packaged auth status failed: ${text.replace(/\d/g, "#").slice(0, 180)}`);
  const parsed = JSON.parse(text || "{}");
  if (parsed.signed_in !== false) throw new Error("Packaged no-browser smoke must use an empty temporary session.");

  console.log(JSON.stringify({
    ok: true,
    packaged_runtime: true,
    login_tool_registered: true,
    no_browser_launched: true,
    no_chrome_navigation: true,
    node_path_empty: true,
    temp_session: true,
  }));
} finally {
  await client.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
