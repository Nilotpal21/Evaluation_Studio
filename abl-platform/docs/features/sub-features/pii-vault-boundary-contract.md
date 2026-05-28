# Feature: PII Vault Boundary Contract

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Guardrails — Sensitive Data Block](guardrails-sensitive-data-block.md)
**Status**: BETA
**Feature Area(s)**: `governance`, `enterprise`, `customer experience`
**Package(s)**: `packages/compiler`, `packages/shared-kernel`, `packages/i18n`, `apps/runtime`, `apps/studio`
**Owner(s)**: Product — Girish; Eng — TBD
**Testing Guide**: `../../testing/sub-features/pii-vault-boundary-contract.md`
**Last Updated**: 2026-05-20

---

## 1. Introduction / Overview

### Problem Statement

The ABL runtime's PII vault promises per-consumer rendering: tools receive the original plaintext (when configured), the LLM receives opaque tokens, users see masked values, and logs see redacted labels. In practice, the runtime breaks this contract in six distinct but architecturally related ways:

1. **Tools always get `[REDACTED_*]`** regardless of configuration, because `resolveRenderMode('tools')` is hardcoded to return `'redacted'` (`pii-vault.ts:477`).
2. **No `'original'` value exists** in the `pii_access` enum (`schema.ts:1003`), so there is no way for an agent author to explicitly opt a tool into plaintext access.
3. **Studio labels `'tools'` as "Original"** (`ToolsSection.tsx:531`, `ToolsEditor.tsx:437`), misleading users into thinking they are granting plaintext access when the runtime delivers redacted values.
4. **LLMs strip the `{{PII:type:UUID}}` wrapper**, emitting bare UUIDs in tool-call arguments. No bare-UUID restoration logic exists, so the tool receives a random UUID string that matches nothing.
5. **User UI displays masked UUIDs** instead of masked originals when the LLM strips the wrapper — the user sees meaningless random text.
6. **Studio Tool Test UI bypasses PII entirely** (`internal-tools.ts:462-479`) — tools receive raw values in test mode but redacted values in live execution, making test results unreliable.

All six manifestations stem from one architectural defect: the vault's consumer-access contract was designed with the right abstraction (`PIIConsumer` + `PIIRenderMode` + `PIIPatternConfig`) but the implementation never wired a pathway for authorized plaintext dispense to tools, never handled LLM-initiated wrapper stripping, and the UI was built against the aspirational contract rather than the actual behavior.

### Goal Statement

Implement the full PII vault boundary contract so that every consumer receives exactly the rendering mode configured by the agent author: tools configured for `'original'` access receive plaintext with mandatory audit logging; tools configured for `'tools'` (default) receive redacted values; bare UUIDs emitted by LLMs are restored from the session vault before tool dispatch; user-side rendering masks the original value (not the token UUID); and the Studio Tool Test UI produces results identical to live execution.

### Summary

This feature adds `'original'` to the `pii_access` enum, fixes `resolveRenderMode()` to honor it, introduces bare-UUID restoration in the tool execution path, emits a `pii_plaintext_dispensed` audit trace event on every plaintext dispense, corrects the Studio UI labels, and wires PII context into the Tool Test route. The `'tools'` consumer default remains `'redacted'` (secure by default). The `'llm'` consumer remains forced to `'tokenized'` (security baseline). Pre-launch posture means zero migration debt.

---

## 2. Scope

### Goals

1. Tools configured with `pii_access: 'original'` receive plaintext values, with every dispense audit-logged.
2. Tools configured with `pii_access: 'tools'` (default) receive `[REDACTED_*]` labels — secure by default.
3. The `'llm'` consumer is forced to `'tokenized'` — no opt-out (security baseline).
4. Bare UUIDs emitted by LLMs in tool-call arguments are restored from the current session's vault before tool dispatch.
5. Studio PII Access dropdown labels accurately reflect the rendering behavior (`'original'` = "Original (plaintext)", `'tools'` = "Redacted").
6. Studio Tool Test UI produces the same PII rendering as live execution.
7. Every `'original'` plaintext dispense emits a `pii_plaintext_dispensed` trace event and a `PIIAuditLogger` entry.
8. The `pii-patterns` route uses project-scoped RBAC (`requireProjectPermission`).

### Non-Goals (Out of Scope)

