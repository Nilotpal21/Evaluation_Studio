# RFC-002: Runtime Core Orchestration

- Status: Draft (5-level deep functional specification)
- Feature ID: F002
- Focus: Runtime execution core, channel orchestration, and API ingress
- Covered files in feature map: 1153
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Runtime execution core, channel orchestration, and API ingress** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (1016 files)
  - packages (137 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)        | File Count | Purpose                                                           |
| ------------------ | ---------: | ----------------------------------------------------------------- |
| apps/runtime       |       1016 | Operational subdomain contributing to Runtime Core Orchestration. |
| packages/shared    |        118 | Operational subdomain contributing to Runtime Core Orchestration. |
| packages/execution |         14 | Operational subdomain contributing to Runtime Core Orchestration. |
| packages/llm       |          5 | Operational subdomain contributing to Runtime Core Orchestration. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Request ingress to response
- Flow 2: Runtime configuration application
- Flow 3: Channel adapter execution

### 3.2 API and Route Surface

- No app-route style endpoints directly matched in this feature scope.

- Router method inventory (module-level):
  - apps/runtime/src/routes/admin-sessions.ts
    - GET /stats
    - GET /
    - GET /:sessionId
  - apps/runtime/src/routes/agent-transfer-webhooks.ts
    - POST /:provider
  - apps/runtime/src/routes/alert-config.ts
    - GET /
    - POST /
    - PATCH /:id
    - DELETE /:id
  - apps/runtime/src/routes/attachments.ts
    - POST /
    - GET /
    - GET /:attachmentId
    - GET /:attachmentId/url
    - GET /:attachmentId/status
    - DELETE /:attachmentId
  - apps/runtime/src/routes/channel-audiocodes.ts
    - GET /webhook/:identifier
    - POST /webhook/:identifier
    - POST /webhook/:identifier/conversation/:conversationId/activities
    - POST /webhook/:identifier/conversation/:conversationId/refresh
    - POST /webhook/:identifier/conversation/:conversationId/disconnect
  - apps/runtime/src/routes/channel-connections.ts
    - POST /
    - GET /
    - GET /sbc-address
    - GET /:id
    - PATCH /:id
    - DELETE /:id
  - apps/runtime/src/routes/channel-genesys.ts
    - POST /hooks/:streamId
  - apps/runtime/src/routes/channel-vxml.ts
    - POST /hooks/:streamId
  - apps/runtime/src/routes/channel-webhooks.ts
    - GET /:channelType/webhook
    - POST /:channelType/:provider/webhook
    - POST /:channelType/:provider/webhook/:connectionIdentifier
    - POST /:channelType/webhook
    - POST /slack/slash/:connectionIdentifier
    - POST /:channelType/webhook/:connectionIdentifier
  - apps/runtime/src/routes/contact-merge.ts
    - POST /merge
    - POST /:id/self-merge
    - DELETE /:id/gdpr
  - apps/runtime/src/routes/contacts.ts
    - GET /:id/history
  - apps/runtime/src/routes/feedback.ts
    - GET /:token
  - apps/runtime/src/routes/guardrail-policies.ts
    - GET /
    - POST /
    - GET /:id
    - PUT /:id
    - POST /:id/activate
    - DELETE /:id
  - apps/runtime/src/routes/guardrail-providers.ts
    - GET /
    - POST /
    - GET /:id
    - PUT /:id
    - DELETE /:id
    - POST /:id/test
  - apps/runtime/src/routes/http-async-channel.ts
    - POST /subscribe
    - GET /subscriptions
    - GET /subscriptions/:id
    - PATCH /subscriptions/:id
    - DELETE /subscriptions/:id
    - POST /message
    - GET /subscriptions/:id/deliveries
    - GET /deliveries/:id
  - apps/runtime/src/routes/human-tasks.ts
    - GET /
    - GET /:taskId
    - POST /:taskId/assign
    - POST /:taskId/claim
    - POST /:taskId/resolve
  - apps/runtime/src/routes/identity-verification.ts
    - POST /initiate
    - POST /complete
    - GET /:attemptId
  - apps/runtime/src/routes/kms-admin.ts
    - GET /config
    - PUT /config
    - POST /validate
    - GET /keys
    - POST /keys/rotate
    - GET /audit
    - GET /health
  - apps/runtime/src/routes/memory-api.ts
    - POST /api/v1/memory
  - apps/runtime/src/routes/merge-suggestions.ts
    - GET /
    - PUT /:id
  - apps/runtime/src/routes/platform-admin-config.ts
    - GET /plans
    - GET /
    - GET /:tenantId
    - PUT /:tenantId/overrides
    - DELETE /:tenantId/overrides
    - PUT /:tenantId/projects/:projectId/overrides
    - DELETE /:tenantId/projects/:projectId/overrides
  - apps/runtime/src/routes/platform-admin-deals.ts
    - GET /
    - POST /
    - GET /:id
    - PATCH /:id
    - POST /:id/assign
    - GET /:id/credits
    - POST /:id/credits/topup
    - GET /:id/line-items
  - apps/runtime/src/routes/platform-admin-features.ts
    - GET /catalog
    - GET /tenants/:tenantId/features
  - apps/runtime/src/routes/platform-admin-health.ts
    - GET /
  - ... +10 additional route modules with methods

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                       |
| ------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                                            |
| Services                       |   244 | apps/runtime/src/services/**tests**/project-config.test.ts<br/>apps/runtime/src/services/**tests**/tenant-config.test.ts<br/>apps/runtime/src/services/adapters/agent-registry-adapter.ts      |
| Routes / Route Modules         |    79 | apps/runtime/src/**tests**/routes/contacts-history.test.ts<br/>apps/runtime/src/**tests**/routes/sessions-messages-cursor.test.ts<br/>apps/runtime/src/routes/**tests**/admin-sessions.test.ts |
| Data Models                    |     0 | N/A                                                                                                                                                                                            |
| Workers / Executors / Pipeline |    33 | apps/runtime/src/**tests**/deployment-pipeline.e2e.test.ts<br/>apps/runtime/src/**tests**/extraction-pipeline.test.ts<br/>apps/runtime/src/**tests**/flow-transform-pipeline.test.ts           |
| Tests                          |   595 | apps/runtime/src/**tests**/TEST_INDEX.md<br/>apps/runtime/src/**tests**/abl-type-to-json-schema.test.ts<br/>apps/runtime/src/**tests**/actions-channel-roundtrip.test.ts                       |

