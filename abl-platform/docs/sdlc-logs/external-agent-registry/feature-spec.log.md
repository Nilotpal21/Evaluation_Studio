# SDLC Log: External Agent Registry — Feature Spec

**Phase**: Feature Spec
**Date**: 2026-04-28
**Artifact**: `docs/features/external-agent-registry.md`

---

## Oracle Session

All 14 clarifying questions were answered with no AMBIGUOUS escalations.

### Decisions Made

| ID   | Question                     | Decision                                                                                                         | Classification |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| D-1  | Nav placement                | New top-level project page `external-agents` (like `mcp-servers`)                                                | DECIDED        |
| D-2  | Inbound vs outbound boundary | New `external_agent_configs` collection; `channel_connections channelType:a2a` stays for inbound                 | ANSWERED       |
| D-3  | Project vs tenant scope      | Project-scoped (matches all other integration resources + project isolation invariant)                           | DECIDED        |
| D-4  | DSL/compiler changes needed  | Compiler already has `HANDOFF TO: ... LOCATION: remote`; `remote_agents` in CompilationOutput; no new DSL needed | ANSWERED       |
| D-5  | OAuth deferred               | Bearer + API key only in Phase 1; IR only defines bearer/api_key; oauth type unwired in runtime                  | DECIDED        |
| D-6  | RBAC                         | `CONNECTION_*` permission family (read/write/delete)                                                             | INFERRED       |
| D-7  | Verification                 | On-demand only (save + test-connection button); background health ping deferred to Phase 2                       | DECIDED        |
| D-8  | Compiler validation          | Advisory warning in editor, not blocking compilation; runtime handles resolution                                 | DECIDED        |
| D-9  | Agent card caching           | Cache in DB (`lastDiscoveredCard`), refresh on test-connection; runtime has own TTL cache                        | DECIDED        |
| D-10 | Model pattern                | Follow `MCPServerConfig` pattern exactly (encryptionPlugin, tenantIsolationPlugin, same status fields)           | ANSWERED       |
| D-11 | Auth mechanisms              | Bearer token + API key header (both); OAuth deferred                                                             | ANSWERED       |
| D-12 | Background job               | BullMQ when implemented (deferred); data schema ready                                                            | DECIDED        |
| D-13 | Runtime auth injection       | Yes — extend `resolveRemoteFromHandoff()` to look up registry and populate `auth.value`                          | ANSWERED       |
| D-14 | Name as key                  | `name` field is canonical reference key; no separate slug; matches DSL HANDOFF TO: target                        | DECIDED        |

### Key Source Files Discovered

- `packages/compiler/src/platform/ir/schema.ts:587-597` — `RemoteAgentLocation` (auth excludes value intentionally)
- `apps/runtime/src/services/execution/agent-lookup.ts:92-117` — `resolveRemoteFromHandoff` (GAP: auth.value not populated)
- `apps/runtime/src/services/execution/routing-executor.ts:1618-1635` — `createClientForAgent` (already handles auth.value injection)
- `packages/a2a/src/infrastructure/authenticated-client-factory.ts` — `createAuthenticatedA2AClient`
- `packages/database/src/models/mcp-server-config.model.ts` — reference model pattern
- `apps/studio/src/app/api/projects/[id]/mcp-servers/` — reference CRUD + test-connection pattern
- `apps/studio/src/lib/permissions.ts` — `CONNECTION_*` permission family
- `packages/compiler/src/platform/ir/validate-cross-agent.ts:126` — remote agents skipped in cross-agent validation

---

## Audit Round 1

Findings and resolutions logged below after audit run.

## Audit Round 2

Findings and resolutions logged below after audit run.

## Audit Round 3

Findings and resolutions logged below after audit run.
