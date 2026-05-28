# HLD: Learning Academy

**Feature**: [docs/features/learning-academy.md](../features/learning-academy.md)
**Test Spec**: [docs/testing/learning-academy.md](../testing/learning-academy.md)
**Status**: APPROVED
**Last Updated**: 2026-04-07

> **Full architecture**: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md)
> **Full functional spec**: [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md)

---

## 1. Problem Statement

The ABL platform has no structured learning experience. Documentation (UserDocs) is reference-oriented — it tells users _what_ exists but not _how_ to learn it progressively. Users lack:

- Persona-based learning paths tailored to their role (developer, architect, analyst)
- Server-side progress tracking that persists across browsers, devices, and tenants
- Assessment to validate understanding before advancing
- Gamification to drive sustained engagement (badges, ranks, leaderboard, streaks)

The solution must be loosely coupled — the core academy logic must be extractable as an independent service for other platforms, depending only on a MongoDB connection and an auth adapter.

---

## 2. Alternatives Considered

### Alternative A: Standalone Express Service (`apps/academy/`) — Chosen

**Description**: Standalone Express API service in `apps/academy/` (port 3116) with its own routes and auth middleware. Core services in `packages/academy/` (zero ABL deps). UI pages and components remain in `apps/studio/`, which proxies `/api/v1/academy/*` to the Academy service. Follows the `apps/template-store/` pattern.

**Pros**: Independently deployable and scalable. Framework-agnostic API layer (not tied to Next.js). Content updates don't require Studio redeploy. Service layer + API layer are both portable. Matches existing template-store pattern in the repo.

**Cons**: Separate deployment adds ops cost. Requires proxy configuration in Studio. Slightly more infrastructure than embedding in Studio.

**Effort**: M

### Alternative B: Package + Studio Pages — Rejected

**Description**: Core services in `packages/academy/` (zero ABL deps). UI pages and API routes in `apps/studio/` as Next.js route handlers. Studio is the host — provides auth, DB connection, and content path.

**Pros**: Seamless UX (same app). Uses existing auth. No SSO complexity. Thin Studio adapter (~150 LOC of route wrappers).

**Cons**: API layer is not independently deployable — coupled to Studio's Next.js framework. Content updates require Studio redeploy. Cannot scale API independently of Studio. Violates the platform pattern established by `apps/template-store/`.

**Effort**: M

### Alternative C: Embed in Existing Studio Feature — Rejected

**Description**: Add academy as a section within an existing Studio area (e.g., help panel, settings).

**Pros**: No new package. Minimal infrastructure.

**Cons**: No portability. Tightly coupled to Studio internals. Hard to extract later. Insufficient space for a full learning experience. Not independently deployable.

**Effort**: S

### Recommendation

**Alternative A** — a standalone Express service at `apps/academy/` (port 3116) provides an independently deployable, framework-agnostic API layer. Combined with `packages/academy/` for core logic (zero ABL deps, ~1,500 LOC), the entire backend is portable. The UI in Studio (~2,800 LOC) is rebuilt per target platform. This follows the `apps/template-store/` pattern already proven in this repo.

---

