# packages/mcp-debug — Agent Learnings

## Package Info

- **Package name**: `@koredotcom/agents-mcp-tools` (NOT `@abl/mcp-debug`)
- **Build**: `tsc` (standard TypeScript compilation)
- **Test**: `vitest` — tests in `src/__tests__/`

## Gotchas

- The npm package name is `@koredotcom/agents-mcp-tools`, not what the directory name suggests. Use this for `pnpm build --filter=`.
- `fetchWithTimeout` default is 5s — fine for health checks, but too aggressive for auth endpoints on remote servers. Always pass explicit timeouts for auth/token calls (15s recommended).
- `deriveStudioUrl()` in platform-projects.ts rewrites runtime URLs to Studio URLs for project CRUD. If the URL can't be parsed, it should return the original URL unchanged, not fall back to localhost.
- Studio API helpers must keep remote server URLs on the connected origin (for example `https://agents-dev.kore.ai`) and only rewrite explicit local runtime ports to `5173`.
- The `platform-projects.ts` file may be concurrently modified (schema additions). Re-read before editing.

## Patterns

- Auth cascade: explicit token -> stored credentials -> device auth (RFC 8628)
- `fetchWithTimeout(url, options, timeoutMs)` — third param is timeout in ms, defaults to 5000
- Tests mock `fetchWithTimeout` via `vi.mock('../utils/fetch.js')` — timeout parameter changes don't require test updates

## 2026-05-17 — Distributed MCP Must Stay Thin

**Category**: architecture
**Learning**: The MCP package is distributed outside the platform and must not depend on private workspace compiler/import packages for ABL package diagnostics. Put compiler-backed validation, design linting, transcript diagnosis, and compiler-model introspection behind Studio API endpoints, then keep MCP tools as path/file-map readers plus HTTP wrappers.
**Files**: `src/tools/platform-validate-package.ts`, `src/tools/platform-package-model.ts`, `src/tools/debug-lint-abl.ts`, `src/tools/debug-why-transcript-failed.ts`, `src/utils/package-files.ts`, `src/utils/studio-api.ts`
**Impact**: Future MCP diagnostics should prefer server-owned endpoints and include clear 404 hints for old platform versions. The MCP layer should help operators loop over traces, eval output, and ABL patches without reimplementing compiler/design-analysis logic client-side. Do not import `@abl/compiler`, `@abl/core`, or `@agent-platform/project-io` into this package just to mirror platform behavior.
