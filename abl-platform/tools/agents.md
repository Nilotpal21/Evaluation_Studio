# tools/ — Agent Learnings

## Running tests in tools/

Tests in `tools/` run directly from the repo root with vitest:

```sh
pnpm vitest run tools/<name>.test.ts
```

No separate vitest config is needed. The root vitest config picks up `tools/**/*.test.ts`.

## TypeScript / tsx conventions

- Files use `import.meta.url` for ESM-style `__filename`/`__dirname` equivalents (see `migrate-test-files.ts`).
- `#!/usr/bin/env npx tsx` shebang is used in CLI scripts.
- Imports from `node:fs/promises` (not `fs`) — consistent with repo `fs.promises` rule.
- Imports must use `.js` extension in test files when importing the sibling implementation (vitest resolves `.ts` via the `.js` specifier).

## Prettier

Run `npx prettier --write tools/<file>.ts` before committing. Prettier will reformat long regex literal lines in object literals.

## Regex guards in import-rewrite codemods

When writing `RegExp`-based import rewrites:

- Use negative lookaheads (`(?![-/])`, `(?!v4/)`) to prevent double-rewriting already-converted paths.
- Apply interface renaming (`IModelName`) before model renaming (`ModelName`) when one is a substring of the other — otherwise word boundaries alone are not enough to avoid corruption.
- `\b` word boundaries prevent partial matches (e.g. `ArchSession` must not match `ArchSessionService`).
- The `g` flag on `RegExp` literals in `const` arrays is safe as long as each call to `.replace(re, ...)` receives a different string — the `lastIndex` state does not persist across different input strings for `str.replace()`.

## M1.1 — v4-codemod (2026-04-18)

Added `v4-codemod.ts` + `v4-codemod.test.ts` for the Arch v4 clone-and-codemod pipeline. The script copies source files to v4 target paths while rewriting 7 categories of imports and optionally renaming Mongoose model exports + injecting collection overrides. 13 tests, all passing, written TDD.

## 2026-04-24 — Studio Video Evidence Scenario Upgrades

- When a reusable Studio video evidence scenario moves from reproducing a bug to proving the fix, keep the same scenario id and update its summary/assertions instead of cloning a second scenario. That keeps Jira evidence paths stable and prevents the “broken” and “fixed” flows from drifting apart.
- Synthetic observability scenarios like `ABLP-523` should assert the visible surface directly (tool names, per-card detail toggles, screenshot framing) instead of proving the UI indirectly through raw-event drawers.
- Files: `tools/studio-video-evidence/scenarios/ablp-ws-observability.mjs`

## 2026-04-24 — Studio Video Evidence For Modal Preview Flows

- Radix `Select` interactions inside Studio modal scenarios should choose dropdown items by `role="option"` and the exact `Select` label text. Broad text locators will happily click background-page matches behind the dialog overlay, and nearby radio labels can differ from the select option label (`Random` vs `Random replacement`).
- When a Studio video evidence scenario needs to verify preview payloads from a rate-limited project API, add a helper-level `429` retry with `retryAfterMs` backoff instead of retrying in tight loops from the scenario body.
- For tall or animated modal flows, it is often more stable to keep the video/screenshot focused on the Studio dialog while asserting the same authenticated project API response that backs the UI, rather than waiting on brittle in-page response hooks or offscreen preview DOM.
- Files: `tools/studio-video-evidence/scenarios/ablp-ui-regressions.mjs`, `tools/studio-video-evidence/lib/studio-issue-api.mjs`
