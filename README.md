# Savia MCP

Local stdio server with 25 tools generated from the Savia OpenAPI authority. The
12 read-class tools can call the Savia API, including three POST operations the
contract classifies as reads. The other 13 are listed but cannot execute until
approval support lands. `get_debt_projection` from the PRD has no OpenAPI
operation yet and is not exposed. Remote transport and OAuth are not implemented here.

Build with `pnpm build` and start with `node dist/server.js`. Read calls use:

- `SAVIA_API_URL`: HTTPS base URL; HTTP is allowed only for loopback hosts.
- `SAVIA_MCP_TOKEN`: bearer credential from the environment, never a tool argument.
- `SAVIA_WORKSPACE_ID`: default workspace UUID. A tool's `workspaceId` takes precedence.

Tool arguments expose path and query parameters at the top level and JSON
request payloads under `body`. For operations requiring an idempotency key,
pass `idempotencyKey` or let the server generate one. Requests do not follow
redirects and have a 2-second deadline and a 1 MiB response limit.

Run `pnpm test` and `pnpm run audit:static`. The protocol tests use a loopback
fake API. The manifest check is skipped in a standalone checkout with no Savia
authorities; opt in with `SAVIA_OPENAPI_PATH` and `SAVIA_PRD_PATH`. Regenerate
with `pnpm tools:generate`. The Node script reads `../../docs/savia-openapi.json`,
the JSON twin regenerated alongside the authoritative YAML, and refuses to run
when the YAML's `x-savia-mcp-tool` annotations disagree with the twin. Use
`--openapi`, `--yaml` and `--prd` to override paths, or `--check` to report gaps
and verify without writing.

Argument validation rejects undeclared properties (including an own `__proto__`
key), counts string lengths in Unicode characters as OpenAPI does, and exposes
the optional `If-Match` header as `ifMatch`.

The process exits 0 on EOF, 130 on SIGINT, and 143 on SIGTERM.
