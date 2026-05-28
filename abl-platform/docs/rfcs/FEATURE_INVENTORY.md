# Feature Inventory and Code Ownership

This inventory defines the RFC feature model and the code areas owned by each feature.

## F010 - Evals and Quality Engineering

- RFC: [docs/specs/rfcs/RFC-010-evals-quality-engineering.md](/docs/specs/rfcs/RFC-010-evals-quality-engineering.md)
- File count in scope: **67**
- Included code paths:
  - `apps/studio/src/components/evals/`
  - `apps/studio/src/app/api/projects/[id]/evals/`
  - `packages/pipeline-engine/src/pipeline/services/eval/`
  - `packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.ts`
  - `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts`
  - `packages/pipeline-engine/src/pipeline/prompts/evaluation.prompts.ts`
  - `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts`
  - `packages/database/src/models/eval-*.model.ts`
- Sample files:
  - `apps/studio/src/app/api/projects/[id]/evals/evaluators/[evaluatorId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/evaluators/templates/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/personas/[personaId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/personas/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/personas/templates/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/preflight/route.ts`
  - `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`

## F009 - Guardrails and PII Safety

- RFC: [docs/specs/rfcs/RFC-009-guardrails-pii-safety.md](/docs/specs/rfcs/RFC-009-guardrails-pii-safety.md)
- File count in scope: **65**
- Included code paths:
  - `apps/studio/src/components/guardrails/`
  - `apps/studio/src/components/governance/`
  - `apps/studio/src/app/api/tenant-llm-policy/`
  - `apps/studio/src/app/api/admin/guardrail-policies/`
  - `apps/studio/src/app/api/admin/guardrail-providers/`
  - `apps/runtime/src/services/guardrails/`
  - `apps/runtime/src/routes/guardrail-policies.ts`
  - `apps/runtime/src/routes/guardrail-providers.ts`
  - `apps/runtime/src/services/identity/`
  - `apps/search-ai/src/services/document-permissions/`
  - `apps/search-ai/src/services/noise-detection/`
  - `packages/compiler/src/platform/guardrails/`
  - `packages/compiler/src/platform/security/`
  - `packages/shared/src/security/`
  - `packages/shared/src/encryption/`
  - `packages/pipeline-engine/src/pipeline/definitions/guardrail-pipeline.ts`
  - `packages/database/src/models/guardrail-*.model.ts`
  - `packages/database/src/models/tenant-llm-policy.model.ts`
  - `packages/database/src/models/dek-registry.model.ts`
  - `packages/database/src/models/key-version.model.ts`
- Sample files:
  - `apps/runtime/src/routes/guardrail-policies.ts`
  - `apps/runtime/src/routes/guardrail-providers.ts`
  - `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-llmeval.test.ts`
  - `apps/runtime/src/services/guardrails/cache.ts`
  - `apps/runtime/src/services/guardrails/cost-tracker.ts`
  - `apps/runtime/src/services/guardrails/pipeline-factory.ts`
  - `apps/runtime/src/services/guardrails/policy-resolver.ts`
  - `apps/runtime/src/services/guardrails/streaming-evaluator.ts`
  - `apps/runtime/src/services/guardrails/trace-events.ts`
  - `apps/runtime/src/services/guardrails/webhook.ts`

## F003 - Threaded Sessions and Memory

- RFC: [docs/specs/rfcs/RFC-003-threaded-sessions-memory.md](/docs/specs/rfcs/RFC-003-threaded-sessions-memory.md)
- File count in scope: **112**
- Included code paths:
  - `apps/studio/src/components/session/`
  - `apps/studio/src/components/sessions/`
  - `apps/studio/src/app/api/runtime/sessions/`
  - `apps/studio/src/app/api/projects/[id]/sessions/`
  - `apps/runtime/src/routes/sessions.ts`
  - `apps/runtime/src/routes/attachments.ts`
  - `apps/runtime/src/routes/transcripts.ts`
  - `apps/runtime/src/routes/memory-api.ts`
  - `apps/runtime/src/routes/contacts.ts`
  - `apps/runtime/src/routes/contact-merge.ts`
  - `apps/runtime/src/routes/merge-suggestions.ts`
  - `apps/runtime/src/services/session/`
  - `apps/runtime/src/contexts/`
  - `apps/runtime/src/attachments/`
  - `apps/runtime/src/services/stores/`
  - `apps/runtime/src/services/metadata/`
  - `packages/shared/src/attachments/`
  - `packages/database/src/models/session*.model.ts`
  - `packages/database/src/models/message.model.ts`
  - `packages/database/src/models/contact.model.ts`
  - `packages/database/src/models/attachment.model.ts`
  - `packages/database/src/models/channel-session.model.ts`
  - `packages/database/src/models/merge-suggestion.model.ts`
