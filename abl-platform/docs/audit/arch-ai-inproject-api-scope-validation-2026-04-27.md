# Arch AI In-Project API Scope Validation

Date: 2026-04-27

Companion implementation:

- `apps/studio/src/lib/arch-ai/engine-factory.ts`
- `apps/studio/src/lib/arch-ai/tools/kb-api-client.ts`
- `apps/studio/src/lib/search-ai-proxy.ts`

## Scope

This note validates the APIs used by the in-project Arch AI tools after wiring the missing project and knowledge-base capabilities into the live registry.

Rules applied:

- Do not invent new APIs when an existing Studio or SearchAI API exists.
- In-project tool calls must carry tenant, project, and user context.
- Project-owned data should be project scoped; user-owned/transient Arch data should also be user/session scoped.
- Missing project/user enforcement in existing APIs is called out explicitly rather than hidden by a tool-layer workaround.

## What Was Fixed

| Area                    | Change                                                                                              | Existing API used                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Project config          | Registered `project_config` in the live registry and delegated to existing compat refs.             | `project-service`, `/api/projects/:id/settings`      |
| Knowledge bases         | Registered `kb_manage`, `kb_search`, `kb_health`, `kb_ingest`, `kb_connector`, `kb_documents`.      | Existing SearchAI Studio proxy/SearchAI service APIs |
| Platform context        | Kept onboarding `list_models`, but delegated in-project actions to existing project-aware executor. | `executePlatformContext()`                           |
| Secret collection       | Aligned live `collect_secret` schema with existing `auth_ops` and `SecretInput` contract.           | Existing Arch tool-answer secret flow                |
| Model configuration     | Aligned live `configure_model` schema with existing in-project executor.                            | `executeConfigureModel()`                            |
| API context propagation | Added `X-Project-Id` and `X-User-Id` propagation in the KB API client and SearchAI proxy.           | Existing proxy/client requests                       |
| Agent update refresh    | Triggered the existing `setLastAgentEdit()` signal when Arch applies a diff.                        | Existing Studio stores                               |
| Global learning writes  | Tenant route can no longer patch/delete global Arch learning memories.                              | Existing learnings route                             |

## Existing API Validation Matrix

| Tool area                                     | API/service path used                                                               | Tenant scoped | Project scoped                             | User scoped           | Validation result                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `project_config get_config/update_config`     | `project-service` (`getProjectById`, `updateProject`)                               | Yes           | Yes                                        | Project-owned         | OK. Project access is gated before in-project message execution.                                       |
| `project_config get_settings/update_settings` | `/api/projects/:id/settings`                                                        | Yes           | Yes                                        | User carried          | OK. Route requires tenant auth and project permission; proxy now forwards tenant/project/user headers. |
| `platform_context` project actions            | `executePlatformContext()`                                                          | Yes           | Yes                                        | User carried          | OK. In-project registry now delegates to project-aware executor.                                       |
| `auth_ops`                                    | Existing auth-profile tool executor                                                 | Yes           | Yes                                        | User/session via flow | OK at tool layer; depends on existing auth-profile route/service enforcement.                          |
| `variable_ops`                                | Existing variable tool executor                                                     | Yes           | Yes                                        | User carried          | OK at tool layer; workflow coverage still needed.                                                      |
| `tools_ops`                                   | Existing tools tool executor                                                        | Yes           | Yes                                        | User carried          | OK at tool layer; workflow coverage still needed.                                                      |
| `integration_ops`                             | Existing integration draft executor                                                 | Yes           | Yes                                        | User/session carried  | OK at tool layer; workflow coverage still needed.                                                      |
| `kb_manage list/create`                       | `/api/search-ai/knowledge-bases`                                                    | Yes           | Yes for list/query/body                    | User header carried   | Existing API used. Studio route requires `projectId` for GET; POST expects projectId in body.          |
| `kb_manage get/update/delete`                 | `/api/search-ai/knowledge-bases/:id`                                                | Yes           | Indirect by KB ID                          | User header carried   | Existing API used, but route path is not project-shaped. See missing API hardening.                    |
| `kb_search`                                   | `/api/search-ai-runtime/search/:indexId/*`                                          | Yes           | Indirect by index ID                       | User header carried   | Existing API used, but runtime route path is index-shaped. See missing API hardening.                  |
| `kb_ingest upload/list_sources/add_text`      | `/api/search-ai/indexes/:id/sources`, `/documents`                                  | Yes           | Indirect by index ID                       | User header carried   | Existing API used, but route path is index-shaped. See missing API hardening.                          |
| `kb_ingest add_url`                           | `/api/search-ai/crawl/batch`                                                        | Yes           | Indirect via index/source IDs              | User header carried   | Existing API used; crawl body currently carries index/source, not project ID.                          |
| `kb_health retry_failed`                      | `/api/search-ai/projects/:projectId/knowledge-bases/:kbId/documents/bulk-reprocess` | Yes           | Yes                                        | User header carried   | Best scoped SearchAI API among the KB tools.                                                           |
| `kb_health errors/check_operation`            | `/api/search-ai/admin/errors`, `/api/search-ai/jobs/:jobId`, connector sync status  | Yes           | Indirect by IDs                            | User header carried   | Existing APIs used; project-shaped alternatives are missing.                                           |
| `kb_connector`                                | `/api/search-ai/indexes/:id/connectors`, `/api/search-ai/connectors/:connectorId/*` | Yes           | Indirect by index/connector IDs            | User header carried   | Existing APIs used; connector action routes are not project-shaped.                                    |
| `kb_documents`                                | `/api/search-ai/indexes/:id/documents*` plus project bulk reprocess                 | Yes           | Indirect by index ID, direct for reprocess | User header carried   | Existing APIs used; most document routes are index-shaped.                                             |

