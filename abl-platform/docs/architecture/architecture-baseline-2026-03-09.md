# Architecture Baseline - 2026-03-09

## Route Complexity Analysis

Target: All route files < 300 LOC

### Top 20 largest route/controller files:

```
    2085 apps/search-ai/src/routes/kg-taxonomy.ts
    2085 apps/runtime/src/routes/sessions.ts
    1934 apps/search-ai/src/routes/crawl.ts
    1700 apps/search-ai/src/routes/connectors.ts
    1559 apps/runtime/src/routes/tenant-models.ts
    1349 apps/studio/src/app/api/arch/generate/route.ts
    1349 apps/studio/.next/standalone/apps/studio/src/app/api/arch/generate/route.ts
    1323 apps/studio/src/app/api/openapi/spec.json/route.ts
    1323 apps/studio/.next/standalone/apps/studio/src/app/api/openapi/spec.json/route.ts
    1209 apps/studio/src/app/api/arch/chat/route.ts
    1209 apps/studio/.next/standalone/apps/studio/src/app/api/arch/chat/route.ts
    1194 apps/runtime/src/routes/chat.ts
    1175 apps/runtime/src/routes/channel-connections.ts
    1023 apps/search-ai/src/routes/kg-enrichment.ts
     880 apps/runtime/src/routes/deployments.ts
     825 apps/runtime/src/routes/pipeline-analytics.ts
     809 apps/runtime/src/routes/project-io.ts
     740 apps/runtime/src/routes/analytics.ts
     714 apps/runtime/src/routes/environment-variables.ts
     713 apps/runtime/src/routes/http-async-channel.ts
```

Summary: 101 / 786 route files exceed 300 LOC

## Direct DB Access in Route Files

Target: Zero direct Model.\* calls in route handlers