- Sample files:
  - `apps/runtime/src/attachments/__tests__/message-preprocessor.test.ts`
  - `apps/runtime/src/attachments/__tests__/multimodal-service-client.test.ts`
  - `apps/runtime/src/attachments/message-preprocessor.ts`
  - `apps/runtime/src/attachments/multimodal-circuit-breaker.ts`
  - `apps/runtime/src/attachments/multimodal-service-client.ts`
  - `apps/runtime/src/contexts/contact/domain/contact-identity.ts`
  - `apps/runtime/src/contexts/contact/domain/contact-repository.ts`
  - `apps/runtime/src/contexts/contact/domain/contact.ts`
  - `apps/runtime/src/contexts/contact/domain/merge-execution.ts`
  - `apps/runtime/src/contexts/contact/domain/merge-suggestion.ts`

## F005 - Agent Tools Platform

- RFC: [docs/specs/rfcs/RFC-005-agent-tools-platform.md](/docs/specs/rfcs/RFC-005-agent-tools-platform.md)
- File count in scope: **72**
- Included code paths:
  - `apps/studio/src/components/tools/`
  - `apps/studio/src/components/mcp-servers/`
  - `apps/studio/src/app/api/projects/[id]/tools/`
  - `apps/studio/src/app/api/projects/[id]/mcp-servers/`
  - `apps/runtime/src/tools/`
  - `apps/runtime/src/routes/tool-secrets.ts`
  - `apps/runtime/src/services/mcp/`
  - `packages/compiler/src/tools/`
  - `packages/shared/src/tools/`
  - `packages/database/src/models/project-tool.model.ts`
  - `packages/database/src/models/tool-secret.model.ts`
  - `packages/database/src/models/mcp-server-config.model.ts`
