import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { load as loadYaml } from "js-yaml";

const root = new URL("../", import.meta.url);
const authorityPath = process.env.SAVIA_OPENAPI_AUTHORITY ??
  fileURLToPath(new URL("../../odd/authority/savia-openapi-8f1ce12.yaml", root));
const pinnedDocument = process.env.SAVIA_OPENAPI_AUTHORITY !== undefined || existsSync(authorityPath)
  ? loadYaml(readFileSync(authorityPath, "utf8")) : null;
const report = "PRD tools missing from OpenAPI: none\n";
const workspace = "59fd5039-58ea-492a-8404-b02b50671c3a", override = "fac2d19d-4273-4941-a7a2-c0eaebd321e6";
const id = "94779f05-9dd8-410e-a478-a7666e04d664", key = "f532b1d5-1952-4eb8-8cd1-9a150bff2a06";
const token = "test_fake_bearer_never_in_output";
const error = text => ({ isError: true, content: [{ type: "text", text }] });
const success = { content: [{ type: "text", text: '{"ok":true}' }] };
const budget = { name: "Budget", method: "cash_flow", periodStart: "2026-01-01", periodEnd: "2026-01-31" };

test("pinned catalog excludes scan_receipt without changing other tools", () => {
  const manifest = readFileSync(new URL("src/generated/tools.json", root));
  assert.equal(JSON.parse(manifest).some(tool => tool.name === "scan_receipt"), false);
  // The 8f1ce12 manifest with only the receipt record removed, including byte layout.
  assert.equal(createHash("sha256").update(manifest).digest("hex"),
    "ebbfb0192c61f1f4779d893469e388ff95ae870bcaf5dd59b0523557c33f5181");
});

