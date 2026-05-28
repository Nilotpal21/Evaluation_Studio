# LLD: Localized Interaction Context

**Feature Spec**: [docs/features/sub-features/localized-interaction-context.md](../features/sub-features/localized-interaction-context.md)
**HLD**: [docs/specs/localized-interaction-context.hld.md](../specs/localized-interaction-context.hld.md)
**Test Spec**: [docs/testing/sub-features/localized-interaction-context.md](../testing/sub-features/localized-interaction-context.md)
**Status**: DRAFT
**Date**: 2026-04-16

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                         | Rationale                                                                                                                | Alternatives Rejected                                                                  |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| D-1 | Define `InteractionContext` in `packages/shared-kernel`          | The contract is pure data and is consumed by runtime, A2A, and compiler-adjacent code without needing compiler ownership | Put the type in compiler core types                                                    |
| D-2 | Separate `current` turn context from `preference` state          | Message-level switching must not overwrite long-lived preference blindly                                                 | Session-global `_locale` bucket                                                        |
| D-3 | Keep only bounded compatibility aliases during migration         | Reduces risk while execution consumers migrate without creating a second canonical generic-language key                  | Flag-day removal of `_locale` or mirroring `session.data.values.language` indefinitely |
| D-4 | Treat `ClientInfo.locale/timezone` as legacy compatibility input | Avoids two competing localization contracts while preserving a migration lane                                            | Leave `ClientInfo` and `InteractionContext` both authoritative                         |
| D-5 | Make date helpers accept explicit locale/reference options       | Relative dates must be user-local and deterministic across all call paths                                                | Continue using process-local `new Date()`                                              |
| D-6 | Normalize channel-native hints at ingress, not in consumers      | Keeps future channels from re-implementing localization logic and stops adapters from discarding locale/language fields  | Consumer-specific hint handling                                                        |

### Key Interfaces & Types

```typescript
interface InteractionContextInput {
  language?: string;
  locale?: string;
  timezone?: string;
}

interface ResolvedInteractionContext {
  current: InteractionContext;
  preference?: {
    language?: string;
    locale?: string;
    timezone?: string;
    source: string;
    updatedAt: string;
  };
  aliases: {
    _language?: string;
    _locale?: string;
    _timezone?: string;
  };
  legacyInputs?: {
    clientInfoLocale?: string;
    clientInfoTimezone?: string;
  };
}
```

### Module Boundaries

| Module                       | Responsibility                                                        | Depends On                                                             |
| ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Shared-kernel types          | Define canonical pure-data interaction-context contract               | `packages/shared-kernel` only                                          |
| Ingress normalization        | Extract explicit and channel-native context from each inbound surface | route handlers, channel adapters                                       |
| Interaction-context resolver | Merge precedence layers and validate values                           | shared-kernel types, locale helper, session state, contact preferences |
| Session-state persistence    | Write canonical state and compatibility aliases                       | runtime session namespace                                              |
| Execution consumers          | Read canonical interaction context only                               | prompt builder, executors, profile resolver, date helper               |
| Date normalization           | Parse relative dates using user-local reference instant               | resolver output, compiler date helper                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                             | Purpose                                            | LOC Estimate |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ |
| `apps/runtime/src/services/execution/interaction-context.ts`                     | Canonical resolver, validation, alias sync helpers | 250          |
| `apps/runtime/src/__tests__/execution/interaction-context-resolver.test.ts`      | Resolver precedence and validation coverage        | 220          |
| `apps/runtime/src/__tests__/execution/interaction-context-session-state.test.ts` | Canonical session-state persistence coverage       | 180          |
| `apps/runtime/src/__tests__/e2e/localized-interaction-context-chat.e2e.test.ts`  | Public API E2E for REST chat and relative dates    | 250          |

### Modified Files

