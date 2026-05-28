# Studio to Runtime Hidden Gap Closure Plan

## Goal

Close the remaining parity gaps where Studio, import/export, module contracts, deployment preflight, and runtime execution disagree about what a tool can resolve. The target contract is that every authoring or deploy-time "ready" signal is backed by the same scoped lookup semantics runtime uses during execution.

## Design Principles

- **Execution context must flow to all secret lookups.** Any runtime lookup for `{{secrets.*}}` or implicit auth fallback secrets must include the current tool name when the secret is tool-scoped.
- **Namespace-scoped config remains runtime-scoped.** Tool binding `{{config.*}}` references for namespace-scoped tools must not be globally baked at compile time.
- **Provisioning surfaces must name the right resource type.** `{{env.*}}` means environment variable; `{{secrets.*}}` means runtime ToolSecret/auth-profile secret, never an env-var substitute.
- **Implicit runtime dependencies are explicit contracts.** If runtime can require fallback auth secret keys, module contracts and deploy preflight must declare those keys.
- **Every scoped lookup carries tenant and project.** Namespace membership checks must include explicit `tenantId` and `projectId`, even when IDs are globally unique today.

## Implementation Slices

1. **OAuth/SearchAI secret context**
   - Add regression coverage proving OAuth2 client and SearchAI token lifecycle secret lookups include `{ toolName }`.
   - Thread tool context through OAuth/SearchAI placeholder resolution and fallback secret reads.

2. **Config namespace parity**
   - Add regression coverage proving namespace-scoped tool `{{config.*}}` placeholders are preserved through compile and resolved by runtime using namespace scope.
   - Add runtime `getConfigVar` placeholder resolution for HTTP/MCP tool execution.

3. **Export provisioning resource typing**
   - Add regression coverage proving export provisioning lists only `{{env.*}}` as required env vars.
   - Keep tool-scoped `{{secrets.*}}` out of env-var provisioning and leave non-tool secret placeholders as warnings/contract concerns.

4. **Implicit auth fallback contracts**
   - Add regression coverage proving `auth: api_key`, `auth: bearer`, OAuth2 client, and SearchAI implicit fallback keys become tool-scoped `requiredSecrets`.
   - Update module contract extraction so deploy preflight can block missing fallback secrets before first runtime call.

5. **Namespace membership isolation**
   - Add regression coverage for runtime env/config/auth-preflight namespace membership queries.
   - Include `tenantId` and `projectId` in every namespace membership lookup.

## Verification

- Run focused Vitest suites per slice before moving to the next slice.
- Build affected packages after implementation: compiler, project-io, runtime, and Studio where feasible.
- Run `npx prettier --write` on all touched files before final summary or commit.
