import { randomUUID } from "node:crypto";
import { z } from "zod";
import pinned from "./generated/tools.json" with { type: "json" };

type Schema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;
type Parameter = { in: string; name: string; required?: boolean; schema: Schema; description?: string };
type Tool = { name: string; description: string; method: string; path: string; parameters: Parameter[];
  requestSchema: Schema | null; requestRequired: boolean; riskClass: string; requiresApproval: boolean; requiredScopes: string[] };
type Args = Record<string, unknown>;
const headersToArgs = new Map([["X-Workspace-Id", "workspaceId"], ["Idempotency-Key", "idempotencyKey"], ["If-Match", "ifMatch"]]);
const contextArguments = new Set(["workspaceId", "idempotencyKey"]);
const argumentName = (p: Parameter) => p.in === "header" ? headersToArgs.get(p.name) : p.name;
const result = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const toolError = (text: string) => ({ ...result(text), isError: true });

// Bridge the OpenAPI cases not fully handled by Zod's JSON Schema converter.
function validator(schema: Schema | boolean): z.ZodType {
  if (typeof schema === "boolean") return z.fromJSONSchema(schema);
  if (schema.type === "object" || (!schema.type && schema.required)) {
    const required = new Set(schema.required);
    const props = Object.entries(schema.properties ?? {}).map(([name, child]) => {
      const field = validator(child);
      return [name, required.delete(name) ? field : field.optional()];
    });
    const shape = Object.fromEntries([...props, ...Array.from(required, name => [name, z.json()])]);
    const base = schema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
    const branches = schema.oneOf?.map(validator);
    return branches ? base.refine(value => branches.filter(branch => branch.safeParse(value).success).length === 1) : base;
  }
  if (schema.format === "date-time") return z.iso.datetime({ offset: true });
  const { default: _default, minLength, maxLength, ...constraints } = schema;
  let base: z.ZodType = z.fromJSONSchema(constraints);
  // JSON Schema string lengths count Unicode code points, not UTF-16 code units.
  if (minLength !== undefined || maxLength !== undefined)
    base = base.refine(value => typeof value !== "string" ||
      (Array.from(value).length >= (minLength ?? 0) && Array.from(value).length <= (maxLength ?? Infinity)));
  return schema.uniqueItems ? base.refine(value => Array.isArray(value) && new Set(value).size === value.length) : base;
}

const catalog = new Map((pinned as Tool[]).map(tool => {
  const required: string[] = [];
  const properties: Record<string, Schema> = {};
  for (const param of tool.parameters) {
    const name = argumentName(param);
    if (!name) continue;
    properties[name] = param.description ? { ...param.schema, description: param.description } : param.schema;
    if (param.required) required.push(name);
  }
  if (tool.requestSchema) properties.body = tool.requestSchema;
  if (tool.requestRequired) required.push("body");
  const inputSchema = { type: "object" as const, properties, required, additionalProperties: false };
  const { name, description, riskClass, requiresApproval, requiredScopes } = tool;
  // The transport can supply workspace and idempotency defaults, never an ETag.
  const parse = validator({ ...inputSchema, required: required.filter(arg => !contextArguments.has(arg)) });
  const bodyOnly = tool.requestSchema !== null && Object.keys(properties).every(arg => arg === "body" || contextArguments.has(arg));
  return [name, { tool, parse, bodyOnly, advertised: { name, description, inputSchema,
    _meta: { "savia.app/riskClass": riskClass, "savia.app/requiresApproval": requiresApproval, "savia.app/requiredScopes": requiredScopes } } }];
}));
export const listTools = Array.from(catalog.values(), entry => entry.advertised);

function apiUrl(): URL | null {
  const url = URL.parse(process.env.SAVIA_API_URL ?? "");
  if (!url || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname;
  const loopback = host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url : null;
}

const MAX_BYTES = 1_048_576;
async function responseText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally { reader.releaseLock(); }
}

// Own "__proto__" keys survive JSON.parse but are invisible to object-shape validation.
export function hasPrototypeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrototypeKey);
  if (value === null || typeof value !== "object") return false;
  return Object.hasOwn(value, "__proto__") || Object.values(value).some(hasPrototypeKey);
}

