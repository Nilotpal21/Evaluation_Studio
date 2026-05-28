# PII Vault Boundary Contract — High-Level Design

**Ticket**: ABLP-535
**Status**: APPROVED
**Feature Spec**: `docs/features/sub-features/pii-vault-boundary-contract.md`
**Test Spec**: `docs/testing/sub-features/pii-vault-boundary-contract.md`
**LLD**: `docs/specs/pii-vault-boundary-contract.lld.md`

---

## What

The PII vault's consumer-access contract was designed with the right abstraction (`PIIConsumer` + `PIIRenderMode` + `PIIPatternConfig`) but the implementation never wired a pathway for authorized plaintext dispense to tools, never handled LLM-initiated wrapper stripping, and the Studio UI was built against the aspirational contract rather than the actual behavior. This HLD describes the architectural approach to fix all six manifestations of this single defect.

## Architecture Approach

### Packages Changed

| Package                  | Change Type | Scope                                                                                    |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------- |
| `packages/compiler`      | MODIFY      | `pii-vault.ts` (resolveRenderMode, renderForConsumer + bare-UUID), `schema.ts` (enum)    |
| `packages/shared-kernel` | MODIFY      | `trace-event-registry.ts` (new PII trace event group)                                    |
| `packages/i18n`          | MODIFY      | `studio.json` (label fixes + new 'original' label)                                       |
| `apps/runtime`           | MODIFY      | `pii-tool-execution.ts`, `reasoning-executor.ts`, `internal-tools.ts`, `pii-patterns.ts` |
| `apps/studio`            | MODIFY      | `ToolsSection.tsx`, `ToolsEditor.tsx` (dropdown fix)                                     |

### Data Flow

```
User Input ("My SSN is 123-45-6789")
  │
  ▼
PIIVault.tokenize()  ──────────────────────────────────────┐
  │  text: "My SSN is {{PII:ssn:<uuid>}}"                  │
  │  store: Map<uuid, {original:'123-45-6789', type:'ssn'}> │
  ▼                                                         │
LLM Context (tokenized)                                    │
  │  LLM sees: "My SSN is {{PII:ssn:<uuid>}}"              │
  ▼                                                         │
LLM Tool Call                                              │
  │  args may contain:                                      │
  │    (a) {{PII:ssn:<uuid>}}  (wrapper intact)             │
  │    (b) <uuid>              (wrapper stripped)            │
  ▼                                                         │
restorePIITokensForToolExecution(session, args, {piiAccess})│
  │                                                         │
  │  Step 1: Regex replace {{PII:type:id}} via              │
  │          vault.renderForConsumer(text, piiAccess)        │
  │                                                         │
  │  Step 2 (NEW): Bare-UUID scan                           │
  │    - Extract all UUID-format strings                     │
  │    - Lookup each in session vault (Map.get)              │
  │    - If match: render per same piiAccess mode            │
  │    - If no match: pass through unchanged                 │
  │                                                         │
  │  resolveRenderMode(piiAccess, ...) →                    │
  │    'original' → plaintext + audit event                 │
  │    'tools'    → [REDACTED_SSN]                          │
  │    'user'     → ***-**-****                             │
  │    'logs'     → [REDACTED_SSN]                          │
  │    'llm'      → {{PII:ssn:<uuid>}} (forced)            │
  ▼                                                         │
Tool Receives Rendered Value                               │
  │                                                         │
  │  If piiAccess='original':                               │
  │    → emit pii_plaintext_dispensed trace event            │
  │    → PIIAuditLogger.log() (Kafka → ClickHouse)          │
  ▼                                                         │
User Response                                              │
  │  protectSessionOutputForUser()                          │
  │  vault.renderForConsumer(text, 'user')                  │
  │  → masked: "My SSN is ***-**-****"                      │
  ▼                                                         │
Display to User                                            │
```

### Key Integration Points

1. **Schema → Runtime**: `ToolIR.pii_access` enum expansion flows through compilation to `session.agentIR.tools[].pii_access`
2. **Vault → Tool Dispatch**: `renderForConsumer` is the single chokepoint for all PII rendering
3. **Tool Dispatch → Audit**: Audit events emitted at the reasoning-executor level after tool args are rendered
4. **Registry → Runtime**: `pii_plaintext_dispensed` registered in shared-kernel, consumed by runtime event emitter
5. **Studio → Schema**: Dropdown value maps to `pii_access` field in agent definition

## Decisions & Tradeoffs

1. **Bare-UUID restoration in vault (not in pii-tool-execution.ts)**: Placing the bare-UUID scan inside `PIIVault.renderForConsumer()` means all consumers benefit automatically. Alternative was to add it only in `restorePIITokensForToolExecution`. Chose vault-level because it's the architectural chokepoint and future consumers don't need to re-implement.

2. **Audit emission at reasoning-executor level (not vault level)**: The vault is a pure data structure (packages/compiler). Audit logging requires runtime context (tenantId, projectId, sessionId, toolName). Keeping audit emission in reasoning-executor maintains the vault's purity and avoids circular dependencies.

3. **`pii_plaintext_dispensed` as a new trace event group**: Adding to the guardrail group was considered but rejected — PII plaintext dispense is a vault-boundary concern, not a guardrail concern. A dedicated `pii` trace event group is more discoverable and extensible.

4. **Native `<select>` → Design-system `<Select>`**: Both ToolsSection.tsx and ToolsEditor.tsx use native `<select>`. The fix replaces with Radix-based `<Select>` from `components/ui/Select.tsx` per Studio CLAUDE.md rules. This is a correctness fix, not a cosmetic change.

5. **Tool Test UI wiring scope**: The internal-tools route gets PII rendering for the tool's `pii_access` level, but does not create a full session. A lightweight `PIIVault` instance is created per-request with PII patterns from project settings. This keeps the Tool Test fast while achieving parity with live execution.

## Task Decomposition

| Task | Package(s)    | Independent? | Est. Files | Description                                                  |
| ---- | ------------- | ------------ | ---------- | ------------------------------------------------------------ |
| T-1  | compiler      | Yes          | 2          | Schema enum + vault core (resolveRenderMode, bare-UUID)      |
| T-2  | shared-kernel | Yes          | 1          | Trace event registry — new PII group                         |
| T-3  | runtime       | No (T-1,T-2) | 3          | pii-tool-execution, reasoning-executor audit, internal-tools |
| T-4  | studio, i18n  | No (T-1)     | 3          | UI dropdown fix + i18n labels                                |
| T-5  | runtime       | No (T-1,T-3) | 3          | Unit + integration + E2E tests                               |

## Out of Scope

- Workflow engine path (`flow-step-executor.ts`) — uses `restorePIITokensForTrustedInternalExecution` which works correctly
- User-render bare-UUID restoration — accepted degradation per GAP-002
- PII detection engine changes
- Cross-session UUID matching
- Customer migration tooling
- Warning icon/confirmation dialog for 'original' selection (deferred to UX review)
