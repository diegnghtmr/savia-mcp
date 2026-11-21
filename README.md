# Savia MCP

Local stdio server with 22 tools generated from the Savia OpenAPI authority. The
10 read-class tools can call the Savia API, including three POST operations the
contract classifies as reads. The other 12 are listed but cannot execute until
approval support lands. Remote transport and OAuth are not implemented here.

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
the JSON twin regenerated alongside the authoritative YAML. Use `--openapi`
and `--prd` to override paths, or `--check` to report gaps and verify without writing.

The process exits 0 on EOF, 130 on SIGINT, and 143 on SIGTERM.