1. Full PII vault rendering in the workflow engine tool dispatch path. The workflow engine (`apps/workflow-engine/src/index.ts`) dispatches tool params to `/api/internal/tools/execute` without PII vault rendering because it does not hold a session-scoped vault. A lightweight PII detection scanner (F-7) emits `workflow_unprotected_pii_dispatched` trace events when PII patterns are detected in params, but no redaction or tokenization is applied. Full rendering is a future work item. The flow-step-executor path (`restorePIITokensForTrustedInternalExecution → vault.detokenize()`) is unaffected — it runs within the runtime where the vault is available.
2. Adding bare-UUID restoration to the user-render path (`protectSessionOutputForUser`). If the LLM strips the wrapper in its response text, the user seeing a UUID is accepted degradation. The tool path handles restoration; user-render does not.
3. Changing the PII detection engine (`pii-detector.ts`, `PIIRecognizerRegistry`) or the vault's storage model.
4. Cross-session UUID matching. Bare-UUID restoration is strictly confined to the current session's vault entries. Cross-session matching would be an information-leakage vector.
5. Customer migration tooling. Pre-launch posture — no production agents to migrate.
6. Changing Settings -> PII Protection behavior beyond what is required for the boundary contract fix.

---

## 3. User Stories

1. As an **AI Engineer** building a customer-care agent, I want to configure a CRM lookup tool's PII access to "Original (plaintext)" so that the tool can query the CRM with the customer's real phone number, and I want an audit log entry for every such plaintext dispense so compliance can review access patterns.

2. As a **Compliance Lead** auditing an agent's PII handling, I want to see a `pii_plaintext_dispensed` trace event in the session trace every time a tool receives plaintext PII, including the entity type and a hash of the value (never the raw value), so that I can verify the agent's PII exposure surface without accessing the data itself.

3. As an **AI Engineer** debugging a tool integration, I want the Studio Tool Test UI to process PII the same way live execution does, so that test results match production behavior and I do not ship a tool that works in test but fails in production.

4. As a **Project Owner** configuring tool PII access in Studio, I want the dropdown labels to accurately describe what each option does — "Original (plaintext)" for plaintext, "Redacted" for `[REDACTED_*]`, "Masked" for `***-***-1234`, "Tokenized" for `{{PII:type:uuid}}` — so that I can make an informed security decision without reading documentation.

5. As an **AI Engineer** building an agent where the LLM sometimes strips PII token wrappers, I want the runtime to detect bare UUIDs that match vault entries in the current session and restore them before dispatching to the tool, so that tool calls succeed even when the LLM does not perfectly preserve the token format.

---

## 4. Functional Requirements

1. **FR-1**: The system must add `'original'` to the `pii_access` enum in the Agent IR schema, representing explicit plaintext access for tools with mandatory audit logging.

2. **FR-2**: The system must update `resolveRenderMode()` so that:
   - `'original'` consumer returns render mode `'original'` (plaintext).
   - `'tools'` consumer returns render mode `'redacted'` (secure default, unchanged).
   - `'llm'` consumer returns render mode `'tokenized'` (security baseline, unchanged).
   - `'user'` consumer returns render mode `'masked'` (unchanged).
   - `'logs'` consumer returns render mode `'redacted'` (unchanged).
   - Pattern-level `consumerAccess` overrides continue to take precedence.

3. **FR-3**: The system must update `normalizeToolPIIAccess()` and the `ToolPIIAccess` type to accept `'original'` as a valid value, normalizing unrecognized values to `'tools'` (never to `'original'`).

4. **FR-4**: The system must implement bare-UUID restoration in the tool execution path: after regex-based `{{PII:...}}` rendering, scan remaining text for UUIDs that exactly match entries in the current session's vault, and render those matches using the same consumer render mode. Non-matching UUIDs pass through unchanged.

5. **FR-5**: The system must emit a `pii_plaintext_dispensed` trace event on every plaintext PII dispense to a tool. Event data: `tenantId`, `projectId`, `sessionId`, `toolName`, `entityType`, `entityHash` (SHA-256 of original value), `agentId`, `piiAccess: 'original'`. The event must be emitted through both the `onTraceEvent` callback (for session traces) and the `PIIAuditLogger` (for Kafka -> ClickHouse persistence).

6. **FR-6**: The Studio PII Access dropdown must display options with accurate labels and include the new `'original'` value:
   - `value="original"` → label "Original (plaintext)" — dispatches plaintext to the tool
   - `value="tools"` → label "Redacted" — dispatches `[REDACTED_*]` to the tool (default)
   - `value="user"` → label "Masked" — dispatches masked values
   - `value="logs"` → label "Redacted (logs)" — dispatches redacted labels
   - `value="llm"` → label "Tokenized" — dispatches `{{PII:type:uuid}}` tokens

7. **FR-7**: The Studio Tool Test UI (`internal-tools.ts` route) must apply PII rendering to tool parameters using the same `restorePIITokensForToolExecution` logic as live execution. The route must accept optional `piiPatternConfigs` and `piiAccess` from the request, create a temporary `PIIVault`, tokenize input parameters containing PII, and render them according to the configured `pii_access` level.

