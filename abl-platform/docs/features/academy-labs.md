# Feature: Academy Hands-On Labs

**Doc Type**: MAJOR FEATURE
**Parent Feature**: [Learning Academy](learning-academy.md) (L01)
**Status**: PLANNED
**Feature Area(s)**: `customer experience`, `agent lifecycle`, `project lifecycle`
**Package(s)**: `packages/academy`, `apps/academy`, `apps/studio`
**Owner(s)**: `platform-team`
**Testing Guide**: [../testing/academy-labs.md](../testing/academy-labs.md)
**Last Updated**: 2026-04-16

> **Market research**: [`explorations/2026-04-14-hands-on-labs-market-research.md`](../../explorations/2026-04-14-hands-on-labs-market-research.md)
> **Trailhead patterns**: [`explorations/2026-04-14-trailhead-patterns-for-academy.md`](../../explorations/2026-04-14-trailhead-patterns-for-academy.md)

---

## 1. Introduction / Overview

### Problem Statement

The Learning Academy teaches platform concepts through passive content (reading lessons) and recall-based assessment (quizzes). Users who complete courses still struggle when building their first real agent because they have never practiced in a guided, verified context. The gap between "I understand how GATHER works" and "I can configure a GATHER block in a real agent" remains unbridged. There is no mechanism to verify that a learner can actually apply what they've learned on the live platform.

Industry research (70-20-10 model) shows 70% of learning comes from hands-on experience. Salesforce Trailhead awards 5x points for hands-on challenges vs quizzes, explicitly valuing doing over knowing. Our current Academy has zero hands-on verification.

### Goal Statement

Add hands-on lab exercises to the Academy that verify learners can build real agent configurations in Studio. Labs inspect actual project state (agents, tools, topology, deployments) via the Runtime API and provide per-objective pass/fail feedback. Lab completion is required for module/course completion (for modules that have labs), making practical skill validation a first-class part of the learning path.

### Summary

Labs are per-module exercises defined in `lab.json` alongside existing `module.json`, `content.md`, and `quiz.json`. A lab defines a scenario, objectives, and programmatic checks. The learner builds the required configuration in their own Studio project, enters the project ID in the Academy UI, and clicks "Verify." The Academy service calls the Runtime API to inspect the project's state and evaluates assertions against the response. Results show per-objective pass/fail with feedback messages. Points are awarded on first pass. Lab completion gates module and course completion for modules that have labs.

---

## 2. Scope

### Goals

- Per-module lab exercises with declarative JSON definitions (`lab.json`)
- 6 verification check types that inspect real project state via Runtime API (7th — `custom-check` — deferred to Phase 2)
- Per-objective pass/fail feedback with hints on failure
- Partial credit scoring (score = earned points / total points)
- Hidden checks that reveal after verification to prevent gaming
- Lab progress tracking in `ModuleProgress` (attempts, passed, best score)
- Lab completion required for module/course completion (for modules with labs)
- Lab-specific points, badges, and gamification integration
- 5 pilot labs for Agent Builder and Agent Architect persona modules
- Rate limiting for verification attempts (5 per 10 min per module)

### Non-Goals (Out of Scope)

- Sandbox project provisioning or template cloning (Phase 2+)
- Dual-mode labs: Guided + Challenge (Phase 2)
- Capstone projects spanning multiple modules (Phase 3)
- AI-powered hints or copilot integration (Phase 3)
- Time-limited labs
- Lab content for all 40 modules (Phase 1 targets 5 pilot labs)
- Project selection dropdown (Phase 1 uses manual project ID input)
- Lab-specific leaderboard filter
- Content authoring tools or lab preview mode
- Business analyst persona labs (Phase 2, requires different check types)

---

## 3. User Stories

1. As a **learner**, I want to see a Lab section after the quiz in relevant modules so that I know there is a hands-on exercise available.
2. As a **learner**, I want to read the lab scenario and objectives before I start building so that I understand what to create.
3. As a **learner**, I want to enter my Studio project ID and click "Verify" to check my work so that I get instant feedback on what I built correctly and what needs fixing.
4. As a **learner**, I want to see per-objective pass/fail results with specific feedback messages so that I know exactly what to fix.
5. As a **learner**, I want to earn points for completing a lab so that my hands-on work is recognized in my rank and on the leaderboard.
6. As a **learner**, I want to discover hidden bonus checks after verification so that I'm motivated to build robust solutions rather than minimum-viable ones.
7. As a **learner**, I want to retry verification unlimited times after fixing my work so that labs feel like practice, not exams.
8. As a **content author**, I want to define labs in JSON with typed checks so that verification is declarative and maintainable.
9. As a **content author**, I want to mark certain checks as hidden so that learners can't game the system by building only the minimum.
10. As a **platform operator**, I want lab completion to be required for course completion so that badges and certifications reflect practical skill, not just quiz recall.