- Sample files:
  - `apps/runtime/src/routes/tool-secrets.ts`
  - `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
  - `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`
  - `apps/runtime/src/tools/__tests__/attachment-tool-executor.test.ts`
  - `apps/runtime/src/tools/attachment-tool-executor.ts`
  - `apps/runtime/src/tools/load-project-tools-as-ir.ts`
  - `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route.ts`
  - `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test/route.ts`
  - `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/preview/route.ts`

## F018 - AI Architect and Agent Design Automation

- RFC: [docs/specs/rfcs/RFC-018-ai-architect-agent-design-automation.md](/docs/specs/rfcs/RFC-018-ai-architect-agent-design-automation.md)
- File count in scope: **35**
- Included code paths:
  - `apps/studio/src/components/arch/`
  - `apps/studio/src/components/spec-generation/`
  - `apps/studio/src/app/api/arch/`
  - `apps/studio/src/app/api/projects/[id]/arch-conversation/`
  - `packages/kore-platform-cli/src/mcp/architect/`
  - `packages/kore-platform-cli/src/mcp/analysis/`
  - `packages/kore-platform-cli/src/mcp/authoring/`
  - `packages/database/src/models/arch-*.model.ts`
- Sample files:
  - `apps/studio/src/app/api/arch/chat/route.ts`
  - `apps/studio/src/app/api/arch/config/route.ts`
  - `apps/studio/src/app/api/arch/deploy-mocks/route.ts`
  - `apps/studio/src/app/api/arch/generate/route.ts`
  - `apps/studio/src/app/api/arch/models/route.ts`
  - `apps/studio/src/app/api/arch/status/route.ts`
  - `apps/studio/src/app/api/arch/validate-key/route.ts`
  - `apps/studio/src/app/api/projects/[id]/arch-conversation/route.ts`
  - `apps/studio/src/components/arch/ArchChat.tsx`
  - `apps/studio/src/components/arch/ArchDiffView.tsx`

## F013 - Import Export and Project IO

- RFC: [docs/specs/rfcs/RFC-013-import-export-project-io.md](/docs/specs/rfcs/RFC-013-import-export-project-io.md)
- File count in scope: **126**
- Included code paths:
  - `apps/studio/src/app/api/projects/[id]/import/`
  - `apps/studio/src/app/api/projects/[id]/export/`
  - `apps/studio/src/app/api/projects/[id]/git/`
  - `apps/studio/src/app/api/projects/[id]/bundle/`
  - `apps/studio/src/app/api/projects/[id]/dependencies/`
  - `packages/project-io/`
  - `packages/kore-platform-cli/src/commands/import.ts`
  - `packages/kore-platform-cli/src/commands/export.ts`
  - `packages/kore-platform-cli/src/commands/git.ts`
  - `packages/database/src/models/import-operation.model.ts`
  - `packages/database/src/models/git-*.model.ts`
- Sample files:
  - `apps/studio/src/app/api/projects/[id]/bundle/route.ts`
  - `apps/studio/src/app/api/projects/[id]/dependencies/route.ts`
  - `apps/studio/src/app/api/projects/[id]/export/async/route.ts`
  - `apps/studio/src/app/api/projects/[id]/export/preview/route.ts`
  - `apps/studio/src/app/api/projects/[id]/export/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/history/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/push/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/route.ts`

## F012 - Workflow HITL Triggers and Approvals

- RFC: [docs/specs/rfcs/RFC-012-workflow-hitl-triggers-approvals.md](/docs/specs/rfcs/RFC-012-workflow-hitl-triggers-approvals.md)
- File count in scope: **19**
- Included code paths:
  - `apps/studio/src/app/api/projects/[id]/approvals/`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/`
  - `apps/studio/src/app/api/projects/[id]/workflows/triggers/`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve/`
  - `apps/workflow-engine/src/routes/workflow-approvals.ts`
  - `apps/workflow-engine/src/routes/human-task-resolution.ts`
  - `apps/workflow-engine/src/routes/triggers.ts`
  - `apps/workflow-engine/src/routes/notification-rules.ts`
  - `apps/workflow-engine/src/notifications/workflow-approval-handler.ts`
  - `apps/workflow-engine/src/services/trigger-engine.ts`
  - `apps/workflow-engine/src/services/trigger-scheduler.ts`
  - `packages/database/src/models/human-task.model.ts`
  - `packages/database/src/models/trigger-registration.model.ts`
- Sample files:
  - `apps/studio/src/app/api/projects/[id]/approvals/route.ts`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/assign/route.ts`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/claim/route.ts`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/resolve/route.ts`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/triggers/[triggerId]/pause/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/triggers/[triggerId]/resume/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/triggers/route.ts`

## F011 - Workflow Actions Engine

- RFC: [docs/specs/rfcs/RFC-011-workflow-actions-engine.md](/docs/specs/rfcs/RFC-011-workflow-actions-engine.md)
- File count in scope: **212**
- Included code paths:
  - `apps/studio/src/components/workflows/`
  - `apps/studio/src/app/api/projects/[id]/workflows/`
  - `apps/workflow-engine/`
  - `packages/pipeline-engine/`
  - `packages/database/src/models/workflow*.model.ts`
- Sample files:
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/notifications/[ruleId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/notifications/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/connectors/route.ts`
  - `apps/studio/src/app/api/projects/[id]/workflows/route.ts`
  - `apps/studio/src/components/workflows/CreateWorkflowModal.tsx`
  - `apps/studio/src/components/workflows/InboxPage.tsx`

## F006 - Connectors Platform

- RFC: [docs/specs/rfcs/RFC-006-connectors-platform.md](/docs/specs/rfcs/RFC-006-connectors-platform.md)
- File count in scope: **157**
- Included code paths:
  - `apps/studio/src/components/connections/`
  - `apps/studio/src/app/api/projects/[id]/connections/`
  - `apps/studio/src/app/api/projects/[id]/connectors/`
  - `apps/studio/src/app/api/projects/[id]/workflows/connectors/`
  - `apps/studio/src/app/api/search-ai/connectors/`
  - `apps/runtime/src/routes/channel-connections.ts`
  - `apps/runtime/src/routes/channel-oauth.ts`
  - `apps/runtime/src/services/channel-oauth/`
  - `apps/runtime/src/services/channel/`
  - `apps/runtime/src/services/channels/`
  - `apps/search-ai/src/routes/connectors.ts`
  - `apps/search-ai/src/routes/connector-discovery.ts`
  - `apps/search-ai/src/routes/webhooks.ts`
  - `apps/workflow-engine/src/routes/connections.ts`
  - `apps/workflow-engine/src/routes/connectors.ts`
  - `apps/workflow-engine/src/services/connection-tester.ts`
  - `packages/connectors/`
  - `packages/database/src/models/connector-*.model.ts`
  - `packages/database/src/models/channel-connection.model.ts`
  - `packages/database/src/models/webhook-subscription*.model.ts`
  - `packages/database/src/models/end-user-oauth-token.model.ts`
