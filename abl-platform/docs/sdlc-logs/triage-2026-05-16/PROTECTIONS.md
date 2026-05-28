# Triage Protection Register — 2026-05-16

This register maps the triage root-cause patterns to repository protections.
The goal is to prevent the same class of issue from leaking again, not just to
patch the individual tickets.

## Active Gates

| Pattern                                                          | Tickets                                                        | Protection                                                                                                                                                                                                          | Command                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Repro tests that pass or fail for the wrong reason               | ABLP-986, ABLP-974, ABLP-1010, ABLP-1059, ABLP-1066, ABLP-1100 | `repro-test-quality-check.mjs` blocks missing ticket markers, skipped/todo repros, internal package mocks, missing future imports, early returns before assertions, and unapproved `@ts-expect-error` suppressions. | `pnpm test:repro-quality`                                                                         |
| Raw trace/debug internals leaking through public route responses | ABLP-1019, ABLP-1066, ABLP-974                                 | `public-response-leak-check.mjs` blocks direct `traceEvents` / `traceContext` in route JSON responses unless explicitly debug-gated or passed through known sanitized read-surface helpers.                         | `pnpm lint:public-response-leak`                                                                  |
| Module publish diagnostics flattened into one user-facing string | ABLP-1010                                                      | `structured-diagnostics-check.mjs` blocks new flattening at the module release builder/API/client/UI boundary.                                                                                                      | `pnpm lint:structured-diagnostics`                                                                |
| Eval import schemas drifting from Mongoose/exporter shapes       | ABLP-905                                                       | `eval-schema-model-parity.test.ts` asserts file-level and staged eval import schemas accept the model-backed exporter shapes.                                                                                       | `pnpm --filter @agent-platform/project-io test -- src/__tests__/eval-schema-model-parity.test.ts` |

## Workflow Wiring

- Claude/Codex edit-time hooks are registered in `.claude/settings.json`.
- Human and non-Claude commits are covered by `.husky/pre-commit`.
- Root package scripts expose the staged gates for local and CI use.

## Known Audit Backlog

These checks intentionally expose existing debt in all-mode, but staged mode is
safe to use as a blocking gate.

| Audit Command                          | Current Use                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm test:repro-quality:all`          | Backlog scan for old repro tests that still need `FAILS` / `REGRESSION` markers or skip cleanup. |
| `pnpm lint:structured-diagnostics:all` | Backlog scan for the existing ABLP-1010 publish-diagnostics flattening path.                     |
| `pnpm lint:public-response-leak:all`   | Expected to pass; use before PRs touching runtime or Studio route response shapes.               |

## Future Contract Tests

The following protection ideas are still best implemented alongside the product
contracts they depend on:

| Future Protection                      | Blocked On                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A2A mode resolver truth-table test     | Introduce `A2AModeResolver` as a pure function.                                                                 |
| A2A turn-context round-trip test       | Introduce `A2ATurnContext` storage and trace fields.                                                            |
| Hidden tool-parameter schema invariant | Land the `hidden` / `defaultSource` IR contract and allowlist.                                                  |
| Provider content-block round-trip test | Expand `ChatResult.rawContent` to a typed assistant content union that can represent reasoning/provider blocks. |
| DSL section cardinality registry test  | Introduce the parser section registry with singleton vs accumulator metadata.                                   |
