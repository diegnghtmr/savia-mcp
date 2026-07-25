import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const paths = [".gitignore", ".mise.toml", ".npmrc", "package.json", "pnpm-lock.yaml", "tsconfig.json",
  "README.md", "scripts/audit.mjs", "src/server.ts", "test/protocol.test.mjs"];
const authored = paths.filter(x => x !== "pnpm-lock.yaml");
const forbidden = /node:(?:net|http|https|tls|dgram)|\bfetch\s*\(|WebSocket|list_workspaces|transaction|budget|credential|from\s+["'](?:\.\.\/){2,}/i;
for (const name of paths) if (!fs.existsSync(path.join(root, name))) throw Error(`missing:${name}`);
const lines = authored.reduce((n, f) => n + fs.readFileSync(path.join(root, f), "utf8").split("\n").length - 1, 0);
for (const name of authored.filter(x => !["scripts/audit.mjs","test/protocol.test.mjs"].includes(x))) if (forbidden.test(fs.readFileSync(path.join(root, name), "utf8"))) throw Error(`forbidden:${name}`);
if (/from\s+["'](?:\.\.\/){2,}/.test(fs.readFileSync(path.join(root,"test/protocol.test.mjs"),"utf8"))) throw Error("test-escapes-child");
if (lines > 340 || fs.existsSync(path.join(root, "..", ".git"))) throw Error(`boundary-or-budget:${lines}`);
if (createHash("sha256").update(fs.readFileSync(path.join(root,"README.md"))).digest("hex") !== "815f2d58ed0e13d86163f0a5c6d1d44fd44b8231099b8b6066f1207eb110f7ed") throw Error("claims-changed");
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
console.log(JSON.stringify({ paths, authoredLines: lines, audit: process.argv[2] ? "allowlisted" : "static-clean" }));