---

## 4. Functional Requirements

1. **FR-1**: The system must load `lab.json` from `packages/academy/content/modules/{moduleId}/lab.json` when the file exists, and return `hasLab: true` on the module info endpoint.
2. **FR-2**: The system must validate `lab.json` against a Zod schema at content-load time, rejecting invalid files with a clear error.
3. **FR-3**: The system must serve the lab definition via `GET /modules/:moduleId/lab` with check config internals stripped and hidden check descriptions replaced with "Bonus check."
4. **FR-4**: The system must accept a `projectId` in the verify request body, forward the user's JWT to `GET /api/projects/:projectId/agents` on the Runtime API (port 3112), and return 404 if the Runtime responds with 401/403/404 (indicating the user lacks project access).
5. **FR-5**: The system must assemble project state by: (a) listing agents via `GET /agents`, (b) fetching each agent's `dslContent` via `GET /agents/:agentName`, (c) parsing DSL with `@abl/core` to extract blocks, tool references, and topology edges, (d) listing deployments via `GET /deployments`, then evaluate all check assertions against the assembled `ProjectState`.
6. **FR-6**: The system must support 6 check types: `agent-exists`, `agent-has-block`, `tool-exists`, `agent-count`, `topology-check`, and `deployment-exists`. (`custom-check` deferred to Phase 2 — see GAP-003.)
7. **FR-7**: The system must return per-objective pass/fail results with feedback messages, where an objective passes only if ALL its checks pass.
8. **FR-8**: The system must calculate a lab score as `sum(earned points) / sum(total points)` and mark the lab as passed when the score meets or exceeds `passThreshold`.
9. **FR-9**: The system must award lab points to the user's progress on first pass only (idempotent — no re-awards on subsequent verifications).
10. **FR-10**: The system must rate-limit lab verification to 5 attempts per module per 10-minute window per user.
11. **FR-11**: The system must extend `ModuleProgress` with `labAttempts`, `labPassed`, `labBestScore`, and `lastLabAttemptDate` fields with backward-compatible defaults.
12. **FR-12**: The system must require lab completion for module/course completion: `isCourseCompleted()` checks `quizPassed && (labPassed || !moduleHasLab)` for each module.
13. **FR-13**: The system must evaluate 3 new badge triggers: `first-lab-pass`, `perfect-lab` (100% score), and `lab-streak:3` (3 labs completed).
14. **FR-14**: The system must display the lab section in the module viewer UI after the quiz section, with scenario, objectives, project ID input, verify button, and results panel.
15. **FR-15**: The system must reveal hidden check criteria and pass/fail status after verification, showing them as "Bonus check" before verification.
16. **FR-16**: The system must update streak tracking on lab verification attempts.
17. **FR-17**: The system must store the `labProjectId` used for the last successful verification in `ModuleProgress`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                         |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Labs read project state (agents, tools, deployments) for verification. Read-only — no writes. |
| Agent lifecycle            | SECONDARY    | Labs verify agent configuration (existence, blocks, topology). Read-only inspection.          |
| Customer experience        | PRIMARY      | Core learning feature — bridges the knowledge-to-practice gap.                                |
| Integrations / channels    | NONE         | Labs are Academy-internal, not channel-facing.                                                |
| Observability / tracing    | NONE         | No trace events emitted. Standard request logging only.                                       |
| Governance / controls      | SECONDARY    | Lab completion becomes a gate for course completion badges and certifications.                |
| Enterprise / compliance    | NONE         | No tenant-scoped lab customization in Phase 1.                                                |
| Admin / operator workflows | NONE         | No admin dashboard for lab analytics in Phase 1.                                              |

### Related Feature Integration Matrix