test("pinned manifest exactly matches the selected OpenAPI YAML without a JSON twin", {
  skip: !pinnedDocument && "standalone checkout has no pinned Savia authority",
}, t => {
  const check = path => {
    const r = spawnSync(process.execPath, ["scripts/generate-tools.mjs", "--check", "--authority", path], { cwd: root, encoding: "utf8" });
    return [r.status, r.stdout, r.stderr];
  };
  assert.deepEqual(check(authorityPath), [0, report, ""]);
  const dir = mkdtempSync(join(tmpdir(), "savia-mcp-authority-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const alternate = join(dir, "savia-openapi.yaml");
  const edited = structuredClone(pinnedDocument);
  edited.paths["/v1/accounts"].get.summary += " (drift probe)";
  writeFileSync(alternate, JSON.stringify(edited)); // JSON is also valid YAML.
  assert.deepEqual(check(alternate), [1, report, "Pinned MCP manifest has drifted; run pnpm tools:generate.\n"]);
  const absent = join(dir, "absent.yaml");
  assert.deepEqual(check(absent), [1, "", `OpenAPI YAML file not found: ${absent}\n`]);
  assert.deepEqual(check(authorityPath), [0, report, ""]);
});

async function fixture(t, handle = (_req, res) => res.end('{"ok":true}'), settings = {}) {
  const requests = [], stderr = [];
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      workspace: req.headers["x-workspace-id"], key: req.headers["idempotency-key"], ifMatch: req.headers["if-match"],
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
  ["get_sinking_fund", { fundId: id }, "GET", `/v1/funds/${id}`],
  ["get_debt_projection", { debtId: id, strategy: "custom_extra", extraMonthlyPaymentMinor: "5000" },
    "GET", `/v1/debts/${id}/projection?strategy=custom_extra&extraMonthlyPaymentMinor=5000`],
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

test("advertised names, scopes, risks and required headers match the pinned authority except deferred scan_receipt", {
  skip: !pinnedDocument && "standalone checkout has no pinned Savia authority",
}, async t => {
  const { client, requests } = await fixture(t);
  const { tools } = await client.listTools();
  const expected = new Map();
  for (const item of Object.values(pinnedDocument.paths)) for (const operation of Object.values(item)) {
    const annotation = operation?.["x-savia-mcp-tool"];
    if (!annotation || annotation.name === "scan_receipt") continue;
    const parameters = new Map();
    for (const raw of [...item.parameters ?? [], ...operation.parameters ?? []]) {
      const parameter = raw.$ref ? pinnedDocument.components.parameters[raw.$ref.split("/").at(-1)] : raw;
      if (parameter.in === "header") parameters.set(parameter.name, parameter.required ?? false);
    }
    expected.set(annotation.name, { annotation, parameters });
  }
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...expected.keys()].sort());
  for (const { name, inputSchema, _meta } of tools) {
    const { annotation, parameters } = expected.get(name);
    assert.deepEqual(_meta, { "savia.app/riskClass": annotation.riskClass, "savia.app/requiresApproval": annotation.requiresApproval,
      "savia.app/requiredScopes": annotation.requiredScopes }, name);
    for (const [header, required] of parameters) {
      const arg = { "X-Workspace-Id": "workspaceId", "Idempotency-Key": "idempotencyKey", "If-Match": "ifMatch" }[header];
      assert.equal(inputSchema.properties[arg].type, "string", `${name}: ${header}`);
      assert.equal(inputSchema.required.includes(arg), required, `${name}: ${header}`);
    }
  }
  assert.deepEqual(requests, []);
});

test("sends the exact HTTP request for each read and preserves read-command defaults", async t => {
  const { client, call, requests } = await fixture(t);
  assert.deepEqual(client.getServerCapabilities(), { tools: {} });
  const { tools } = await client.listTools();
  const balance = tools.find(tool => tool.name === "get_account_balance");
  assert.equal(balance.description, "Get account balance");
  assert.deepEqual(balance.inputSchema.required.slice().sort(), ["accountId", "workspaceId"]);
  assert.deepEqual(balance.inputSchema.properties.accountId, { type: "string", format: "uuid" });
  assert.deepEqual(balance._meta, { "savia.app/riskClass": "read", "savia.app/requiresApproval": false,
    "savia.app/requiredScopes": ["accounts:read"] });
  assert.deepEqual(tools.find(tool => tool.name === "get_debt_projection")._meta,
    { "savia.app/riskClass": "read", "savia.app/requiresApproval": false, "savia.app/requiredScopes": ["budgets:read"] });
  for (const [name, args, method, url] of reads) {
    assert.deepEqual(await call(name, args), success, name);
    const request = requests.at(-1);
    assert.deepEqual(request, { method, url, authorization: `Bearer ${token}`,
      workspace: name === "list_workspaces" ? undefined : args.workspaceId ?? workspace,
      key: name === "run_scenario" ? request.key : args.idempotencyKey, ifMatch: undefined, contentType: args.body ? "application/json" : undefined,
      accept: "application/json, application/problem+json", body: args.body ? JSON.stringify(args.body) : "" }, name);
    if (name === "run_scenario") assert.match(request.key, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  }
  assert.equal(requests.length, reads.length);
});

test("unknown tools and invalid arguments never reach the API", async t => {
  const { call, requests } = await fixture(t);
  for (const name of ["not_a_tool", "confirm_approval"]) assert.deepEqual(await call(name), error("Unknown tool."));
  assert.deepEqual(await call("scan_receipt", { body: { file: "synthetic fixture" } }), error("Unknown tool."));
  for (const [name, args] of [
    ["get_account_balance", {}], ["get_account_balance", { accountId: "../other" }],
    ["list_accounts", { limit: 0 }], ["list_accounts", { limit: 201 }], ["list_accounts", { limit: "1" }],
    ["list_accounts", { status: "unknown" }], ["list_accounts", { workspaceId: "invalid" }],
    ["list_accounts", { authorization: token }], ["search_transactions", { query: "x".repeat(201) }],
    ["get_financial_summary", { from: "2026-02-30", to: "2026-03-01" }],
    ["create_forecast", {}], ["create_forecast", { body: { accountIds: [id, id] } }],
    ["run_report", { body: { format: "json" } }], ["run_report", { body: { preset: "expenses", definitionId: id, format: "json" } }],
    ["run_scenario", { scenarioId: id, idempotencyKey: "not-a-uuid" }],
    ["create_budget", { body: budget, idempotencyKey: "bad" }],
    ["update_sinking_fund", { fundId: id, body: { name: "Fund" } }],
    ["update_sinking_fund", { fundId: id, ifMatch: 7, body: { name: "Fund" } }],
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

const occurredAt = "2026-01-02T00:00:00Z";
const amount = { amountMinor: "25", currency: "USD" };
const proposals = [
  ["create_account", { body: { name: "Cash", type: "cash", currency: "USD" } }],
  ["create_transaction", { body: { accountId: id, type: "expense", amount, occurredAt } }],
  ["update_transaction", { transactionId: id, ifMatch: '"7"', body: { notes: "Updated" } }],
  ["void_transaction", { transactionId: id, ifMatch: '"7"', body: { reason: "Duplicate" } }],
  ["create_transfer", { body: { sourceAccountId: id, destinationAccountId: override, amount, occurredAt } }],
  ["create_cross_currency_transfer", { body: { sourceAccountId: id, destinationAccountId: override, sourceAmount: amount,
    destinationAmount: { ...amount, currency: "EUR" }, executedRate: "1", occurredAt } }],
  ["create_budget", { body: budget }],
  ["update_budget", { budgetId: id, ifMatch: '"7"', body: { name: "Updated" } }],
  ["update_budget_allocations", { budgetId: id, ifMatch: '"7"', body: { allocations: [] } }],
  ["create_sinking_fund", { body: { name: "Fund", currency: "USD", targetAmount: amount } }],
  ["contribute_to_fund", { fundId: id, body: { accountId: override, amount, occurredAt } }],
  ["create_report_definition", { body: { name: "Report", dimensions: ["category"], measures: ["sum"], visualization: "table" } }],
];

test("writes return pending proposals unchanged and never call a direct write or confirm", async t => {
  const pending = { id, preview: { action: "preview from API" }, expiresAt: occurredAt, status: "pending" };
  const { call, requests } = await fixture(t, (_req, res) => { res.writeHead(201); res.end(JSON.stringify(pending)); });
  for (const [name, args] of proposals) {
    const proposed = { content: [{ type: "text", text: JSON.stringify(pending) }] };
    assert.deepEqual(await call(name, { ...args, workspaceId: override, idempotencyKey: key }), proposed, name);
    const toolArgs = Object.keys(args).length === 1 ? args.body : args;
    assert.deepEqual(requests.at(-1), { method: "POST", url: "/v1/mcp/proposals", authorization: `Bearer ${token}`,
      workspace: override, key, ifMatch: undefined, contentType: "application/json", accept: "application/json, application/problem+json",
      body: JSON.stringify({ toolName: name, arguments: toolArgs }) }, name);
  }
  assert.equal(requests.length, proposals.length);
});

test("proposal callers can supply a replay key or receive a fresh default; backend rejections do not retry", async t => {
  const { call, requests } = await fixture(t, (_req, res) => {
    res.writeHead(422, { "Content-Type": "application/problem+json" });
    res.end('{"title":"Invalid MCP proposal tool or arguments"}');
  });
  const rejected = error("Savia API 422: Invalid MCP proposal tool or arguments");
  const fundEdit = { fundId: id, ifMatch: '"7"', body: { name: "New name" } };
  const withdrawal = { fundId: id, body: { accountId: override, amount, reason: "Goal reached" } };
  const calls = [
    ["update_sinking_fund", fundEdit, key], ["update_sinking_fund", fundEdit, key],
    ["withdraw_from_fund", withdrawal], ["withdraw_from_fund", withdrawal], ["withdraw_from_fund", withdrawal, key],
  ];
  for (const [index, [name, args, suppliedKey]] of calls.entries()) {
    assert.deepEqual(await call(name, suppliedKey ? { ...args, idempotencyKey: suppliedKey } : args), rejected, name);
    const sentKey = requests[index].key;
    if (!suppliedKey) assert.match(sentKey, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    assert.deepEqual(requests[index], { method: "POST", url: "/v1/mcp/proposals", authorization: `Bearer ${token}`,
      workspace, key: suppliedKey ?? sentKey, ifMatch: undefined, contentType: "application/json", accept: "application/json, application/problem+json",
      body: JSON.stringify({ toolName: name, arguments: args }) }, name);
  }
  assert.notEqual(requests[2].key, requests[3].key);
  assert.equal(requests.length, calls.length);
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
  skip: !pinnedDocument || !existsSync(new URL("../../docs/PRD - Savia.md", root)),
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
  delete env.SAVIA_OPENAPI_AUTHORITY;
  delete env.SAVIA_OPENAPI_PATH;
  delete env.SAVIA_OPENAPI_YAML_PATH;
  delete env.SAVIA_PRD_PATH;
  const check = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/generate-tools.mjs", "--check", ...args],
      { cwd, env, encoding: "utf8" });
    assert.deepEqual(readFileSync(pinned), original);
    return [result.status, result.stdout, result.stderr];
  };
  await t.test("skips absent default authorities in a standalone checkout", () => {
    assert.deepEqual(check(), [0, "", ""]);
  });
  const docs = join(dir, "docs");
  mkdirSync(docs);
  cpSync(new URL("../../docs/PRD - Savia.md", root), join(docs, "PRD - Savia.md"));
  writeFileSync(join(docs, "savia-openapi.json"), JSON.stringify(pinnedDocument));
  assert.deepEqual(check(), [0, report, ""], "a missing default YAML still allows checking the JSON manifest");
  const authority = join(docs, "savia-openapi.yaml");
  cpSync(authorityPath, authority);
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

test("gated success responses must match the approval schema and invalid bodies are not echoed", async t => {
  const valid = { id, preview: { details: { label: "untrusted-response-marker" } }, expiresAt: "2027-02-01T00:00:00+01:00", status: "pending" };
  const invalid = [
    ...Object.keys(valid).map(field => [`missing ${field}`, JSON.stringify({ ...valid, [field]: undefined })]),
    ["invalid UUID", JSON.stringify({ ...valid, id: "not-a-uuid" })],
    ["non-object preview", JSON.stringify({ ...valid, preview: [valid.preview] })],
    ["null preview", JSON.stringify({ ...valid, preview: null })],
    ["invalid date-time", JSON.stringify({ ...valid, expiresAt: "2027-02-30T00:00:00Z" })],
    ["non-pending status", JSON.stringify({ ...valid, status: "confirmed" })],
    ["extra property", JSON.stringify({ ...valid, extra: "untrusted-response-marker" })],
    ["own __proto__ property", JSON.stringify({ ...valid, ["__proto__"]: "untrusted-response-marker" })],
    ["non-object response", JSON.stringify([valid])],
    ["invalid JSON", "untrusted-response-marker"],
  ];
  let reply;
  const { call, requests } = await fixture(t, (_req, res) => res.writeHead(201).end(reply));
  const args = { idempotencyKey: key, body: { name: "Envelope", type: "cash", currency: "USD" } };
  for (const [label, text] of invalid) {
    reply = text;
    assert.deepEqual(await call("create_account", args), error("Savia API returned an invalid proposal approval."), label);
  }
  reply = JSON.stringify(valid);
  assert.deepEqual(await call("create_account", args), { content: [{ type: "text", text: reply }] });
  assert.deepEqual(requests.map(r => [r.method, r.url, r.key]),
    Array.from({ length: invalid.length + 1 }, () => ["POST", "/v1/mcp/proposals", key]));
});

// Reviewer regressions (verify mwtnbz4k). Append to generar/savia-mcp/test/tools.test.mjs.
test("S12/U5: no gated tool follows a direct-write or confirm redirect", async t => {
  const cases = [
    ...proposals,
    ["update_sinking_fund", { fundId: id, ifMatch: '"7"', body: { name: "Reserve" } }],
    ["withdraw_from_fund", { fundId: id, body: { accountId: override, amount, reason: "Goal reached" } }],
  ];
  let status, location;
  const { call, requests } = await fixture(t, (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/mcp/proposals") {
      return res.writeHead(500).end();
    }
    res.writeHead(status, { Location: location }).end();
  });
  for (const [code, target] of [
    [307, "/v1/transactions"],
    [308, `/v1/approvals/${id}/confirm`],
  ]) {
    status = code;
    location = target;
    for (const [name, args] of cases) {
      assert.deepEqual(await call(name, { ...args, idempotencyKey: key }),
        error("Savia API redirects are not allowed."), name);
    }
  }
  assert.deepEqual(requests.map(r => [r.method, r.url]),
    Array.from({ length: cases.length * 2 }, () => ["POST", "/v1/mcp/proposals"]));
});

test("S12/U5: a saved proposal can be replayed after the response is lost", async t => {
  const pending = { id, preview: { name: "Envelope" }, expiresAt: "2027-02-01T00:00:00Z", status: "pending" };
  const ledger = new Map();
  let loseResponse = true;
  const { call, requests } = await fixture(t, (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/mcp/proposals") return res.writeHead(500).end();
    const k = req.headers["idempotency-key"];
    if (!ledger.has(k)) ledger.set(k, pending);
    if (loseResponse) { loseResponse = false; return res.destroy(); }
    res.writeHead(201).end(JSON.stringify(ledger.get(k)));
  });
  const args = { idempotencyKey: key, body: { name: "Envelope", type: "cash", currency: "USD" } };
  assert.deepEqual(await call("create_account", args), error("Savia API request failed."));
  const stored = JSON.stringify([...ledger]);
  assert.deepEqual(await call("create_account", args),
    { content: [{ type: "text", text: JSON.stringify(pending) }] });
  assert.equal(JSON.stringify([...ledger]), stored);
  assert.equal(ledger.size, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual([requests[0].method, requests[0].url, requests[0].key],
    ["POST", "/v1/mcp/proposals", key]);
});

test("S12/U5: do not report a non-pending proposal response as a success", async t => {
  const { call, requests } = await fixture(t, (_req, res) =>
    res.writeHead(201).end('{"status":"confirmed"}'));
  const actual = await call("create_account", {
    idempotencyKey: key,
    body: { name: "Envelope", type: "cash", currency: "USD" },
  });
  assert.deepEqual(requests.map(r => [r.method, r.url]), [["POST", "/v1/mcp/proposals"]]);
  assert.equal(actual.isError, true, JSON.stringify(actual));
});

// Reviewer regression (verify mwtpt1qm). Append to test/tools.test.mjs.
test("S12/U5: proposal expiration requires RFC 3339 seconds", async t => {
  const { call } = await fixture(t, (_req, res) =>
    res.writeHead(201).end(JSON.stringify({
      id, preview: { marker: "must not echo" },
      expiresAt: "2027-02-01T00:00Z", status: "pending",
    })));
  assert.deepEqual(await call("create_account", {
    idempotencyKey: key, body: { name: "Envelope", type: "cash", currency: "USD" },
  }), error("Savia API returned an invalid proposal approval."));
});
