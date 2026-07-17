import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suppliedRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (suppliedRoot && !statSync(suppliedRoot).isDirectory()) throw new Error("Packaged runtime argument must be an unpacked MCPB directory.");
const packageRoot = suppliedRoot || mkdtempSync(path.join(os.tmpdir(), "glovo-packaged-runtime-"));
if (!suppliedRoot) {
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  copyFileSync(path.join(root, "dist", "server.mjs"), path.join(packageRoot, "dist", "server.mjs"));
  for (const file of ["package.json", "browsers.json", "manifest.json", "README.md", "LICENSE"]) {
    copyFileSync(path.join(root, file), path.join(packageRoot, file));
  }
}
const sessionDir = mkdtempSync(path.join(os.tmpdir(), "glovo-packaged-session-"));
const sessionPath = path.join(sessionDir, "session.json");
const serverPath = path.join(packageRoot, "dist", "server.mjs");

const bundledSource = readFileSync(serverPath, "utf8");
if (!bundledSource.includes("createRequire(import.meta.url)") || !bundledSource.includes("const __dirname =")) {
  throw new Error("Bundled server is missing the Node ESM compatibility banner required by the login/runtime package.");
}
JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
JSON.parse(readFileSync(path.join(packageRoot, "browsers.json"), "utf8"));
JSON.parse(readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));

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
  const expectedTools = [
    "glovo_add_to_basket", "glovo_analyze_order_history", "glovo_auth_status", "glovo_browse_store_catalog",
    "glovo_browse_stores", "glovo_get_basket", "glovo_get_location", "glovo_get_order_items",
    "glovo_get_order_stats", "glovo_get_product", "glovo_get_purchase_history", "glovo_get_saved_locations",
    "glovo_get_shopping_guide", "glovo_get_store", "glovo_get_store_menu", "glovo_get_store_order_options",
    "glovo_get_store_recommendations", "glovo_get_suggestions", "glovo_login", "glovo_plan_reorder",
    "glovo_preview_reorder", "glovo_remove_from_basket", "glovo_search_locations", "glovo_search_store_items",
    "glovo_select_location", "glovo_set_location", "glovo_set_quantity",
  ].sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) throw new Error("Packaged runtime tool surface does not match v0.2.1.");

  const result = await client.callTool({ name: "glovo_auth_status", arguments: {} });
  const text = result.content?.map((c) => c.text).join("\n") ?? "";
  if (result.isError) throw new Error(`Packaged auth status failed: ${text.replace(/\d/g, "#").slice(0, 180)}`);
  const parsed = JSON.parse(text || "{}");
  if (parsed.signed_in !== false) throw new Error("Packaged no-browser smoke must use an empty temporary session.");

  console.log(JSON.stringify({
    ok: true,
    packaged_runtime: true,
    login_tool_registered: true,
    tool_count: toolNames.length,
    store_catalog_tool_registered: toolNames.includes("glovo_browse_store_catalog"),
    no_browser_launched: true,
    no_chrome_navigation: true,
    node_path_empty: true,
    temp_session: true,
  }));
} finally {
  await client.close();
  rmSync(sessionDir, { recursive: true, force: true });
  if (!suppliedRoot) rmSync(packageRoot, { recursive: true, force: true });
}
