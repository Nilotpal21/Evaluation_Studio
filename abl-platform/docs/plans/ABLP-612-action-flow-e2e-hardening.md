# ABLP-612 Action Flow E2E Hardening Plan

## Goal

Make Studio -> DB -> DSL/YAML -> compiler -> runtime -> channels behavior deterministic for action-driven agent routing and structured responses. The steady-state contract is that every layer either preserves the canonical payload or fails closed with a developer-visible diagnostic.

## Design Principles

- **One action response shape:** `RESPOND` inside action handlers may carry `VOICE`, `FORMATS`, and `ACTIONS`; parsers, AST, IR, compiler helpers, runtime execution, and compatibility mirrors must all preserve that shape.
- **One protection seam:** assistant text and structured response payloads from authored flow, tool break-loop, and guardrail/pipeline early exits must pass through the same PII protection helpers before streaming, history persistence, or channel delivery.
- **One ingress validator:** Web SDK, websocket, Slack, Teams, Line, Messenger, Instagram, WhatsApp, and queue ingress must normalize `ActionEvent` through the shared validator before `_action.formData` becomes runtime-visible.
- **One fork persistence contract:** forked sessions inherit parent PII vault/redaction context so redacted history and downstream output protection remain reversible and consistent.
- **Test-first slices:** each confirmed seam gets a regression that fails against the pre-fix behavior, then the smallest code change that locks the invariant.

## Slice Tracker

| Slice | Seam                                            | Risk                                                                          | Regression Lock                                               | Implementation                                                                         |
| ----- | ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | Action-handler structured responses/actions     | Handler `ACTIONS` vanish or terminal routing returns unprotected rich/actions | Parser, YAML, compiler IR, runtime action dispatch tests      | Add `actions` to AST/IR/mirrors, parse ABL/YAML, compile, interpolate, protect, return |
| 2     | Reasoning structured break-loop and early exits | Tool/guardrail/pipeline output bypasses PII masking                           | Runtime PII tests for structured result and early text exits  | Route through `protectStructuredOutputForUser` and `protectSessionOutputForUser`       |
| 3     | Channel action ingress                          | Non-SDK adapters can enqueue unsafe/malformed `formData`                      | Adapter/worker regressions for Messenger, Instagram, WhatsApp | Normalize with shared `requireNormalizedActionEvent` before returning messages         |
| 4     | Session fork PII context                        | Forked sessions lose vault/config and leak or double-mask PII                 | Session fork unit regression                                  | Copy `piiVaultData` and `piiRedactionConfig` into the fork                             |

## Exit Criteria

- Targeted tests for all four slices pass.
- Changed files are formatted with Prettier.
- No unrelated dirty worktree edits are reverted.
- Any remaining broad E2E gaps are documented as follow-up coverage, not hidden behind unit-only claims.
