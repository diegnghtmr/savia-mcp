import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CallToolRequestSchema, ListToolsRequestSchema, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { callTool, listTools, toolError } from "./tools.js";

type Obj = Record<string, unknown>;
type Id = string | number | null;
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { name: string; version: string };
let phase: "new" | "initializing" | "ready" = "new";
let pending = Buffer.alloc(0), closing = false;
const active = new Set<Promise<void>>();
const object = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const id = (x: unknown): x is string | number => typeof x === "string" || Number.isInteger(x);
const send = (x: Obj): void => { process.stdout.write(`${JSON.stringify(x)}\n`); };
const fail = (requestId: Id, code: number, message: string): void =>
  send({ jsonrpc: "2.0", id: requestId, error: { code, message } });

function message(x: unknown): void {
  if (!object(x) || x.jsonrpc !== "2.0" || typeof x.method !== "string") return fail(null, -32600, "Invalid Request");
  const notice = x.id === undefined;
  if (!notice && !id(x.id)) return fail(null, -32600, "Invalid Request");
  const requestId = notice ? null : x.id as string | number;
  if (x.method === "ping") {
    if (x.params !== undefined && (!object(x.params) || Object.keys(x.params).length)) {
      if (!notice) fail(requestId, -32602, "Invalid params");
    } else if (!notice) send({ jsonrpc: "2.0", id: requestId, result: {} });
    return;
  }
  if (x.method === "initialize") {
    if (notice || phase !== "new") { if (!notice) fail(requestId, -32600, "Initialize allowed once"); return; }
    const p = x.params;
    if (!object(p) || typeof p.protocolVersion !== "string" || !object(p.capabilities) ||
        !object(p.clientInfo) || typeof p.clientInfo.name !== "string" || typeof p.clientInfo.version !== "string")
      return fail(requestId, -32602, "Invalid params");
    phase = "initializing";
    const version = SUPPORTED_PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : LATEST_PROTOCOL_VERSION;
    return send({ jsonrpc: "2.0", id: requestId, result: { protocolVersion: version, capabilities: { tools: {} },
      serverInfo: { name: metadata.name, version: metadata.version } } });
  }
  if (x.method === "notifications/initialized") {
    if (notice && phase === "initializing") phase = "ready";
    else if (!notice) fail(requestId, -32600, "Invalid lifecycle");
    return;
  }
  if (phase !== "ready") { if (!notice) fail(requestId, -32600, "Not initialized"); return; }
  if (notice) return;
  if (x.method === "tools/list") {
    if (!ListToolsRequestSchema.safeParse(x).success) return fail(requestId, -32602, "Invalid params");
    return send({ jsonrpc: "2.0", id: requestId, result: { tools: listTools } });
  }
  if (x.method === "tools/call") {
    const request = CallToolRequestSchema.safeParse(x);
    if (!request.success) return fail(requestId, -32602, "Invalid params");
    const respond = (result: unknown) => { if (!closing) send({ jsonrpc: "2.0", id: requestId, result }); };
    const task = callTool(request.data.params.name, request.data.params.arguments ?? {})
      .then(respond, () => respond(toolError("Tool execution failed.")));
    active.add(task);
    void task.finally(() => active.delete(task));
    return;
  }
  fail(requestId, -32601, "Method not found");
}

function consume(): void {
  for (let at; (at = pending.indexOf(10)) >= 0;) {
    const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
    if (!line.length) continue;
    try { message(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown); }
    catch { fail(null, -32700, "Parse error"); }
  }
}
async function close(code: number): Promise<never | void> {
  if (closing) return; closing = true; process.stdin.pause(); pending = Buffer.alloc(0);
  await new Promise<void>((ok, no) => process.stdout.write("", e => e ? no(e) : ok())); process.exit(code);
}
process.stdin.on("data", (x: Buffer) => { pending = Buffer.concat([pending, x]); consume(); });
process.stdin.on("end", () => { void Promise.allSettled(active).then(() => close(0)); });
process.on("SIGINT", () => void close(130));
process.on("SIGTERM", () => void close(143));