| Related Feature                                           | Relationship Type | Why It Matters                                                              | Key Touchpoints                                                                   | Current State |
| --------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------- |
| [Learning Academy](learning-academy.md)                   | extends           | Labs extend the Academy's content delivery with a new hands-on content type | Content model, progress tracking, gamification, UI shell                          | ALPHA         |
| [Agent Development (Studio)](agent-development-studio.md) | depends on        | Labs verify agent configurations created in Studio                          | `GET /api/projects/:id/agents`, `GET /api/projects/:id/agents/:name` (dslContent) | STABLE        |
| [Tool Invocations](tool-invocations.md)                   | reads             | Labs verify tool bindings on agents (e.g., "agent has an HTTP tool")        | Parsed from agent `dslContent` TOOLS blocks — no dedicated tools endpoint         | BETA          |
| [Multi-Agent Orchestration](multi-agent-orchestration.md) | reads             | Architect-persona labs verify multi-agent topologies                        | Parsed from agent `dslContent` FLOW blocks — handoff/delegate edge detection      | BETA          |
| [Deployments & Versioning](deployments-versioning.md)     | reads             | Some labs verify deployment state (e.g., "deployed to dev")                 | `GET /api/projects/:id/deployments`                                               | BETA          |
| [Auth Profiles](auth-profiles.md)                         | depends on        | Lab verification requires JWT forwarding for cross-service auth             | `Authorization` header forwarding from Academy to Runtime                         | BETA          |

---

## 6. Design Considerations

### Lab UX Flow

1. User navigates to module viewer → sees "Lab" tab alongside content sections and quiz
2. Lab section shows scenario (markdown), ordered objectives with visible criteria, hints
3. User enters project ID in text input → clicks "Verify Access" → system confirms access
4. User builds required configuration in Studio (separate tab/window)
5. User clicks "Verify My Work" → loading spinner with progress ("Checking objective 1 of N...")
6. Results panel shows per-objective pass/fail with feedback
7. Hidden checks revealed after verification with pass/fail status
8. Score bar shows earned/total points and pass/fail status
9. On pass: confetti animation, points awarded, badge announcements
10. On fail: retry available immediately (within rate limit)

### Section Navigation

Current module viewer sections: `number | 'quiz'`. Extended to: `number | 'quiz' | 'lab'`.
Navigation flow: content sections → quiz → lab → next module.
Lab is accessible regardless of quiz status (user decision).

---

## 7. Technical Considerations

### Cross-Service Communication

The Academy service (port 3116) cannot directly access the database for project/agent data. Instead, it makes server-side HTTP calls to the Runtime API (port 3112), forwarding the user's JWT from the original request. The Runtime enforces all tenant/project/user isolation — the Academy is a pass-through.

This pattern avoids:

- Service-to-service credentials (no new JWT minting)
- Duplicating authorization logic across services
- Coupling the Academy package to ABL-specific models

### ProjectState Port (Hexagonal Architecture)

The `packages/academy` core package defines a `ProjectStatePort` interface describing what project state it needs. The `apps/academy` host app provides a concrete adapter that calls the Runtime API. This preserves the Academy package's zero-dependency-on-ABL-runtime principle.

```
packages/academy/          apps/academy/
  ProjectStatePort  ←----  RuntimeProjectStateAdapter
  (interface)               (implementation: HTTP calls)
```

### Verification Engine

The verification engine is a **pure function**: `verifyLab(labDefinition, projectState) => LabVerificationResult`. No side effects, no I/O. Fully unit-testable. The Academy app layer handles I/O (fetching project state, persisting progress) and calls the pure verifier.

### DSL-Based State Derivation

Tool references and topology are **not** available via dedicated Runtime API endpoints. Instead, the `RuntimeProjectStateAdapter` assembles this state by:

1. Fetching each agent's `dslContent` via the per-agent detail endpoint
2. Parsing DSL with `@abl/core` to extract structured blocks (IDENTITY, TOOLS, GATHER, FLOW, etc.)
3. Extracting tool references from TOOLS blocks (tool name, type)
4. Extracting topology edges from FLOW blocks (handoff/delegate target agent names)

This approach uses only existing Runtime endpoints. The `dsl-parser.ts` module encapsulates all `@abl/core` parsing logic, keeping it isolated from the verification engine.

---

## 8. How to Consume

### Studio UI

**Route**: `/academy/modules/{moduleId}?courseId={courseId}&section=lab`

**Entry points**:

- Module viewer sidebar: "Lab" entry appears after "Quiz" when `hasLab: true`
- Section footer nav: "Next" after quiz goes to lab (if present)
- Academy dashboard: course card shows lab completion indicator per module

**Components**:

- `LabSection` — scenario display, objectives list, project input, verify button
- `LabResults` — per-objective pass/fail with feedback, score bar, badge announcements
- `ModuleStepSidebar` — extended with lab entry (flask icon)
- `SectionFooterNav` — extended with lab navigation

### Surface Semantics Matrix

