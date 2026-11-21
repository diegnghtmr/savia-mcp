import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const missing = ["get_debt_projection"];
const approvals = ["contribute_to_fund", "create_account", "create_budget", "create_cross_currency_transfer",
  "create_report_definition", "create_sinking_fund", "create_transaction", "create_transfer", "scan_receipt", "update_budget",
  "update_budget_allocations", "update_transaction", "void_transaction"];
const workspace = "59fd5039-58ea-492a-8404-b02b50671c3a", override = "fac2d19d-4273-4941-a7a2-c0eaebd321e6";
const id = "94779f05-9dd8-410e-a478-a7666e04d664", key = "f532b1d5-1952-4eb8-8cd1-9a150bff2a06";
const token = "test_fake_bearer_never_in_output";
const error = text => ({ isError: true, content: [{ type: "text", text }] });
const success = { content: [{ type: "text", text: '{"ok":true}' }] };

test("pinned manifest exactly matches the OpenAPI JSON and reports all missing PRD tools", {
  skip: !process.env.SAVIA_OPENAPI_PATH && !existsSync(new URL("../../docs/", root)) && "standalone checkout has no Savia authorities",
}, t => {
  const check = (...args) => {
    const r = spawnSync(process.execPath, ["scripts/generate-tools.mjs", "--check", ...args], { cwd: root, encoding: "utf8" });
    return [r.status, r.stdout, r.stderr];
  };
  const report = `PRD tools missing from OpenAPI: ${missing.join(", ")}\n`;
  assert.deepEqual(check(), [0, report, ""]);
  const dir = mkdtempSync(join(tmpdir(), "savia-mcp-authority-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const authority = JSON.parse(readFileSync(process.env.SAVIA_OPENAPI_PATH ?? new URL("../../docs/savia-openapi.json", root), "utf8"));
  authority.paths["/v1/accounts"].get.summary += " (drift probe)";
  const alternate = join(dir, "savia-openapi.json");
  writeFileSync(alternate, JSON.stringify(authority));
  assert.deepEqual(check("--openapi", alternate), [1, report, "Pinned MCP manifest has drifted; run pnpm tools:generate.\n"]);
  assert.deepEqual(check(), [0, report, ""]);
});

async function fixture(t, handle = (_req, res) => res.end('{"ok":true}'), settings = {}) {
  const requests = [], stderr = [];
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      workspace: req.headers["x-workspace-id"], key: req.headers["idempotency-key"],
      contentType: req.headers["content-type"], accept: req.headers.accept, body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json"); handle(req, res);
  });
  await new Promise((resolve, reject) => api.listen(0, "127.0.0.1", resolve).once("error", reject));
  const url = `http://${settings.host ?? "127.0.0.1"}:${api.address().port}`;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("dist/server.js", root))], stderr: "pipe",
    env: { SAVIA_API_URL: url, SAVIA_MCP_TOKEN: token, SAVIA_WORKSPACE_ID: workspace, ...settings.env } });
  const client = new Client({ name: "savia-loopback-tests", version: "1" });
  transport.stderr.on("data", data => stderr.push(data));
  t.after(async () => {
    await client.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
    assert.equal(Buffer.concat(stderr).toString(), "");
  });
  await client.connect(transport);
  return { client, requests, call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 8000 }) };
}

