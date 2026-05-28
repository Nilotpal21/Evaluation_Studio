# Feature Spec Log: Workflow Editor Modes

**Phase**: FEATURE-SPEC
**Date**: 2026-03-24
**Artifact**: `docs/features/sub-features/workflow-editor-modes.md`

## Oracle Decisions

All 15 clarifying questions answered autonomously (no AMBIGUOUS items escalated to user).

Key decisions:

- **D-1**: YAML is an alternative view, not a separate format (pattern: `DslEditorOverlay`)
- **D-2**: Bidirectional conversion required (graph ↔ YAML)
- **D-3**: New workflow-specific YAML schema (not ABL FlowDefinition/FlowStep)
- **D-4**: Canonical storage remains JSON graph in MongoDB
- **D-5**: Omit positions in YAML, auto-layout on round-trip
- **D-6**: Import/export is follow-up scope
- **D-7**: Primarily Studio UI + shared-kernel changes
- **D-8**: Monaco editor with YAML highlighting, Zod validation

## Audit Results

### Round 1: NEEDS_REVISION

- 5 CRITICAL: Field name mappings undocumented (`nodeType`↔`type`, `source`↔`from`, `target`↔`to`), edge ID auto-gen, sourceHandle/config defaults, node type count
- 3 HIGH: Testing below minimums, FR-5 wording, delivery plan manual E2E, stale parent spec
- 3 MEDIUM: E2E scenario count, config optionality, position required field
- All fixed before round 2

### Round 2: APPROVED

- 1 HIGH: `sourceHandle` default should use `getOutputHandles()` not hardcoded `"default"` — fixed
- 1 MEDIUM: YAML example could show `label` on edges — deferred (cosmetic)

## Files Created

- `docs/features/sub-features/workflow-editor-modes.md` — feature spec
- `docs/testing/sub-features/workflow-editor-modes.md` — testing guide placeholder

## Files Updated

- `docs/features/README.md` — added to Focused Sub-Feature Modules table
- `docs/features/sub-features/README.md` — added to Current Sub-Features table
- `docs/testing/README.md` — added as #77 in P3 section
- `docs/testing/sub-features/README.md` — added to Current Sub-Feature Guides table

## Open Questions

1. Keyboard shortcuts in YAML mode (Ctrl+S, Ctrl+Enter)
2. YAML comment preservation on round-trip
3. Editor mode preference persistence (localStorage vs workflow model)
4. Auto-layout algorithm choice (Dagre vs ELK)
5. Flat vs nested YAML for complex branches
