import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => !/(^package-lock\.json$|\.png$|\.mcpb$)/.test(file));

const patterns = [
  [/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}/, "jwt"],
  [/refreshToken["']?\s*[:=]\s*["'][^"']+["']/, "refresh token"],
  [/accessToken["']?\s*[:=]\s*["'][^"']+["']/, "access token"],
  [/Authorization["']?\s*[:=]\s*["'][^"']+["']/, "authorization header"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google Maps API key"],
];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) throw new Error(`Potential ${label} in ${file}`);
  }
}

console.log(`OK - scanned ${files.length} files`);