8. **FR-8**: The `pii-patterns` route must use `requireProjectPermission(req, res, 'pii-pattern:read|write')` instead of `requirePermission('pii-pattern:read|write')` for all operations, ensuring project-scoped authorization.

9. **FR-9 (F-6)**: The Studio PII Pattern Form must offer a "Mask Style" preset dropdown when the redaction type is "Masked", with three options:
   - **Full mask** (default) — `{ showFirst: 0, showLast: 0, maskChar: '*' }` → `***-**-****`
   - **Last 4 visible** — `{ showFirst: 0, showLast: 4, maskChar: '*' }` → `***-**-6789`
   - **Custom** — reveals the raw `showFirst`, `showLast`, `maskChar` controls for arbitrary configuration
     The preset dropdown is a convenience layer over the existing `maskConfig` field; no schema changes are required. `applyMask()` already supports all combinations via `showFirst`/`showLast`. The default behavior (full mask for SSN/IP, last-4 for phone/credit card) is unchanged.

10. **FR-10**: Existing tests that assert the broken behavior must be updated with comments referencing ABLP-535 closure:

- `session-pii-vault.test.ts:88` — comment noting `'tools'` defaults to redacted (secure default)
- `reported-pii-masking-gaps.test.ts:1083` — update to reflect correct behavior

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                        |
| -------------------------- | ------------ | ---------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project-level schema changes                                              |
| Agent lifecycle            | PRIMARY      | `pii_access` enum change affects agent IR compilation and tool configuration |
| Customer experience        | PRIMARY      | Tools receive correct PII values; user UI shows meaningful masked text       |
| Integrations / channels    | SECONDARY    | Channel-delivered responses benefit from correct user-side masking           |
| Observability / tracing    | PRIMARY      | New `pii_plaintext_dispensed` trace event + audit log entries                |
| Governance / controls      | PRIMARY      | Audit trail for plaintext PII dispense to tools                              |
| Enterprise / compliance    | PRIMARY      | HIPAA Safe Harbor / GDPR pseudonymization alignment                          |
| Admin / operator workflows | NONE         | No admin portal changes                                                      |

### Related Feature Integration Matrix

| Related Feature                                                         | Relationship Type | Why It Matters                                                                                                             | Key Touchpoints                                                   | Current State                          |
| ----------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| [Guardrails — Sensitive Data Block](guardrails-sensitive-data-block.md) | extends           | This sub-feature fixes the vault contract that Sensitive Data Block's PII handling depends on                              | `pii-vault.ts`, `resolveRenderMode`, `PIIPatternConfig`           | ALPHA — vault boundary contract broken |
| [PII Detection Tiered Recognizers](pii-detection-tiered-recognizers.md) | shares data with  | Tiered recognizers feed detected PII into the vault; this fix changes how the vault renders those detections at boundaries | `PIIRecognizerRegistry`, `pii-detector.ts`, `PIIVault.tokenize()` | BETA                                   |
| [Session Scope Enforcement](session-scope-enforcement.md)               | depends on        | Bare-UUID restoration must be session-scoped; cross-session matching is an info-leakage vector                             | `session.piiVault` instance isolation                             | ALPHA                                  |

---

## 6. Design Considerations

### UI Changes

**ToolsSection.tsx / ToolsEditor.tsx PII Access Dropdown**:

Current (broken):

```
[Original]     → value="tools"   → resolves to 'redacted'  (MISLABELED)
[Masked]       → value="user"    → resolves to 'masked'
[Redacted]     → value="logs"    → resolves to 'redacted'
[Tokenized]    → value="llm"     → resolves to 'tokenized'
```

After fix:

```
[Original (plaintext)]  → value="original" → resolves to 'original'  (NEW)
[Redacted]              → value="tools"    → resolves to 'redacted'  (DEFAULT)
[Masked]                → value="user"     → resolves to 'masked'
[Redacted (logs)]       → value="logs"     → resolves to 'redacted'
[Tokenized]             → value="llm"      → resolves to 'tokenized'
```

The dropdown must use the design-system `<Select>` component (per `apps/studio/CLAUDE.md` — never native `<select>`). The default selection for new tools is `"tools"` (Redacted).

---

## 7. Technical Considerations

### Terminology Table

