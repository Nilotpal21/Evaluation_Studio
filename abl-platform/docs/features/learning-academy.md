# Feature: Learning Academy

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `customer experience`, `integrations`
**Package(s)**: `packages/academy`, `apps/academy`, `apps/studio`
**Owner(s)**: `platform-team`
**Testing Guide**: [../testing/learning-academy.md](../testing/learning-academy.md)
**Last Updated**: 2026-04-07

> **Full functional specification**: [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md)
> **Platform integration design**: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md)

---

## 1. Introduction / Overview

### Problem Statement

New users and partner developers lack structured, progressive learning paths for the ABL platform. Documentation exists (UserDocs) but is reference-oriented — not designed for guided learning. Users must self-navigate across dozens of pages with no progress tracking, assessment, or certification. There is no way to measure platform knowledge adoption or identify knowledge gaps across teams.

### Goal Statement

Integrate the Learning Academy into the ABL Platform Studio as a persona-based, self-paced learning portal with server-side progress persistence, quizzes, gamification, and a global leaderboard. The academy package must be loosely coupled — extractable as an independent service for other platforms.

### Summary

The Learning Academy provides 14 courses across 3 personas (Agent Builder, Agent Architect, Business Analyst), with 40 modules, 180 quiz questions, badges, ranks, streaks, and a global leaderboard. Progress is persisted per-user in MongoDB (not per-tenant, not localStorage). The core logic lives in `packages/academy/` with zero ABL dependencies — Studio provides thin API route wrappers and UI pages.

---

## 2. Scope

### Goals

- Persona-based learning paths (3 personas, 14 courses, 40 modules)
- Server-side progress persistence keyed on userId (cross-tenant)
- Quiz assessment with server-side grading (answers never sent to client)
- Gamification: points, 11 badges, 6 ranks, streaks
- Global leaderboard (not tenant-scoped)
- Portable package with zero `@agent-platform/*` dependencies
- Storage port interface for DB-agnostic portability
- Optional video content per module section (YouTube embeds alongside markdown text)

### Non-Goals (Out of Scope)

- Content authoring/CMS — content is bundled in the package
- Tenant-scoped academies or per-tenant content customization
- Instructor-led or live sessions
- Certificate PDF generation (printable HTML only, future)
- Social features (comments, discussions, forums)
- Content sourcing from UserDocs at build time (standalone content)

---

## 3. User Stories

1. As a **new developer**, I want to select my persona and follow a structured learning path so that I can ramp up on the ABL platform progressively.
2. As a **developer**, I want to take quizzes after each module so that I can validate my understanding before moving on.
3. As a **developer**, I want my progress persisted server-side so that I don't lose it when switching browsers or devices.
4. As a **team lead**, I want to see a global leaderboard so that I can encourage learning adoption across my team.
5. As a **platform operator**, I want the academy package to be extractable so that I can deploy it independently for partner portals.
6. As a **returning learner**, I want streak tracking and badges so that I stay motivated to learn consistently.

---

## 4. Functional Requirements

1. **FR-1**: The system must display 3 persona cards on the academy dashboard for persona selection.
2. **FR-2**: The system must show courses filtered by selected persona with progress indicators.
3. **FR-3**: The system must render module content as markdown with syntax highlighting.
4. **FR-4**: The system must serve quiz questions with answers stripped from GET responses.
5. **FR-5**: The system must grade quiz submissions server-side (MCQ + fill-blank) and return scores with explanations.
6. **FR-6**: The system must enforce quiz rate limiting (max 3 attempts per module per 5-minute window).
7. **FR-7**: The system must award points on content read (10pts) and quiz pass (100/50/25 diminishing).
8. **FR-8**: The system must evaluate and award badges based on 11 trigger types.
9. **FR-9**: The system must derive ranks from points and path completion (6 ranks).
10. **FR-10**: The system must track daily streaks with 60-day retention.
11. **FR-11**: The system must provide a global leaderboard sorted by points (paginated, no email exposure).
12. **FR-12**: The system must persist progress per-userId (not per-tenant) in a dedicated `academy_progress` collection.
13. **FR-13**: The system must stamp `contentVersion` on quiz completions for future reassessment tracking.
14. **FR-14**: The system must be accessible from Studio's UserMenu via a "Learning Academy" item.
15. **FR-15**: The system must support optional video content per module section — YouTube embeds rendered above the markdown text. Video metadata (`url`, `title`, `durationSeconds`) is stored in `module.json` keyed by section slug. Sections without video render normally.

