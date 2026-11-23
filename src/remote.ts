import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Implementation } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteAuth } from "./remote-auth.js";
import { callTool, hasPrototypeKey, listTools } from "./tools.js";

const MAX_REQUEST_BYTES = 1_048_576;
const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Implementation;
const implementation = { name, version };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
}

export function createRemoteServer(env: Readonly<Record<string, string | undefined>> = process.env) {
  const { resource, issuer, upstream, verifyBearer } = createRemoteAuth(env);
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;
  const metadataUrl = new URL(metadataPath, resource).href;
  const metadata = { resource: resource.href, authorization_servers: [issuer.href], bearer_methods_supported: ["header"] };
  const workspace = env.SAVIA_WORKSPACE_ID;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path] = req.url?.split("?", 1) ?? [];
    const origin = req.headers.origin;
    if (req.headers.host?.toLowerCase() !== resource.host.toLowerCase() || (origin !== undefined && origin !== resource.origin))
      return json(res, 403, { error: "Forbidden" });
    if (path === metadataPath && req.method === "GET") return json(res, 200, metadata);
    if (path !== resource.pathname) return json(res, 404, { error: "Not found" });

    const authorization = req.headersDistinct.authorization;
    const token = await verifyBearer(authorization?.length === 1 ? authorization[0] : undefined);
    if (!token) {
      const challenge = `Bearer resource_metadata="${metadataUrl}"${authorization ? ', error="invalid_token"' : ""}`;
      return json(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": challenge });
    }
    // Stateless Streamable HTTP uses JSON POST responses and offers no GET SSE or DELETE session.
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    const wantBody = Number(req.headers["content-length"] ?? 0);
    const body = wantBody > MAX_REQUEST_BYTES ? null : await readBody(req);
    if (body === null) {
      req.resume();
      return json(res, 413, { error: "Request too large" }, { Connection: "close" });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (hasPrototypeKey(parsed))
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

    // Use the SDK's Web Standard transport directly, without the Node/Hono adapter.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const protocol = new Server(implementation, { capabilities: { tools: {} } });
    protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools }));
    protocol.setRequestHandler(CallToolRequestSchema, request =>
      callTool(request.params.name, request.params.arguments ?? {}, { token, upstream, workspace }));
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"] as const) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    try {
      await protocol.connect(transport);
      const response = await transport.handleRequest(new Request(resource, { method: "POST", headers, body }), { parsedBody: parsed });
      const bytes = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), "Cache-Control": "no-store" }).end(bytes);
    } finally { await protocol.close(); }
  }

  return createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent || res.destroyed) res.destroy();
      else json(res, 500, { error: "MCP request failed" });
    });
  });
}

if (import.meta.main) {
  try {
    const port = Number(process.env.SAVIA_MCP_PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error();
    createRemoteServer().once("error", () => {
      process.stderr.write("Could not start Savia remote MCP.\n");
      process.exitCode = 1;
    }).listen(port, "127.0.0.1");
  } catch {
    process.stderr.write("Invalid Savia remote MCP configuration.\n");
    process.exitCode = 1;
  }
}