## Missing API Hardening

These are existing API gaps. I did not create replacement APIs in this pass.

1. **SearchAI KB detail/update/delete routes are not project-shaped.**

   Current shape:
   - `/api/search-ai/knowledge-bases/:id`

   Preferred in-project shape:
   - `/api/search-ai/projects/:projectId/knowledge-bases/:kbId`

   Required enforcement:
   - Tenant auth.
   - Project permission check in Studio or SearchAI.
   - Verify `knowledgeBase.projectId === projectId`.
   - Return non-leaky `404` on cross-project access.

2. **SearchAI index document/source routes are index-shaped.**

   Current shape:
   - `/api/search-ai/indexes/:id/documents`
   - `/api/search-ai/indexes/:id/sources`

   Preferred in-project shape:
   - `/api/search-ai/projects/:projectId/knowledge-bases/:kbId/indexes/:indexId/documents`
   - `/api/search-ai/projects/:projectId/knowledge-bases/:kbId/indexes/:indexId/sources`

   Required enforcement:
   - Verify index belongs to a KB in the requested project.
   - Carry user ID for audit fields on write actions.

3. **Search runtime query routes are index-shaped.**

   Current shape:
   - `/api/search-ai-runtime/search/:indexId/query`
   - `/api/search-ai-runtime/search/:indexId/discover`
   - `/api/search-ai-runtime/search/:indexId/resolve`

   Preferred in-project shape:
   - `/api/search-ai-runtime/projects/:projectId/indexes/:indexId/search/query`

   Required enforcement:
   - Verify runtime index belongs to the requested tenant/project before query execution.
   - Preserve query audit metadata with user ID.

4. **Connector operational routes are connector-ID-shaped.**

   Current shape:
   - `/api/search-ai/connectors/:connectorId/auth/initiate`
   - `/api/search-ai/connectors/:connectorId/sync/start`
   - `/api/search-ai/connectors/:connectorId/sync/status`
   - `/api/search-ai/connectors/:connectorId/sync/pause`
   - `/api/search-ai/connectors/:connectorId/sync/resume`

   Preferred in-project shape:
   - `/api/search-ai/projects/:projectId/knowledge-bases/:kbId/connectors/:connectorId/...`

   Required enforcement:
   - Verify connector belongs to an index/KB in the requested project.
   - Carry user ID for audit and sync initiator.

5. **SearchAI proxy routes mostly require auth but do not consistently perform Studio-side project permission checks.**

   The in-project Arch message route performs project access gating before tool execution, and the SearchAI service should enforce tenant/project ownership too. For defense in depth, project-shaped Studio proxy routes should also call `requireProjectPermission()` or verify project membership before proxying.

## Implementation Boundary

This pass fixes the Arch tool wiring and context propagation without inventing new API routes. The missing API hardening items above should be implemented as SearchAI/Studio API contract work with route-level tests.