> Full details: personas, courses, modules, quiz format, scoring, badges, ranks — see [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md) sections 3-7.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                   |
| -------------------------- | ------------ | --------------------------------------- |
| Project lifecycle          | NONE         | Academy is independent of projects      |
| Agent lifecycle            | NONE         | Academy is independent of agents        |
| Customer experience        | PRIMARY      | Core learning and onboarding experience |
| Integrations / channels    | NONE         | Not channel-aware                       |
| Observability / tracing    | NONE         | No trace events (self-contained)        |
| Governance / controls      | NONE         | No tenant governance                    |
| Enterprise / compliance    | SECONDARY    | Email privacy on leaderboard            |
| Admin / operator workflows | NONE         | No admin workflows                      |

### Related Feature Integration Matrix

| Related Feature                      | Relationship Type | Why It Matters                                          | Key Touchpoints                                | Current State  |
| ------------------------------------ | ----------------- | ------------------------------------------------------- | ---------------------------------------------- | -------------- |
| [Auth / SSO](sso-enterprise-auth.md) | depends on        | Academy uses Studio's `requireAuth()` for user identity | JWT verified via `@agent-platform/shared-auth` | No integration |

---

## 6. Design Considerations

- **Academy layout**: Separate from Studio's main layout — own header (back-to-studio link, user avatar), sidebar (Dashboard, Courses, Leaderboard, Badges), main content area
- **UI wireframes**: See [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md) section 9 for layout diagrams

---

## 7. Technical Considerations

- **Package architecture**: `packages/academy/` with zero `@agent-platform/*` dependencies. Mongoose as peer dependency. Storage port interface for DB-agnostic portability.
- **Factory DI**: `createAcademyServices(storage, options?)` — host passes storage port, not raw connection
- **Content path**: Explicit `contentRoot` option (no `import.meta.url` — breaks in webpack/turbopack bundles)
- **No tenantIsolationPlugin**: Progress is user-scoped globally, not tenant-scoped
- **Standalone service**: `apps/academy/` is an Express service (port 3116) following the `apps/template-store/` pattern. Uses `@agent-platform/shared-auth` for JWT verification. Studio proxies client requests at `/api/academy/*` to the Academy service at `/api/v1/academy/*`.

> Full architecture: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md)

---

## 8. How to Consume

### Studio UI

| Route                         | Page           | Description                              |
| ----------------------------- | -------------- | ---------------------------------------- |
| `/academy`                    | Dashboard      | Persona selection, stats, badges, streak |
| `/academy/courses`            | Course catalog | Courses for selected persona             |
| `/academy/courses/[courseId]` | Course detail  | Module list with completion status       |
| `/academy/modules/[moduleId]` | Module viewer  | Markdown content + quiz                  |
| `/academy/leaderboard`        | Leaderboard    | Global leaderboard with pagination       |

Entry point: UserMenu → "Learning Academy" (`GraduationCap` icon)

### API (Academy Service — Port 3116)

Studio proxies client requests at `/api/academy/*` to `ACADEMY_URL/api/v1/academy/*` (default `http://localhost:3116`).

| Method | Path                                   | Purpose                           |
| ------ | -------------------------------------- | --------------------------------- |
| GET    | `/api/v1/academy/config`               | Academy config + courses          |
| GET    | `/api/v1/academy/progress`             | User progress                     |
| PATCH  | `/api/v1/academy/progress/persona`     | Set selected persona              |
| POST   | `/api/v1/academy/progress/reset`       | Reset progress                    |
| GET    | `/api/v1/academy/modules/[id]/content` | Module markdown                   |
| GET    | `/api/v1/academy/modules/[id]/quiz`    | Quiz questions (answers stripped) |
| POST   | `/api/v1/academy/modules/[id]/quiz`    | Submit quiz for grading           |
| POST   | `/api/v1/academy/modules/[id]/read`    | Mark content read                 |
| GET    | `/api/v1/academy/leaderboard`          | Global leaderboard (paginated)    |
| POST   | `/api/v1/academy/streak`               | Update streak                     |

### Admin Portal

N/A — no admin workflows.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. The academy is not channel-aware.

