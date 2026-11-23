# Savia MCP

Local stdio server with 29 tools generated from the pinned Savia OpenAPI authority
(`8f1ce12`): 14 reads, including `get_debt_projection` (`budgets:read`), and 15
approval-gated tools. Read tools call their annotated endpoints, including three
POST operations classified as reads. Approval-gated tools only submit `POST
/v1/mcp/proposals`; they never call a direct write route or confirm an approval.
The result includes the backend's pending approval ID, preview, expiry and status.
Review and confirm in Savia web or mobile. The backend may reject proposals for
annotated tools it does not yet implement (including `scan_receipt`,
`update_sinking_fund`, and `withdraw_from_fund` in the U4 backend).

Build with `pnpm build` and start with `node dist/server.js`. Calls use:

- `SAVIA_API_URL`: HTTPS base URL; HTTP is allowed only for loopback hosts.
- `SAVIA_MCP_TOKEN`: bearer credential from the environment, never a tool argument.
  Proposals require a grant-bound OAuth credential accepted by the Savia API.
  This stdio server does not obtain tokens or implement remote transport.
- `SAVIA_WORKSPACE_ID`: default workspace UUID. A tool's `workspaceId` takes precedence.

Tool arguments expose path and query parameters at the top level and JSON
request payloads under `body`. Advertised schemas mark required OpenAPI headers
as required, including `ifMatch` for `update_sinking_fund`. For compatibility,
stdio calls may omit `workspaceId` when `SAVIA_WORKSPACE_ID` supplies it, and may
omit `idempotencyKey` to generate a fresh UUID. To safely retry the same request,
pass and reuse your own UUID; omitting the key on a second call creates a new
idempotency key. Where supported, pass the resource's quoted ETag as `ifMatch`.
U4 budget and transaction mutation proposals need it even though their direct
OpenAPI operations mark it optional. Requests do not follow redirects and have
a 2-second deadline and a 1 MiB response limit.

Run `pnpm build`, `pnpm test` and `pnpm run audit:static`. The tool-call tests
use a loopback fake API. From this repository, regenerate the pinned manifest
with:

```sh
pnpm tools:generate --authority ../../odd/authority/savia-openapi-8f1ce12.yaml
```

Add `--check` to verify it without writing. `SAVIA_OPENAPI_AUTHORITY` also selects
this YAML-only mode. Without a selected authority, the generator reads
`../../docs/savia-openapi.json` and, when YAML is present, compares the full
`x-savia-mcp-tool` annotations for each method and path. Comments and formatting
don't count as drift.

Use `--openapi`, `--yaml` and `--prd` to override paths (or set
`SAVIA_OPENAPI_PATH`, `SAVIA_OPENAPI_YAML_PATH` and `SAVIA_PRD_PATH`). An
explicit OpenAPI path that doesn't exist is an error and leaves the manifest
unchanged. Use `--check` to report gaps and verify without writing. With no
OpenAPI overrides, `--check` skips standalone checkouts where both default
OpenAPI files are absent. If only the default YAML is absent, it still checks
the manifest against the JSON twin.

Argument validation rejects undeclared properties (including an own `__proto__`
key) and counts string lengths in Unicode characters as OpenAPI does.

The process exits 0 on EOF, 130 on SIGINT, and 143 on SIGTERM.