- Sample files:
  - `apps/runtime/src/routes/channel-connections.ts`
  - `apps/runtime/src/routes/channel-oauth.ts`
  - `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts`
  - `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts`
  - `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`
  - `apps/runtime/src/services/channel-oauth/index.ts`
  - `apps/runtime/src/services/channel-oauth/providers/__tests__/meta-oauth-provider.test.ts`
  - `apps/runtime/src/services/channel-oauth/providers/__tests__/msteams-oauth-provider.test.ts`
  - `apps/runtime/src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts`
  - `apps/runtime/src/services/channel-oauth/providers/index.ts`

## F008 - Knowledgebase Invocation Runtime

- RFC: [docs/specs/rfcs/RFC-008-knowledgebase-invocation-runtime.md](/docs/specs/rfcs/RFC-008-knowledgebase-invocation-runtime.md)
- File count in scope: **100**
- Included code paths:
  - `apps/studio/src/app/api/search-ai-runtime/`
  - `apps/search-ai-runtime/`
  - `apps/runtime/src/services/search-ai/`
  - `packages/search-ai-sdk/`
  - `packages/database/src/models/knowledge-base.model.ts`
- Sample files:
  - `apps/runtime/src/services/search-ai/__tests__/search-ai-tool-executor.test.ts`
  - `apps/runtime/src/services/search-ai/index.ts`
  - `apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts`
  - `apps/runtime/src/services/search-ai/search-ai-tool-executor.ts`
  - `apps/runtime/src/services/search-ai/search-ai-tool-handler.ts`
  - `apps/search-ai-runtime/ARCHITECTURE_REVIEW.md`
  - `apps/search-ai-runtime/Dockerfile`
  - `apps/search-ai-runtime/QUERY-PIPELINE-GUIDE.md`
  - `apps/search-ai-runtime/QUERY_PIPELINE_DEEP_DIVE.md`
  - `apps/search-ai-runtime/docs/phase-3-design.md`

## F007 - Search AI Ingestion and KB Build

- RFC: [docs/specs/rfcs/RFC-007-search-ai-ingestion-kb-build.md](/docs/specs/rfcs/RFC-007-search-ai-ingestion-kb-build.md)
- File count in scope: **636**
- Included code paths:
  - `apps/studio/src/components/search-ai/`
  - `apps/studio/src/app/api/search-ai/`
  - `apps/search-ai/`
  - `apps/multimodal-service/`
  - `apps/nlu-sidecar/`
  - `services/preprocessing-service/`
  - `services/docling-service/`
  - `services/bge-m3-service/`
  - `packages/search-ai-internal/`
  - `packages/database/src/models/search-*.model.ts`
  - `packages/database/src/models/chunk-*.model.ts`
  - `packages/database/src/models/field-mapping.model.ts`
  - `packages/database/src/models/canonical-*.model.ts`
  - `packages/database/src/models/domain-vocabulary.model.ts`
  - `packages/database/src/models/knowledge-graph-*.model.ts`
  - `packages/database/src/models/taxonomy-health-cache.model.ts`
  - `packages/database/src/models/document-page.model.ts`
  - `packages/database/src/models/fact.model.ts`
  - `packages/database/src/models/sync-checkpoint.model.ts`
  - `packages/database/src/models/drive-delta-token.model.ts`
  - `packages/database/src/models/user-crawl-preference.model.ts`
  - `packages/database/src/models/crawl-*.model.ts`
  - `packages/database/src/models/shared-index-tracker.model.ts`
- Sample files:
  - `apps/multimodal-service/.gitignore`
  - `apps/multimodal-service/Dockerfile`
  - `apps/multimodal-service/package.json`
  - `apps/multimodal-service/src/__tests__/attachment-rate-limit.test.ts`
  - `apps/multimodal-service/src/__tests__/attachment-routes.test.ts`
  - `apps/multimodal-service/src/__tests__/multimodal-service.test.ts`
  - `apps/multimodal-service/src/config.ts`
  - `apps/multimodal-service/src/db/index.ts`
  - `apps/multimodal-service/src/index.ts`
  - `apps/multimodal-service/src/jobs/__tests__/cleanup-job.test.ts`

## F024 - Crawler Intelligence and Browser Automation

- RFC: [docs/specs/rfcs/RFC-024-crawler-intelligence-browser-automation.md](/docs/specs/rfcs/RFC-024-crawler-intelligence-browser-automation.md)
- File count in scope: **102**
- Included code paths:
  - `packages/crawler/`
  - `apps/crawler-go-worker/`
  - `apps/crawler-mcp-server/`
  - `test-browser-crawl-e2e.ts`
  - `test-bulk-crawl-e2e.ts`
  - `test-crawler-api.sh`
  - `test-e2e-crawl.js`
  - `test-mcp-crawler-integration.ts`