```
apps/workflow-engine/src/routes/human-task-resolution.ts                         2 calls
apps/workflow-engine/src/routes/workflow-approvals.ts                            4 calls
apps/workflow-engine/src/routes/notification-rules.ts                            7 calls
apps/workflow-engine/src/routes/connections.ts                                   1 calls
apps/workflow-engine/src/routes/workflow-executions.ts                           7 calls
apps/workflow-engine/src/routes/workflow-callbacks.ts                            4 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/dev-login/route.ts     1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/microsoft/callback/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/verify-email/route.ts  2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/reset-password/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/callback/route.ts      1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/auth/linkedin/callback/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/arch-conversation/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/quick/route.ts 5 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/personas/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/sets/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/scenarios/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/cancel/route.ts 3 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/start/route.ts 5 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/status/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/evals/runs/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/agents/[agentId]/lock/route.ts 7 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/agents/[agentId]/permissions/route.ts 3 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/agents/[agentId]/ownership/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/connections/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/teams/route.ts 3 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/git/pull/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/git/status/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/git/push/route.ts 4 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/git/route.ts  5 calls
apps/studio/.next/standalone/apps/studio/src/app/api/projects/[id]/git/history/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/service-nodes/[id]/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/admin/sdk-clients/route.ts  1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/agents/apps/[domain]/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/pipelines/[pipelineId]/clone/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/pipelines/[pipelineId]/route.ts 4 calls
apps/studio/.next/standalone/apps/studio/src/app/api/pipelines/[pipelineId]/deactivate/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/pipelines/[pipelineId]/activate/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/traces/route.ts    1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/sessions/route.ts  1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/route.ts           1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/audit-export/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/[id]/download/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/archives/[id]/route.ts      1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/sdk/widget/[projectId]/route.ts 2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/sdk/keys/route.ts           2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/sdk/keys/[keyId]/route.ts   2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/sdk/preview-token/route.ts  1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/sdk/share/route.ts          2 calls
apps/studio/.next/standalone/apps/studio/src/app/api/arch/config/route.ts        5 calls
apps/studio/.next/standalone/apps/studio/src/app/api/arch/status/route.ts        1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/webhooks/git/[projectId]/route.ts 1 calls
apps/studio/.next/standalone/apps/studio/src/app/api/debug/validate/route.ts     2 calls
apps/studio/src/app/api/auth/dev-login/route.ts                                  1 calls
apps/studio/src/app/api/auth/microsoft/callback/route.ts                         1 calls
apps/studio/src/app/api/auth/verify-email/route.ts                               2 calls
apps/studio/src/app/api/auth/reset-password/route.ts                             2 calls
apps/studio/src/app/api/auth/callback/route.ts                                   1 calls
apps/studio/src/app/api/auth/linkedin/callback/route.ts                          1 calls
apps/studio/src/app/api/projects/[id]/arch-conversation/route.ts                 2 calls
apps/studio/src/app/api/projects/[id]/evals/quick/route.ts                       5 calls
apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts                  1 calls
apps/studio/src/app/api/projects/[id]/evals/personas/route.ts                    1 calls
apps/studio/src/app/api/projects/[id]/evals/sets/route.ts                        1 calls
apps/studio/src/app/api/projects/[id]/evals/scenarios/route.ts                   1 calls
apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/cancel/route.ts         3 calls
apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/start/route.ts          5 calls
apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/status/route.ts         2 calls
apps/studio/src/app/api/projects/[id]/evals/runs/route.ts                        1 calls
apps/studio/src/app/api/projects/[id]/agents/[agentId]/lock/route.ts             7 calls
apps/studio/src/app/api/projects/[id]/agents/[agentId]/permissions/route.ts      3 calls
apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts             2 calls
apps/studio/src/app/api/projects/[id]/agents/[agentId]/ownership/route.ts        2 calls
apps/studio/src/app/api/projects/[id]/connections/route.ts                       1 calls
apps/studio/src/app/api/projects/[id]/teams/route.ts                             3 calls
apps/studio/src/app/api/projects/[id]/git/pull/route.ts                          1 calls
apps/studio/src/app/api/projects/[id]/git/status/route.ts                        1 calls
apps/studio/src/app/api/projects/[id]/git/push/route.ts                          4 calls
apps/studio/src/app/api/projects/[id]/git/route.ts                               5 calls
apps/studio/src/app/api/projects/[id]/git/history/route.ts                       1 calls
apps/studio/src/app/api/service-nodes/[id]/route.ts                              1 calls
apps/studio/src/app/api/admin/sdk-clients/route.ts                               1 calls
apps/studio/src/app/api/agents/apps/[domain]/route.ts                            1 calls
apps/studio/src/app/api/pipelines/[pipelineId]/clone/route.ts                    1 calls
apps/studio/src/app/api/pipelines/[pipelineId]/route.ts                          4 calls
apps/studio/src/app/api/pipelines/[pipelineId]/deactivate/route.ts               2 calls
apps/studio/src/app/api/pipelines/[pipelineId]/activate/route.ts                 2 calls
apps/studio/src/app/api/archives/traces/route.ts                                 1 calls
apps/studio/src/app/api/archives/sessions/route.ts                               1 calls
apps/studio/src/app/api/archives/route.ts                                        1 calls
apps/studio/src/app/api/archives/audit-export/route.ts                           1 calls
apps/studio/src/app/api/archives/[id]/download/route.ts                          1 calls
apps/studio/src/app/api/archives/[id]/route.ts                                   1 calls
apps/studio/src/app/api/sdk/widget/[projectId]/route.ts                          2 calls
apps/studio/src/app/api/sdk/keys/route.ts                                        2 calls
apps/studio/src/app/api/sdk/keys/[keyId]/route.ts                                2 calls
apps/studio/src/app/api/sdk/preview-token/route.ts                               1 calls
apps/studio/src/app/api/sdk/share/route.ts                                       2 calls
apps/studio/src/app/api/arch/config/route.ts                                     5 calls
apps/studio/src/app/api/arch/status/route.ts                                     1 calls
apps/studio/src/app/api/webhooks/git/[projectId]/route.ts                        1 calls
apps/studio/src/app/api/debug/validate/route.ts                                  2 calls
apps/multimodal-service/src/routes/admin.ts                                      1 calls
apps/multimodal-service/src/routes/attachments.ts                                1 calls
apps/search-ai-runtime/src/routes/idp-sync.ts                                    1 calls
apps/search-ai-runtime/src/routes/similar.ts                                     1 calls
apps/search-ai/src/routes/kg-enrichment.ts                                       16 calls
apps/search-ai/src/routes/mappings.ts                                            5 calls
apps/search-ai/src/routes/chunks.ts                                              1 calls
apps/search-ai/src/routes/vocabulary.ts                                          8 calls
apps/search-ai/src/routes/webhooks.ts                                            2 calls
apps/search-ai/src/routes/progress.ts                                            1 calls
apps/search-ai/src/routes/crawler-ingestion.ts                                   1 calls
apps/search-ai/src/routes/kg-taxonomy.ts                                         30 calls
apps/search-ai/src/routes/errors.ts                                              1 calls
apps/search-ai/src/routes/indexes.ts                                             10 calls
apps/search-ai/src/routes/schemas.ts                                             7 calls
apps/search-ai/src/routes/admin.ts                                               1 calls
apps/search-ai/src/routes/sources.ts                                             7 calls
apps/search-ai/src/routes/jobs.ts                                                2 calls
apps/search-ai/src/routes/crawl-history.ts                                       6 calls
apps/search-ai/src/routes/knowledge-bases.ts                                     12 calls
apps/search-ai/src/routes/structured-data-ingest.ts                              3 calls
apps/search-ai/src/routes/document-upload.ts                                     7 calls
apps/search-ai/src/routes/documents.ts                                           4 calls
apps/search-ai/src/routes/connectors.ts                                          35 calls
apps/search-ai/src/routes/connector-discovery.ts                                 7 calls
apps/search-ai/src/routes/crawl.ts                                               6 calls
apps/runtime/src/routes/channel-connections.ts                                   15 calls
apps/runtime/src/routes/guardrail-providers.ts                                   5 calls
apps/runtime/src/routes/merge-suggestions.ts                                     1 calls
apps/runtime/src/routes/tenant-models.ts                                         2 calls
apps/runtime/src/routes/analytics.ts                                             4 calls
apps/runtime/src/routes/workflows.ts                                             1 calls
apps/runtime/src/routes/http-async-channel.ts                                    11 calls
apps/runtime/src/routes/guardrail-policies.ts                                    6 calls
apps/runtime/src/routes/platform-admin-hubspot.ts                                5 calls
apps/runtime/src/routes/pipeline-config.ts                                       4 calls
apps/runtime/src/routes/project-llm-config.ts                                    2 calls
apps/runtime/src/routes/platform-admin-usage.ts                                  4 calls
apps/runtime/src/routes/experiments.ts                                           6 calls
apps/runtime/src/routes/project-io.ts                                            2 calls
apps/runtime/src/routes/human-tasks.ts                                           6 calls
apps/runtime/src/routes/alert-config.ts                                          3 calls
apps/runtime/src/routes/platform-admin-deals.ts                                  13 calls
apps/runtime/src/routes/platform-admin-config.ts                                 9 calls
apps/runtime/src/routes/platform-admin-tenants.ts                                5 calls
apps/runtime/src/routes/project-runtime-config.ts                                2 calls
apps/runtime/src/routes/contacts.ts                                              3 calls
apps/runtime/src/routes/roi.ts                                                   5 calls
apps/runtime/src/routes/workspace-billing.ts                                     4 calls
apps/runtime/src/routes/platform-admin-features.ts                               2 calls
apps/runtime/src/routes/tags.ts                                                  3 calls
apps/runtime/src/routes/kms-admin.ts                                             2 calls
apps/runtime/src/routes/alerts.ts                                                5 calls
```

