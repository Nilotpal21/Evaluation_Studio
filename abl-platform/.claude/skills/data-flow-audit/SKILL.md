---
name: data-flow-audit
description: Data-flow and dependency-wiring audit. Pick one sensitive value and follow it through every boundary where it can be copied, stored, transformed, published, decrypted, rendered, or consumed. Catches raw-value leaks, wiring gaps, silent field drops, schema-route misalignment, and missing boundary tests. Mandatory (2 rounds) for features introducing cross-boundary data flows, PII, credentials, new dependencies, or parallel implementations.
---

# Data-Flow & Dependency-Wiring Audit

## Core Mindset

> **Do not ask "does this function redact?"**
> Ask: **"Can the raw value reach any consumer without passing through the approved boundary?"**

Pick one sensitive value — a user message, a credential, a PII field, an experiment assignment, a tenant ID. Then follow it through every boundary where it can be copied, stored, transformed, published, decrypted, rendered, or consumed. The audit is complete when you can answer: "no raw value escapes without passing through the correct policy gate."

This is the mindset distinction from a code review. A code review asks whether each function is correct. This audit asks whether the correct function is **always on the critical path** for every route the value can take.

## When Mandatory (2 Rounds Minimum)

Trigger this audit before declaring a feature BETA-ready when any of these apply:

- Feature introduces a new **sensitive value** (PII, credentials, keys, payment data, message content, health data)
- Feature adds **new serialization boundaries** (Kafka, EventBus, Restate, HTTP calls, worker queues)
- Feature wires **new dependencies** into services, workers, or handlers (constructor injection, factory deps, singleton registration)
- Feature has **parallel implementations** (e.g., two service variants, two route families, live vs. async trigger paths)
- Feature adds **new persistence** of a value that was previously only in-memory
- Feature touches **right-to-erasure** or data lifecycle paths

For all other features, use this audit as a Round 4 or Round 5 code review lens.

## The 9-Dimension Audit

Pick the sensitive value(s) for the feature. For each value, trace all 9 dimensions:

### 1. Source

Where does the value **first enter** the system?

- What function / handler first receives it?
- What is the entry type? (HTTP body, WebSocket frame, Kafka message, DB read, environment variable)
- Is the value validated at entry? What schema?
- Is the entry point the **only** entry point, or can the value enter through multiple paths?

**Document:** file path, function name, line range, entry type, validation applied.

### 2. Writes

Where is the value **persisted**?

- MongoDB collections and field names
- ClickHouse tables and columns
- Redis keys (and their TTL)
- Object storage / S3
- Audit log / trace event fields
- Kafka topic payloads
- Log lines (structured logger fields)

**For each write:** is the value written raw, encrypted, hashed, or redacted? Who controls the write?

### 3. Serialization Boundaries

Where does the value **cross a process or service boundary**?

- EventBus / Kafka payload construction
- Restate / pipeline trigger inputs
- HTTP client calls (headers, body, query params)
- Worker queue job payloads
- IPC / gRPC messages
- SDK/WebSocket protocol frames

**For each boundary:** what is serialized? What is the receiving service? Does the receiver have the same policy as the sender?

### 4. Read Paths

Who **reads the value back** and under what conditions?

- DB query results (which projections include the field?)
- Conversation window builders / transcript readers
- Admin API routes
- Session detail routes
- Trace / debug routes
- LLM context builders

**For each read:** what audience is the read serving? Is this the correct audience for the raw value?

### 5. Policy Boundary

Is the value **rendered at the right boundary for the right consumer**?

This is the most critical dimension. Map every consumer against its required policy level:

| Consumer Class        | Example                 | Allowed Policy           |
| --------------------- | ----------------------- | ------------------------ |
| LLM (prompt)          | GPT-4, Claude, Bedrock  | redacted or approved raw |
| External tool / HTTP  | Slack webhook, REST API | redacted or stripped     |
| Internal session view | Studio session screen   | depends on role          |
| Admin reveal          | Admin panel PII reveal  | gate + audit log         |
| Background pipeline   | Analytics, scoring      | depends on data class    |
| Logs / traces         | ClickHouse trace_events | never raw PII            |
| Kafka / EventBus      | Downstream consumers    | redacted at emit         |