- Sample files:
  - `apps/crawler-go-worker/.dockerignore`
  - `apps/crawler-go-worker/.env.example`
  - `apps/crawler-go-worker/.gitattributes`
  - `apps/crawler-go-worker/.gitignore`
  - `apps/crawler-go-worker/BUILDING.md`
  - `apps/crawler-go-worker/Dockerfile`
  - `apps/crawler-go-worker/Makefile`
  - `apps/crawler-go-worker/OPTION_A_COMPLETE.md`
  - `apps/crawler-go-worker/README.md`
  - `apps/crawler-go-worker/RECURSIVE-CRAWLING.md`

## F014 - Agent Transfer and A2A

- RFC: [docs/specs/rfcs/RFC-014-agent-transfer-a2a.md](/docs/specs/rfcs/RFC-014-agent-transfer-a2a.md)
- File count in scope: **120**
- Included code paths:
  - `packages/agent-transfer/`
  - `packages/a2a/`
  - `apps/runtime/src/routes/agent-transfer-webhooks.ts`
  - `apps/runtime/src/services/agent-transfer/`
  - `packages/database/src/models/tenant-transfer.model.ts`
- Sample files:
  - `apps/runtime/src/routes/agent-transfer-webhooks.ts`
  - `apps/runtime/src/services/agent-transfer/index.ts`
  - `apps/runtime/src/services/agent-transfer/message-bridge.ts`
  - `packages/a2a/package.json`
  - `packages/a2a/src/__tests__/agent-executor-adapter.test.ts`
  - `packages/a2a/src/__tests__/discover-agent.test.ts`
  - `packages/a2a/src/__tests__/express-handlers.test.ts`
  - `packages/a2a/src/__tests__/ports.test.ts`
  - `packages/a2a/src/__tests__/send-task.test.ts`
  - `packages/a2a/src/__tests__/ssrf-interceptor.test.ts`

## F015 - Agent Observability

- RFC: [docs/specs/rfcs/RFC-015-agent-observability.md](/docs/specs/rfcs/RFC-015-agent-observability.md)
- File count in scope: **48**
- Included code paths:
  - `apps/studio/src/components/observatory/`
  - `apps/studio/src/components/traces/`
  - `apps/studio/src/app/api/archives/`
  - `apps/runtime/src/observability/`
  - `apps/runtime/src/services/trace/`
  - `packages/observatory/`
  - `apps/observatory-cli/`
  - `packages/database/src/models/debug-token.model.ts`
  - `packages/database/src/models/archive-*.model.ts`
- Sample files:
  - `apps/observatory-cli/package.json`
  - `apps/observatory-cli/src/client/debug-client.ts`
  - `apps/observatory-cli/src/client/repl.ts`
  - `apps/observatory-cli/src/index.ts`
  - `apps/observatory-cli/tsconfig.json`
  - `apps/runtime/src/observability/metrics.ts`
  - `apps/runtime/src/observability/otel-setup.ts`
  - `apps/runtime/src/observability/otel-trace-bridge.ts`
  - `apps/runtime/src/observability/voice-metrics.ts`
  - `apps/runtime/src/observability/voice-trace.ts`

## F016 - System Observability and Reliability

- RFC: [docs/specs/rfcs/RFC-016-system-observability-reliability.md](/docs/specs/rfcs/RFC-016-system-observability-reliability.md)
- File count in scope: **167**
- Included code paths:
  - `apps/studio/src/components/analytics/`
  - `apps/studio/src/components/alerts/`
  - `apps/studio/src/app/api/audit/`
  - `apps/studio/src/app/api/pipelines/`
  - `apps/studio/src/app/api/admin/alerts/`
  - `apps/studio/src/app/api/runtime/analytics/`
  - `apps/runtime/src/routes/analytics.ts`
  - `apps/runtime/src/routes/pipeline-analytics.ts`
  - `apps/runtime/src/routes/pipeline-config.ts`
  - `apps/runtime/src/routes/nl-analytics.ts`
  - `apps/runtime/src/routes/alerts.ts`
  - `apps/runtime/src/routes/alert-config.ts`
  - `apps/runtime/src/routes/experiments.ts`
  - `apps/runtime/src/routes/custom-events.ts`
  - `apps/runtime/src/routes/external-events.ts`
  - `apps/runtime/src/routes/roi.ts`
  - `apps/runtime/src/routes/tags.ts`
  - `apps/runtime/src/services/pipeline/`
  - `apps/runtime/src/services/diagnostics/`
  - `apps/runtime/src/services/event-bus/`
  - `apps/runtime/src/services/resilience/`
  - `packages/eventstore/`
  - `packages/circuit-breaker/`
  - `packages/database/src/models/audit-log.model.ts`
  - `packages/database/src/models/alert-config.model.ts`
  - `packages/database/src/models/llm-usage-metric.model.ts`
  - `packages/database/src/models/org-profile-metric.model.ts`
  - `packages/database/src/models/usage-period.model.ts`