| Term          | Meaning in This Feature                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `'original'`  | New `pii_access` enum value: tool receives plaintext PII with mandatory audit logging                             |
| `'tools'`     | Existing `pii_access` default: tool receives `[REDACTED_*]` labels (secure default)                               |
| `'tokenized'` | `{{PII:type:uuid}}` format — only used for LLM context (forced, no opt-out)                                       |
| `'masked'`    | Partial-reveal format (e.g., `***-***-1234`) — used for user-facing display                                       |
| `'redacted'`  | Full redaction label (e.g., `[REDACTED_SSN]`) — used for tools (default) and logs                                 |
| Bare UUID     | A UUID emitted by the LLM without the `{{PII:...}}` wrapper; may or may not be a vault token ID                   |
| Render mode   | One of `'original'`, `'masked'`, `'redacted'`, `'tokenized'`, `'random'` — determined by `resolveRenderMode()`    |
| Consumer      | A labeled boundary that receives PII: `'llm'`, `'user'`, `'logs'`, `'tools'`, `'original'`, `'admin'`, `'system'` |

### Fail-Closed Behavior

| Scenario                                       | Behavior                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unrecognized `pii_access` value                | Normalized to `'tools'` (redacted). Never fails open to plaintext.                            |
| Unrecognized consumer in `resolveRenderMode()` | Returns `'redacted'` (existing behavior at `pii-vault.ts:490`).                               |
| Bare UUID not found in session vault           | Passes through unchanged. No error, no partial match.                                         |
| Vault empty or missing                         | Text returned unmodified (existing guard at `pii-tool-execution.ts:30-32`).                   |
| `PIIAuditLogger` flush fails                   | Logged as warning, never blocks the request path (existing behavior at `pii-audit.ts:72-76`). |

### Threat Model Summary

| Asset               | Threat                                            | Mitigation                                                                                                                                           |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original PII values | Unauthorized plaintext dispense to tools          | Default is `'tools'` (redacted). `'original'` requires explicit opt-in via `pii_access` enum. Every `'original'` dispense emits audit event.         |
| Vault token UUIDs   | Cross-session info leakage via bare-UUID matching | Bare-UUID restoration is strictly scoped to `session.piiVault` — the in-memory vault instance bound to the current session. No cross-session lookup. |
| Audit trail         | Tampering or evasion                              | Audit events flow through Kafka → ClickHouse with TTL-based retention. Audit log includes entity hash (SHA-256), never raw value.                    |
| PII in Tool Test UI | Divergent behavior masking production bugs        | Tool Test route wired with same `restorePIITokensForToolExecution` pipeline as live execution.                                                       |

### Rollout & Rollback

Pre-launch posture — direct deployment:

- **Forward**: Deploy the fix. Existing agents with `pii_access: 'tools'` (or unset) continue to receive `'redacted'` — identical to current behavior.
- **Backward**: Revert the commit. The `'original'` enum value becomes unrecognized and normalizes to `'tools'` (redacted) — safe degradation.

### Divergence with Workflow Engine Path

The workflow engine path (`flow-step-executor.ts:3940, 4187`) uses `restorePIITokensForTrustedInternalExecution`, which calls `vault.detokenize()` directly — always returning plaintext regardless of `pii_access`. This is intentional for internal workflow execution (the workflow engine is a trusted internal consumer, not a user-facing tool boundary). This feature does NOT change the workflow path. The divergence is:

| Path                | Function                                      | Behavior                        | Consumer                 |
| ------------------- | --------------------------------------------- | ------------------------------- | ------------------------ |
| LLM tool call       | `restorePIITokensForToolExecution`            | Renders per `pii_access` config | External tool            |
| Flow step tool call | `restorePIITokensForTrustedInternalExecution` | Always detokenizes (plaintext)  | Internal workflow engine |

---

## 8. How to Consume

### Studio UI

**Agent Detail > Tools Section** (`apps/studio/src/components/agent-detail/ToolsSection.tsx`): PII Access dropdown with corrected labels and new `'original'` option.

**Agent Editor > Tools Editor** (`apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`): Same dropdown with corrected labels.

**Tool Test UI**: When testing a tool, PII in test parameters is processed through the same pipeline as live execution. The test results reflect the configured `pii_access` level.

### Surface Semantics Matrix

| Asset / Entity Type     | Source of Truth                  | Design-Time Surface(s)                          | Editable?      | Consumer Reference                         | Runtime Materialization                                      | Notes                                 |
| ----------------------- | -------------------------------- | ----------------------------------------------- | -------------- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------- |
| `pii_access` enum value | Agent IR `ToolIR.pii_access`     | Tool config dropdown in agent detail/editor     | Yes            | `pii_access` field in tool definition      | `resolveRenderMode(consumer, ...)` at tool dispatch boundary | New `'original'` value added          |
| PII audit trail         | ClickHouse `pii_audit_log` table | Observable via trace events in session debugger | No (read-only) | `pii_plaintext_dispensed` trace event type | Kafka → ClickHouse sink                                      | New event type for plaintext dispense |

### Design-Time vs Runtime Behavior