| File                                                           | Change Description                                                                              | Risk   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| `packages/shared-kernel/src/types/index.ts`                    | Add canonical `InteractionContext` and `SessionInteractionState` types                          | Medium |
| `packages/compiler/src/platform/core/types.ts`                 | Mark `ClientInfo.locale/timezone` as legacy compatibility input or deprecate                    | Medium |
| `apps/runtime/src/routes/chat.ts`                              | Accept explicit interaction-context input and map to execution options                          | Medium |
| `apps/runtime/src/server.ts`                                   | Map A2A localization input into execution options                                               | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                    | Preserve per-message interaction context across execution and auth-gate replay                  | Medium |
| `packages/a2a/src/infrastructure/agent-executor-adapter.ts`    | Extract canonical interaction-context input from A2A message metadata                           | Medium |
| `apps/runtime/src/channels/adapters/msteams-adapter.ts`        | Stop discarding `activity.locale` and forward it as canonical resolver input                    | Medium |
| `apps/runtime/src/channels/types.ts`                           | Add normalized interaction-context field to inbound channel message contract                    | Medium |
| `apps/runtime/src/channels/session-resolver.ts`                | Normalize channel-native locale/language hints and preserve persistence boundaries              | Medium |
| `apps/runtime/src/channels/pipeline/types.ts`                  | Thread interaction context through session-creation pipeline                                    | Medium |
| `apps/runtime/src/channels/pipeline/session-factory.ts`        | Apply normalized interaction context during channel session bootstrap                           | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                | Persist canonical state under `session.interaction.*` plus compatibility aliases                | High   |
| `apps/runtime/src/services/execution/prompt-builder.ts`        | Inject user-local interaction fields into prompt context                                        | High   |
| `apps/runtime/src/services/execution/reasoning-executor.ts`    | Read canonical interaction context instead of `_locale` and stop session-language drift         | High   |
| `apps/runtime/src/services/execution/profile-resolver.ts`      | Read canonical interaction language instead of legacy `sessionMeta.language` seed               | High   |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Read canonical interaction context and pass it to extraction/date paths                         | High   |
| `apps/runtime/src/services/execution/extraction-validation.ts` | Pass locale/timezone/reference instant into date normalization                                  | High   |
| `packages/compiler/src/platform/utils/date-extraction.ts`      | Accept explicit reference instant / timezone-aware date parsing and fix `toISODate()` semantics | High   |

### Deleted Files (if any)

| File | Reason                                         |
| ---- | ---------------------------------------------- |
| N/A  | No files should be deleted in the first slice. |

---

## 3. Implementation Phases

### Phase 1: Contract and Ingress Normalization

**Goal**: Define the canonical interaction-context contract and feed it from every inbound surface.

**Tasks**:
1.1. Add canonical `InteractionContext` / `SessionInteractionState` types to `packages/shared-kernel/src/types/index.ts`.
1.2. Update `packages/compiler/src/platform/core/types.ts` so `ClientInfo.locale/timezone` is documented and handled as legacy compatibility input, not a competing canonical contract.
1.3. Create `interaction-context.ts` with validation, precedence rules, legacy-input mapping, and alias sync helpers.
1.4. Extend REST chat, A2A, and WebSocket SDK ingress to accept explicit interaction-context input.
1.5. Extend channel ingress contracts to carry normalized localization hints and stop discarding Teams `activity.locale`.
1.6. Map Teams `locale`, AudioCodes `language`, and similar hints into resolver inputs.

**Files Touched**:

- `packages/shared-kernel/src/types/index.ts` - canonical shared contract
- `packages/compiler/src/platform/core/types.ts` - legacy `ClientInfo` bridge/deprecation notes
- `apps/runtime/src/services/execution/interaction-context.ts` - new shared resolver
- `apps/runtime/src/routes/chat.ts` - REST contract
- `apps/runtime/src/server.ts` - A2A execution options
- `apps/runtime/src/websocket/sdk-handler.ts` - SDK message flow
- `packages/a2a/src/infrastructure/agent-executor-adapter.ts` - A2A metadata extraction
- `apps/runtime/src/channels/adapters/msteams-adapter.ts` - Teams locale preservation
- `apps/runtime/src/channels/types.ts` - normalized inbound contract
- `apps/runtime/src/channels/session-resolver.ts` - channel hint extraction
- `apps/runtime/src/channels/pipeline/types.ts` - pipeline threading
- `apps/runtime/src/channels/pipeline/session-factory.ts` - session bootstrap