## 3. Architecture Overview

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│         apps/academy             │  │          apps/studio             │
│      (Express, port 3116)        │  │        (Next.js, UI host)        │
│  ┌────────────────────────────┐  │  │  ┌──────────┐  ┌─────────────┐  │
│  │ Routes (10)                │  │  │  │ Pages    │  │ Components  │  │
│  │ createUnifiedAuthMiddleware│  │  │  │ /academy │  │ /academy/   │  │
│  │ academy-auth-adapter       │  │  │  │ (6)      │  │ (12)        │  │
│  └────────────┬───────────────┘  │  │  └──────────┘  └─────────────┘  │
│               │                  │  │                                  │
│  ┌────────────┴───────────────┐  │  │  ┌──────────────────────────┐   │
│  │ academy-init.ts            │  │  │  │ proxy: /api/v1/academy/* →  │   │
│  │ (singleton, lazy)          │  │  │  │   ACADEMY_URL (:3116)    │   │
│  └────────────┬───────────────┘  │  │  └──────────────────────────┘   │
├───────────────┼──────────────────┤  └──────────────────────────────────┘
│               ▼                  │
│  packages/academy  (ZERO @agent-platform/* deps)                      │
│  ┌───────────────────────────────────────────────┐                    │
│  │ createAcademyServices(storage, options?)       │                    │
│  │   → { content, progress, gamification,         │                    │
│  │       leaderboard }                            │                    │
│  ├───────────────────────────────────────────────┤                    │
│  │ AcademyStoragePort ← MongooseAcademyStorage   │                    │
│  │ AcademyAuthPort   ← (host implements)         │                    │
│  ├───────────────────────────────────────────────┤                    │
│  │ content/  (bundled JSON + markdown)            │                    │
│  └───────────────────────────────────────────────┘                    │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. Twelve Architectural Concerns

### 4.1 Resource Isolation

- **No tenant isolation**: `academy_progress` has no `tenantId`. Progress is keyed on `userId` only — intentionally cross-tenant so learning follows the user.
- **User isolation**: All queries filter by `userId` from JWT `sub` claim. One user cannot read/modify another's progress.
- **No project isolation**: Academy is not project-scoped.

### 4.2 Auth

- Academy service uses `createUnifiedAuthMiddleware()` from `@agent-platform/shared-auth` — no custom auth.
- `AcademyAuthPort` interface allows other platforms to plug in their own auth.
- No public/unauthenticated endpoints.

### 4.3 Stateless Distributed

- No pod-local state for user data (all in MongoDB).
- Content cache is read-only and reconstructable (loaded from filesystem).
- Singleton `getAcademyServices()` is per-process, not cross-pod shared state.

### 4.4 Traceability

- Standard Studio request logging. No custom trace events.
- Progress mutations are timestamped via `updatedAt`.

### 4.5 Compliance

- Email never exposed in leaderboard responses (only `displayName`).
- No PII beyond email and displayName (both provided by user's existing profile).
- No data minimization TTL needed (progress is the user's own data).

### 4.6 Performance

- Content loaded via `fs.promises` with in-memory cache (read once, cached indefinitely per process).
- Leaderboard query uses `{ points: -1 }` index.
- Quiz grading is CPU-only (no external calls) — sub-millisecond.
- Streak array capped at 60 entries (pruned on update).

### 4.7 Data Model

- Single collection: `academy_progress` with unique `userId` index.
- `modules` field uses Mongoose Map — flexible but no compound indexes on map fields.
- `_v` field for future schema migrations (no migration mechanism yet — GAP-001 in feature spec).

### 4.8 Error Handling

- Services throw typed errors. Academy service uses `errorToResponse()` from `@agent-platform/shared-kernel`.
- Quiz rate limiting returns 429 with structured error response.

### 4.9 Security

- Quiz answers stripped from GET responses (server-side only).
- Rate limiting on quiz submissions (3 attempts/5min/module) prevents brute-force.
- Content served via API only — never via static file middleware.

### 4.10 Portability

| What's Portable                                              | What's Rebuilt Per Target                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/academy/` (services, models, content) — ~1,500 LOC | UI components and pages (~2,800 LOC)                                |
| `apps/academy/` (Express routes + auth middleware)           | Auth adapter (implement `AcademyAuthPort` if not using shared-auth) |
| `AcademyStoragePort` (Mongoose adapter ships as default)     |                                                                     |
| Content (JSON + markdown)                                    |                                                                     |

With a standalone Express service, both the API layer (`apps/academy/`) and the core logic (`packages/academy/`) are portable together. Only the UI in Studio needs rebuilding per target platform.

### 4.11 Testing Strategy

- Unit tests: content loading, quiz grading, gamification logic (mongodb-memory-server)
- Integration tests: progress lifecycle, leaderboard queries
- E2E tests: full flow via Studio HTTP API (no mocks, real server)

### 4.12 Deployment

- New standalone Express service at port 3116. Own Dockerfile (`apps/academy/Dockerfile`), own scaling.
- Studio proxies `/api/v1/academy/*` to it (env var `ACADEMY_URL`, default `http://localhost:3116`).
- Dockerfile COPY lines needed for `packages/academy/package.json` in all app Dockerfiles.
- New env var: `ACADEMY_URL` in Studio. Port constant `3116` added to `packages/config/src/constants.ts`.

---

## 5. Key Design Decisions

| #   | Decision                                                    | Rationale                                                                            | Alternative Rejected                                               |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| D-1 | Storage port interface instead of raw `mongoose.Connection` | True DB portability — any backend can implement ~8 methods                           | Direct Mongoose DI (ties package to MongoDB)                       |
| D-2 | Explicit `contentRoot` path option                          | `import.meta.url` breaks in webpack/turbopack bundles                                | `import.meta.url` resolution (fragile in bundlers)                 |
| D-3 | Email stripped from leaderboard responses                   | Cross-tenant email exposure is a privacy risk                                        | Include email (privacy violation)                                  |
| D-4 | Quiz rate limiting in package layer (not route layer)       | Portability — rate limit logic travels with the package                              | Route-level rate limiting (not portable)                           |
| D-5 | `contentVersion` stamp on quiz completions                  | Future-proofs reassessment when content changes                                      | No versioning (old completions become stale silently)              |
| D-6 | Global leaderboard (not tenant-scoped)                      | Learning is cross-org; matches user-scoped progress model                            | Tenant-scoped leaderboard (fragments small user bases)             |
| D-7 | `displayName` field separate from `email`                   | Leaderboard needs something to show; email is private                                | Derive from email (exposes email)                                  |
| D-8 | Standalone Express service instead of Studio route handlers | Independent deployment, framework-agnostic API layer, follows template-store pattern | Next.js route handlers in Studio (couples API to Studio framework) |

---

## 6. Data Flow

### Quiz Submission Flow

```
Client POST /api/v1/academy/modules/:id/quiz { answers }
  → requireAuth() → userId from JWT
  → academy.progress.submitQuiz(userId, moduleId, answers)
    → rate limit check (3 attempts / 5 min)
    → content.getQuizInternal(moduleId) → full quiz with answers
    → quizGrader.grade(answers, quiz) → { score, results }
    → storage.upsertProgress(userId, { module update, +points })
    → gamification.checkBadges(progress) → new badges
    → gamification.deriveRank(progress) → rank
  → Response { score, passed, results (with explanations), newBadges, rank }
```

### Content Loading Flow

```
Client GET /api/v1/academy/modules/:id/content
  → requireAuth()
  → academy.content.getModuleContent(moduleId)
    → contentLoader.loadMarkdown(contentRoot, moduleId)
      → cache hit? return cached
      → fs.promises.readFile → cache → return
  → Response { content: "# markdown..." }
```

---

## 7. API Contract Summary

> Full API route pattern and list: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md) — Studio Integration section

All routes follow: Express middleware chain → `createUnifiedAuthMiddleware()` → academy service call → `res.json({ success: true, data })`. Studio proxies `/api/v1/academy/*` to `ACADEMY_URL` (default `http://localhost:3116`).

10 route files, each ~10 lines. No complex middleware beyond auth.

---

## 8. References

- Feature spec: [docs/features/learning-academy.md](../features/learning-academy.md)
- Full architecture: [`LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md`](../../LearningAcademy/PLATFORM-INTEGRATION-DESIGN.md)
- Full functional spec: [`LearningAcademy/FUNCTIONAL-SPEC.md`](../../LearningAcademy/FUNCTIONAL-SPEC.md)
- Pattern references: `packages/a2a/src/domain/ports.ts` (port/adapter DI), `packages/pipeline-engine/src/schemas/` (self-owned models)