- **Design-time**: Agent author selects `pii_access` per tool in Studio. The selection is stored in the agent definition and compiled into `ToolIR.pii_access`.
- **Runtime**: When the LLM emits a tool call, the runtime reads `toolDef.pii_access`, passes it to `restorePIITokensForToolExecution(session, args, { piiAccess })`, which calls `vault.renderForConsumer(text, piiAccess, patternConfigs)`. If `piiAccess === 'original'`, the vault returns plaintext and the runtime emits an audit event.

### API (Runtime)

| Method              | Path                                            | Purpose                                       |
| ------------------- | ----------------------------------------------- | --------------------------------------------- |
| POST                | `/api/projects/:projectId/tools/:toolName/test` | Tool Test — now includes PII rendering        |
| GET/POST/PUT/DELETE | `/api/projects/:projectId/pii-patterns/*`       | PII pattern CRUD — RBAC fix to project-scoped |

### API (Studio)

No new Studio API routes.

### Admin Portal

No admin portal changes.

### Channel / SDK / Voice / A2A / MCP Integration

Channel-delivered responses benefit from correct user-side masking (the `protectSessionOutputForUser` path already calls `vault.renderForConsumer(text, 'user', ...)` — no changes needed). The fix ensures that the user sees masked originals when the `{{PII:...}}` wrapper is intact.

---

## 9. Data Model

### Collections / Tables

No new MongoDB collections. No new ClickHouse tables.

**Existing ClickHouse table — `abl_platform.pii_audit_log`**: New rows written with `consumer: 'original'` and `action: 'plaintext_dispensed'`. Existing schema is sufficient.

**Existing trace event system**: New event type `pii_plaintext_dispensed` added to the trace event registry.

### Key Relationships

```
Agent IR (ToolIR.pii_access)
  → compiled into session.agentIR.tools[].pii_access
  → read by reasoning-executor at tool-call boundary
  → passed to restorePIITokensForToolExecution(session, args, { piiAccess })
  → dispatched to vault.renderForConsumer(text, piiAccess, patternConfigs)
  → resolveRenderMode(consumer, patternName, patternConfigs)
  → returns PIIRenderMode → vault applies render → tool receives result
  → if 'original': audit event emitted via PIIAuditLogger + onTraceEvent
```

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                           | Purpose                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/security/pii-vault.ts`         | `resolveRenderMode()` — add `'original'` case; `renderForConsumer()` — add bare-UUID restoration pass |
| `packages/compiler/src/platform/ir/schema.ts`                  | `pii_access` enum — add `'original'`                                                                  |
| `packages/shared-kernel/src/constants/trace-event-registry.ts` | New `pii_plaintext_dispensed` trace event type                                                        |

### Routes / Handlers

| File                                                        | Purpose                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/pii-tool-execution.ts` | `ToolPIIAccess` type — add `'original'`; `normalizeToolPIIAccess()` — accept `'original'` |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Audit event emission on `'original'` dispense                                             |
| `apps/runtime/src/routes/internal-tools.ts`                 | Wire PII context into Tool Test route                                                     |
| `apps/runtime/src/routes/pii-patterns.ts`                   | RBAC fix — `requireProjectPermission`                                                     |

### UI Components

| File                                                               | Purpose                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `apps/studio/src/components/agent-detail/ToolsSection.tsx`         | PII Access dropdown — fix labels, add `'original'` option |
| `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx` | Same dropdown fix                                         |
| `packages/i18n/locales/en/studio.json`                             | i18n label updates                                        |

### Jobs / Workers / Background Processes

| File                                                         | Purpose                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts` | Existing — no changes; audit entries for `'original'` flow through this |

### Tests

| File                                                            | Type        | Coverage Focus                                                                   |
| --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/sessions/session-pii-vault.test.ts` | unit        | Vault render-mode resolution, bare-UUID detection                                |
| `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`  | integration | Tool-execution PII rendering, audit trail                                        |
| New E2E test file TBD                                           | e2e         | Full round-trip: user PII → LLM tokenized → tool original/redacted → user masked |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

No new runtime configuration. The `pii_access` field is per-tool in the agent definition.

### DSL / Agent IR / Schema

