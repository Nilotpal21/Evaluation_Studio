# Arch AI Integrations — E2E Specs (ABLP-162)

Real Playwright E2E specs for the Arch overlay integration-setup flow. Per the
project E2E standards, these tests:

- Do **not** mock platform components (`@agent-platform/*`, `@abl/*`, or
  relative imports). External services (mock OAuth provider, mock REST
  endpoint, mock MCP server) are mocked only via fixtures that boot real
  servers on random ports.
- Drive the flow through the real Studio UI and hit real runtime / Mongo /
  Redis.
- Use `data-testid` / `data-widget` selectors that the Arch overlay should
  expose.

## Phase 6 Status (ABLP-162)

**Scaffolds landed; fixture work tracked separately.**

Each spec is committed with the full test body but is currently guarded by
`test.skip(true, 'TODO(ABLP-162): ...')` until the supporting fixtures land.
The spec files compile and parse cleanly, so they don't break the rest of the
suite. Lifting the skip is the first action item once the fixtures below
exist.

## Specs

| File                   | Scenario                                                                                                                                                        | Missing fixtures                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `saas-oauth.spec.ts`   | S1 — Full Slack OAuth flow: SecretInput → OAuthLaunch → SingleSelect → DiffCard → test pass → Integration tab complete card                                     | `mock-oauth-provider.ts`, `integration-project.ts`, arch overlay testids                                   |
| `rest-api.spec.ts`     | S5 — Paste cURL → bearer auth → tool created → wired → tested                                                                                                   | `mock-rest-endpoint.ts`, `integration-project.ts`, `CurlPasteWidget` testids                               |
| `mcp-server.spec.ts`   | S7 — Configure MCP server → tools imported → wired. **Critical:** new agent session sees server within seconds (not 5 minutes), proving cache invalidation hook | `mock-mcp-server.ts`, `integration-project.ts`, `McpServerForm` / `ToolMultiSelect` testids                |
| `revalidate.spec.ts`   | S3 — Park integration at `needs_input`, edit auth profile via Connections, return to Arch, click Resume, verify revalidate output                               | `integration-project.ts`, `mock-oauth-provider.ts`, Connections page testids                               |
| `suggestion.spec.ts`   | S2 — Agent with unbound TOOLS → overlay shows `IntegrationSuggestionCard` → click provider → `start_integration` prefill triggers                               | `integration-project.ts` (unbound-TOOLS seeding), `IntegrationSuggestionCard` testids                      |
| `collision.spec.ts`    | Multi-user shared-profile collision: user A creates "Slack OAuth App" shared, user B tries same name → `PROFILE_NAME_COLLISION` recovery widget reuse-or-rename | `shared-tenant.ts` (two users one tenant), `mock-oauth-provider.ts`, recovery widget testids               |
| `sanitization.spec.ts` | Force tool-test failure with credentialled URL → assert chat message redacts URL credentials and stack frames                                                   | `mock-rest-endpoint.ts` with failure-mode injection, `[data-result=fail]` + `[data-error-message]` testids |

## Required fixture work (separate tickets)

1. `apps/studio/e2e/fixtures/mock-oauth-provider.ts` — start/stop helper for a
   mock OAuth 2 provider that auto-grants consent. Boots a real HTTP server on
   `port: 0`. Used by S1, S3, collision.
2. `apps/studio/e2e/fixtures/mock-rest-endpoint.ts` — bearer-protected echo
   server with configurable failure modes (unreachable, 401, 500, timeout).
   Used by S5, sanitization.
3. `apps/studio/e2e/fixtures/mock-mcp-server.ts` — minimal MCP server exposing
   2-3 sample tools. Used by S7.
4. `apps/studio/e2e/fixtures/integration-project.ts` — seeds a project + an
   agent with declared TOOLS (optionally unbound) so each spec starts from a
   known state without poking Mongo directly.
5. `apps/studio/e2e/fixtures/shared-tenant.ts` — provisions two users in the
   same tenant. Used by `collision.spec.ts`.
6. **Studio UI changes** — wire up the testids/widget attributes referenced by
   the specs:
   - `data-testid` on overlay controls: `arch-toggle`, `arch-input`, `arch-send`,
     `arch-close`, `connections-nav`, `auth-profile-client-secret`,
     `auth-profile-save`, `toast-success`.
   - `data-widget` on each integration widget: `SecretInput`, `OAuthLaunch`,
     `SingleSelect`, `DiffCard`, `CurlPasteWidget`, `McpServerForm`,
     `ToolMultiSelect`, `IntegrationSuggestionCard`,
     `ProfileNameCollisionRecovery`.
   - `data-tab="integration"`, `data-draft-status`, `data-pill`, `data-result`,
     `data-revalidate-output`, `data-error-message`, `data-auth-profile-name`.

## Running

Once a spec's fixtures land, remove the `test.skip(true, ...)` line at the top
of the file and run:

```bash
cd apps/studio
pnpm exec playwright test e2e/arch-ai-integrations/saas-oauth.spec.ts
```

The full suite:

```bash
pnpm exec playwright test e2e/arch-ai-integrations/
```