const problem = z.object({ code: z.string().optional(), title: z.string().optional(), detail: z.string().optional() });
// The OpenAPI McpProposalApproval envelope is closed; only preview permits arbitrary fields.
const proposalApproval = z.strictObject({ id: z.uuid(), preview: z.looseObject({}),
  // Zod's ISO datetime also accepts minute precision; RFC 3339 requires seconds.
  expiresAt: z.iso.datetime({ offset: true }).refine(value => /T\d{2}:\d{2}:\d{2}/u.test(value)),
  status: z.literal("pending") });
const invalidApproval = "Savia API returned an invalid proposal approval.";
export async function callTool(name: string, args: Args) {
  const entry = catalog.get(name);
  if (!entry) return toolError("Unknown tool.");
  const proposal = entry.tool.requiresApproval;
  if (!proposal && entry.tool.riskClass !== "read") return toolError("Tool execution is unavailable.");
  if (hasPrototypeKey(args) || !entry.parse.safeParse(args).success) return toolError("Invalid tool arguments.");
  const url = apiUrl(), token = process.env.SAVIA_MCP_TOKEN;
  if (!url || !token || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) return toolError("Savia API configuration is invalid.");
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json, application/problem+json" });
  let path = entry.tool.path;
  for (const param of entry.tool.parameters) {
    const argument = argumentName(param);
    if (!argument) continue;
    const value = args[argument];
    if (param.name === "X-Workspace-Id" && param.in === "header") {
      const workspace = validator(param.schema).safeParse(value ?? process.env.SAVIA_WORKSPACE_ID);
      if (!workspace.success) return toolError("A valid workspaceId is required.");
      headers.set(param.name, String(workspace.data));
    } else if (param.name === "Idempotency-Key" && param.in === "header") {
      if (value !== undefined || param.required) headers.set(param.name, String(value ?? randomUUID()));
    } else if (proposal) {
      // Other inputs (including ifMatch) bind the proposal; they are not HTTP context.
      continue;
    } else if (param.in === "header" && value !== undefined) {
      headers.set(param.name, String(value));
    } else if (param.in === "path") path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    else if (param.in === "query" && value !== undefined) url.searchParams.set(param.name, String(value));
  }
  url.pathname = url.pathname.replace(/\/$/u, "") + (proposal ? "/v1/mcp/proposals" : path);
  const method = proposal ? "POST" : entry.tool.method;
  // The backend accepts flat arguments for body-only tools; targeted actions retain their
  // resource ID, body and ETag together in the immutable proposal arguments.
  const payload = proposal ? { toolName: name, arguments: entry.bodyOnly ? args.body :
    Object.fromEntries(Object.entries(args).filter(([arg]) => !contextArguments.has(arg))) } : args.body;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const signal = AbortSignal.timeout(2000);
  const redact = (text: string) => text.replaceAll(token, "[redacted]");
  try {
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal, redirect: "manual" });
    const isProblem = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json";
    if (response.status >= 300 && response.status < 400 || !response.ok && !isProblem) {
      await response.body?.cancel();
      return toolError(response.status < 400 ? "Savia API redirects are not allowed." : `Savia API ${response.status}.`);
    }
    const text = await responseText(response);
    if (text === null) return toolError("Savia API response is too large.");
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { return toolError(proposal && response.ok ? invalidApproval : "Savia API returned invalid JSON."); }
    if (response.ok) {
      // An own __proto__ key can bypass Zod's unknown-key check, but the envelope forbids it.
      if (proposal && (!proposalApproval.safeParse(data).success || Object.hasOwn(data as object, "__proto__")))
        return toolError(invalidApproval);
      return result(redact(JSON.stringify(data)));
    }
    const parsed = problem.safeParse(data);
    const { code, title, detail } = parsed.success ? parsed.data : {};
    return toolError(redact(`Savia API ${response.status}${code ? ` [${code}]` : ""}${title ? `: ${title}` : ""}${detail ? ` — ${detail}` : ""}`));
  } catch {
    return toolError(signal.aborted ? "Savia API request timed out." : "Savia API request failed.");
  }
}