**Question to answer for each consumer:** Can the raw value reach this consumer without passing through the approved policy gate?

If yes: that is a **CRITICAL** finding regardless of whether it currently happens in practice. The path must be closed.

### 6. Consumers / Sinks

Where can the value **reach an LLM, external API, or external system**?

- Pipeline LLM nodes (prompt construction)
- HTTP action nodes (outbound requests)
- Email / Slack / SMS sends
- Kafka publish to external topics
- DB queries used as LLM tool results
- File / S3 writes

**For each sink:** does the value reach the sink raw, or has it passed through a policy gate first?

### 7. Dependency Wiring

Is every **required service actually initialized and passed through**?

A dependency can be fully implemented and unit-tested but silently absent at runtime if the wiring code never passes it to the consumer.

**Procedure:**

1. List all services/resolvers the feature introduces or modifies
2. For each: trace the constructor / factory injection chain from `start()` / `main()` to every consumer
3. Verify the dep is **actually passed**, not just present in the type signature
4. Check that consumers handle the `null` case when the dep is optional

**Template to fill in for each dependency:**

```
DEPENDENCY: <name>
  Constructed at: <file>:<line>
  Consumer 1: <name> via <mechanism> — WIRED ✓ / NOT WIRED ✗
  Consumer 2: <name> via <mechanism> — WIRED ✓ / NOT WIRED ✗
  Null-handling: <how consumers handle missing dep>
```

### 8. Parallel Paths

Are there **sibling implementations** that must handle the value identically?

Common sibling pairs:

- Live chat vs. async/switched sessions
- Traces vs. messages (same data, different store)
- Message-trigger vs. session-trigger pipeline
- Built-in vs. custom policy patterns
- Workspace-scoped vs. project-scoped routes
- Two packages that mirror each other (e.g., `shared` vs. `shared-auth-profile`)
- V1 vs. V2 API routes

**For each sibling:** does it handle the value with the same policy? If one path redacts and the other doesn't, that's a CRITICAL gap.

### 9. Regression Tests

Are there **boundary tests** that will fail if a future change bypasses the policy gate?

The test must be at the **boundary**, not inside the helper. A test that calls `redact(value)` and checks the output will pass even if `redact` is never called on the critical path. A test that makes an HTTP request and asserts the raw value is absent from the response will catch any future bypass.

**Required coverage:**

- [ ] A test that seeds raw sensitive data via the real entry point and asserts the raw value is absent from every unauthorized consumer (E2E-style)
- [ ] A test at each serialization boundary that verifies the payload does not contain the raw value
- [ ] A test that verifies the dependency wiring: the policy service is actually called, not silently skipped (use a spy or contract assertion, not a mock that always passes)
- [ ] A test for the parallel path that mirrors the primary path test

---

## Audit Rounds

### Round 1: Full Path Trace

Trace all 9 dimensions for every sensitive value the feature introduces or modifies. Produce a findings report using the format below.

**Entry criteria:** All 7 LLD phases committed. Feature compiles and passes unit tests.

**Exit criteria:** Every CRITICAL and HIGH finding from the path trace has a proposed fix. Every path from Source to Consumer/Sink is accounted for.

### Round 2: Fix Verification + Boundary Tests

Verify every CRITICAL and HIGH fix from Round 1 closes the path. Run boundary regression tests.

**Entry criteria:** Round 1 fixes committed.

**Exit criteria:**

- No CRITICAL findings remain open
- Boundary tests exist at each policy gate (Round 9 checklist green)
- Every parallel path verified identical
- Audit log at `docs/sdlc-logs/<slug>/data-flow-audit.md` complete

---

## Reporting Format

### Per-Value Summary

```
VALUE: <name> (e.g., "user message content", "contactId", "API key secret")
  DATA CLASS: PII | CREDENTIAL | KEY | PAYMENT | INTERNAL | BUSINESS
  APPROVED CONSUMERS: <comma-separated list>

  1. Source:          <file>:<line> — <entry type> — <validation applied>
  2. Writes:          <list each write: file, field, format (raw/enc/hash)>
  3. Serialization:   <list each boundary crossing>
  4. Read Paths:      <list each read back: file, function, audience>
  5. Policy Boundary: <list each consumer with policy verdict>
  6. Consumers/Sinks: <list external systems the value can reach>
  7. Wiring:          <list each dep with WIRED/NOT WIRED verdict>
  8. Parallel Paths:  <list sibling implementations with parity verdict>
  9. Boundary Tests:  <list missing tests>

  CRITICAL FINDINGS:
    - [path] <raw value can reach <consumer> via <route> without passing through <gate>>
  HIGH FINDINGS:
    - <finding with file:line>
  MEDIUM FINDINGS:
    - <finding>
```