| Asset / Entity Type              | Source of Truth                          | Design-Time Surface         | Editable?                              | Consumer Reference                | Runtime Materialization              | Notes                         |
| -------------------------------- | ---------------------------------------- | --------------------------- | -------------------------------------- | --------------------------------- | ------------------------------------ | ----------------------------- |
| Lab definition                   | `lab.json` in content dir                | Module viewer "Lab" section | Read-only (content authored offline)   | `GET /modules/:moduleId/lab`      | N/A — evaluated at verification time | Content is bundled in package |
| Lab progress                     | `academy_progress.modules.{moduleId}`    | Module viewer, sidebar      | Read-only (updated by verify endpoint) | Part of `GET /progress`           | N/A                                  | Stored in MongoDB             |
| Project state (for verification) | Runtime API (agents, tools, deployments) | Not surfaced in Academy     | N/A                                    | Fetched at verification time only | Transient — not persisted by Academy | Read-only cross-service call  |

### Design-Time vs Runtime Behavior

Labs are entirely design-time (Academy UI). There is no runtime component — labs do not affect agent execution, deployment, or conversation handling. The "verification" is a point-in-time read of project state, not a continuous monitor.

### API (Academy Service — Port 3116)

| Method | Path                                           | Purpose                                                                   |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/api/v1/academy/modules/:moduleId/lab`        | Returns lab definition (check configs stripped, hidden checks anonymized) |
| POST   | `/api/v1/academy/modules/:moduleId/lab/verify` | Accepts `{ projectId }`, runs checks, returns per-objective results       |

### API (Runtime — Port 3112, Consumed by Academy)

The Academy's `RuntimeProjectStateAdapter` assembles `ProjectState` by calling these **existing** Runtime endpoints:

| Method | Path                                         | Purpose                | Returns                                                                                  |
| ------ | -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/agents`            | List agents in project | `{ agents: [{ id, name, agentPath, description, versionCount }] }` — **no `dslContent`** |
| GET    | `/api/projects/:projectId/agents/:agentName` | Single agent detail    | `{ agent: { ..., dslContent } }` — **includes `dslContent`**                             |
| GET    | `/api/projects/:projectId/deployments`       | List deployments       | Deployment list with environment and status                                              |

**Important: No `/topology` or `/tools` endpoints exist.** The adapter derives this state:

- **Tool references**: Parsed from each agent's `dslContent` using `@abl/core` parser — TOOLS blocks list tool names and types.
- **Topology (edges)**: Parsed from each agent's `dslContent` FLOW blocks — handoff/delegate steps reference target agents by name.
- **Agent blocks**: Parsed from `dslContent` — IDENTITY, TOOLS, GATHER, FLOW, etc.

**Data assembly flow:**

1. `GET /agents` → list of agent names (access check — 401/403/404 means user lacks access)
2. `GET /agents/:agentName` for each agent (parallelized) → `dslContent` per agent
3. Parse each `dslContent` with `@abl/core` → extract blocks, tool refs, flow edges
4. `GET /deployments` → deployment list
5. Assemble into `ProjectState` shape for the pure verifier

**N+1 query note**: The per-agent detail calls create an N+1 pattern. For typical projects (<20 agents), parallelized calls complete well within the 5s p95 target. For projects with 50+ agents, the adapter should short-circuit after fetching agents relevant to the lab's check assertions.

### Admin Portal

N/A for Phase 1. Lab analytics dashboard planned for Phase 2.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. Labs are an Academy-only feature with no channel exposure.

---

## 9. Data Model

### Collections / Tables

```text
Collection: academy_progress (EXISTING — extended)
Fields (ModuleProgress sub-document, per moduleId in modules Map):
  - contentRead: Boolean (existing)
  - quizAttempts: Number (existing)
  - quizPassed: Boolean (existing)
  - bestScore: Number (existing)
  - lastAttemptDate: Date (existing)
  - contentVersion: String (existing)
  - labAttempts: Number (NEW, default: 0)
  - labPassed: Boolean (NEW, default: false)
  - labBestScore: Number (NEW, default: 0, stored as 0-1 fraction)
  - lastLabAttemptDate: Date (NEW, default: null)
  - labProjectId: String (NEW, default: null — project used for last successful verification)
Indexes: unchanged (userId unique, points descending)
```

No new collections. No migration needed — Mongoose defaults handle missing fields on existing documents. The dot-notation `$set` pattern in `MongooseAcademyStorage.updateModuleProgress()` already supports adding new sub-fields.

### Content Files (New)

```text
File: packages/academy/content/modules/{moduleId}/lab.json
Structure:
  - moduleId: string (must match directory name)
  - title: string
  - scenario: string (markdown)
  - estimatedMinutes: number
  - difficulty: 1 | 2 | 3
  - passThreshold: number (0-1)
  - prerequisites: string[] (module IDs, advisory only)
  - objectives: LabObjective[]
    - id: string (unique within lab)
    - title: string
    - description: string
    - points: number
    - checks: LabCheck[]
      - type: LabCheckType
      - hidden: boolean
      - feedback: { pass: string, fail: string }
      - config: (type-specific)
    - hints: string[]
```