const reads = [
  ["list_accounts", { limit: 1, status: "active" }, "GET", "/v1/accounts?limit=1&status=active"],
  ["get_account_balance", { accountId: id, workspaceId: override, asOf: "2026-11-20T12:00:00+01:00" },
    "GET", `/v1/accounts/${id}/balance?asOf=2026-11-20T12%3A00%3A00%2B01%3A00`],
  ["search_transactions", { query: "a&b + c", limit: 200 }, "GET", "/v1/transactions?limit=200&query=a%26b+%2B+c"],
  ["get_budget_status", { budgetId: id }, "GET", `/v1/budgets/${id}`],
  ["get_financial_summary", { from: "2026-01-01", to: "2026-01-31", presentationCurrency: "COP" },
    "GET", "/v1/analytics/summary?from=2026-01-01&to=2026-01-31&presentationCurrency=COP"],
  ["create_forecast", { body: { horizonDays: 730, accountIds: [id] }, idempotencyKey: key }, "POST", "/v1/forecasts/balance"],
  ["run_scenario", { scenarioId: id }, "POST", `/v1/scenarios/${id}/runs`],
  ["run_report", { body: { preset: "monthly_summary", format: "json", filters: { accountId: id } }, idempotencyKey: key },
    "POST", "/v1/report-runs"],
  ["list_ai_providers", {}, "GET", "/v1/ai/providers"],
  ["get_forecast", { forecastId: id }, "GET", `/v1/forecasts/${id}`],
  ["list_workspaces", { limit: 5 }, "GET", "/v1/workspaces?limit=5"],
  ["export_report_pdf", { reportRunId: id }, "GET", `/v1/report-runs/${id}`],
];

test("advertises the 25 annotated tools and sends the exact request for each read", async t => {
  const { client, call, requests } = await fixture(t);
  assert.deepEqual(client.getServerCapabilities(), { tools: {} });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...reads.map(([name]) => name), ...approvals].sort());
  const balance = tools.find(tool => tool.name === "get_account_balance");
  assert.equal(balance.description, "Get account balance");
  assert.deepEqual(balance.inputSchema.required, ["accountId"]);
  assert.deepEqual(balance.inputSchema.properties.accountId, { type: "string", format: "uuid" });
  assert.deepEqual(balance._meta, { "savia.app/riskClass": "read", "savia.app/requiresApproval": false,
    "savia.app/requiredScopes": ["accounts:read"] });
  for (const [name, args, method, url] of reads) {
    assert.deepEqual(await call(name, args), success, name);
    const request = requests.at(-1);
    assert.deepEqual(request, { method, url, authorization: `Bearer ${token}`,
      workspace: name === "list_workspaces" ? undefined : args.workspaceId ?? workspace,
      key: name === "run_scenario" ? request.key : args.idempotencyKey, contentType: args.body ? "application/json" : undefined,
      accept: "application/json, application/problem+json", body: args.body ? JSON.stringify(args.body) : "" }, name);
    if (name === "run_scenario") assert.match(request.key, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  }
  assert.equal(requests.length, 12);
});

test("approval, unknown tools, and invalid arguments never reach the API", async t => {
  const { call, requests } = await fixture(t);
  for (const name of approvals) assert.deepEqual(await call(name, { extra: token }),
    error("requires approval — not available in this version"), name);
  for (const name of missing) assert.deepEqual(await call(name), error("Unknown tool."));
  for (const [name, args] of [
    ["get_account_balance", {}], ["get_account_balance", { accountId: "../other" }],
    ["list_accounts", { limit: 0 }], ["list_accounts", { limit: 201 }], ["list_accounts", { limit: "1" }],
    ["list_accounts", { status: "unknown" }], ["list_accounts", { workspaceId: "invalid" }],
    ["list_accounts", { authorization: token }], ["search_transactions", { query: "x".repeat(201) }],
    ["get_financial_summary", { from: "2026-02-30", to: "2026-03-01" }],
    ["create_forecast", {}], ["create_forecast", { body: { accountIds: [id, id] } }],
    ["run_report", { body: { format: "json" } }], ["run_report", { body: { preset: "expenses", definitionId: id, format: "json" } }],
  ]) assert.deepEqual(await call(name, args), error("Invalid tool arguments."), name);
  assert.deepEqual(requests, []);
});

