# Savia MCP

Local stdio server with 28 tools generated from the pinned Savia OpenAPI authority
(`9785033`): 14 reads, including `get_debt_projection` and `get_sinking_fund`
(`budgets:read`), and 14 approval-gated tools. Both transports call the same
annotated read endpoints, including three POST operations classified as reads.
Approval-gated tools only submit `POST /v1/mcp/proposals`; they never call a
direct write route or confirm an approval. The result includes the backend's
pending approval ID, preview, expiry and status. Review and confirm in Savia web
or mobile. The integrated backend does not yet execute proposals for
`update_sinking_fund` or `withdraw_from_fund`; both remain advertised while
backend support is in progress.

The generator deliberately excludes `scan_receipt`, so neither local stdio nor
remote Streamable HTTP advertises it. OpenAPI defines it as a multipart upload,
but the JSON proposal contract has no way to represent the file and a storage
upload cannot be rolled back with approval execution. The backend rejects these
proposals until the contract defines a staged upload reference and its storage
lifecycle.

## Local stdio

Build with `pnpm build` and start with `node dist/server.js`. Calls use:

- `SAVIA_API_URL`: HTTPS base URL; HTTP is allowed only for loopback hosts.
- `SAVIA_MCP_TOKEN`: bearer credential from the environment, never a tool argument.
  Proposals require a grant-bound OAuth credential accepted by the Savia API.
  The stdio process does not obtain tokens.
- `SAVIA_WORKSPACE_ID`: default workspace UUID. A tool's `workspaceId` takes precedence.

Tool arguments expose path and query parameters at the top level and JSON
request payloads under `body`. Advertised schemas mark required OpenAPI headers
as required, including `ifMatch` for `update_sinking_fund`. For compatibility,
stdio calls may omit `workspaceId` when `SAVIA_WORKSPACE_ID` supplies it, and may
omit `idempotencyKey` to generate a fresh UUID. To safely retry the same request,
pass and reuse your own UUID; omitting the key on a second call creates a new
idempotency key. Where supported, pass the resource's quoted ETag as `ifMatch`.
Budget and transaction mutation proposals need it even though their direct
OpenAPI operations mark it optional. In `update_transaction`, set
`body.extraordinary` to `true` or `false` to set or clear manual extraordinary
classification; omit it to leave classification unchanged. Requests do not follow
redirects and have a 2-second deadline and a 1 MiB response limit.

## Remote Streamable HTTP

After `pnpm build`, run `node dist/remote.js`. It listens on `127.0.0.1` (port
`SAVIA_MCP_PORT`, default `3000`). In a non-loopback setup use a TLS reverse
proxy that preserves `Host`, routes the MCP path and its path-specific
`/.well-known/oauth-protected-resource` endpoint here, and routes Savia API
requests to the backend **on the same public origin and OAuth resource**.

- `SAVIA_MCP_PROPOSAL_AUDIENCE`: exact canonical MCP URL (for example
  `https://savia.example/mcp`), also used as the metadata `resource` and token
  audience. Clients request it as their OAuth resource.
- `JWT_ISSUER`: trusted authorization server URL (Supabase Auth uses an
  `/auth/v1` suffix). The server validates ES256 or RS256 bearer JWTs against
  `<issuer>/.well-known/jwks.json`; key sets are cached for up to 60 seconds.
- `SAVIA_API_URL`: the bare origin serving that resource's Savia `/v1` routes,
  such as `https://savia.example`. A different origin or base path is rejected at
  startup. Use HTTPS except with loopback fakes. Remote requests never use
  `SAVIA_MCP_TOKEN` as a fallback.
- `SAVIA_WORKSPACE_ID`: optional default workspace UUID, as in stdio.

The endpoint uses stateless Streamable HTTP with JSON POST responses and no
standalone SSE stream or session deletion. Requests without an acceptable
bearer receive `401` and a `WWW-Authenticate` challenge linking to metadata.
Tokens must have the expected issuer and sole audience, a valid expiry, and
signed UUID `sub` and `mcp_grant_id` claims. The bearer is forwarded only to
Savia and is never logged. All 14 read routes in `9785033` accept `mcpOAuth`
with the tool's required scopes. The integrated backend checks the live grant,
including ownership, revocation, and tool access. If the upstream rejects a read
or proposal with `401` or `403`, the remote tool error shows only the status.
Tests use local issuer/JWKS and API fakes; real Supabase OAuth compatibility
has not been verified.

## Verification and regeneration

Run `pnpm build`, `pnpm test` and `pnpm run audit:static`. The tool-call tests
use loopback fakes. From this repository, regenerate the pinned manifest with:

```sh
pnpm tools:generate --authority ../../odd/authority/savia-openapi-9785033.yaml
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