- Sample files:
  - `apps/runtime/src/routes/alert-config.ts`
  - `apps/runtime/src/routes/alerts.ts`
  - `apps/runtime/src/routes/analytics.ts`
  - `apps/runtime/src/routes/custom-events.ts`
  - `apps/runtime/src/routes/experiments.ts`
  - `apps/runtime/src/routes/external-events.ts`
  - `apps/runtime/src/routes/nl-analytics.ts`
  - `apps/runtime/src/routes/pipeline-analytics.ts`
  - `apps/runtime/src/routes/pipeline-config.ts`
  - `apps/runtime/src/routes/roi.ts`

## F017 - Developer Tooling MCP LSP CLI

- RFC: [docs/specs/rfcs/RFC-017-developer-tooling-mcp-lsp-cli.md](/docs/specs/rfcs/RFC-017-developer-tooling-mcp-lsp-cli.md)
- File count in scope: **265**
- Included code paths:
  - `packages/kore-platform-cli/`
  - `packages/mcp-debug/`
  - `packages/abl-lsp-server/`
  - `packages/abl-vscode/`
  - `packages/openapi/`
  - `packages/web-sdk/`
  - `examples/`
  - `apps/studio/src/app/api/openapi/`
  - `apps/studio/src/components/docs/`
  - `apps/studio/src/app/docs/`
  - `packages/database/src/models/api-key.model.ts`
  - `packages/database/src/models/public-api-key.model.ts`
  - `packages/database/src/models/widget-config.model.ts`
  - `packages/database/src/models/sdk-channel.model.ts`
  - `packages/database/src/models/device-auth-request.model.ts`
- Sample files:
  - `apps/studio/src/app/api/openapi/route.ts`
  - `apps/studio/src/app/api/openapi/spec.json/route.ts`
  - `apps/studio/src/app/docs/abl/page.tsx`
  - `apps/studio/src/components/docs/ABLDocsPage.tsx`
  - `examples/DisputeTransaction/README.md`
  - `examples/DisputeTransaction/agents/agent_transfer.agent.abl`
  - `examples/DisputeTransaction/agents/dispute.agent.abl`
  - `examples/DisputeTransaction/agents/feedback_agent.agent.abl`
  - `examples/DisputeTransaction/supervisor.agent.abl`
  - `examples/agent-transfer/agents/customer-support.agent.abl`

## F004 - ABL Language and Compiler

- RFC: [docs/specs/rfcs/RFC-004-abl-language-compiler.md](/docs/specs/rfcs/RFC-004-abl-language-compiler.md)
- File count in scope: **451**
- Included code paths:
  - `apps/studio/src/components/abl/`
  - `apps/studio/src/app/api/abl/`
  - `packages/core/`
  - `packages/compiler/`
  - `packages/analyzer/`
  - `packages/editor/`
  - `packages/language-service/`
  - `packages/nl-parser/`
- Sample files:
  - `apps/studio/src/app/api/abl/analysis/route.ts`
  - `apps/studio/src/app/api/abl/compile/route.ts`
  - `apps/studio/src/app/api/abl/diagnostics/route.ts`
  - `apps/studio/src/app/api/abl/docs/route.ts`
  - `apps/studio/src/app/api/abl/parse/route.ts`
  - `apps/studio/src/components/abl/ABLDiagnosticsPanel.tsx`
  - `apps/studio/src/components/abl/ABLEditor.tsx`
  - `apps/studio/src/components/abl/ABLSymbolTree.tsx`
  - `apps/studio/src/components/abl/AgentSelector.tsx`
  - `apps/studio/src/components/abl/IRViewer.tsx`

## F002 - Runtime Core Orchestration