### Key Relationships

- `lab.json` → `module.json`: 1:1 optional relationship. Not all modules have labs.
- `ModuleProgress.labPassed` → `isCourseCompleted()`: Lab completion gates course completion for modules with labs.
- Academy service → Runtime API: Cross-service read-only relationship via JWT forwarding.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                      | Purpose                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/academy/src/types.ts`                           | `LabFile`, `LabObjective`, `LabCheck`, `LabCheckType`, `LabCheckConfig`, `LabVerificationResult`, `ProjectState` interfaces; `ModuleProgress` extension |
| `packages/academy/src/lab/lab-verifier.ts`                | **New** — pure function `verifyLab(lab, projectState)` with 6 check type implementations                                                                |
| `packages/academy/src/lab/lab-checks.ts`                  | **New** — individual check type implementations (`checkAgentExists`, `checkAgentHasBlock`, etc.)                                                        |
| `packages/academy/src/lab/dsl-parser.ts`                  | **New** — parses agent `dslContent` via `@abl/core` to extract blocks, tool refs, and topology edges                                                    |
| `packages/academy/src/services/content-service.ts`        | Extended with `getLab()`, `getLabInternal()`, `hasLab()` methods                                                                                        |
| `packages/academy/src/services/progress-service.ts`       | Extended with `verifyLab()` orchestrator method                                                                                                         |
| `packages/academy/src/services/gamification-service.ts`   | Extended `isCourseCompleted()` to check lab status; 3 new badge triggers                                                                                |
| `packages/academy/src/validation/schemas.ts`              | `labVerifySchema` (Zod), `labFileSchema` (Zod for content validation)                                                                                   |
| `packages/academy/src/schemas/academy-progress.schema.ts` | 4 new fields on `MODULE_PROGRESS_SCHEMA`                                                                                                                |
| `packages/academy/src/ports.ts`                           | `ProjectStatePort` interface for cross-service project state fetching                                                                                   |

### Routes / Handlers

| File                                            | Purpose                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/academy/src/routes/academy.ts`            | Extended with `GET /modules/:moduleId/lab` and `POST /modules/:moduleId/lab/verify`; existing module endpoint gains `hasLab` |
| `apps/academy/src/lib/project-state-adapter.ts` | **New** — `RuntimeProjectStateAdapter` implementing `ProjectStatePort` via HTTP calls to Runtime                             |

### UI Components

| File                                                       | Purpose                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/studio/src/app/academy/modules/[moduleId]/page.tsx`  | Extended with lab section rendering, `'lab'` section type      |
| `apps/studio/src/components/academy/LabSection.tsx`        | **New** — lab scenario, objectives, project input, verify flow |
| `apps/studio/src/components/academy/LabResults.tsx`        | **New** — per-objective results display with feedback          |
| `apps/studio/src/components/academy/ModuleStepSidebar.tsx` | Extended with lab entry                                        |
| `apps/studio/src/components/academy/SectionFooterNav.tsx`  | Extended with lab navigation                                   |
| `apps/studio/src/store/academy-store.ts`                   | `AcademyModuleProgress` gains lab fields                       |

### Jobs / Workers / Background Processes

| File | Purpose                                              |
| ---- | ---------------------------------------------------- |
| N/A  | No background jobs. Lab verification is synchronous. |

### Tests

| File                                                          | Type        | Coverage Focus                                                        |
| ------------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `packages/academy/src/__tests__/unit/lab-verifier.test.ts`    | unit        | All 6 check types, grading algorithm, edge cases                      |
| `packages/academy/src/__tests__/unit/lab-checks.test.ts`      | unit        | Individual check type implementations                                 |
| `packages/academy/src/__tests__/unit/dsl-parser.test.ts`      | unit        | DSL-to-ProjectState extraction (blocks, tools, topology)              |
| `packages/academy/src/__tests__/service/lab-progress.test.ts` | integration | Lab verification flow, progress updates, point awards, badge triggers |
| `apps/academy/src/__tests__/e2e/lab-api.test.ts`              | e2e         | Lab API endpoints, auth, rate limiting, project access                |

---

## 11. Configuration

### Environment Variables

| Variable      | Default                 | Description                                            |
| ------------- | ----------------------- | ------------------------------------------------------ |
| `RUNTIME_URL` | `http://localhost:3112` | Base URL for Runtime API calls during lab verification |

### Runtime Configuration

Lab settings in `packages/academy/content/academy.json` under `settings`:

