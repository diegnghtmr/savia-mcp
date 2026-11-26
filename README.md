# Savia MCP

Local stdio protocol infrastructure only. It proves MCP connectivity and exposes no tools,
resources, prompts, finance behavior, authorization, backend integration, remote transport,
production-readiness claim, or completed Savia MCP product.

The server handles initialization and ping as newline-delimited JSON-RPC over
standard input and output. It runs independently of the other Savia repositories.

## Repositories

- [savia-web](https://github.com/diegnghtmr/savia-web) — web app and account setup.
- [savia-mobile](https://github.com/diegnghtmr/savia-mobile) — Expo app shell.
- [savia-backend](https://github.com/diegnghtmr/savia-backend) — HTTP API and background worker.

## Stack

- Node.js 24.18.0 and pnpm 11.15.1, pinned in `.mise.toml`
- TypeScript 5.9.3 and `@modelcontextprotocol/sdk` 1.29.0

## Run locally

Use the exact tool versions through Mise. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/server.js
```

An MCP client launches `node dist/server.js` and communicates with it over stdio.
The process exits 0 on EOF, 130 on SIGINT, and 143 on SIGTERM.

## Tests

```sh
pnpm audit:static
pnpm test
```

Build first: the Linux protocol suite launches the compiled server and checks
its lifecycle, output streams, and cleanup. The repository also verifies a
frozen/offline install, a dependency allowlist, and a Linux network trace.

## Repository structure

| Path | Purpose |
| --- | --- |
| `src/server.ts` | JSON-RPC framing and MCP lifecycle |
| `test/protocol.test.mjs` | Process-level protocol suite |
| `scripts/audit.mjs` | Static boundary and documentation checks |

## License

MIT, see [LICENSE](LICENSE).
