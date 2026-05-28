# Test Specification: Conversation Behavior

**Feature Spec**: [docs/features/sub-features/conversation-behavior.md](../../features/sub-features/conversation-behavior.md)
**HLD**: [docs/specs/conversation-behavior.hld.md](../../specs/conversation-behavior.hld.md)
**LLD**: [docs/plans/2026-04-21-conversation-behavior-impl-plan.md](../../plans/2026-04-21-conversation-behavior-impl-plan.md)
**Status**: PLANNED
**Last Updated**: 2026-04-21

---

## 1. Coverage Matrix

| FR    | Description                                                                      | Unit | Integration | E2E | Manual | Status  |
| ----- | -------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Canonical `speaking` / `listening` / `interaction` model                         | NO   | NO          | NO  | NO     | PLANNED |
| FR-2  | ABL-native authoring at agent and behavior-profile scope                         | NO   | NO          | NO  | NO     | PLANNED |
| FR-3  | Ownership boundaries across identity, voice, localization, and runtime transport | NO   | NO          | NO  | NO     | PLANNED |
| FR-4  | `language_policy` resolved through canonical `InteractionContext`                | NO   | NO          | NO  | NO     | PLANNED |
| FR-5  | Phase-1 launch field set supported with stable grouping                          | NO   | NO          | NO  | NO     | PLANNED |
| FR-6  | Phrase and pronunciation asset references                                        | NO   | NO          | NO  | NO     | PLANNED |
| FR-7  | Deterministic precedence and merge rules                                         | NO   | NO          | NO  | NO     | PLANNED |
| FR-8  | Channel-family capability gating for unsupported behavior                        | NO   | NO          | NO  | NO     | PLANNED |
| FR-9  | Compile-time validation for unsupported combinations and asset refs              | NO   | NO          | NO  | NO     | PLANNED |
| FR-10 | One resolved behavior view per runtime turn with diagnostics                     | NO   | NO          | NO  | NO     | PLANNED |
| FR-11 | Studio / project-I/O round-trip preservation                                     | NO   | NO          | NO  | NO     | PLANNED |
| FR-12 | Extensibility for deferred advanced fields without breaking the core model       | NO   | NO          | NO  | NO     | PLANNED |

### Current Baseline

The repository already has partial baseline coverage that this feature should extend:

- behavior-profile parsing and compilation in `packages/core` and `packages/compiler`
- runtime profile resolution and effective-config tests in `apps/runtime`
- canonical interaction-context resolution in `packages/shared-kernel` and `apps/runtime`
- Studio serializer and behavior/profile editing state
- project localization asset CRUD and project-I/O round-trip coverage

Those seams prove the platform has the right integration points. They do not yet prove one unified Conversation Behavior layer.

---

## 2. E2E Test Scenarios (MANDATORY)

### E2E-1: Voice-targeted behavior profile applies Conversation Behavior overrides

- **Preconditions**: Project with an agent, a voice-capable channel, and a behavior profile containing `CONVERSATION:` overrides.
- **Steps**:
  1. Execute the agent through a voice-capable surface.
  2. Confirm the matching behavior profile is active.
  3. Confirm the voice-specific conversation behavior is applied.
- **Expected Result**: Runtime resolves one effective Conversation Behavior view using base behavior plus active profile overrides.

### E2E-2: Non-voice channel fails closed on unsupported voice-only behavior

- **Preconditions**: Agent/profile includes `listening` settings that only make sense on voice-capable channels.
- **Steps**:
  1. Execute the same agent through a non-voice surface.
  2. Inspect preview/runtime diagnostics and final delivery behavior.
- **Expected Result**: Unsupported voice-only behavior is rejected or explicitly dropped according to channel capability rules.

### E2E-3: Locale asset reference changes phrase behavior by locale

- **Preconditions**: Project contains at least two locale-specific phrase assets referenced by Conversation Behavior.
- **Steps**:
  1. Execute the same agent twice with different interaction locales.
  2. Inspect the resolved phrase behavior and output wording.
  3. Export the project and confirm the asset refs survive.
- **Expected Result**: The agent changes phrasing by locale using shared project assets rather than duplicated inline copy.

### E2E-4: Studio authoring round-trips Conversation Behavior through structured UI and raw ABL

- **Preconditions**: Studio project with agent/profile authoring enabled.
- **Steps**:
  1. Add Conversation Behavior through structured UI.
  2. Switch to raw ABL and verify serialization.
  3. Edit the ABL directly and reopen structured UI.
- **Expected Result**: Structured UI and raw ABL remain one round-trippable source of truth.

### E2E-5: Runtime diagnostics expose resolved behavior and capability drops

- **Preconditions**: Feature-active agent executed on a channel where at least one policy is gated or merged from a profile.
- **Steps**:
  1. Execute the agent.
  2. Inspect trace/debug output for resolved behavior.