---

## 9. Data Model

### Collections / Tables

```text
Collection: academy_progress (NO tenantIsolationPlugin)
Fields:
  - _id: string (uuidv7)
  - userId: string (unique index — one doc per user globally)
  - email: string (internal use only — never exposed in leaderboard)
  - displayName: string | null (shown on leaderboard)
  - selectedPersona: string | null (agent-builder, agent-architect, business-analyst)
  - modules: Map<string, ModuleProgress> (Mongoose Map)
  - points: number (default: 0)
  - badges: string[] (earned badge IDs)
  - streakDays: string[] (ISO dates, max 60 retained)
  - lastActiveDate: string | null
  - _v: number (default: 1, schema version)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { userId: 1 } unique
  - { points: -1 } (leaderboard sorting)

Sub-document: ModuleProgress ({ _id: false })
  - contentRead: boolean
  - quizAttempts: number
  - quizPassed: boolean
  - bestScore: number
  - lastAttemptDate: Date | null
  - contentVersion: string | null
```

### Content Model: ModuleConfig (in `module.json`)

```
ModuleConfig:
  - id: string
  - title: string
  - lessons: Lesson[]
  - videos?: Record<string, VideoRef>   // keyed by section slug (e.g., "the-execution-block")

VideoRef:
  - url: string                          // YouTube embed URL (https://www.youtube.com/embed/<id>)
  - title: string                        // accessible title for the video
  - durationSeconds: number              // video length in seconds
```

The `videos` field is optional. When present, the Studio module viewer renders a responsive YouTube embed above the markdown content for the matching section. Sections without a video entry render text-only as before.

### Key Relationships

- `userId` maps to Studio's `User._id` (verified via JWT `sub` claim)
- No foreign key enforcement — `userId` is a loose reference
- No tenant relationship — progress is global per-user

---

## 10. Key Implementation Files

> Full file map: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md) — Package Architecture + Studio Integration sections

### Domain / Core Logic (`packages/academy/`)

| File                                                      | Purpose                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/academy/src/index.ts`                           | Barrel export — factory, types, ports                      |
| `packages/academy/src/types.ts`                           | All interfaces (AcademyProgress, ModuleProgress, etc.)     |
| `packages/academy/src/ports.ts`                           | AcademyAuthPort interface                                  |
| `packages/academy/src/factory.ts`                         | `createAcademyServices(storage, options?)` factory with DI |
| `packages/academy/src/storage/storage-port.ts`            | DB-agnostic `AcademyStoragePort` interface                 |
| `packages/academy/src/storage/mongoose-storage.ts`        | Default Mongoose implementation of storage port            |
| `packages/academy/src/schemas/academy-progress.schema.ts` | Mongoose schema — userId unique, no tenantIsolationPlugin  |
| `packages/academy/src/schemas/model-registry.ts`          | `getOrCreateModel()` — idempotent model registration       |
| `packages/academy/src/services/progress-service.ts`       | Progress tracking, quiz submission, persona selection      |
| `packages/academy/src/services/gamification-service.ts`   | Badges (11 types), ranks (6), streaks                      |
| `packages/academy/src/services/content-service.ts`        | Content loading + config                                   |
| `packages/academy/src/services/leaderboard-service.ts`    | Global leaderboard (sorted, paginated)                     |
| `packages/academy/src/quiz/quiz-grader.ts`                | Server-side grading (MCQ + fill-blank)                     |
| `packages/academy/src/content/content-loader.ts`          | fs.promises reader with in-memory cache                    |
| `packages/academy/src/validation/schemas.ts`              | Zod schemas for API inputs                                 |

### Express Service (`apps/academy/`)

| File                                           | Purpose                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| `apps/academy/src/server.ts`                   | Express app — helmet, CORS, JSON, observability           |
| `apps/academy/src/index.ts`                    | Entry point — starts HTTP server                          |
| `apps/academy/src/config.ts`                   | Env-based config loader                                   |
| `apps/academy/src/routes/academy.ts`           | 10 endpoints mounted at `/api/v1/academy`                 |
| `apps/academy/src/routes/health.ts`            | Health check route                                        |
| `apps/academy/src/middleware/auth.ts`          | JWT auth via `createUnifiedAuthMiddleware` + dev fallback |
| `apps/academy/src/middleware/error-handler.ts` | Centralized Express error handler                         |
| `apps/academy/src/lib/db.ts`                   | MongoDB connection + `initMongoBackend()`                 |

### Tests

| File                                                        | Purpose                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/academy/src/__tests__/unit/*.test.ts`             | 5 unit test files (content, loader, quiz grader, gamification, validation) |
| `packages/academy/src/__tests__/services/*.test.ts`         | 4 service test files (progress, quiz-grading, gamification, streak)        |
| `packages/academy/src/__tests__/integration/*.test.ts`      | 3 integration test files (leaderboard, gamification, progress)             |
| `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts`    | 27 E2E tests — full Express app + MongoMemoryServer harness                |
| `apps/academy/src/__tests__/e2e/academy-api.test.ts`        | E2E tests — lightweight setup with injected services                       |
| `apps/academy/src/__tests__/e2e/helpers/academy-harness.ts` | E2E test harness — starts Express + in-memory MongoDB                      |