- RFC: [docs/specs/rfcs/RFC-002-runtime-core-orchestration.md](/docs/specs/rfcs/RFC-002-runtime-core-orchestration.md)
- File count in scope: **961**
- Included code paths:
  - `apps/runtime/`
  - `packages/execution/`
  - `packages/llm/`
  - `packages/shared/`
- Sample files:
  - `apps/runtime/.dockerignore`
  - `apps/runtime/.env.example`
  - `apps/runtime/.env.template`
  - `apps/runtime/Dockerfile`
  - `apps/runtime/TODO-voice.md`
  - `apps/runtime/package.json`
  - `apps/runtime/src/__tests__/TEST_INDEX.md`
  - `apps/runtime/src/__tests__/abl-type-to-json-schema.test.ts`
  - `apps/runtime/src/__tests__/actions-channel-roundtrip.test.ts`
  - `apps/runtime/src/__tests__/adapters/ag-ui-adapter.test.ts`

## F019 - Admin and Governance Surfaces

- RFC: [docs/specs/rfcs/RFC-019-admin-governance-surfaces.md](/docs/specs/rfcs/RFC-019-admin-governance-surfaces.md)
- File count in scope: **207**
- Included code paths:
  - `apps/admin/`
  - `apps/telco-noc/`
  - `packages/admin-ui/`
  - `apps/studio/src/components/admin/`
  - `apps/studio/src/app/api/platform-admin/`
  - `apps/studio/src/app/api/tenant-models/`
  - `apps/studio/src/app/api/tenant-credentials/`
  - `apps/studio/src/app/api/tenant-usage/`
  - `apps/studio/src/app/api/workspaces/`
  - `apps/studio/src/app/api/organizations/`
  - `apps/runtime/src/routes/platform-admin-*.ts`
  - `apps/runtime/src/routes/tenant-*.ts`
  - `apps/runtime/src/routes/workspace-billing.ts`
  - `apps/runtime/src/routes/kms-admin.ts`
  - `apps/runtime/src/routes/model-catalog.ts`
  - `apps/runtime/src/routes/model-capabilities.ts`
  - `apps/runtime/src/routes/project-llm-config.ts`
  - `apps/runtime/src/routes/project-settings.ts`
  - `apps/runtime/src/routes/project-runtime-config.ts`
  - `apps/runtime/src/routes/deployments.ts`
  - `apps/runtime/src/routes/environment-variables.ts`
  - `packages/database/src/models/tenant*.model.ts`
  - `packages/database/src/models/org-*.model.ts`
  - `packages/database/src/models/organization.model.ts`
  - `packages/database/src/models/project-*.model.ts`
  - `packages/database/src/models/resource-*.model.ts`
  - `packages/database/src/models/role-definition.model.ts`
  - `packages/database/src/models/team.model.ts`
  - `packages/database/src/models/workspace-invitation.model.ts`
  - `packages/database/src/models/llm-credential.model.ts`
  - `packages/database/src/models/model-config.model.ts`
  - `packages/database/src/models/materialized-kms-config.model.ts`
  - `packages/database/src/models/tenant-kms-config.model.ts`
- Sample files:
  - `apps/admin/.auth/admin.json`
  - `apps/admin/.dockerignore`
  - `apps/admin/.env.example`
  - `apps/admin/Dockerfile`
  - `apps/admin/e2e/admin-pages.spec.ts`
  - `apps/admin/e2e/auth.setup.ts`
  - `apps/admin/e2e/screenshots/audit.png`
  - `apps/admin/e2e/screenshots/config-overrides.png`
  - `apps/admin/e2e/screenshots/config.png`
  - `apps/admin/e2e/screenshots/dashboard.png`

## F001 - Studio Core Control Plane

- RFC: [docs/specs/rfcs/RFC-001-studio-core-control-plane.md](/docs/specs/rfcs/RFC-001-studio-core-control-plane.md)
- File count in scope: **853**
- Included code paths:
  - `apps/studio/`
  - `apps/spec-mock/`
- Sample files:
  - `apps/spec-mock/next-env.d.ts`
  - `apps/spec-mock/next.config.js`
  - `apps/spec-mock/package.json`
  - `apps/spec-mock/postcss.config.js`
  - `apps/spec-mock/src/app/globals.css`
  - `apps/spec-mock/src/app/layout.tsx`
  - `apps/spec-mock/src/app/page.tsx`
  - `apps/spec-mock/src/app/project/agents/[agentId]/page.tsx`
  - `apps/spec-mock/src/app/project/agents/page.tsx`
  - `apps/spec-mock/src/app/project/architect/page.tsx`

## F020 - Data Platform and Persistence