```json
{
  "pointsLabComplete": 200,
  "labVerifyRateLimitMax": 5,
  "labVerifyRateLimitWindowMs": 600000,
  "requireLabForCompletion": true
}
```

### DSL / Agent IR / Schema

N/A — Labs do not affect the ABL DSL, compiler IR, or agent schemas. Labs are an Academy-only feature that reads (but never writes) agent configurations.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Lab verification forwards the user's JWT to the Runtime API. The Runtime enforces `projectId` scoping — Academy never queries the project database directly. A user cannot verify against a project they don't have access to. |
| Tenant isolation  | The Runtime API rejects requests where the JWT's `tenantId` doesn't match the project's `tenantId`. Cross-tenant access returns 404 (not 403).                                                                                 |
| User isolation    | Lab progress is stored in `AcademyProgress` keyed by `userId`. Each user's lab results are independent. The `labProjectId` field stores which project was used — this is per-user, not shared.                                 |

### Security & Compliance

- **Authentication**: Lab verification requires a valid JWT (same auth as all Academy endpoints).
- **Authorization**: Runtime API enforces project-level RBAC. Minimum required permission: `agent:read`, `tool:read` (available to `viewer` role).
- **No write access**: Lab verification is entirely read-only. The Academy never modifies the target project.
- **Secret handling**: No new secrets. JWT forwarding uses the existing `Authorization` header.
- **Audit logging**: Lab verification attempts are not audit-logged in Phase 1. Consideration for Phase 2.
- **PII**: No additional PII collected. Project IDs are not PII.

### Performance & Scalability