## Shared Package Coupling

Target: shared-kernel has zero database dependency

Imports of @agent-platform/shared per app:

```
apps/runtime                             375 imports
apps/studio                              132 imports
apps/search-ai                           24 imports
apps/admin                               0 imports
```

Shared package dependencies (from package.json):
Internal: "@agent-platform/shared"
"@agent-platform/database"
"@agent-platform/i18n"

Shared package file count: 115 TypeScript files

## Coverage vs Targets

```
{
  "apps/runtime": { "lines": 12, "branches": 11, "functions": 16 },
  "apps/studio": { "lines": 7, "branches": 4, "functions": 12 },
  "packages/compiler": { "lines": 75, "branches": 59, "functions": 69 },
  "packages/database": { "lines": 53, "branches": 31, "functions": 31 },
  "packages/core": { "lines": 69, "branches": 55, "functions": 92 },
  "packages/project-io": { "lines": 86, "branches": 77, "functions": 78 },
  "apps/search-ai": { "lines": 24, "branches": 19, "functions": 16 },
  "apps/search-ai-runtime": { "lines": 46, "branches": 39, "functions": 46 }
}
```

## Runtime Executor Consolidation Progress

Target: runtime-executor.ts < 1,500 LOC

```
apps/runtime/src/services/runtime-executor.ts                          2626 LOC
apps/runtime/src/services/execution/flow-step-executor.ts              4105 LOC
```

Delegated sub-executors found:

```
gather-executor                                    not yet created
constraint-executor                                481 LOC
complete-executor                                  not yet created
handoff-executor                                   not yet created
delegate-executor                                  not yet created
reasoning-executor                                 1550 LOC
flow-executor                                      not yet created
```

## Additional Metrics

### File sizes

```
    2626 apps/runtime/src/services/runtime-executor.ts
    4105 apps/runtime/src/services/execution/flow-step-executor.ts
    1700 apps/search-ai/src/routes/connectors.ts
```

### Shared package file count

     115

### Studio API route count

     295