### Studio UI (`apps/studio/`)

| File                                                      | Purpose                                              |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/app/academy/layout.tsx`                  | Auth guard + academy layout shell                    |
| `apps/studio/src/app/academy/page.tsx`                    | Dashboard — persona selection, stats, badges, streak |
| `apps/studio/src/app/academy/courses/page.tsx`            | Course catalog for selected persona                  |
| `apps/studio/src/app/academy/courses/[courseId]/page.tsx` | Course detail — module list with status              |
| `apps/studio/src/app/academy/modules/[moduleId]/page.tsx` | Module viewer — markdown content + quiz              |
| `apps/studio/src/app/academy/leaderboard/page.tsx`        | Global leaderboard                                   |
| `apps/studio/src/components/academy/AcademyLayout.tsx`    | Header + sidebar + main content area                 |
| `apps/studio/src/components/academy/AcademySidebar.tsx`   | Nav: Dashboard, Courses, Leaderboard, Badges         |
| `apps/studio/src/components/academy/PersonaCard.tsx`      | Persona selection card                               |
| `apps/studio/src/components/academy/CourseCard.tsx`       | Course with progress bar                             |
| `apps/studio/src/components/academy/ModuleCard.tsx`       | Module status indicator                              |
| `apps/studio/src/components/academy/MarkdownContent.tsx`  | react-markdown wrapper                               |
| `apps/studio/src/components/academy/QuizForm.tsx`         | MCQ radio + fill-blank text input                    |
| `apps/studio/src/components/academy/QuizResults.tsx`      | Score, explanations, retry                           |
| `apps/studio/src/components/academy/BadgeGrid.tsx`        | Earned/locked badge display                          |
| `apps/studio/src/components/academy/RankBadge.tsx`        | Current rank display                                 |
| `apps/studio/src/components/academy/StreakIndicator.tsx`  | Streak fire/counter                                  |
| `apps/studio/src/components/academy/DashboardStats.tsx`   | Stats overview widget                                |
| `apps/studio/src/components/academy/ProgressBar.tsx`      | Reusable progress indicator                          |
| `apps/studio/src/store/academy-store.ts`                  | Zustand store — caches progress + content            |

---

## 11. Configuration

### Environment Variables

| Variable      | Default                 | Description                             |
| ------------- | ----------------------- | --------------------------------------- |
| `PORT`        | `3116`                  | Academy service port                    |
| `MONGODB_URL` | (from env)              | MongoDB connection string               |
| `JWT_SECRET`  | (from env)              | JWT secret for auth verification        |
| `ACADEMY_URL` | `http://localhost:3116` | Studio proxy target (set in Studio env) |

### Runtime Configuration

No feature flags. Academy content is bundled in the package.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                          |
| ----------------- | ---------------------------------------------------------------------------------- |
| Project isolation | N/A — academy is not project-scoped                                                |
| Tenant isolation  | Intentionally absent — progress is per-userId globally, not per-tenant             |
| User isolation    | Progress filtered by `userId` from JWT. Users cannot access other users' progress. |

### Security & Compliance

- Quiz answers never sent to client (stripped in GET, graded server-side)
- Email never exposed in leaderboard (only `displayName`)
- Quiz rate limiting prevents brute-force (3 attempts/5min/module)
- All routes require authentication via `requireAuth()`

### Performance & Scalability

