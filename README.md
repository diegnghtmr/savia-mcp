# Savia MCP

Local stdio protocol infrastructure only. It proves MCP connectivity and exposes no tools,
resources, prompts, finance behavior, authorization, backend integration, remote transport,
production-readiness claim, or completed Savia MCP product.

Use exact tools through Mise. Build with `pnpm build`; verify with `pnpm test`,
`pnpm audit:static`, the frozen/offline install, dependency allowlist, and Linux network trace.
The process exits 0 on EOF, 130 on SIGINT, and 143 on SIGTERM.
