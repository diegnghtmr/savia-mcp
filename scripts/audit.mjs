import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const sources = fs.readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => path.relative(root, path.join(entry.parentPath, entry.name))).sort();
const paths = [".gitignore", ".mise.toml", ".npmrc", "package.json", "pnpm-lock.yaml", "tsconfig.json",
  ".github/workflows/ci.yml", "README.md", "scripts/audit.mjs", "scripts/generate-tools.mjs", ...sources,
  "test/protocol.test.mjs", "test/tools.test.mjs"];
const forbiddenNetwork = /["'](?:node:)?(?:net|https?|tls|dgram)["']|\b(?:fetch|WebSocket)\b/i;
const escapes = /from\s+["'](?:\.\.\/){2,}/;
for (const name of paths) if (!fs.existsSync(path.join(root, name))) throw Error(`missing:${name}`);
const authoredLines = paths.filter(x => x !== "pnpm-lock.yaml" && x !== "src/generated/tools.json")
  .reduce((n, f) => n + fs.readFileSync(path.join(root, f), "utf8").split("\n").length - 1, 0);
for (const name of [...sources, "scripts/generate-tools.mjs", "test/protocol.test.mjs", "test/tools.test.mjs"]
  .filter(x => /\.[mt]?[jt]s$/.test(x))) {
  let source = fs.readFileSync(path.join(root, name), "utf8");
  if (escapes.test(source)) throw Error(`escapes-child:${name}`);
  // The runtime has one HTTP client; the tests bind a fake API to loopback.
  if (name === "src/tools.ts") source = source.replace(
    'await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal, redirect: "manual" });', "");
  if (name === "test/tools.test.mjs") source = source.replace('import { createServer } from "node:http";', "");
  if (forbiddenNetwork.test(source)) throw Error(`forbidden-network:${name}`);
}
if (fs.existsSync(path.join(root, "..", ".git"))) throw Error("repository-boundary");
if (process.argv[2]) {
  const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const rows = Object.values(report.advisories ?? {});
  const allowed = rows.length === 1 && rows[0].github_advisory_id === "GHSA-frvp-7c67-39w9" &&
    rows[0].module_name === "@hono/node-server" && rows[0].severity === "moderate" &&
    rows[0].findings?.length === 1 && rows[0].findings[0].version === "1.19.14" &&
    JSON.stringify(rows[0].findings[0].paths) === JSON.stringify([".>@modelcontextprotocol/sdk>@hono/node-server"]) &&
    !/(?:node:http|hono)/i.test(fs.readFileSync(path.join(root, "src/server.ts"), "utf8"));
  if (!allowed || report.metadata.vulnerabilities.high || report.metadata.vulnerabilities.critical) throw Error("audit-not-allowlisted");
}
console.log(JSON.stringify({ paths, authoredLines, audit: process.argv[2] ? "allowlisted" : "static-clean" }));