### 4.2 Detailed Implementation Paths

- apps/runtime/src
- packages/shared/src
- packages/execution/src
- packages/llm/src
- apps/runtime/.dockerignore
- apps/runtime/.env.example
- apps/runtime/src/**tests**/routes/contacts-history.test.ts
- apps/runtime/src/**tests**/routes/sessions-messages-cursor.test.ts
- apps/runtime/src/routes/**tests**/admin-sessions.test.ts
- apps/runtime/src/routes/**tests**/platform-admin-models.test.ts
- apps/runtime/src/routes/admin-sessions.ts
- apps/runtime/src/routes/agent-model-config.ts
- apps/runtime/src/services/**tests**/project-config.test.ts
- apps/runtime/src/services/**tests**/tenant-config.test.ts
- apps/runtime/src/services/adapters/agent-registry-adapter.ts
- apps/runtime/src/services/adapters/index.ts
- apps/runtime/src/services/adapters/service-node-executor.ts
- apps/runtime/src/services/adapters/tool-executor-adapter.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 595
  - apps/runtime/src/**tests**/TEST_INDEX.md
  - apps/runtime/src/**tests**/abl-type-to-json-schema.test.ts
  - apps/runtime/src/**tests**/actions-channel-roundtrip.test.ts
  - apps/runtime/src/**tests**/adapters/ag-ui-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/audiocodes-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/audiocodes-ws-manager.test.ts
  - apps/runtime/src/**tests**/adapters/email-attachment-processor.test.ts
  - apps/runtime/src/**tests**/adapters/genesys-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/gupshup-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/gupshup-provider.test.ts
  - apps/runtime/src/**tests**/adapters/infobip-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/infobip-provider.test.ts
  - apps/runtime/src/**tests**/adapters/instagram-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/instagram-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/instagram-media-processor.test.ts
  - apps/runtime/src/**tests**/adapters/messenger-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/messenger-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/messenger-media-processor.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-auth.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-file-attachments.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-file-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-file-processor.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-stream-buffer.test.ts
  - apps/runtime/src/**tests**/adapters/msteams-stream-client.test.ts
  - apps/runtime/src/**tests**/adapters/netcore-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/netcore-provider.test.ts
  - apps/runtime/src/**tests**/adapters/slack-file-attachments.test.ts
  - apps/runtime/src/**tests**/adapters/slack-file-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/slack-stream-buffer.test.ts
  - apps/runtime/src/**tests**/adapters/slack-stream-client.test.ts
  - apps/runtime/src/**tests**/adapters/slack-transform.test.ts
  - apps/runtime/src/**tests**/adapters/teams-transform.test.ts
  - apps/runtime/src/**tests**/adapters/twilio-sms-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/twilio-sms-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/twilio-sms-media-processor.test.ts
  - apps/runtime/src/**tests**/adapters/whatsapp-adapter.test.ts
  - apps/runtime/src/**tests**/adapters/whatsapp-file-attachments.test.ts
  - apps/runtime/src/**tests**/adapters/whatsapp-media-downloader.test.ts
  - apps/runtime/src/**tests**/adapters/whatsapp-media-processor.test.ts
  - apps/runtime/src/**tests**/adapters/zendesk-adapter.test.ts
  - ... +555 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Request ingress to response

