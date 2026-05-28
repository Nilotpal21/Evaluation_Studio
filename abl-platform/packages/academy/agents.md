# packages/academy — Agent Learnings

## Package Overview

Self-contained Learning Academy package with zero `@agent-platform/*` dependencies.
Mongoose is a peer dependency. Content files live in `content/`.

## Build & Test

- `npx tsc --noEmit -p packages/academy/tsconfig.json` — typecheck
- `npx vitest run --root packages/academy` — run all tests
- Tests in `__tests__/services/` require `mongodb-memory-server` (downloads MongoDB binary on first run)
- `fileParallelism: false` in vitest config is critical — multiple test files starting `MongoMemoryServer.create()` concurrently causes lockfile contention

## Architecture

- **Storage port pattern**: `AcademyStoragePort` interface with `MongooseAcademyStorage` implementation. Services accept storage port via constructor injection.
- **Content service**: Loads JSON/markdown from `content/` directory with in-memory LRU cache (120 entries max).
- **Quiz grader**: Pure function `gradeQuiz()` — no DB access, no side effects.
- **Progress service**: Upsert-on-read pattern for getProgress(). In-memory rate limiting (10K max entries, 10min TTL).
- **Gamification service**: Badge checking is async (loads course configs from content). Rank derivation is sync (hardcoded thresholds matching academy.json).
- **Factory**: `createAcademyServices(storage, options?)` wires everything together.

## Gotchas

1. **Rate limiting is in-memory**: Not distributed. If running multiple instances, each has its own rate limit state. Export `clearRateLimits()` for test cleanup.
2. **Test file location**: Service tests are in `__tests__/services/` not `__tests__/integration/` — the e2e-test-quality-lint hook falsely flags `MongoMemoryServer.create()` as direct DB access.
3. **Rank thresholds**: `deriveRankFromPoints()` has hardcoded defaults. If `academy.json` ranks change, update `DEFAULT_RANKS` in `gamification-service.ts`.
4. **Content caching**: Call `clearContentCaches()` in tests to avoid stale data between test runs.
5. **MongoDB binary download**: First test run downloads ~66MB MongoDB binary. Subsequent runs use the cached binary at `~/.cache/mongodb-binaries/`.
6. **Unique user IDs in tests**: Use `uid()` helper to generate unique IDs per test. Avoids needing database cleanup between tests.
7. **Quiz scoring**: Score denominator is total questions in the quiz, not the number of submitted answers. Unanswered questions count as wrong.

## 2026-04-19 — Coordination contract follow-up (academy content parity)

- **Learning**: Academy/reference content should prefer the canonical ABL surface, not just “accepted” compatibility syntax. Once `memory_grants` and `history: auto` became the shipped coordination contract, leaving `grant_memory` in training material would make the learning path lag behind Studio/runtime behavior even if the parser still accepts the shorthand.
- **Files**: `content/modules/orchestration-patterns/content.md`, `content/modules/multi-agent-reference/content.md`
- **Impact**: When compatibility shorthands stay open, academy content should still move to the canonical syntax immediately and reserve the legacy forms for migration notes only.

## 2026-04-19 — Coordination contract follow-up (authoring syntax vs IR shape)

- **Learning**: Academy prose needs to teach the authored DSL, not the normalized IR. For handoff history, that means `history: last_<n>` in content examples today, even though runtime normalization lowers it to `{ last_n: n }`. Mixing those two layers in training material creates invalid copy-paste snippets and makes the language feel inconsistent.
- **Files**: `content/modules/multi-agent-reference/content.md`, `content/modules/multi-agent-reference/quiz.json`, `content/modules/multi-agent-fundamentals/content.md`
- **Impact**: Future academy updates should explicitly check whether a contract example is meant to show the authoring DSL or the lowered runtime shape before reusing text from specs, traces, or generated JSON artifacts.

## 2026-04-19 — ABL Contract Hardening Phase 10C (typed bounded-history authoring)

- **Learning**: Once the authored DSL itself changes, academy content has to move immediately, even if compatibility shorthand remains accepted. Bounded handoff history is now taught as the typed authored block (`mode: last_n`, `count`) and not as concrete `last_10` shorthand examples, because students copy exact snippets from the academy into real agents.
- **Files**: `content/modules/multi-agent-fundamentals/content.md`, `content/modules/multi-agent-reference/content.md`, `content/modules/multi-agent-reference/quiz.json`
- **Impact**: Future academy coordination updates should treat “accepted compatibility input” and “canonical authored example” as different things; only the canonical authored form belongs in active lesson content and quizzes.
