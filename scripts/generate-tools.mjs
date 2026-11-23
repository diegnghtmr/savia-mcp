import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { load as loadYaml } from "js-yaml";

const root = resolve(import.meta.dirname, "..");
const docs = resolve(root, "../../docs");
const manifest = resolve(root, "src/generated/tools.json");
const methods = "get post put patch delete head options trace".split(" ");

function dereference(node, document, refs = []) {
  if (Array.isArray(node)) return node.map(item => dereference(item, document, refs));
  if (node === null || typeof node !== "object") return node;
  const { $ref: reference, ...rest } = node;
  const fields = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, dereference(value, document, refs)]));
  if (reference === undefined) return fields;
  if (!reference.startsWith("#/") || refs.includes(reference)) throw Error(`Non-local or circular tool reference: ${reference}`);
  const target = reference.slice(2).split("/").reduce((item, part) => {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!item || !Object.hasOwn(item, key)) throw Error(`Unresolved tool reference: ${reference}`);
    return item[key];
  }, document);
  return { ...dereference(target, document, [...refs, reference]), ...fields };
}

function* toolOperations(document) {
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (operation && Object.hasOwn(operation, "x-savia-mcp-tool")) {
        yield { path, method, item, operation, annotation: operation["x-savia-mcp-tool"] };
      }
    }
  }
}

function generate(document) {
  const tools = new Map();
  for (const { path, method, item, operation, annotation } of toolOperations(document)) {
    if (!annotation) continue;
    const { name, riskClass, requiresApproval, requiredScopes } = annotation;
    if (tools.has(name)) throw Error(`Duplicate MCP tool: ${name}`);
    const parameters = new Map();
    for (const source of [item, operation]) {
      for (const raw of source.parameters ?? []) {
        const param = dereference(raw, document);
        parameters.set(`${param.in}:${param.name}`, param);
      }
    }
    const request = dereference(operation.requestBody, document);
    tools.set(name, { name, description: operation.summary, method: method.toUpperCase(), path,
      parameters: [...parameters.values()], requestSchema: request ? (request.content["application/json"] ?? Object.values(request.content)[0])?.schema ?? null : null,
      requestRequired: Boolean(request?.required), riskClass, requiresApproval, requiredScopes });
  }
  return tools;
}

function annotationsByOperation(document) {
  return new Map([...toolOperations(document)].map(({ method, path, annotation }) => [`${method} ${path}`, annotation]));
}

function assertTwinMatchesYaml(document, yamlPath) {
  const yaml = loadYaml(readFileSync(yamlPath, "utf8"));
  if (!isDeepStrictEqual(annotationsByOperation(yaml), annotationsByOperation(document))) {
    throw Error("OpenAPI YAML and JSON twin disagree on x-savia-mcp-tool annotations; regenerate the JSON twin.");
  }
}

// Preserve the pinned layout: one record per line, with spaces after structural separators.
function encode(value) {
  if (Array.isArray(value)) return `[${value.map(encode).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}: ${encode(field)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function main() {
  const { values } = parseArgs({ options: {
    authority: { type: "string" },
    openapi: { type: "string" },
    yaml: { type: "string" },
    prd: { type: "string", default: process.env.SAVIA_PRD_PATH ?? resolve(docs, "PRD - Savia.md") },
    check: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: pnpm tools:generate [--authority <OpenAPI YAML> | [--openapi <OpenAPI JSON>] [--yaml <OpenAPI YAML>]] [--prd <PRD Markdown>] [--check]\n" +
      "Generate the pinned manifest or check it without writing. Reports PRD tools missing from OpenAPI.\n" +
      "With --authority (or SAVIA_OPENAPI_AUTHORITY), use that YAML directly without the JSON twin.\n" +
      "Explicit OpenAPI paths must exist. With no overrides, --check skips when both default OpenAPI files are absent.");
    return;
  }
  const authorityPath = values.authority ?? process.env.SAVIA_OPENAPI_AUTHORITY;
  const openapiOverride = values.openapi ?? process.env.SAVIA_OPENAPI_PATH;
  const yamlOverride = values.yaml ?? process.env.SAVIA_OPENAPI_YAML_PATH;
  const openapiPath = openapiOverride ?? resolve(docs, "savia-openapi.json");
  const yamlPath = yamlOverride ?? resolve(docs, "savia-openapi.yaml");
  let document;
  try {
    if (authorityPath !== undefined) {
      if (!existsSync(authorityPath)) throw Error(`OpenAPI YAML file not found: ${authorityPath}`);
      document = loadYaml(readFileSync(authorityPath, "utf8"));
    } else {
      const hasJson = existsSync(openapiPath);
      const hasYaml = existsSync(yamlPath);
      if (values.check && openapiOverride === undefined && yamlOverride === undefined && !hasJson && !hasYaml) return;
      if (!hasYaml && yamlOverride !== undefined) throw Error(`OpenAPI YAML file not found: ${yamlPath}`);
      if (!hasJson) throw Error(`OpenAPI JSON file not found: ${openapiPath}`);
      document = JSON.parse(readFileSync(openapiPath, "utf8"));
      if (hasYaml) assertTwinMatchesYaml(document, yamlPath);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const tools = generate(document);
  const [, section] = readFileSync(values.prd, "utf8").split("FR-MCP-001 — Herramientas", 2);
  const expected = new Set(section?.split("FR-MCP-002", 1)[0].match(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/gm));
  if (!expected.size) throw Error("FR-MCP-001 contains no tool names");
  const missing = [...expected].filter(name => !tools.has(name)).sort();
  console.log(`PRD tools missing from OpenAPI: ${missing.join(", ") || "none"}`);
  const pinned = Buffer.from(`[\n${[...tools.keys()].sort().map(name => `  ${encode(tools.get(name))}`).join(",\n")}\n]\n`);
  if (values.check) {
    if (!existsSync(manifest) || !pinned.equals(readFileSync(manifest))) {
      console.error("Pinned MCP manifest has drifted; run pnpm tools:generate.");
      process.exitCode = 1;
    }
  } else {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, pinned);
  }
}

main();