**Exit Criteria**:

- [ ] All ingress surfaces can produce a canonical `InteractionContextInput`
- [ ] `InteractionContext` is exported from `packages/shared-kernel` and imported without introducing a new compiler dependency edge for non-compiler consumers
- [ ] `ClientInfo.locale/timezone` is documented as legacy compatibility input only
- [ ] Invalid locale/timezone values are rejected or sanitized at the boundary
- [ ] Teams inbound normalization preserves `activity.locale`
- [ ] `pnpm build --filter=apps/runtime` succeeds with 0 errors
- [ ] Resolver unit tests cover precedence and validation rules

**Test Strategy**:

- Unit: shared type contract, resolver validation, precedence, alias generation
- Integration: ingress normalizers for REST/A2A/SDK/channel fixtures, including Teams locale preservation

**Rollback**: Stop using explicit ingress context and fall back to legacy metadata forwarding while keeping the new helper isolated.

---

### Phase 2: Canonical Session State and Execution Consumers

**Goal**: Persist canonical interaction state and make execution consumers read it.

**Tasks**:
2.1. Persist `session.interaction.current` and `session.interaction.preference` in `runtime-executor.ts`.
2.2. Sync compatibility aliases `_locale`, `_language`, and `_timezone` without introducing a new long-lived generic `session.data.values.language` alias.
2.3. Update prompt builder, reasoning executor, flow executor, and profile resolver to read canonical state only.
2.4. Reconcile the current `_locale` extraction path and `session.data.values.language` behavior-profile path.
2.5. Define policy for when current-turn signals update session preference.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/execution/prompt-builder.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/profile-resolver.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`

**Exit Criteria**:

- [ ] Canonical session interaction state is present after execution begins
- [ ] Legacy alias fields are derived from canonical state
- [ ] No direct `_locale` reads remain in the targeted execution paths
- [ ] No targeted execution consumer still depends on `session.data.values.language` for language routing
- [ ] Prompt builder includes user-local interaction fields

**Test Strategy**:

- Unit: session-state persistence, alias sync, preference update policy
- Integration: reasoning/flow execution and profile resolution consume the same canonical state

**Rollback**: Re-enable legacy `_locale` reads temporarily while retaining the canonical state writes for observation-only mode; do not reintroduce a second generic `session.data.values.language` source of truth.

---

### Phase 3: User-Local Date Parsing and Normalization

**Goal**: Make relative dates deterministic and user-local.

**Tasks**:
3.1. Extend `extractDatesFromText()` to accept an explicit reference instant/options object.
3.2. Update `extraction-validation.ts` and extractor call sites to pass resolved locale/timezone context, including `normalizeDate()`.
3.3. Replace or fix `toISODate()` so date-only formatting semantics are host-timezone-safe and match the documented contract.
3.4. Add deterministic tests for `today`, `tomorrow`, `a week from tomorrow`, and weekday phrases near timezone boundaries.

**Files Touched**:

- `packages/compiler/src/platform/utils/date-extraction.ts`
- `apps/runtime/src/services/execution/extraction-validation.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`

**Exit Criteria**:

- [ ] Relative-date parsing no longer depends on process-local `new Date()`
- [ ] `normalizeDate()` and flow extraction pass the same locale-aware options into date extraction
- [ ] Date-only formatting no longer depends on host-local getters that contradict the helper contract
- [ ] Deterministic tests pass under any CI timezone
- [ ] Existing locale-aware date tests continue to pass
- [ ] `pnpm build --filter=@abl/compiler --filter=apps/runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: date helper edge cases, `toISODate()` contract behavior
- Integration: extraction validation path with explicit interaction context and locale propagation

**Rollback**: Keep the new helper signature compatible and revert call sites to legacy reference behavior if needed.

---

### Phase 4: End-to-End Hardening and Regression Coverage