test("requires configuration, permits an explicit workspace, and rejects non-loopback cleartext", async t => {
  const absent = await fixture(t, undefined, { env: { SAVIA_WORKSPACE_ID: "" } });
  assert.deepEqual(await absent.call("list_accounts"), error("A valid workspaceId is required."));
  assert.deepEqual(absent.requests, []);
  assert.deepEqual(await absent.call("list_accounts", { workspaceId: override }), success);
  assert.deepEqual(absent.requests.map(r => r.workspace), [override]);
  for (const settings of [{ host: "0.0.0.0" }, { env: { SAVIA_MCP_TOKEN: "" } }, { env: { SAVIA_API_URL: "" } }]) {
    const { call, requests } = await fixture(t, undefined, settings);
    assert.deepEqual(await call("list_accounts"), error("Savia API configuration is invalid."));
    assert.deepEqual(requests, []);
  }
});

test("maps problems, redacts backend echoes, and bounds redirects, size and time", async t => {
  const { call, requests } = await fixture(t, (req, res) => {
    switch (new URL(req.url, "http://localhost").searchParams.get("cursor")) {
      case "problem": res.writeHead(403, { "Content-Type": "application/problem+json; charset=utf-8" });
        return res.end(JSON.stringify({ title: "Forbidden", code: "workspace_denied", detail: `denied ${token}` }));
      case "echo": return res.end(JSON.stringify({ [token]: [`Bearer ${token}`] }));
      case "redirect": res.writeHead(302, { Location: "/must-not-follow" }); return res.end();
      case "large": res.write("\"" + "x".repeat(1_048_576)); return res.end("\"");
      case "slow": return res.write("{");
      default: return res.end("not JSON");
    }
  });
  assert.deepEqual(await call("list_accounts", { cursor: "problem" }), error("Savia API 403 [workspace_denied]: Forbidden — denied [redacted]"));
  assert.deepEqual(await call("list_accounts", { cursor: "echo" }),
    { content: [{ type: "text", text: '{"[redacted]":["Bearer [redacted]"]}' }] });
  for (const [cursor, text] of [["redirect", "Savia API redirects are not allowed."], ["large", "Savia API response is too large."],
    ["slow", "Savia API request timed out."], ["invalid", "Savia API returned invalid JSON."]])
    assert.deepEqual(await call("list_accounts", { cursor }), error(text), cursor);
  assert.deepEqual(requests.map(r => r.url), ["problem", "echo", "redirect", "large", "slow", "invalid"].map(v => `/v1/accounts?cursor=${v}`));
});

test("approval-only tools advertise their optional If-Match parameter", async t => {
  const { client, requests } = await fixture(t);
  const { tools } = await client.listTools();
  for (const name of ["update_budget", "update_budget_allocations", "update_transaction", "void_transaction"]) {
    const { inputSchema } = tools.find(tool => tool.name === name);
    assert.equal(inputSchema.properties.ifMatch?.type, "string", name);
    assert.ok(!inputSchema.required.includes("ifMatch"), name);
  }
  assert.deepEqual(requests, []);
});

test("undeclared own properties are rejected before any HTTP request", async t => {
  const { call, requests } = await fixture(t);
  const undeclared = JSON.parse('{"__proto__":{}}');
  assert.deepEqual(await call("list_accounts", undeclared), error("Invalid tool arguments."));
  assert.deepEqual(await call("create_forecast", { body: undeclared }), error("Invalid tool arguments."));
  assert.deepEqual(requests, []);
});

test("search query length follows the OpenAPI Unicode character limit", async t => {
  const { call, requests } = await fixture(t);
  assert.deepEqual(await call("search_transactions", { query: "a".repeat(200) + "🙂" }),
    error("Invalid tool arguments."));
  assert.deepEqual(requests, []);
  const query = "a".repeat(199) + "🙂";
  assert.deepEqual(await call("search_transactions", { query }), success);
  assert.deepEqual(requests.map(r => r.url), [`/v1/transactions?query=${encodeURIComponent(query)}`]);
});

