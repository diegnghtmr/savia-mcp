import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const grant = "59fd5039-58ea-492a-8404-b02b50671c3a";
const subject = "94779f05-9dd8-410e-a478-a7666e04d664";
const primary = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...primary.publicKey.export({ format: "jwk" }), kid: "local-ec", alg: "ES256", use: "sig" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function jwt(issuer, audience, changes = {}, header = {}, key = primary.privateKey) {
  const payload = { iss: issuer, aud: audience, sub: subject, mcp_grant_id: grant, exp: now() + 600, ...changes };
  const input = `${encode({ alg: "ES256", kid: jwk.kid, ...header })}.${encode(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function loopback(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function issuer(t, reply = (_req, res) => res.end(JSON.stringify({ keys: [jwk] }))) {
  const requests = [];
  const base = await loopback(t, (req, res) => {
    if (req.url !== "/auth/v1/.well-known/jwks.json") return res.writeHead(404).end();
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    return reply(req, res);
  });
  return { url: `${base}/auth/v1`, requests };
}

function settings(issuerUrl, base = "http://127.0.0.1:9000") {
  return { JWT_ISSUER: issuerUrl, SAVIA_MCP_PROPOSAL_AUDIENCE: `${base}/mcp`, SAVIA_API_URL: base };
}

test("remote auth accepts only unambiguous same-origin upstream configuration", async () => {
  const { createRemoteAuth } = await import("../dist/remote-auth.js");
  const good = settings("http://127.0.0.1:9001/auth/v1");
  assert.equal(createRemoteAuth(good).resource.href, good.SAVIA_MCP_PROPOSAL_AUDIENCE);
  for (const bad of [
    { SAVIA_MCP_PROPOSAL_AUDIENCE: "" }, { SAVIA_MCP_PROPOSAL_AUDIENCE: "authenticated" },
    { SAVIA_MCP_PROPOSAL_AUDIENCE: "http://127.0.0.1:9000/mcp?" },
    { JWT_ISSUER: "" }, { JWT_ISSUER: "http://issuer.example/auth/v1" },
    { SAVIA_API_URL: "http://127.0.0.1:9002" }, { SAVIA_API_URL: "https://127.0.0.1:9000" },
    { SAVIA_API_URL: "http://user@127.0.0.1:9000" }, { SAVIA_API_URL: "http://127.0.0.1:9000/?a=b" },
    { SAVIA_API_URL: "http://127.0.0.1:9000/unrelated-api" },
  ]) assert.throws(() => createRemoteAuth({ ...good, ...bad }), { message: "Invalid Savia remote MCP configuration." });
});

test("remote auth verifies signed issuer, singleton audience, lifetime, subject and grant", async t => {
  const { createRemoteAuth } = await import("../dist/remote-auth.js");
  const fake = await issuer(t);
  const config = settings(fake.url), audience = config.SAVIA_MCP_PROPOSAL_AUDIENCE;
  const { verifyBearer } = createRemoteAuth(config);
  const token = jwt(fake.url, audience);
  assert.equal(await verifyBearer(`bEaReR ${token}`), token);
  const arrayAud = jwt(fake.url, [audience]);
  assert.equal(await verifyBearer(`Bearer ${arrayAud}`), arrayAud);
  for (const [label, wrong] of [
    ["missing", undefined], ["opaque", "Bearer svt_not_an_oauth_token"], ["wrong scheme", `Basic ${token}`],
    ["multiple", `Bearer ${token}, Bearer ${token}`], ["wrong signature", `Bearer ${jwt(fake.url, audience, {}, {}, other.privateKey)}`],
    ["wrong issuer", `Bearer ${jwt(`${fake.url}/other`, audience)}`], ["wrong aud", `Bearer ${jwt(fake.url, "authenticated")}`],
    ["multi aud", `Bearer ${jwt(fake.url, [audience, "authenticated"])}`],
    ...Object.entries({ exp: now() - 1, nbf: now() + 10, sub: "not-a-uuid", mcp_grant_id: "not-a-uuid" })
      .map(([field, value]) => [field, `Bearer ${jwt(fake.url, audience, { [field]: value })}`]),
    ...["exp", "sub", "mcp_grant_id"].map(field => [`missing ${field}`, `Bearer ${jwt(fake.url, audience, { [field]: undefined })}`]),
    ["wrong algorithm", `Bearer ${jwt(fake.url, audience, {}, { alg: "HS256" })}`],
    ["critical extension", `Bearer ${jwt(fake.url, audience, {}, { crit: ["custom"], custom: true })}`],
    ["unknown key", `Bearer ${jwt(fake.url, audience, {}, { kid: "other" })}`],
  ]) assert.equal(await verifyBearer(wrong), null, label);
  assert.deepEqual(fake.requests, [{ url: "/auth/v1/.well-known/jwks.json", authorization: undefined }]);
});

test("remote auth accepts RS256 only with the matching RSA verification key", async t => {
  const { createRemoteAuth } = await import("../dist/remote-auth.js");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaJwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "local-rsa", alg: "RS256" };
  const fake = await issuer(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk, rsaJwk] })));
  const config = settings(fake.url), { verifyBearer } = createRemoteAuth(config);
  const claims = encode({ iss: fake.url, aud: config.SAVIA_MCP_PROPOSAL_AUDIENCE,
    sub: subject, mcp_grant_id: grant, exp: now() + 600 });
  for (const kid of [rsaJwk.kid, jwk.kid]) {
    const input = `${encode({ alg: "RS256", kid })}.${claims}`;
    const token = `${input}.${sign("sha256", Buffer.from(input), rsa.privateKey).toString("base64url")}`;
    assert.equal(await verifyBearer(`Bearer ${token}`), kid === rsaJwk.kid ? token : null);
  }
});

test("remote auth fails closed on untrusted JWKS responses and never follows redirects", async t => {
  const { createRemoteAuth } = await import("../dist/remote-auth.js");
  let hits = 0;
  const redirect = await loopback(t, (_req, res) => { hits++; res.end(JSON.stringify({ keys: [jwk] })); });
  for (const reply of [
    (_req, res) => res.writeHead(302, { Location: redirect }).end(),
    (_req, res) => res.end(JSON.stringify({ keys: [jwk, jwk] })),
    (_req, res) => res.end(JSON.stringify({ keys: [{ ...jwk, use: "enc" }] })),
    (_req, res) => res.end("not JSON"),
  ]) {
    const fake = await issuer(t, reply);
    const config = settings(fake.url);
    const token = jwt(fake.url, config.SAVIA_MCP_PROPOSAL_AUDIENCE);
    assert.equal(await createRemoteAuth(config).verifyBearer(`Bearer ${token}`), null);
    assert.deepEqual(fake.requests, [{ url: "/auth/v1/.well-known/jwks.json", authorization: undefined }]);
  }
  assert.equal(hits, 0);
});

const accept = "application/json, text/event-stream";
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const pending = { id: grant, preview: { name: "Envelope" }, expiresAt: "2027-02-01T00:00:00Z", status: "pending" };
const toolError = text => ({ content: [{ type: "text", text }], isError: true });

async function remoteFixture(t, reply = (_req, res) => res.end('{}')) {
  const { createRemoteServer } = await import("../dist/remote.js");
  const fake = await issuer(t), api = [];
  let remote;
  // The public fake routes MCP and Savia API paths on one origin, like the reverse proxy.
  const base = await loopback(t, async (req, res) => {
    if (!req.url.startsWith("/v1/")) return remote.emit("request", req, res);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    api.push({ method: req.method, url: req.url, bearer: req.headers.authorization,
      workspace: req.headers["x-workspace-id"], key: req.headers["idempotency-key"], body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    reply(req, res);
  });
  const env = settings(fake.url, base);
  remote = createRemoteServer({ ...env, SAVIA_WORKSPACE_ID: subject, SAVIA_MCP_TOKEN: "never_use_stdio_env" });
  const audience = env.SAVIA_MCP_PROPOSAL_AUDIENCE;
  return { base, api, issuer: fake.url, audience, token: jwt(fake.url, audience), jwks: fake.requests };
}

function send(base, path, { method = "GET", authorization, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method, headers: { ...headers, Accept: accept,
      ...(authorization === undefined ? {} : { Authorization: authorization }), ...(body === undefined ? {} : { "Content-Type": "application/json" }) } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("remote HTTP publishes protected-resource metadata and challenges every unauthorized MCP method", async t => {
  const fake = await remoteFixture(t);
  const metadataPath = "/.well-known/oauth-protected-resource/mcp";
  const discovered = await send(fake.base, metadataPath);
  assert.equal(discovered.status, 200);
  assert.match(discovered.headers["content-type"], /^application\/json/u);
  assert.deepEqual(JSON.parse(discovered.text), { resource: fake.audience,
    authorization_servers: [fake.issuer], bearer_methods_supported: ["header"] });
  assert.equal((await send(fake.base, "/.well-known/oauth-protected-resource/other")).status, 404);
  const challenged = async (method, path, authorization, invalid) => {
    const result = await send(fake.base, path, { method, authorization,
      body: method === "POST" ? JSON.stringify(init) : undefined, headers: { "X-Mcp-Grant-Id": grant } });
    assert.equal(result.status, 401);
    assert.equal(result.headers["www-authenticate"], `Bearer resource_metadata="${fake.base}${metadataPath}"${invalid ? ', error="invalid_token"' : ''}`);
    assert.deepEqual(JSON.parse(result.text), { error: "Unauthorized" });
  };
  for (const method of ["GET", "POST", "DELETE"]) await challenged(method, "/mcp", undefined, false);
  await challenged("POST", `/mcp?access_token=${fake.token}`, undefined, false);
  for (const bearer of ["opaque", jwt(fake.issuer, fake.audience, {}, {}, other.privateKey),
    jwt(fake.issuer, fake.audience, { exp: now() - 1 }), jwt(fake.issuer, "authenticated"),
    jwt(fake.issuer, fake.audience, { mcp_grant_id: undefined }), jwt(fake.issuer, fake.audience, { mcp_grant_id: "invalid" })])
    await challenged("POST", "/mcp", `Bearer ${bearer}`, true);
  assert.deepEqual(fake.api, []);
  assert.deepEqual(fake.jwks, [{ url: "/auth/v1/.well-known/jwks.json", authorization: undefined }]);
});

test("remote HTTP uses SDK streaming HTTP with request-local bearer and no direct write", async t => {
  const fake = await remoteFixture(t, (req, res) => req.url === "/v1/mcp/proposals"
    ? res.writeHead(201).end(JSON.stringify(pending)) : res.end(JSON.stringify({ ok: true, echo: req.headers.authorization })));
  const secondToken = jwt(fake.issuer, fake.audience, { mcp_grant_id: subject });
  const connect = async token => {
    const client = new Client({ name: "savia-http-test", version: "1" });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(fake.audience),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const [first, second] = await Promise.all([connect(fake.token), connect(secondToken)]);
  const { tools } = await first.listTools();
  assert.equal(tools.length, 29);
  assert.ok(tools.some(tool => tool.name === "get_debt_projection"));
  assert.deepEqual(await first.callTool({ name: "list_accounts" }), { content: [{ type: "text", text: '{"ok":true,"echo":"Bearer [redacted]"}' }] });
  const body = { name: "Envelope", type: "cash", currency: "USD" };
  const key = "f532b1d5-1952-4eb8-8cd1-9a150bff2a06";
  assert.deepEqual(await second.callTool({ name: "create_account", arguments: { body, idempotencyKey: key } }),
    { content: [{ type: "text", text: JSON.stringify(pending) }] });
  assert.deepEqual(fake.api, [
    { method: "GET", url: "/v1/accounts", bearer: `Bearer ${fake.token}`, workspace: subject, key: undefined, body: "" },
    { method: "POST", url: "/v1/mcp/proposals", bearer: `Bearer ${secondToken}`, workspace: subject, key,
      body: JSON.stringify({ toolName: "create_account", arguments: body }) },
  ]);
});

test("remote HTTP suppresses upstream 401/403 bodies and refuses untrusted browser origins", async t => {
  const fake = await remoteFixture(t, (req, res) => res.writeHead(req.url === "/v1/accounts" ? 401 : 403,
    { "Content-Type": "application/problem+json" }).end(JSON.stringify({ title: "must not echo", detail: req.headers.authorization })));
  const authorization = `Bearer ${fake.token}`;
  const origin = await send(fake.base, "/mcp", { method: "POST", authorization, body: JSON.stringify(init), headers: { Origin: "http://untrusted.example" } });
  assert.equal(origin.status, 403);
  const get = await send(fake.base, "/mcp", { authorization });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  const tooLarge = await send(fake.base, "/mcp", { method: "POST", authorization, body: JSON.stringify("x".repeat(1_048_576)) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(fake.api, []);
  const client = new Client({ name: "savia-http-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(fake.audience), { requestInit: { headers: { Authorization: authorization } } }));
  assert.deepEqual(await client.callTool({ name: "list_accounts" }), toolError("Savia API 401."));
  assert.deepEqual(await client.callTool({ name: "get_debt_projection", arguments: { debtId: grant } }), toolError("Savia API 403."));
  assert.deepEqual(fake.api.map(row => row.url), ["/v1/accounts", `/v1/debts/${grant}/projection`]);
});

test("remote HTTP executable refuses a different upstream origin before listening", () => {
  const env = { ...process.env, ...settings("http://127.0.0.1:9001/auth/v1"), SAVIA_MCP_TOKEN: "must_not_log",
    SAVIA_API_URL: "http://127.0.0.1:9002" };
  const child = spawnSync(process.execPath, ["dist/remote.js"], { cwd: new URL("../", import.meta.url), encoding: "utf8", env, timeout: 3000 });
  assert.deepEqual([child.status, child.stdout, child.stderr], [1, "", "Invalid Savia remote MCP configuration.\n"]);
});
