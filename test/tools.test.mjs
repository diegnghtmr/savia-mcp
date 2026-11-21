import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const missing = ["export_report_pdf", "get_debt_projection", "list_workspaces", "scan_receipt"];
const approvals = ["contribute_to_fund", "create_account", "create_budget", "create_cross_currency_transfer",
  "create_report_definition", "create_sinking_fund", "create_transaction", "create_transfer", "update_budget",
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
];

test("advertises the 22 annotated tools and sends the exact request for each read", async t => {
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
    assert.deepEqual(request, { method, url, authorization: `Bearer ${token}`, workspace: args.workspaceId ?? workspace,
      key: name === "run_scenario" ? request.key : args.idempotencyKey, contentType: args.body ? "application/json" : undefined,
      accept: "application/json, application/problem+json", body: args.body ? JSON.stringify(args.body) : "" }, name);
    if (name === "run_scenario") assert.match(request.key, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  }
  assert.equal(requests.length, 10);
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