- **Expected Result**: Diagnostics show active source chain, capability drops, and asset refs without leaking internal-only details.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Parser and compiler lower agent-scoped Conversation Behavior into canonical IR

- **Boundary**: `packages/core` parser -> `packages/compiler` IR
- **Expected Result**: Agent-level `CONVERSATION:` authoring becomes canonical `conversation_behavior` IR.

### INT-2: Behavior-profile Conversation Behavior merges with base agent behavior

- **Boundary**: compiler IR -> runtime `profile-resolver`
- **Expected Result**: Active profiles override or extend base behavior deterministically by documented precedence.

### INT-3: `InteractionContext` remains the canonical owner of language policy

- **Boundary**: conversation behavior -> `interaction-context.ts`
- **Expected Result**: `language_policy` influences output behavior without bypassing runtime language/locale/timezone resolution.

### INT-4: Channel-family gating suppresses unsupported runtime-only policies

- **Boundary**: runtime resolver -> `channel-behavior-contract.ts`
- **Expected Result**: Voice-only policies are rejected or dropped according to channel-family capability rules.

### INT-5: Phrase and pronunciation asset refs survive project I/O round-trip

- **Boundary**: Studio/project authoring -> export/import/bundle
- **Expected Result**: Conversation Behavior and referenced assets round-trip together with no broken links.

### INT-6: Deferred advanced fields fail with explicit diagnostics

- **Boundary**: parser/compiler validators
- **Expected Result**: Fields outside the phase-1 launch subset are rejected or flagged explicitly rather than silently accepted.

---

## 4. Unit Test Scenarios

### UT-1: Ownership validator

- **Module**: Conversation Behavior validator helpers
- **Expected Output**: Invalid overlap with persona, acoustic voice, localization ownership, or runtime transport controls is rejected deterministically.

### UT-2: Channel-family capability validator

- **Module**: compiler/runtime capability helpers
- **Expected Output**: Unknown channel families and unsupported behavior combinations fail closed.

### UT-3: Asset reference validator

- **Module**: phrase/pronunciation asset-ref validation
- **Expected Output**: Only valid project-owned asset references are accepted.

### UT-4: Merge precedence helper

- **Module**: runtime conversation behavior resolver
- **Expected Output**: Base behavior, active profiles, and runtime inputs merge in the documented order.

### UT-5: Deferred-field gate

- **Module**: parser/compiler field gating
- **Expected Output**: Advanced fields produce clear "not supported in phase 1" diagnostics.

---

## 5. Security & Isolation Tests

- **Cross-project asset access returns 404**: phrase and pronunciation assets must not resolve across project boundaries.
- **Cross-tenant authoring surfaces return 404**: localization and project-I/O routes must remain tenant-scoped.
- **Sanitized diagnostics**: preview/apply/runtime diagnostics must explain conflicts without leaking provider internals or hidden asset details.
- **No runtime policy bypass**: Conversation Behavior must not override platform-owned channel or acoustic voice controls.

---

## 6. Performance & Load Tests (if applicable)

- Measure resolved Conversation Behavior overhead on both chat and voice turns and confirm it remains in-memory.
- Verify asset-reference lookup does not introduce a new network hop on the hot path.
- Verify prompt shaping remains bounded for large projects with many shared phrase assets.

---

## 7. Test Infrastructure

- **Required services**: Runtime, Studio, MongoDB, Redis, project-I/O/export surfaces
- **Data seeding**: Project with agents, behavior profiles, project phrase assets, pronunciation assets, and at least one voice-capable channel
- **Environment variables**: Reuse existing runtime/Studio test configuration; no new env var is required for phase 1
- **CI configuration**: Ensure coverage includes parser/compiler/runtime and Studio/project-I/O seams

---

## 8. Test File Mapping

| Test File                                                                      | Type               | Covers                  |
| ------------------------------------------------------------------------------ | ------------------ | ----------------------- |
| `packages/core/src/__tests__/conversation-behavior-parser.test.ts`             | unit / integration | FR-1, FR-2, FR-5        |
| `packages/compiler/src/__tests__/ir/conversation-behavior-ir.test.ts`          | integration        | FR-3, FR-6, FR-9, FR-12 |
| `apps/runtime/src/__tests__/conversation-behavior-resolver.test.ts`            | integration        | FR-4, FR-7, FR-8, FR-10 |
| `apps/runtime/src/__tests__/channels/conversation-behavior-capability.test.ts` | integration        | FR-8, FR-10             |
| `apps/studio/src/__tests__/conversation-behavior-editor.test.tsx`              | integration        | FR-2, FR-11             |
| `packages/project-io/src/__tests__/conversation-behavior-roundtrip.test.ts`    | integration        | FR-6, FR-11             |
| `apps/runtime/src/__tests__/e2e/conversation-behavior.e2e.test.ts`             | e2e                | FR-5, FR-7, FR-8, FR-10 |
