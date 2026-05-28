# RFC-003: Threaded Sessions and Memory

- Status: Draft (5-level deep functional specification)
- Feature ID: F003
- Focus: Threaded session continuity, message memory, and contact context
- Covered files in feature map: 112
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Threaded session continuity, message memory, and contact context** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (98 files)
  - packages (14 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)       | File Count | Purpose                                                             |
| ----------------- | ---------: | ------------------------------------------------------------------- |
| apps/runtime      |         86 | Operational subdomain contributing to Threaded Sessions and Memory. |
| apps/studio       |         12 | Operational subdomain contributing to Threaded Sessions and Memory. |
| packages/shared   |          8 | Operational subdomain contributing to Threaded Sessions and Memory. |
| packages/database |          6 | Operational subdomain contributing to Threaded Sessions and Memory. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Session resume after interruption
- Flow 2: Attachment-linked conversation turn
- Flow 3: Memory API read/write lifecycle

### 3.2 API and Route Surface

- App-route endpoints discovered: 7
  - /api/projects/[id]/sessions
  - /api/runtime/sessions/[id]/attachments
  - /api/runtime/sessions/[id]/close
  - /api/runtime/sessions/[id]
  - /api/runtime/sessions/[id]/traces
  - /api/runtime/sessions/bulk-close
  - /api/runtime/sessions

- Router method inventory (module-level):
  - apps/runtime/src/routes/attachments.ts
    - POST /
    - GET /
    - GET /:attachmentId
    - GET /:attachmentId/url
    - GET /:attachmentId/status
    - DELETE /:attachmentId
  - apps/runtime/src/routes/contact-merge.ts
    - POST /merge
    - POST /:id/self-merge
    - DELETE /:id/gdpr
  - apps/runtime/src/routes/contacts.ts
    - GET /:id/history
  - apps/runtime/src/routes/memory-api.ts
    - POST /api/v1/memory
  - apps/runtime/src/routes/merge-suggestions.ts
    - GET /
    - PUT /:id
  - apps/runtime/src/routes/sessions.ts
    - POST /bulk-close
    - POST /cleanup-orphans
    - POST /:id/close
    - GET /:id/messages

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                    |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     5 | apps/studio/src/components/session/AgentConversationTree.tsx<br/>apps/studio/src/components/session/SessionDetailPage.tsx<br/>apps/studio/src/components/session/SessionSummaryPanel.tsx                                    |
| Services                       |    32 | apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts<br/>apps/runtime/src/services/metadata/custom-dimensions.ts<br/>apps/runtime/src/services/session/compaction-engine.ts                               |
| Routes / Route Modules         |    14 | apps/runtime/src/routes/attachments.ts<br/>apps/runtime/src/routes/contact-merge.ts<br/>apps/runtime/src/routes/contacts.ts                                                                                                 |
| Data Models                    |     6 | packages/database/src/models/attachment.model.ts<br/>packages/database/src/models/channel-session.model.ts<br/>packages/database/src/models/contact.model.ts                                                                |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                                         |
| Tests                          |     3 | apps/runtime/src/attachments/**tests**/message-preprocessor.test.ts<br/>apps/runtime/src/attachments/**tests**/multimodal-service-client.test.ts<br/>apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts |

### 4.2 Detailed Implementation Paths

- apps/runtime/src
- apps/studio/src
- packages/shared/src
- packages/database/src
- apps/runtime/src/routes/attachments.ts
- apps/runtime/src/routes/contact-merge.ts
- apps/runtime/src/routes/contacts.ts
- apps/runtime/src/routes/memory-api.ts
- apps/runtime/src/routes/merge-suggestions.ts
- apps/runtime/src/routes/sessions.ts
- apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts
- apps/runtime/src/services/metadata/custom-dimensions.ts
- apps/runtime/src/services/session/compaction-engine.ts
- apps/runtime/src/services/session/index.ts
- apps/runtime/src/services/session/ir-cache.ts
- apps/runtime/src/services/session/memory-session-store.ts
- packages/database/src/models/attachment.model.ts
- packages/database/src/models/channel-session.model.ts
- packages/database/src/models/contact.model.ts
- packages/database/src/models/merge-suggestion.model.ts
- packages/database/src/models/message.model.ts
- packages/database/src/models/session.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 3
  - apps/runtime/src/attachments/**tests**/message-preprocessor.test.ts
  - apps/runtime/src/attachments/**tests**/multimodal-service-client.test.ts
  - apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Session resume after interruption

- Level 1 (Outcome): Deliver Threaded Sessions and Memory business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, apps/studio, packages/shared).
- Level 3 (Flow): Realize workflow stage "Session resume after interruption" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, apps/studio/src, packages/shared/src.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/attachments/**tests**/message-preprocessor.test.ts, apps/runtime/src/attachments/**tests**/multimodal-service-client.test.ts, apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts.

#### Scenario 2: Attachment-linked conversation turn

- Level 1 (Outcome): Deliver Threaded Sessions and Memory business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, apps/studio, packages/shared).
- Level 3 (Flow): Realize workflow stage "Attachment-linked conversation turn" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/shared/src, packages/database/src, apps/runtime/src/routes/attachments.ts.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/services/metadata/**tests**/custom-dimensions.test.ts.

#### Scenario 3: Memory API read/write lifecycle

- Level 1 (Outcome): Deliver Threaded Sessions and Memory business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/runtime, apps/studio, packages/shared).
- Level 3 (Flow): Realize workflow stage "Memory API read/write lifecycle" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src/routes/attachments.ts, apps/runtime/src/routes/contact-merge.ts, apps/runtime/src/routes/contacts.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F003 are represented in this feature's decomposition.
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