- **Verification latency**: Target p50 < 3s, p95 < 5s. Achieved by parallelizing objective checks (each objective's Runtime API calls run concurrently via `Promise.all`).
- **Rate limiting**: 5 attempts per module per 10-minute window per user. In-memory bounded map (10K entries, TTL-based eviction) — same pattern as quiz rate limiter.
- **Caching**: Lab JSON files cached in the existing content-loader LRU cache (120 entries). No new cache needed.
- **Project state**: Not cached — always fetched fresh to reflect the latest project configuration.

### Reliability & Failure Modes

- **Runtime API unavailable**: Verification returns 502 with message "Could not verify lab — platform services unavailable. Please try again."
- **Project has unparseable agents**: Topology compilation may fail. Checks that depend on compiled IR fall back to DSL-level inspection where possible; otherwise the check fails with feedback "Agent could not be compiled — fix syntax errors first."
- **Idempotent point awards**: Points awarded only on first pass (`labPassed === false` → `true`). Subsequent verifications update `labBestScore` and `labAttempts` but don't re-award.
- **Concurrent verifications**: Atomic Mongoose `$set` operations prevent race conditions. Rate limiter handles concurrent requests.

### Observability

- Standard request logging for lab API endpoints (method, path, status code, latency).
- No custom trace events or metrics in Phase 1.
- Lab verification failures logged with `moduleId`, `projectId`, and error type.

### Data Lifecycle

- Lab progress stored indefinitely in `academy_progress` (same as quiz progress).
- No TTL on lab fields.
- `labProjectId` retained for reference but not used for ongoing verification.
- Progress reset (`POST /progress/reset`) clears all lab fields alongside quiz fields.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Core Lab Infrastructure

1. **Content model and types**
   1.1. Define `LabFile`, `LabObjective`, `LabCheck`, `LabCheckConfig` types in `packages/academy/src/types.ts`
   1.2. Define `ProjectState`, `ProjectStatePort` interfaces
   1.3. Define `LabVerificationResult`, `ObjectiveResult`, `CheckResult` types
   1.4. Extend `ModuleProgress` with 4 lab fields + `labProjectId`
   1.5. Create Zod validation schema for `lab.json` in `packages/academy/src/validation/schemas.ts`
   1.6. Extend `AcademySettings` type with lab-specific settings (`pointsLabComplete`, `labVerifyRateLimitMax`, `labVerifyRateLimitWindowMs`, `requireLabForCompletion`)

2. **Mongoose schema extension**
   2.1. Add lab fields to `MODULE_PROGRESS_SCHEMA` in `packages/academy/src/schemas/academy-progress.schema.ts`

3. **Verification engine (pure functions)**
   3.1. Create `packages/academy/src/lab/lab-verifier.ts` — `verifyLab()` grading function
   3.2. Create `packages/academy/src/lab/lab-checks.ts` — 6 check type implementations (`custom-check` deferred to Phase 2)
   3.3. Create `packages/academy/src/lab/dsl-parser.ts` — DSL-to-ProjectState helper using `@abl/core` parser (extracts blocks, tool refs, topology edges from `dslContent`)
   3.4. Unit tests for all check types, DSL parsing, and grading algorithm

4. **Content service extension**
   4.1. Add `getLab(moduleId)`, `getLabInternal(moduleId)`, `hasLab(moduleId)` to `ContentService`
   4.2. Implement lab answer stripping (hidden checks anonymized, check configs removed)

5. **Progress service extension**
   5.1. Add `verifyLab(userId, moduleId, projectState)` method
   5.2. Lab rate limiting (5/10min per module)
   5.3. Lab progress persistence (attempts, passed, bestScore, projectId)
   5.4. Lab point awards (idempotent)

6. **Gamification extension**
   6.1. Update `isCourseCompleted()` to check `labPassed` for modules with labs
   6.2. Add 3 new badge triggers: `first-lab-pass`, `perfect-lab`, `lab-streak:3`
   6.3. Add 3 new badges to `academy.json`
   6.4. Add lab point settings to `academy.json`

7. **ProjectState adapter**
   7.1. Create `apps/academy/src/lib/project-state-adapter.ts` — Runtime API HTTP client
   7.2. JWT forwarding from original request
   7.3. Error handling for Runtime unavailability

8. **API routes**
   8.1. `GET /modules/:moduleId/lab` — lab definition endpoint
   8.2. `POST /modules/:moduleId/lab/verify` — verification endpoint
   8.3. Extend `GET /modules/:moduleId` to include `hasLab`
   8.4. Zod validation for verify request body

9. **Studio UI**
   9.1. Create `LabSection.tsx` component
   9.2. Create `LabResults.tsx` component
   9.3. Extend module viewer page with `'lab'` section type
   9.4. Extend `ModuleStepSidebar` with lab entry
   9.5. Extend `SectionFooterNav` with lab navigation
   9.6. Update `AcademyModuleProgress` in academy store

10. **Pilot lab content**
    10.1. `abl-basics/lab.json` — Build Your First Agent (difficulty 1)
    10.2. `agent-configuration/lab.json` — Configure Agent Identity (difficulty 1)
    10.3. `tools-integrations/lab.json` — Connect Your First Tool (difficulty 2)
    10.4. `data-collection/lab.json` — Build a GATHER Form (difficulty 2)
    10.5. `multi-agent-fundamentals/lab.json` — Build a Multi-Agent System (difficulty 2)

11. **i18n**
    11.1. Add lab-related strings to `packages/i18n/locales/en/academy.json`

12. **Integration and E2E tests**
    12.1. Service-level tests for lab verification flow
    12.2. E2E tests for lab API endpoints

13. **Exports and wiring**
    13.1. Update `packages/academy/src/index.ts` barrel exports
    13.2. Update factory to wire lab-related services

---

## 14. Success Metrics

| Metric                                | Baseline          | Target                                             | How Measured                                                |
| ------------------------------------- | ----------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Lab completion rate (per pilot lab)   | N/A (new feature) | >50% of learners who start a lab complete it       | `labPassed` counts / `labAttempts > 0` counts               |
| Average verification attempts to pass | N/A               | <4 attempts                                        | `labAttempts` at time of `labPassed = true`                 |
| Lab verification latency              | N/A               | p50 < 3s, p95 < 5s                                 | Request duration on `POST /lab/verify`                      |
| Lab point contribution to leaderboard | 0%                | >15% of total points come from labs                | Sum of lab points / total points across all users           |
| Course completion drop-off from labs  | N/A               | <10% of users who passed quiz fail to complete lab | Users with `quizPassed && !labPassed` for modules with labs |

---

## 15. Open Questions

1. **Lab content for modules shared across personas**: Courses like `platform-foundations` appear in multiple persona paths. Should labs be persona-specific or shared across all paths?
2. **DSL parsing failures**: Topology and tool refs are derived from agent DSL parsing. If an agent has syntax errors, its DSL may not parse. Should lab verification skip unparseable agents (partial state) or fail the check with feedback "Agent has syntax errors — fix before verifying"?
3. **Lab versioning**: When `lab.json` is updated (new checks, changed point values), should existing `labPassed` status be preserved or require re-verification?
4. **Runtime API stability contract**: Labs depend on specific Runtime API response shapes. How do we handle Runtime API changes that break lab checks?
5. **Project state snapshot**: Should we snapshot the project state at verification time for audit/debugging, or is the pass/fail result sufficient?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                   | Severity | Status                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| GAP-001 | No sandbox project provisioning — user must have an existing project                                                                                                                          | Medium   | Open (Phase 2 planned)                         |
| GAP-002 | No guided vs challenge mode — all labs are guided in Phase 1                                                                                                                                  | Low      | Open (Phase 2 planned)                         |
| GAP-003 | `custom-check` expression evaluator deferred to Phase 2 — requires security hardening (sandboxed evaluator, input sanitization) before shipping. Phase 1 ships with 6 typed check types only. | Medium   | Deferred (Phase 2)                             |
| GAP-004 | No lab analytics dashboard for admins                                                                                                                                                         | Low      | Open (Phase 2 planned)                         |
| GAP-005 | Business analyst persona modules have no labs — BA check types TBD                                                                                                                            | Low      | Open (Phase 2)                                 |
| GAP-006 | Lab verification depends on Runtime API availability — no offline/cached fallback                                                                                                             | Medium   | Open (accepted — read-only calls are low risk) |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                    | Coverage Type | Status     | Test File / Note       |
| --- | --------------------------------------------------------------------------- | ------------- | ---------- | ---------------------- |
| 1   | `agent-exists` check passes when agent with matching name found             | unit          | NOT TESTED | `lab-verifier.test.ts` |
| 2   | `agent-has-block` check detects IDENTITY/TOOLS/GATHER/FLOW blocks           | unit          | NOT TESTED | `lab-checks.test.ts`   |
| 3   | `tool-exists` check filters by tool type                                    | unit          | NOT TESTED | `lab-checks.test.ts`   |
| 4   | `agent-count` check enforces min/max bounds                                 | unit          | NOT TESTED | `lab-checks.test.ts`   |
| 5   | `topology-check` detects handoff/delegate edges                             | unit          | NOT TESTED | `lab-checks.test.ts`   |
| 6   | `deployment-exists` check filters by environment and status                 | unit          | NOT TESTED | `lab-checks.test.ts`   |
| 7   | DSL parser extracts blocks, tool refs, and topology edges from `dslContent` | unit          | NOT TESTED | `dsl-parser.test.ts`   |
| 8   | Lab grading: partial credit scoring correct                                 | unit          | NOT TESTED | `lab-verifier.test.ts` |
| 9   | Lab grading: hidden checks contribute to score                              | unit          | NOT TESTED | `lab-verifier.test.ts` |
| 10  | Lab grading: passThreshold boundary (exactly at threshold = pass)           | unit          | NOT TESTED | `lab-verifier.test.ts` |
| 11  | Lab points awarded on first pass only                                       | integration   | NOT TESTED | `lab-progress.test.ts` |
| 12  | Lab verification updates labAttempts, labBestScore                          | integration   | NOT TESTED | `lab-progress.test.ts` |
| 13  | isCourseCompleted requires labPassed for modules with labs                  | integration   | NOT TESTED | `gamification.test.ts` |
| 14  | Badge trigger: first-lab-pass fires on first lab completion                 | integration   | NOT TESTED | `gamification.test.ts` |
| 15  | Rate limiting: 6th attempt within 10min returns 429                         | e2e           | NOT TESTED | `lab-api.test.ts`      |
| 16  | GET /modules/:moduleId/lab returns stripped definition                      | e2e           | NOT TESTED | `lab-api.test.ts`      |
| 17  | POST /modules/:moduleId/lab/verify returns per-objective results            | e2e           | NOT TESTED | `lab-api.test.ts`      |
| 18  | Verify with inaccessible project returns 404                                | e2e           | NOT TESTED | `lab-api.test.ts`      |
| 19  | GET /modules/:moduleId returns hasLab:true for modules with labs            | e2e           | NOT TESTED | `lab-api.test.ts`      |
| 20  | Existing progress without lab fields returns defaults                       | integration   | NOT TESTED | `lab-progress.test.ts` |

### Testing Notes

No tests exist yet — this is a PLANNED feature. Full testing details will be developed in the test spec phase.

> Full testing details: [../testing/academy-labs.md](../testing/academy-labs.md)

---

## 18. References

- Market research: [`explorations/2026-04-14-hands-on-labs-market-research.md`](../../explorations/2026-04-14-hands-on-labs-market-research.md)
- Trailhead patterns: [`explorations/2026-04-14-trailhead-patterns-for-academy.md`](../../explorations/2026-04-14-trailhead-patterns-for-academy.md)
- Parent feature: [`docs/features/learning-academy.md`](learning-academy.md)
- AI Coach design: [`LearningAcademy/AI-COACH-DESIGN.md`](../../LearningAcademy/AI-COACH-DESIGN.md)
- SDLC log: [`docs/sdlc-logs/academy-labs/feature-spec.log.md`](../sdlc-logs/academy-labs/feature-spec.log.md)