- Level 1 (Outcome): Deliver Runtime Core Orchestration business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, packages/shared, packages/execution).
- Level 3 (Flow): Realize workflow stage "Request ingress to response" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, packages/shared/src, packages/execution/src.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/**tests**/TEST_INDEX.md, apps/runtime/src/**tests**/abl-type-to-json-schema.test.ts, apps/runtime/src/**tests**/actions-channel-roundtrip.test.ts.

#### Scenario 2: Runtime configuration application

- Level 1 (Outcome): Deliver Runtime Core Orchestration business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, packages/shared, packages/execution).
- Level 3 (Flow): Realize workflow stage "Runtime configuration application" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/execution/src, packages/llm/src, apps/runtime/.dockerignore.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/**tests**/actions-channel-roundtrip.test.ts, apps/runtime/src/**tests**/adapters/ag-ui-adapter.test.ts, apps/runtime/src/**tests**/adapters/audiocodes-adapter.test.ts.

#### Scenario 3: Channel adapter execution

- Level 1 (Outcome): Deliver Runtime Core Orchestration business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, packages/shared, packages/execution).
- Level 3 (Flow): Realize workflow stage "Channel adapter execution" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/.dockerignore, apps/runtime/.env.example, apps/runtime/src/**tests**/routes/contacts-history.test.ts.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/**tests**/adapters/audiocodes-adapter.test.ts, apps/runtime/src/**tests**/adapters/audiocodes-ws-manager.test.ts, apps/runtime/src/**tests**/adapters/email-attachment-processor.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F002 are represented in this feature's decomposition.
- AC-002: Each primary flow has route/module/test traceability.
- AC-003: Security and boundary assumptions are explicit for this feature.
- AC-004: Adjacent-feature ownership boundaries are preserved by feature-map mapping rules.

## 6. Security, Compliance, and Risk Controls

- Identity and tenancy boundaries are enforced through mapped auth/middleware routes where present.
- Sensitive data handling is constrained to mapped secure services/models in this feature boundary.
- Operational risks are mitigated through mapped tests, validation scripts, and route error handling.

## 7. Traceability

- Feature map: `docs/specs/feature-map.json`
- Coverage summary: `docs/specs/CODE_COVERAGE_SUMMARY.md`
- File matrix: `docs/specs/CODE_COVERAGE_MATRIX.csv`