### Per-Finding Template

```
FINDING: <F-N>
  SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
  DIMENSION: <which of the 9 dimensions>
  PATH: <source> → <step> → <step> → <consumer>
  EVIDENCE: <file>:<line> — <what the code does>
  IMPACT: <what breaks or leaks if this stays>
  FIX: <exact edit required>
  TEST: <boundary test that would have caught this>
```

---

## The Field Propagation Sub-Audit

For features where the primary concern is a field being silently dropped between layers (not a policy boundary violation), use this lighter-weight checklist:

### Propagation Matrix

```
| Field        | Schema | Service | UI     | API Write | Runtime |
|--------------|--------|---------|--------|-----------|---------|
| name         | Y      | Y       | Y      | Y         | Y       |
| newField     | Y      | Y       | GAP    | Y         | GAP     |
```

**Symbols:**

| Symbol  | Meaning                      |
| ------- | ---------------------------- |
| **Y**   | Field handled at this layer  |
| **-**   | Intentionally not applicable |
| **GAP** | Should be here but isn't     |

### Schema ↔ Route Alignment

Compare every field in the Zod `CreateSchema`/`UpdateSchema` against the route handler's persistence payload:

- Every field in `CreateSchema` → corresponding line in `Model.create({...})`
- Every field in `UpdateSchema` → corresponding `doc.field = updates.field` assignment
- Fields with Mongoose defaults are **highest risk** — the silence masks the bug

### Common Propagation Patterns

| Pattern                                                | How to Catch                                            |
| ------------------------------------------------------ | ------------------------------------------------------- |
| Prefill miss (UI maps 8 of 9 fields)                   | Compare provider type against prefill function          |
| Resolver miss (return {} has 9 of 10 fields)           | Compare interface definition against return block       |
| Parallel drift (package A adds field, B doesn't)       | Diff parallel files after any change                    |
| Spread vs explicit (`{...obj, field: undefined}`)      | Check for spread patterns that overwrite                |
| Schema-route gap (validated but not persisted)         | Compare schema fields against create payload            |
| Wiring gap (dep constructed but never passed)          | Trace dep from start() to every consumer                |
| Default masking (Mongoose default hides missing field) | Explicitly test that user value survives the round-trip |
| Stale reference (code reads field removed from model)  | `grep -r "fieldName" --include="*.ts"` after removal    |

---

## Audit Log Template

Create `docs/sdlc-logs/<slug>/data-flow-audit.md`:

```markdown
# Data-Flow & Dependency-Wiring Audit: <Feature>

**Date**: <date>
**Auditor**: <agent or human>
**Round**: 1 | 2
**Feature**: `docs/features/<slug>.md`

## Sensitive Values Audited

- <value 1> — DATA CLASS: <class>
- <value 2> — DATA CLASS: <class>

## Round 1: Path Trace Findings

### VALUE: <name>

[9-dimension trace]

### Findings Summary

| ID  | Severity | Dimension       | Finding                                                 |
| --- | -------- | --------------- | ------------------------------------------------------- |
| F-1 | CRITICAL | Policy Boundary | Raw PII reaches LLM node without redaction              |
| F-2 | HIGH     | Wiring          | PII filter dep not passed to analytics worker           |
| F-3 | MEDIUM   | Parallel Paths  | Async trigger path missing redaction that sync path has |

## Round 2: Fix Verification

| Finding | Fix Committed | Boundary Test Added | Verified |
| ------- | ------------- | ------------------- | -------- |
| F-1     | <commit sha>  | yes / no            | ✓ / ✗    |

## Final Verdict

- [ ] No CRITICAL findings open
- [ ] All boundary tests added
- [ ] Parallel paths verified identical
- [ ] Audit log complete
```