- RFC: [docs/specs/rfcs/RFC-020-data-platform-persistence.md](/docs/specs/rfcs/RFC-020-data-platform-persistence.md)
- File count in scope: **171**
- Included code paths:
  - `packages/database/`
- Sample files:
  - `packages/database/package.json`
  - `packages/database/prisma/data/dev.db`
  - `packages/database/prisma/data/runtime.db`
  - `packages/database/seed-mongo.ts`
  - `packages/database/src/__tests__/arch-workspace-config.test.ts`
  - `packages/database/src/__tests__/attachment-model.test.ts`
  - `packages/database/src/__tests__/clickhouse-writer.test.ts`
  - `packages/database/src/__tests__/encryption-plugin-kms.test.ts`
  - `packages/database/src/__tests__/encryption-plugin-v3.test.ts`
  - `packages/database/src/__tests__/helpers/setup-mongo.ts`

## F021 - Sandboxed Code Execution

- RFC: [docs/specs/rfcs/RFC-021-sandboxed-code-execution.md](/docs/specs/rfcs/RFC-021-sandboxed-code-execution.md)
- File count in scope: **27**
- Included code paths:
  - `services/codetool-sandbox/`
- Sample files:
  - `services/codetool-sandbox/Dockerfile`
  - `services/codetool-sandbox/custom_logger_js/context.js`
  - `services/codetool-sandbox/custom_logger_js/index.js`
  - `services/codetool-sandbox/custom_logger_js/package.json`
  - `services/codetool-sandbox/custom_logger_py/lib/korelogger-0.1.0-py3-none-any.whl`
  - `services/codetool-sandbox/memory_service_sdk-0.1.0-py3-none-any.whl`
  - `services/codetool-sandbox/requirements.txt`
  - `services/codetool-sandbox/requirements_codetool.txt`
  - `services/codetool-sandbox/runtime/__init__.py`
  - `services/codetool-sandbox/runtime/main.py`

## F022 - Platform Foundations and Shared Config

- RFC: [docs/specs/rfcs/RFC-022-platform-foundations-shared-config.md](/docs/specs/rfcs/RFC-022-platform-foundations-shared-config.md)
- File count in scope: **105**
- Included code paths:
  - `packages/config/`
  - `packages/i18n/`
  - `packages/sizing-calculator/`
  - `packages/tailwind-config/`
  - `packages/apps/`
- Sample files:
  - `packages/config/package.json`
  - `packages/config/src/__tests__/env-mapping.test.ts`
  - `packages/config/src/__tests__/environment.test.ts`
  - `packages/config/src/__tests__/loader.test.ts`
  - `packages/config/src/__tests__/schemas.test.ts`
  - `packages/config/src/__tests__/sealer.test.ts`
  - `packages/config/src/__tests__/tenant-config-types.test.ts`
  - `packages/config/src/__tests__/validation/production-checks.test.ts`
  - `packages/config/src/__tests__/vault/composite-provider.test.ts`
  - `packages/config/src/__tests__/vault/providers.test.ts`

## F023 - Infrastructure Delivery and Operations

- RFC: [docs/specs/rfcs/RFC-023-infrastructure-delivery-operations.md](/docs/specs/rfcs/RFC-023-infrastructure-delivery-operations.md)
- File count in scope: **129**
- Included code paths:
  - `deploy/`
  - `benchmarks/`
  - `scripts/`
  - `docker/`
  - `tools/`
  - `.harness/`
  - `.husky/`
  - `package.json`
  - `pnpm-lock.yaml`
  - `pnpm-workspace.yaml`
  - `turbo.json`
  - `tsconfig.json`
  - `docker-compose.yml`
  - `ecosystem.config.js`
  - `vercel.json`
  - `commitlint.config.ts`
  - `coverage-thresholds.json`
  - `.dependency-cruiser.cjs`
  - `.editorconfig`
  - `.gitattributes`
  - `.gitignore`
  - `.gitleaks.toml`
  - `.lintstagedrc.json`
  - `.mcp.json`
  - `.prettierignore`
  - `.prettierrc.json`
  - `.trivyignore`
  - `apx`
- Sample files:
  - `.dependency-cruiser.cjs`
  - `.editorconfig`
  - `.gitattributes`
  - `.gitignore`
  - `.gitleaks.toml`
  - `.harness/pipelines/ci-build.yaml`
  - `.harness/templates/docker-build-node-app.yaml`
  - `.harness/templates/docker-build-python-service.yaml`
  - `.harness/templates/docker-build-standalone-app.yaml`
  - `.husky/commit-msg`