```typescript
// packages/compiler/src/platform/ir/schema.ts — ToolIR.pii_access
pii_access?: 'original' | 'tools' | 'user' | 'logs' | 'llm';
// 'original' — plaintext + audit log (NEW)
// 'tools'    — [REDACTED_*] (default, secure)
// 'user'     — masked (***-***-1234)
// 'logs'     — [REDACTED_*]
// 'llm'      — {{PII:type:uuid}} (forced, security baseline)
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | PII patterns CRUD uses `requireProjectPermission` (FR-8). Vault is session-scoped.                                                                                                |
| Tenant isolation  | Vault is session-scoped; session is tenant-scoped. No cross-tenant vault access possible.                                                                                         |
| User isolation    | N/A — vault is session-scoped, not user-scoped. Multiple users in the same session share the session vault (by design — PII detected in the conversation belongs to the session). |
| Session isolation | Bare-UUID restoration is strictly confined to `session.piiVault`. Cross-session UUID matching is prevented by the in-memory vault being session-bound.                            |

### Security & Compliance

- **HIPAA Safe Harbor alignment**: The `'tokenized'` mode for LLM context satisfies the de-identification safe harbor by replacing PII with opaque tokens. The `'original'` mode for tools is an authorized re-identification with audit trail — compliant when the tool has a legitimate need (e.g., CRM lookup by phone number).
- **GDPR pseudonymization alignment**: Tokenization is pseudonymization (reversible with the vault key). The `'original'` mode is authorized de-pseudonymization with logging.
- **Audit trail**: Every `'original'` plaintext dispense is logged with entity type and hash (never raw value) through two channels: trace events (session-visible) and PIIAuditLogger (Kafka → ClickHouse, persistent).
- **Fail-closed**: Unrecognized `pii_access` values normalize to `'tools'` (redacted). Unrecognized consumers in `resolveRenderMode` return `'redacted'`. The system never fails open to plaintext.

### Performance & Scalability

- **Tool-arg restoration is hot-path**: Vault lookups are in-memory `Map.get()` — O(1) per token. No DB round-trip.
- **Bare-UUID scanning**: Regex-based UUID extraction followed by `Map.get()` per candidate. Expected cost: sub-ms for typical tool arguments (< 10 UUIDs).
- **Audit logging**: Fire-and-forget through buffered `PIIAuditLogger` — no blocking on audit persistence. Buffer flushes every 5s or at 100 entries.
- **No new caches**: The vault is already session-scoped and in-memory. No additional caching layers needed.

### Reliability & Failure Modes

- **Audit flush failure**: Warning logged, request not blocked (existing behavior).
- **Vault eviction**: If the vault exceeds `MAX_VAULT_TOKENS` (10,000), oldest entries are evicted. A bare-UUID lookup for an evicted entry returns no match — the UUID passes through unchanged. This is expected degradation for extremely long sessions.
- **LLM wrapper stripping**: Degraded but handled — bare-UUID restoration catches the common case. If the LLM further mutates the UUID (truncation, reformatting), the lookup fails and the UUID passes through. This is a best-effort enhancement, not a guarantee.

### Observability

- **New trace event**: `pii_plaintext_dispensed` — emitted on every `'original'` plaintext dispense. Visible in session trace debugger.
- **Existing telemetry**: `pii.detect.latency_ms` telemetry continues unchanged. The `PIIAuditLogger` Kafka → ClickHouse pipeline logs all audit entries.

### Data Lifecycle

- **PII audit log retention**: 90 days (existing `DEFAULT_RETENTION_DAYS` in `pii-audit.ts:32`).
- **Vault lifetime**: Session-scoped — destroyed when the session ends. No persistence changes.

---

## 13. Delivery Plan / Work Breakdown

1. **Schema & Core Vault**
   1.1 Add `'original'` to `pii_access` enum in `schema.ts`
   1.2 Add `'original'` case to `resolveRenderMode()` in `pii-vault.ts`
   1.3 Add bare-UUID restoration to `renderForConsumer()` in `pii-vault.ts`
   1.4 Unit tests for render-mode resolution and bare-UUID detection

2. **Runtime Tool Execution**
   2.1 Update `ToolPIIAccess` type and `normalizeToolPIIAccess()` in `pii-tool-execution.ts`
   2.2 Add audit event emission for `'original'` path in `reasoning-executor.ts`
   2.3 Register `pii_plaintext_dispensed` trace event in `trace-event-registry.ts`
   2.4 Integration tests for tool execution with `'original'` and `'tools'` access

3. **Studio UI**
   3.1 Fix PII Access dropdown labels in `ToolsSection.tsx` and `ToolsEditor.tsx`
   3.2 Add `'original'` option to both dropdowns
   3.3 Replace native `<select>` with design-system `<Select>` component
   3.4 Update i18n labels in `studio.json`

4. **Tool Test UI Parity**
   4.1 Wire PII context into `internal-tools.ts` Tool Test route
   4.2 Integration test verifying Tool Test and live execution produce identical PII rendering

5. **RBAC Fix**
   5.1 Update `pii-patterns.ts` to use `requireProjectPermission`
   5.2 Integration test for project-scoped PII pattern access

6. **E2E Tests**
   6.1 Full round-trip: user PII → LLM tokenized → tool original → user masked
   6.2 Full round-trip: tool receives redacted with `pii_access: 'tools'`
   6.3 Bare-UUID restoration: mock LLM strips wrapper → tool receives plaintext
   6.4 Cross-session isolation: bare UUID from session A not restored in session B
   6.5 Update existing broken-behavior tests with ABLP-535 closure comments

---

## 14. Success Metrics

| Metric                                     | Baseline                | Target                                | How Measured                                                                     |
| ------------------------------------------ | ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| Tool receives correct PII value per config | 0% (always redacted)    | 100%                                  | E2E test: `pii_access: 'original'` → plaintext, `pii_access: 'tools'` → redacted |
| Bare-UUID restoration success rate         | 0% (no restoration)     | >95% for UUID-format tokens           | E2E test: mock LLM strips wrapper → tool receives correct value                  |
| Audit trail completeness                   | 0% (no audit for tools) | 100% of `'original'` dispenses logged | E2E test: verify trace event after plaintext dispense                            |
| Studio label accuracy                      | 0% (mislabeled)         | 100%                                  | Manual: verify dropdown labels match behavior                                    |
| Tool Test parity                           | 0% (PII bypassed)       | 100%                                  | Integration test: Tool Test result = live execution result                       |

---

## 15. Open Questions

1. **Should the `'original'` option in Studio include a warning icon or tooltip?** A plaintext dispense is a security-relevant action. Consider a cautionary badge or confirmation dialog. Deferred to UX review — the spec supports it but does not mandate it.

2. **Future: should `'original'` require tenant-admin approval?** For post-launch, consider requiring elevated permissions to set `pii_access: 'original'`. Pre-launch, any project member with tool-edit permission can set it. This is tracked as a future enhancement.

3. **Audit log queryability**: The `pii_plaintext_dispensed` events flow to ClickHouse. Should there be a Studio UI to query/filter these events? Deferred — the session trace debugger shows per-session events today. A dedicated audit dashboard is a separate feature.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                   | Severity | Status                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| GAP-001 | Bare-UUID restoration is best-effort. If the LLM truncates or reformats the UUID, restoration fails silently (UUID passes through unchanged). | Medium   | Accepted — documented as expected degradation. LLM prompt engineering can reduce wrapper stripping frequency. |
| GAP-002 | User-render path does not detect bare UUIDs. If the LLM strips the wrapper in its response text, the user sees a random UUID.                 | Medium   | Accepted — out of scope (see Non-Goals §2). The tool path handles restoration; user-render does not.          |
| GAP-003 | Vault eviction (>10,000 tokens per session) could cause bare-UUID lookups to miss. Extremely long sessions with heavy PII are affected.       | Low      | Accepted — MAX_VAULT_TOKENS is sufficient for typical sessions.                                               |
| GAP-004 | No Studio warning/confirmation when selecting `'original'` PII access.                                                                        | Low      | Open — deferred to UX review (see Open Questions §15).                                                        |
| DFA-M1  | Tool Test path omits `onTraceEvent` from auditContext — trace events do not fire for Tool Test invocations (PIIAuditLogger still captures).   | Medium   | Accepted — Tool Test is internal-only. PIIAuditLogger compensates. Trace parity is nice-to-have.              |
| DFA-M2  | Workflow safety-net detection (`workflow_unprotected_pii_dispatched`) has no automated test coverage.                                         | Medium   | Accepted — workflow PII path is explicitly scoped as "future work"; safety net is best-effort.                |
| DFA-L1  | `workflow_unprotected_pii_dispatched` emitted via `log.warn()`, not `onTraceEvent()`. Trace-only dashboards miss it.                          | Low      | Accepted — intentional per PM scope. Will be resolved when full workflow PII rendering lands.                 |

### Resolved Findings (Meta-Review, 2026-05-20)

| ID    | Severity | Finding                                                                                                    | Resolution                                                     | Fix Commit  |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------- |
| R1-1  | Medium   | Audit over-reporting: all vault tokens per tool call, not just tokens in args                              | `renderForConsumerWithTrace` + `dispensedTokens` threading     | `928e72202` |
| R2-1  | Low      | Tool Test tokenization only tokenized top-level string params                                              | `tokenizeStringLeavesDeep` recursive helper with WeakSet guard | `f1782e9fd` |
| F-1   | Critical | Audit emission scattered across 6 callers with inconsistent logic                                          | Centralized in `emitPIIAuditEvents` choke point                | `8ee142c5f` |
| F-3   | High     | WeakSet cycle guard lost shared-object tokenization                                                        | WeakMap with pre-registered clone before recursion             | `7e9239413` |
| F-5   | Medium   | Same token in multiple leaves emitted duplicate audit events                                               | Dedup via `Map<string, PIIToken>` keyed by `token.id`          | `8ee142c5f` |
| F-6   | Medium   | No mask-style preset UI for pattern config                                                                 | Studio mask-style dropdown (full / last-4 / custom)            | `3480fa501` |
| F-7   | Medium   | Workflow engine dispatches tool params without PII detection                                               | Best-effort `detectPII` safety-net scanner with structured log | `2aab6471f` |
| F-9   | Low      | Bare-UUID collision risk undocumented                                                                      | JSDoc with P(collision) analysis and mitigations               | `2aab6471f` |
| F-10  | Medium   | Missing `tenantId` on audit event caused silent drop                                                       | `__internal__` sentinel fallback                               | `8ee142c5f` |
| F-11  | Medium   | Pattern-override suppression warning only fired in regex pass, not bare-UUID pass                          | Added suppression check in `restoreBareUUIDsWithTrace`         | `d993c6a5a` |
| R11-2 | Medium   | Swallowed catch in workflow PII scanner                                                                    | Added `log.warn('workflow-pii-scan-failed', { error })`        | `d993c6a5a` |
| R11-3 | Low      | i18n mask-style hints showed dash-preserving output instead of `applyMask` output                          | Corrected hints to `***********` and `*******6789`             | `d993c6a5a` |
| R13-1 | Medium   | `pii_audit_missing_tenant` and `pii_pattern_override_suppressed_original` missing from RUNTIME_EVENT_TYPES | Registered both events                                         | `bce25cacf` |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                            | Coverage Type | Status | Test File / Note                                 |
| --- | ------------------------------------------------------------------- | ------------- | ------ | ------------------------------------------------ |
| 1   | `resolveRenderMode('original')` returns `'original'`                | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 2   | `resolveRenderMode('tools')` returns `'redacted'`                   | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 3   | Bare-UUID detection regex doesn't false-positive on non-vault UUIDs | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 4   | Bare-UUID restoration succeeds for current-session vault entries    | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 5   | `vault.renderForConsumer(text, 'original')` returns plaintext       | integration   | PASS   | `pii-vault-boundary.integration.test.ts`         |
| 6   | `vault.renderForConsumer(text, 'tools')` returns `[REDACTED_*]`     | integration   | PASS   | `pii-vault-boundary.integration.test.ts`         |
| 7   | Full round-trip: user PII tokenized before LLM                      | e2e           | PASS   | `pii-vault-boundary.e2e.test.ts` (E2E-1)         |
| 8   | PII in LLM output masked for user                                   | e2e           | PASS   | `pii-vault-boundary.e2e.test.ts` (E2E-2)         |
| 9   | Cross-session isolation: bare UUID from session A not in session B  | e2e           | PASS   | `pii-vault-boundary.e2e.test.ts` (E2E-4)         |
| 10  | RBAC: PII pattern access denied cross-project / cross-tenant        | e2e           | PASS   | `pii-vault-boundary.e2e.test.ts` (E2E-6a/6b)     |
| 11  | `normalizeToolPIIAccess` accepts `'original'`, rejects unknown      | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 12  | Masking of original returns masked plaintext, not masked token UUID | unit          | PASS   | `pii-vault-boundary.test.ts`                     |
| 13  | Cross-call-site invariant: all callers pass auditContext            | unit          | PASS   | `pii-vault-boundary-call-site-invariant.test.ts` |
| 14  | `renderForConsumerWithTrace` returns only substituted tokens        | unit          | PASS   | `pii-vault-boundary.test.ts`                     |

### Testing Notes

101 test cases across 4 files: 57 unit (`pii-vault-boundary.test.ts`), 32 integration (`pii-vault-boundary.integration.test.ts`), 2 call-site invariant (`pii-vault-boundary-call-site-invariant.test.ts`, yields 5 vitest results via dynamic test generation), 10 E2E (`pii-vault-boundary.e2e.test.ts`). Exceeds the minimum 5 E2E + 5 integration requirement.

> Full testing details: `../../testing/sub-features/pii-vault-boundary-contract.md`

---

## 18. References

- Characterization: `docs/sdlc-logs/pii-vault-boundary-contract/characterization.md`
- Parent feature: `docs/features/sub-features/guardrails-sensitive-data-block.md`
- Related feature: `docs/features/sub-features/pii-detection-tiered-recognizers.md`
- JIRA: ABLP-535 (umbrella), ABLP-673 (duplicate)
- Design docs: `docs/specs/pii-vault-boundary-contract.hld.md`
- Low-level design: `docs/specs/pii-vault-boundary-contract.lld.md`