- Content loaded via `fs.promises` with in-memory cache (read once per module)
- Leaderboard uses `{ points: -1 }` index
- Streak array capped at 60 entries

### Observability

- Standard structured logging via `@agent-platform/shared-observability`
- No custom trace events (self-contained feature)

### Data Lifecycle

- No TTL on progress — retained indefinitely
- Streak days pruned to last 60 on each update

---

## 13. Delivery Plan / Work Breakdown

> Full phased implementation plan: `docs/plans/2026-04-05-learning-academy-impl-plan.md`

1. **Package scaffold + model** — types, ports, storage, schema, factory
2. **Content layer** — content loader, content service, Zod validation
3. **Core services** — quiz grader, progress service, gamification service
4. **Leaderboard** — leaderboard service
5. **Academy service** — Express server, routes, auth middleware, Dockerfile, Studio proxy
6. **Studio UI — layout + navigation** — UserMenu entry, layout, sidebar, Zustand store
7. **Studio UI — core pages** — persona selection, courses, module viewer, quiz
8. **Studio UI — gamification + leaderboard** — badges, ranks, streak, leaderboard page
9. **E2E tests** — 6+ scenarios against real HTTP API

---

## 14. Success Metrics

| Metric                       | Baseline | Target               | How Measured                                               |
| ---------------------------- | -------- | -------------------- | ---------------------------------------------------------- |
| Quiz pass rate (1st attempt) | N/A      | 70%+                 | `bestScore` distribution across `academy_progress.modules` |
| Courses completed per user   | N/A      | 2+                   | Count of modules with `quizPassed: true` per course        |
| Leaderboard participation    | N/A      | 50%+ of active users | Users with `points > 0` / total users                      |
| Streak retention (7-day)     | N/A      | 30%+                 | Users with `streak-7-day` badge / total learners           |

---

## 15. Open Questions

1. Should the academy be accessible to unauthenticated users (read-only content, no progress)?
2. Should course prerequisites enforce locked progression or just recommend ordering?
3. Should content updates invalidate old quiz completions (via `contentVersion`)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                   | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | No content versioning migration strategy when quiz questions change                                                           | Low      | Open      |
| GAP-002 | Leaderboard has no pagination cursor (offset-based only)                                                                      | Low      | Open      |
| GAP-003 | No admin UI for viewing academy analytics                                                                                     | Medium   | Open      |
| GAP-005 | `Map<string, ModuleProgress>` serializes as `{}` in JSON responses — fixed via `serializeProgress()` helper at route boundary | Medium   | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                      | Coverage Type | Status | Test File / Note                                                                                                 |
| --- | --------------------------------------------- | ------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Progress lifecycle (create/read/update/reset) | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — 4 tests                                               |
| 2   | Quiz submission + grading                     | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — 4 tests (correct/incorrect/partial/rate-limit)        |
| 3   | Badge earning flow                            | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — covered in quiz grading tests (badge awarded on pass) |
| 4   | Leaderboard ordering                          | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — 2 tests (ordering + pagination)                       |
| 5   | Auth enforcement (401)                        | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — 5 tests (all endpoints reject unauthenticated)        |
| 6   | Quiz answers not in GET response              | e2e           | ✅     | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts` — verified in quiz grading tests                        |

### Test Summary

| Type              | Count          | Files                                                                                                           |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Unit tests        | 5 files        | `packages/academy/src/__tests__/unit/` (content-service, content-loader, quiz-grader, gamification, validation) |
| Service tests     | 4 files        | `packages/academy/src/__tests__/services/` (progress, quiz-grading, gamification, streak)                       |
| Integration tests | 3 files        | `packages/academy/src/__tests__/integration/` (leaderboard, gamification, progress)                             |
| E2E tests         | 27 tests       | `apps/academy/src/__tests__/e2e/academy-api.e2e.test.ts`                                                        |
| **Total**         | **~167 tests** | **14 test files**                                                                                               |

> Full testing details: [../testing/learning-academy.md](../testing/learning-academy.md)

---

## 18. References

- Functional spec: [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md)
- Platform integration design: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md)
- Standalone app maintenance: [`LearningAcademy/MAINTENANCE.md`](../../LearningAcademy/MAINTENANCE.md)
- Content: `LearningAcademy/courses/`, `LearningAcademy/modules/`
