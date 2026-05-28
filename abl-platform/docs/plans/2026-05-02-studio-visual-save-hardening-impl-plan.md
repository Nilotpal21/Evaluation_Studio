# Studio Visual Save Hardening Implementation Plan

**Date**: 2026-05-02
**Status**: In Progress
**Scope**: Studio visual save path for FLOW and lifecycle tool invocations, plus surgical section edit persistence

## Problem Statement

The current Studio visual save path still has three hardening gaps:

1. Canonical `CALL/WITH/AS` emission is not parser-valid when saved from Studio serializers.
2. Visual editors treat all `call_spec` payloads as safe even though structured `WITH` values round-trip lossy.
3. Surgical section edits persist directly to `ProjectAgent.dslContent` without a validation gate, so serializer defects become DB-backed runtime failures.

## Design Decisions

### D1. Define a visual-save-safe invocation subset

The canonical invocation shape stays:

```abl
CALL: tool_name
  WITH:
    key: value
  AS: result_key
```

But the visual editor only claims support for the subset it can round-trip exactly:

- `tool`: non-empty string
- `as`: optional non-empty string
- `with`: optional flat record of scalar values only
- allowed scalar value kinds: `string`, `number`, `boolean`
- blocked value kinds: `null`, arrays, objects

Structured payloads remain valid in raw DSL and YAML authoring, but visual editors must fail closed for them until the visual model has first-class structured value editing.

### D2. Serializer output must be parser-locked

Studio serializers are not “best effort” emitters. Any canonical invocation they emit must parse back into the same `call_spec` shape. We will lock this with round-trip tests against the real parser, not string snapshots alone.

### D3. Raw DSL save and surgical visual save use different safety modes

- `PUT /dsl` remains **draft-friendly**: preserve user text and attach diagnostics, even when invalid.
- `POST /edit` becomes **fail-closed**: validate the spliced DSL before persistence and reject invalid output.

This keeps the raw editor safe for iterative authoring while making machine-generated visual edits trustworthy.

### D4. Save success must be explicit to the caller

The visual editor must only clear dirty state after a confirmed successful persistence. Failed or rejected saves leave the section dirty so the user can recover without losing context.

## Slice Plan

### Slice 1: Parser-Locked Invocation Emission

**Goal**: Emit parser-valid multiline `CALL/WITH/AS` blocks from Studio serializers.

**Tests first**:

- Add serializer tests that assert exact indentation for FLOW and `ON_START`.
- Add parser round-trip tests that feed serializer output back into `parseAgentBasedABL()` and verify `call_spec.with` and `call_spec.as`.

**Implementation**:

- Fix `appendToolInvocation()` indentation for nested `WITH:` / `AS:` blocks.

**Exit criteria**:

- FLOW and `ON_START` serializer tests pass.
- Round-trip parser assertions preserve canonical `call_spec`.

### Slice 2: Visual-Safe Invocation Compatibility

**Goal**: Block lossy visual saves for structured `WITH` payloads.

**Tests first**:

- Add flow compatibility tests for object/array `call_spec.with` values.
- Add lifecycle compatibility tests for structured `on_start.call_spec.with` values.

**Implementation**:

- Introduce a shared “visual-save-safe invocation” check.
- Use it in flow and lifecycle compatibility analyzers.
- Continue allowing scalar `WITH` payloads.

**Exit criteria**:

- Flow analyzer flags structured `call_spec.with.*` values.
- Lifecycle analyzer flags structured `call_spec.with.*` values.
- Scalar canonical invocations remain supported.

### Slice 3: Fail-Closed Surgical Save Validation

**Goal**: Prevent invalid visual edits from being persisted.

**Tests first**:

- Add route tests for `/edit` success, validation rejection, and diagnostics persistence.
- Add hook tests proving failed saves do not report success to the caller.

**Implementation**:

- Extract shared DSL draft validation helpers used by both `/dsl` and `/edit`.
- Make `/edit` validate spliced DSL before persistence.
- Persist validation metadata on successful `/edit` saves.
- Reject invalid `/edit` output with a validation response.
- Make `saveEditsNow()` return success/failure so `AgentEditor` only clears dirty state on success.

**Exit criteria**:

- Invalid surgical edits do not update `dslContent`.
- Successful surgical edits update `dslValidationStatus` / `dslDiagnostics`.
- Failed saves keep the editor dirty.

## Files Expected

### Modified

- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/lib/abl/flow-visual-editor-compat.ts`
- `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts`
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts`
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts`
- `apps/studio/src/hooks/useSectionEdit.ts`
- `apps/studio/src/components/agent-editor/AgentEditor.tsx`
- `apps/studio/src/__tests__/abl-serializers.test.ts`
- `apps/studio/src/__tests__/flow-visual-editor-compat.test.ts`
- `apps/studio/src/__tests__/lifecycle-visual-editor-compat.test.ts`
- `apps/studio/src/__tests__/hooks/section-edit-hook.test.ts`

### New

- `apps/studio/src/lib/abl/draft-validation.ts`
- `apps/studio/src/__tests__/api-routes/api-agent-edit-route.test.ts`

## Verification Strategy

- Run focused Studio build/type validation for touched code.
- Run the new slice tests plus the existing serializer/editor-save regression tests.
- Re-run the relevant route and hook tests to confirm fail-closed behavior.