test("manifest check rejects a YAML-only tool annotation change", {
  skip: !existsSync(new URL("../../docs/savia-openapi.yaml", root)),
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "savia-mcp-yaml-drift-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "generar", "savia-mcp");
  mkdirSync(join(cwd, "src", "generated"), { recursive: true });
  cpSync(new URL("scripts/", root), join(cwd, "scripts"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("node_modules", root)), join(cwd, "node_modules"), "dir");
  const pinned = join(cwd, "src", "generated", "tools.json");
  const original = readFileSync(new URL("src/generated/tools.json", root));
  writeFileSync(pinned, original);
  const env = { ...process.env };
  delete env.SAVIA_OPENAPI_PATH;
  delete env.SAVIA_OPENAPI_YAML_PATH;
  delete env.SAVIA_PRD_PATH;
  const check = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/generate-tools.mjs", "--check", ...args],
      { cwd, env, encoding: "utf8" });
    assert.deepEqual(readFileSync(pinned), original);
    return [result.status, result.stdout, result.stderr];
  };
  const report = "PRD tools missing from OpenAPI: get_debt_projection\n";
  await t.test("skips absent default authorities in a standalone checkout", () => {
    assert.deepEqual(check(), [0, "", ""]);
  });
  const docs = join(dir, "docs");
  mkdirSync(docs);
  for (const file of ["savia-openapi.json", "PRD - Savia.md"]) {
    cpSync(new URL(`../../docs/${file}`, root), join(docs, file));
  }
  assert.deepEqual(check(), [0, report, ""], "a missing default YAML still allows checking the JSON manifest");
  const authority = join(docs, "savia-openapi.yaml");
  cpSync(new URL("../../docs/savia-openapi.yaml", root), authority);
  assert.deepEqual(check(), [0, report, ""]);

  const yaml = readFileSync(authority, "utf8");
  const disagreement = "OpenAPI YAML and JSON twin disagree on x-savia-mcp-tool annotations; regenerate the JSON twin.\n";
  const blocks = /^ {6}x-savia-mcp-tool:\r?\n(?: {8}[^\r\n]*\r?\n)+/gm;
  const annotations = [...yaml.matchAll(blocks)].map(m => m[0]);
  const [accounts, transactions] = ["list_accounts", "search_transactions"]
    .map(name => annotations.find(block => block.includes(`name: ${name}`)));
  assert.ok(accounts && transactions);
  for (const [name, edited] of [
    ["changed risk class", yaml.replace(/(name: list_accounts\r?\n +riskClass: )read/, "$1administrative")],
    ["uppercase YAML boolean", yaml.replace(/(name: list_accounts\r?\n +riskClass: read\r?\n +requiresApproval: )false/, "$1TRUE")],
    ["annotations swapped between operations", yaml.replace(blocks, block => block === accounts ? transactions : block === transactions ? accounts : block)],
    ["annotation missing from YAML", yaml.replace(accounts, "")],
    ["extra annotation field", yaml.replace(accounts, `${accounts}        extra: true\n`)],
  ]) {
    await t.test(name, () => {
      assert.notEqual(edited, yaml);
      writeFileSync(authority, edited);
      assert.deepEqual(check(), [1, "", disagreement]);
    });
  }
  await t.test("an annotation missing from JSON is drift too", () => {
    writeFileSync(authority, yaml);
    const twin = JSON.parse(readFileSync(join(docs, "savia-openapi.json"), "utf8"));
    delete twin.paths["/v1/accounts"].get["x-savia-mcp-tool"];
    const altered = join(dir, "altered.json");
    writeFileSync(altered, JSON.stringify(twin));
    assert.deepEqual(check("--openapi", altered), [1, "", disagreement]);
  });
  await t.test("annotation comment is not drift", () => {
    const commentOnly = yaml.replace(/(name: list_accounts)(?=\r?\n)/, "$1 # display name");
    assert.notEqual(commentOnly, yaml);
    writeFileSync(authority, commentOnly);
    assert.deepEqual(check(), [0, report, ""]);
  });
  for (const [flag, extension] of [["--yaml", "yaml"], ["--openapi", "json"]]) {
    await t.test(`rejects missing ${flag} override`, () => {
      writeFileSync(authority, yaml);
      const absent = join(dir, `absent.${extension}`);
      assert.deepEqual(check(flag, absent), [1, "", `OpenAPI ${extension.toUpperCase()} file not found: ${absent}\n`]);
    });
  }
});
