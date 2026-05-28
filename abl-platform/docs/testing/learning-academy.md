# Testing Guide: Learning Academy

**Feature**: [Learning Academy](../features/learning-academy.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-07

---

## Feature Metadata

| Field          | Value                                             |
| -------------- | ------------------------------------------------- |
| Feature Status | ALPHA                                             |
| Package(s)     | `packages/academy`, `apps/academy`, `apps/studio` |
| Service(s)     | Academy (port 3116), Studio (port 5173)           |
| Dependencies   | MongoDB                                           |

---

## Current State

**~167 tests across 14 test files.** All passing.

- 5 unit test files in `packages/academy/src/__tests__/unit/`
- 4 service test files in `packages/academy/src/__tests__/services/`
- 3 integration test files in `packages/academy/src/__tests__/integration/`
- 2 E2E test files in `apps/academy/src/__tests__/e2e/`:
  - `academy-api.e2e.test.ts` (582 lines, 27 tests) — full harness with real Express app + MongoMemoryServer
  - `academy-api.test.ts` (834 lines) — lightweight setup mirroring route handlers with injected services
- 1 E2E test harness in `apps/academy/src/__tests__/e2e/helpers/academy-harness.ts`

---

## Coverage Matrix

| #     | Functional Requirement              | Unit | Integration | E2E | Manual | Status                                                           |
| ----- | ----------------------------------- | ---- | ----------- | --- | ------ | ---------------------------------------------------------------- |
| FR-1  | Persona selection on dashboard      | -    | -           | ✅  | -      | TESTED                                                           |
| FR-2  | Courses filtered by persona         | ✅   | ✅          | -   | -      | PARTIAL                                                          |
| FR-3  | Module content rendered as markdown | ✅   | -           | ✅  | -      | TESTED                                                           |
| FR-4  | Quiz answers stripped from GET      | ✅   | ✅          | ✅  | -      | TESTED                                                           |
| FR-5  | Server-side quiz grading            | ✅   | ✅          | ✅  | -      | TESTED                                                           |
| FR-6  | Quiz rate limiting                  | -    | -           | ✅  | -      | TESTED                                                           |
| FR-7  | Points awarded on read/quiz         | ✅   | ✅          | ✅  | -      | TESTED                                                           |
| FR-8  | Badge evaluation and award          | ✅   | ✅          | ✅  | -      | TESTED                                                           |
| FR-9  | Rank derivation                     | ✅   | -           | -   | -      | PARTIAL                                                          |
| FR-10 | Streak tracking                     | ✅   | ✅          | ✅  | -      | TESTED                                                           |
| FR-11 | Leaderboard (no email)              | -    | ✅          | ✅  | -      | TESTED                                                           |
| FR-12 | Progress persisted per-userId       | -    | ✅          | ✅  | -      | TESTED                                                           |
| FR-13 | Content version stamped on quiz     | ✅   | ✅          | -   | -      | PARTIAL                                                          |
| FR-14 | UserMenu "Learning Academy" entry   | -    | -           | -   | ✅     | PARTIAL — Implemented, manual verification only (no browser E2E) |
| FR-15 | Optional video content per section  | ✅   | -           | ✅  | -      | TESTED                                                           |

Legend: ✅ = Tested, ❌ = Not Tested, - = N/A

**Notes:**

- FR-2 (courses filtered by persona): Tested at service level; no E2E test for persona-based filtering yet
- FR-9 (rank derivation): Tested at unit level only; no integration/E2E coverage
- FR-13 (content version): Tested at service/integration level; no explicit E2E assertion
- FR-14 (UserMenu): Studio UI integration not yet implemented

---

## E2E Test Scenarios (27 tests in 1 consolidated file)

All E2E tests exercise the real Academy Express API with full middleware chain (auth, validation, error handling). Uses `MongoMemoryServer` backend. No mocks, no direct DB access.

**File**: `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts`
**Harness**: `apps/academy/src/__tests__/e2e/helpers/academy-harness.ts`

### E2E-1: Config endpoint (1 test) ✅

1. `GET /api/v1/academy/config` → returns academy config with courses and personas

### E2E-2: Progress lifecycle (4 tests) ✅

1. `GET /api/v1/academy/progress` → creates initial progress (upsert-on-read)
2. `POST /api/v1/academy/modules/:id/read` → marks content read, awards points
3. User isolation — each user sees only their own progress
4. `POST /api/v1/academy/progress/reset` → resets points/persona to initial state

### E2E-3: Persona selection (3 tests) ✅

1. `PATCH /api/v1/academy/progress/persona` with valid persona → 200, persona set
2. Invalid persona → 400 validation error
3. `GET /api/v1/academy/progress` → confirms persona persisted

### E2E-4: Quiz submission and grading (4 tests) ✅

1. All correct answers → `passed: true`, score 100%, points awarded, badges earned
2. All wrong answers → `passed: false`, score 0%
3. Partial answers → appropriate score, `passed: false` below threshold
4. Quiz rate limiting → 429 after 3 attempts within 5-minute window

### E2E-5: Leaderboard ordering and privacy (2 tests) ✅

1. Multiple users with different points → leaderboard sorted by points descending, no email exposed
2. Pagination works (limit/offset)

### E2E-6: Streak tracking (2 tests) ✅

1. `POST /api/v1/academy/streak` → updates streak, returns lastActiveDate
2. Requires existing progress doc (must call GET /progress first)

### E2E-7: Module content (2 tests) ✅

1. `GET /api/v1/academy/modules/:id/content` → returns markdown content
2. `GET /api/v1/academy/modules/:id/quiz` → returns questions with answers stripped

### E2E-8: Progress reset (1 test) ✅

1. Reset clears points and persona but preserves userId

### E2E-9: Auth enforcement (5 tests) ✅

1. `GET /progress` without auth → 401
2. `PATCH /progress/persona` without auth → 401
3. `POST /progress/reset` without auth → 401
4. `POST /modules/:id/quiz` without auth → 401
5. `GET /leaderboard` without auth → 401

### E2E-10: Unknown routes (2 tests) ✅

1. Unknown path under `/api/v1/academy/` → 404
2. Path outside `/api/v1/academy` → 404

### E2E-11: Video content metadata (2 tests) ✅

1. `GET /modules/:id` for a module with `videos` field → response includes `videos` map with `url`, `title`, `durationSeconds`
2. `GET /modules/:id` for a module without `videos` field → response has no `videos` key, no crash

---

## Integration Test Scenarios (3 files, all passing)

Integration tests use `mongodb-memory-server`, create real service instances via `createAcademyServices()`, and test service-to-storage boundaries.

### INT-1: Progress service ✅

**File**: `packages/academy/src/__tests__/integration/progress-service.test.ts`

1. `getProgress(userId)` for nonexistent user → creates and returns new progress doc
2. Second call → returns same doc (no duplicate)
3. `markContentRead()` → awards points, marks module as read
4. `submitQuiz()` → grades, updates bestScore, awards points
5. `setPersona()` → updates persona selection
6. `resetProgress()` → clears all progress data

### INT-2: Gamification — badges and ranks ✅

**File**: `packages/academy/src/__tests__/integration/gamification.test.ts`

1. Pass first quiz → `first-quiz` badge awarded
2. Badge trigger evaluation → correct badges detected
3. `checkBadges()` is idempotent (doesn't double-award)
4. Rank derivation from points

### INT-3: Leaderboard queries ✅

**File**: `packages/academy/src/__tests__/integration/leaderboard.test.ts`

1. Create progress docs with different points
2. `getLeaderboard(limit, offset)` → returns sorted by points desc
3. Pagination works (limit/offset)
4. `getUserPosition(userId)` → returns correct position
5. Email NOT in leaderboard projection

---

## Unit Test Scenarios (5 files, all passing) ✅

### Unit: quiz-grader ✅

**File**: `packages/academy/src/__tests__/unit/quiz-grader.test.ts`

- MCQ: correct option → score 1, wrong option → score 0
- Fill-blank: exact match → score 1, case-insensitive match → score 1
- Fill-blank: acceptAlternatives match → score 1
- Fill-blank: whitespace trimming → score 1
- Mixed quiz (3 MCQ + 2 fill-blank): correct total scoring
- Pass threshold: 4/5 correct = 80% = pass, 3/5 = 60% = fail

### Unit: content-loader ✅

**File**: `packages/academy/src/__tests__/unit/content-loader.test.ts`

- Load markdown file from contentRoot → returns string
- Load JSON file → returns parsed object
- Nonexistent file → throws descriptive error
- Cache: second load returns cached (no filesystem hit)

### Unit: content-service ✅

**File**: `packages/academy/src/__tests__/unit/content-service.test.ts`

- `getConfig()` → returns academy.json content (personas, badges, ranks)
- `getCourses()` → returns course list
- `getModule(id)` → returns module metadata
- `getQuiz(id)` → returns questions WITHOUT answers
- `getQuizInternal(id)` → returns questions WITH answers

### Unit: gamification-service (pure logic) ✅

**File**: `packages/academy/src/__tests__/unit/gamification.test.ts`

- `deriveRank()`: 0pts → Newcomer, 500 → Explorer, 1500 → Practitioner, etc.
- `checkBadges()`: returns only newly earned badges (not already in badges array)
- Badge trigger: `pass-any-quiz` fires on first quiz pass
- Badge trigger: `complete-course:X` fires when all course modules passed
- Badge trigger: `streak-3-day` fires at 3 consecutive days

### Unit: Zod validation schemas ✅

**File**: `packages/academy/src/__tests__/unit/validation.test.ts`

- Quiz submission: valid answers array → passes
- Quiz submission: empty array → fails
- Persona selection: valid persona → passes
- Persona selection: invalid string → fails
- Leaderboard pagination: valid limit/offset → passes
- Leaderboard pagination: negative values → fails

### Unit: Video content pass-through ✅

**File**: `packages/academy/src/__tests__/unit/content-service.test.ts`

- `getModule` for module with `videos` field → returns `videos` map with correct structure
- `getModule` for module without `videos` field → returns `undefined` for `videos`, no error

## Service Tests (4 files, all passing) ✅

### Service: progress-service ✅

**File**: `packages/academy/src/__tests__/services/progress-service.test.ts`

- Progress CRUD lifecycle via storage port

### Service: quiz-grading ✅

**File**: `packages/academy/src/__tests__/services/quiz-grading.test.ts`

- End-to-end quiz grading through service layer

### Service: gamification ✅

**File**: `packages/academy/src/__tests__/services/gamification.test.ts`

- Badge and rank service-level tests

### Service: streak ✅

**File**: `packages/academy/src/__tests__/services/streak.test.ts`

- Streak update, deduplication, pruning

---

## Security & Isolation Tests

| #   | Scenario                                               | Type | Status                                                |
| --- | ------------------------------------------------------ | ---- | ----------------------------------------------------- |
| 1   | All endpoints require authentication (401 without JWT) | e2e  | ✅ TESTED — 5 auth enforcement tests                  |
| 2   | User A cannot read User B's progress                   | e2e  | ✅ TESTED — user isolation test in progress lifecycle |
| 3   | Quiz GET never returns answer/correct fields           | e2e  | ✅ TESTED — verified in quiz grading tests            |
| 4   | Leaderboard never returns email field                  | e2e  | ✅ TESTED — leaderboard ordering test                 |
| 5   | Quiz rate limiting enforced (429 on excess)            | e2e  | ✅ TESTED — rate limit test submits 4 times           |
| 6   | Progress reset only affects calling user               | e2e  | ✅ TESTED — reset test verifies user isolation        |
