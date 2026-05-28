# agents.md — packages / observatory

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-19 — ABL Contract Hardening Phase 5 (canonical trace contract)

**Category**: architecture
**Learning**: Observatory should own payload-layer schema and platform-name mappings, but it should not own the canonical trace event union anymore. The stable split is: shared-kernel exports `TraceEventType`, `ALL_TRACE_EVENT_TYPES`, and registry metadata; observatory re-exports that contract from `src/schema/trace-events.ts` and layers `ExtendedTraceEvent`, payload interfaces, and platform-name mappings on top.
**Files**: `src/schema/trace-events.ts`, `src/schema/trace-event-mappings.ts`, `package.json`, `tsconfig.json`
**Impact**: Future observability work should add new canonical event names in shared-kernel first, then update observatory payloads/mappings as a consumer. Reintroducing a second observatory-owned union will recreate the same drift this phase removed.

**Category**: gotcha
**Learning**: The reverse map derived from `TRACE_TO_PLATFORM_TYPE` is not sufficient for replay normalization because emit-time overrides like `llm.call.failed` and `tool.call.failed` do not appear in the forward map. Compatibility aliases such as `PLATFORM_TO_TRACE_ALIASES` must be explicit and test-backed.
**Files**: `src/schema/trace-event-mappings.ts`, `src/__tests__/trace-event-mappings.test.ts`
**Impact**: Any new dotted platform event that is emitted as an override or compatibility alias must be added to the alias map and covered by mapping tests, or Studio normalization will silently miss it.

## 2026-04-25 — ABLP-571 (runtime trace schema alignment)

**Category**: gotcha
**Learning**: `tool_call_retry` is emitted by runtime and has an EventStore schema (`tool.call.retried`), so it needs a forward entry in `TRACE_TO_PLATFORM_TYPE`; keeping only `PLATFORM_TO_TRACE_ALIASES['tool.call.retried']` lets replay normalize historical dotted events but does not make live runtime traces dual-write to EventStore.
**Files**: `src/schema/trace-event-mappings.ts`, `src/__tests__/trace-event-mappings.test.ts`
**Impact**: Reverse aliases are not a substitute for forward runtime mappings. If runtime emits the underscore trace name and EventStore should persist it, add both forward mapping coverage and replay alias coverage when needed.