**Goal**: Prove the feature across real runtime entry points and guard against regressions.

**Tasks**:
4.1. Add REST E2E coverage for explicit interaction context and relative dates.
4.2. Add WebSocket SDK E2E coverage for message-level language switching.
4.3. Add A2A and channel ingress integration/E2E coverage for Teams and AudioCodes hint normalization, including proof that Teams locale is not dropped.
4.4. Add migration/regression coverage for legacy `ClientInfo.locale/timezone` compatibility input and removal of `session.data.values.language` dependency.
4.5. Add dedup and queued-message replay regression coverage for turn-specific context.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/localized-interaction-context-chat.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/ws-sdk-interaction-context.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/teams-interaction-context.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`
- `packages/a2a/src/__tests__/interaction-context-a2a.integration.test.ts`
- `apps/runtime/src/__tests__/execution/interaction-context-dedup.integration.test.ts`

**Exit Criteria**:

- [ ] At least 5 E2E scenarios and 5 integration scenarios from the test spec are implemented or marked with concrete blockers
- [ ] Same-session language switching is verified through a public runtime surface
- [ ] Different message-level interaction contexts do not dedup into the same execution
- [ ] Teams locale retention is verified through a public ingress path
- [ ] Legacy `ClientInfo` compatibility and removal of `session.data.values.language` dependency are covered by regression tests
- [ ] Production wiring is verified for REST, SDK, A2A, and at least one channel adapter path

**Test Strategy**:

- E2E: public runtime and channel surfaces only
- Integration: resolver, session state, date helper, replay/dedup semantics

**Rollback**: Keep new tests while disabling feature code paths through compatibility mapping if runtime regressions appear.

---

## 4. Wiring Checklist

- [ ] Shared resolver exported from runtime execution services
- [ ] Canonical `InteractionContext` exported from `packages/shared-kernel`
- [ ] REST chat route passes interaction context into execution options
- [ ] A2A server path maps inbound interaction context into execution options
- [ ] WebSocket SDK path preserves interaction context through auth-gate queue/replay
- [ ] Teams adapter forwards `activity.locale` into normalized interaction context
- [ ] Channel session factory threads normalized interaction context into session creation
- [ ] Runtime session namespace persists canonical interaction state
- [ ] Prompt builder reads canonical state instead of `_locale`
- [ ] Reasoning executor reads canonical state instead of `_locale`
- [ ] Profile resolver no longer depends on `session.data.values.language`
- [ ] Flow executor reads canonical state instead of `_locale`
- [ ] Date helper signature change is reflected in all call sites
- [ ] `normalizeDate()` passes locale-aware options through the same date helper contract
- [ ] Tests cover REST, SDK, A2A, and channel ingress wiring

---

## 5. Cross-Phase Concerns

### Database Migrations

No database migration is required for the first slice. The new state is session-scoped and can live in the existing runtime session namespace.

### Feature Flags (if applicable)

No new public feature flag is planned. If rollout gating is needed, keep it internal to runtime execution so the public contract does not drift.

### Configuration Changes

- No new environment variables required
- No mandatory new project runtime config required
- Public inbound contracts may gain explicit `interactionContext` support

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Every inbound surface resolves one canonical `InteractionContext`
- [ ] Execution consumers no longer rely on raw `_locale` or `session.data.values.language` in the targeted paths
- [ ] Relative date parsing is user-local and deterministic
- [ ] `ClientInfo.locale/timezone` no longer competes with the canonical execution contract
- [ ] Teams locale and other channel-native hints survive normalization into canonical state
- [ ] Message-level language switching works in a single session
- [ ] Test spec coverage goals are implemented or broken down into explicit blockers
- [ ] Feature spec, test spec, HLD, and LLD stay aligned on the same contract

---

## 7. Open Questions

1. Should compatibility aliases remain indefinitely for tooling/access convenience, or be removed after migration?
2. When should legacy `ClientInfo.locale/timezone` compatibility reads be removed after the canonical contract ships?
3. Should the resolver write inferred language changes into long-lived preference automatically, or require repeated confirmation?
