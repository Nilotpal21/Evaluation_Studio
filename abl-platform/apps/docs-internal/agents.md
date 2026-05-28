# agents.md — apps / docs-internal

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

## 2026-04-18 — ABL Contract Hardening Phase 1

**Category**: pattern
**Learning**: Docs surfaces that mirror repo-root reference documents should not rely on manual sync. The package build must run `pnpm --dir ../.. abl:docs:check`, and the app build cache must include the canonical source docs plus generator inputs; otherwise Turbo can reuse a stale app build even when repo-root docs changed.
**Files**: `apps/docs-internal/package.json`, `apps/docs-internal/content/abl-reference/full-specification.mdx`, `turbo.json`
**Impact**: Any future docs-internal content generated from repo-root sources should update both the package build script and the Turbo inputs together.

## 2026-04-18 — ABL Contract Hardening Phase 2 (coordination contract mirrors)

**Category**: pattern
**Learning**: Coordination-contract reference surfaces are now easiest to keep accurate through generated contract facts, not hand-edited MDX snippets. When registry constructs or compatibility notes change, `contract-facts.mdx` is the canonical docs-internal landing zone for the updated machine-readable contract, while `full-specification.mdx` remains a mirrored long-form narrative surface.
**Files**: `apps/docs-internal/content/abl-reference/contract-facts.mdx`, `apps/docs-internal/content/abl-reference/full-specification.mdx`
**Impact**: Future compiler-contract changes should update generated facts first and only hand-edit long-form docs when the narrative itself changes.

## 2026-04-19 — ABL Contract Hardening Phase 6 (manual guide integrity)

**Category**: pattern
**Learning**: Generated contract facts do not protect hand-authored MDX snippets from becoming invalid in isolation. If a docs-internal code fence uses a named `ON_RETURN` handler, it should define the matching `RETURN_HANDLERS` block in the same snippet unless the surrounding code fence already contains it. Mirror pages also need a byte-identical parity check against Studio so one manual cleanup cannot drift from the other.
**Files**: `apps/docs-internal/content/guides/multi-agent-orchestration.mdx`, `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx`, `packages/compiler/src/__tests__/docs/phase6-doc-alignment.test.ts`
**Impact**: Future docs-internal guide edits should treat each code fence as copy-pasteable on its own and preserve the mirrored docs-internal/studio parity gate whenever manual examples change.

## 2026-05-18 — Docs Search Path Safety

**Category**: security
**Learning**: Docs route and search targets are backed by filesystem MDX lookup, so section and page slugs must stay constrained to lowercase dash-separated path segments before any path is built. The shared content loader now rejects unsafe segments before `path.join`.
**Files**: `apps/docs-internal/src/lib/content.ts`, `apps/docs-internal/src/__tests__/docs-search.test.ts`
**Impact**: Future docs-internal navigation or search features should reuse the shared slug guard instead of accepting arbitrary URL, config, or filesystem-derived segments.
