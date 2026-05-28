# ABL Platform Learning Academy -- Executive Summary

**Status:** Alpha | **Version:** 3.0.0 | **Date:** 2026-04-10

---

## 1. Executive Overview

The Learning Academy is a self-paced, in-product education platform that teaches users how to build, architect, and manage AI agents on the ABL Platform. It ships as a **standalone microservice** (`apps/academy/`, port 3116) with a lightweight Studio UI integration -- zero coupling to core runtime or compiler packages.

The Academy addresses a concrete business problem: as the platform's surface area grows (ABL language, multi-agent orchestration, SDK integrations, enterprise security), users need structured onboarding beyond static documentation. The Academy provides guided learning paths, knowledge assessments, and gamified progress tracking -- all accessible from within Studio at `/academy`.

**By the numbers:**

| Metric                    | Value     |
| ------------------------- | --------- |
| Learning paths (personas) | 3         |
| Courses                   | 14        |
| Modules                   | 40        |
| Quiz questions            | 200       |
| Total content             | ~25 hours |
| Badges                    | 22        |
| Ranks                     | 6         |

---

## 2. Key Features

### Persona-Based Learning Paths

Three curated paths target distinct user profiles:

| Persona              | Target Audience                | Courses | Hours |
| -------------------- | ------------------------------ | ------- | ----- |
| **Agent Builder**    | Developers                     | 6       | 10.9  |
| **Agent Architect**  | Senior Devs / Architects       | 6       | 10.4  |
| **Business Analyst** | Non-technical / Semi-technical | 5       | 6.6   |

Each path defines a prerequisite chain from beginner to advanced, with courses leveled as beginner, intermediate, or advanced. Users can switch between paths at any time -- progress is preserved per-persona, no lock-in. The dashboard dynamically recalculates completion stats, course grids, and the "Continue Learning" CTA when a user switches paths.

### Persona Dashboard

Once a persona is selected, the dashboard presents a unified view of the learner's state:

- **Overall progress bar** with weighted scoring (quiz passed = 100%, content read = 50%, not started = 0%)
- **Stats row** showing courses completed (e.g., "2 of 6"), modules passed, total points earned, and estimated time remaining
- **Continue Learning CTA** that deep-links directly to the first incomplete module section -- the user picks up exactly where they left off
- **Course card grid** with per-course progress bars, module counts, estimated time, level badges (beginner/intermediate/advanced), and pass ratios
- **Gamification panel** below courses: current rank badge, 7-day streak indicator, and a collapsible badge collection showing earned vs. total achievements

### Section-by-Section Content Delivery

Module content (markdown with GFM tables, syntax-highlighted code blocks, callout tips) is split into digestible sections (~5-10 minutes each). Users navigate one section at a time rather than scrolling a long document. The experience is structured around three UI elements:

- **Unified left sidebar**: Shows all modules in the course with progress indicators (green checkmark = quiz passed, solid dot = content read, hollow ring = not started). The current module auto-expands to reveal its individual sections and a quiz entry point. Clicking any section or module navigates instantly.
- **Content pane**: Renders one section at a time with full GFM markdown support -- tables, fenced code blocks with syntax highlighting, blockquote callouts (tip/warning/note), and inline code. Content auto-scrolls to the top on every section transition.
- **Fixed footer navigation**: Prev/next buttons with section titles, a step indicator ("Section 5 of 12"), and intelligent transitions -- last content section leads to "Continue to Quiz", quiz completion leads to "Next Module". Cross-module navigation is seamless.

### Assessment System

Every module ends with a 5-question quiz presented as a stepper -- one question per screen with animated slide transitions. Two question types:

- **Multiple choice (MCQ)**: 3 options with styled radio selection and visual feedback on the selected answer
- **Fill-in-the-blank**: Free-text input with placeholder hints

Users must answer the current question before advancing. On the final question, a "Submit" button sends all answers to the server for grading. The client never sees correct answers -- grading is entirely server-side. Pass threshold: 80%. Rate-limited to 3 attempts per 5-minute window per module to prevent brute-force.

**Results screen** provides immediate, detailed feedback:

- Animated score counter that counts up to the final percentage
- Per-question breakdown with correct/incorrect indicators and written explanations for every question
- Points awarded (diminishing: 100/50/25 per attempt), current rank, and any newly earned badges
- Confetti animation on pass; retry button on failure

### Gamification & Progression

The gamification system is designed to sustain engagement across the ~25 hours of content:

- **Points**: Diminishing returns per quiz attempt (100/50/25 pts), plus bonus points for course completion and full path completion. This rewards first-attempt mastery while still incentivizing retry.
- **Ranks**: 6 tiers (Newcomer → Apprentice → Practitioner → Expert → Specialist → Master). Each rank has a minimum point threshold; Master additionally requires 2 completed learning paths. Rank is displayed as a styled badge on the dashboard.
- **Badges**: 22 distinct achievements spanning three categories: per-course certifications (pass all modules in a course), per-path certifications ("Certified Agent Builder"), and activity milestones (first quiz completed, perfect score, 7-day streak, etc.). Badges appear as a collapsible grid showing earned vs. locked state.
- **Streaks**: Daily activity tracking with a 7-day visual history. The streak indicator shows consecutive active days and the last active date.
- **Leaderboard**: Global ranking by points with pagination. Accessible from the header navigation.

### Course Certifications

Each course defines a certification badge. Awarded when all module quizzes in that course are passed. Persona path completion earns a named certification (e.g., "Certified Agent Builder"). Visual confetti celebration on earn. Certification status is surfaced on the course detail page alongside the module timeline.

---

## 3. User Journey

```
Landing Page
  |
  v
[Choose Persona] -- 3 cards: Builder / Architect / Analyst
  |                  (switchable anytime, progress preserved)
  v
Persona Dashboard
  |-- Progress bar (weighted: quiz passed=100%, read=50%)
  |-- Stats: courses completed, modules done, points, est. time
  |-- "Continue Learning" CTA -> first incomplete module
  |-- Course card grid with per-course progress
  |-- Gamification: rank badge, streak indicator, collapsible badges
  |
  v
Course Detail
  |-- Module timeline (ordered list with completion indicators)
  |-- Certification status at bottom
  |
  v
Module Viewer (section-by-section)
  |-- Left sidebar: all modules (expandable) + current module's sections + quiz
  |-- Content pane: one h2 section at a time (markdown rendered)
  |-- Fixed footer: prev/next section, transitions to quiz and cross-module
  |-- "Mark as Read" on last content section
  |
  v
Quiz (stepper)
  |-- One question per screen, animated transitions
  |-- MCQ (3 options) or fill-in-the-blank
  |-- Progress bar, submit on final question
  |
  v
Results
  |-- Animated score counter, confetti on pass
  |-- Points awarded, rank update, new badges
  |-- Per-question breakdown with explanations
  |-- Retry button on failure
```

---

## 4. Technical Architecture

### Design Philosophy: Independent Module, Integrated Experience

The Academy follows the same architectural pattern as SearchAI -- a **fully independent service** that is packaged within the ABL monorepo to leverage shared infrastructure (auth, user profiles, database adapters) without coupling to the core runtime or compiler.

This is a deliberate choice. The Academy service has zero imports from `@abl/core`, `@abl/compiler`, or any runtime package. Its core logic lives in `packages/academy/` -- a portable package that depends only on `zod` and `mongoose` (as peers). The Express service in `apps/academy/` wires this package to HTTP, auth middleware, and MongoDB. Studio provides the UI shell and proxies API requests through its auth boundary.

**Why integrate into ABL rather than build standalone?** The roadmap answers this question directly. Future capabilities -- hands-on labs that spin up real ABL projects, video walkthroughs of Studio workflows, content authoring tied to platform releases -- all require deep integration with the platform's project system, auth layer, and runtime. Building the Academy inside the monorepo today means these extensions are additive wiring, not ground-up integrations. The service boundary is clean enough to extract later if needed, but the integration surface is already there when the roadmap demands it.

### Service Topology

```
Studio (Next.js, :5173)              Academy Service (Express, :3116)
  |                                    |
  |  /api/academy/* ----[proxy]---->   /api/v1/academy/*
  |                                    |
  |  Zustand store                     |-- Content Service (fs-based, LRU cached)
  |  26 React components               |-- Progress Service (MongoDB)
  |  3 page routes                     |-- Gamification Service (badges, ranks, streaks)
  |                                    |-- Leaderboard Service (MongoDB sort)
  |                                    |
  |                                    packages/academy/ (core, zero-ABL-dependency)
  |                                      |-- Storage Port (interface)
  |                                      |-- Mongoose adapter
  |                                      |-- Quiz grader (pure function)
  |                                      |-- Content loader (async fs + LRU)
```

Like SearchAI, the Academy service can be deployed, scaled, and health-checked independently. It shares the MongoDB cluster and auth middleware (`@agent-platform/shared-auth`) but owns its own collection (`academy_progress`) and has no runtime dependencies. The proxy pattern means Studio handles the auth boundary -- the Academy service trusts the JWT it receives, extracts `userId`, and proceeds.

### Design Decisions

| Decision                                           | Rationale                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Standalone Express service**                     | Independent deployment, own scaling profile, no runtime coupling                         |
| **Zero ABL dependencies** in `packages/academy/`   | Core package is portable; only depends on `zod` + `mongoose` (peer)                      |
| **SearchAI-style integration**                     | Lives in monorepo for shared auth/infra, but service boundary is clean enough to extract |
| **Storage Port pattern** (DI)                      | Database-agnostic; Mongoose adapter today, swappable tomorrow                            |
| **Content in npm package**                         | Self-contained; `packages/academy/content/` ships with the package                       |
| **Client-side markdown splitting**                 | No backend API changes needed; full content fetched once, split on h2 boundaries         |
| **Studio proxy integration**                       | Single auth boundary; Studio rewrites `/api/academy/*` to the service                    |
| **Progress keyed on `userId`** (not tenant-scoped) | Learning is personal, cross-organization                                                 |
| **Server-side quiz grading**                       | Clients never see correct answers; rate-limited to prevent brute-force                   |

### API Surface

15 endpoints total (13 authenticated + 2 health probes). Auth via `@agent-platform/shared-auth` (JWT Bearer or API key). Key endpoints:

| Method | Endpoint               | Purpose                           |
| ------ | ---------------------- | --------------------------------- |
| GET    | `/config`              | Academy config + course catalog   |
| GET    | `/modules/:id/content` | Module markdown                   |
| GET    | `/modules/:id/quiz`    | Quiz questions (answers stripped) |
| POST   | `/modules/:id/quiz`    | Submit + grade quiz               |
| POST   | `/modules/:id/read`    | Mark content as read              |
| GET    | `/progress`            | User progress                     |
| PATCH  | `/progress/persona`    | Set/switch persona                |
| GET    | `/leaderboard`         | Global rankings                   |

### Data Model

Single MongoDB collection: `academy_progress`

```
{
  _id:              uuidv7,
  userId:           string (unique index),
  email:            string,
  displayName:      string | null,
  selectedPersona:  "agent-builder" | "agent-architect" | "business-analyst" | null,
  modules:          Map<moduleId, {
    contentRead:    boolean,
    quizAttempts:   number,
    quizPassed:     boolean,
    bestScore:      number,
    lastAttemptDate: Date | null,
    contentVersion:  string | null
  }>,
  points:           number (indexed desc for leaderboard),
  badges:           string[],
  streakDays:       string[] (max 60, YYYY-MM-DD),
  lastActiveDate:   string | null
}
```

### Security & Guardrails

- Unified auth middleware (JWT / API key) on all endpoints
- Quiz rate limiting: 3 attempts per module per 5-minute window (in-memory, bounded at 10K entries)
- Helmet security headers, CORS whitelist, request body limit (10MB)
- Bounded collections: modules map (max 40), streak days (max 60), content cache (LRU, max 120 entries)
- Graceful shutdown with 10-second force-exit timeout

---

## 5. Content Architecture

Three-layer hierarchy, all static files in `packages/academy/content/`:

```
academy.json (master config: personas, course map, badges, ranks, settings)
  |
  +-- courses/*.json (14 files: title, level, modules[], prerequisites[], certification)
       |
       +-- modules/*/module.json (40 dirs: title, lessons[], optional videos map)
       +-- modules/*/content.md  (markdown content, 8-13 h2 sections each)
       +-- modules/*/quiz.json   (5 questions per module)
```

Select modules include an optional `videos` map in `module.json`, keyed by section slug. Each entry references a YouTube embed URL with a title and duration. When present, the module viewer renders a responsive video player above the section's markdown text. Sections without a video entry render text-only as before -- fully backward compatible.

Content covers the full ABL Platform:

| Domain           | Courses                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| **Foundations**  | Platform Foundations, ABL Language                                        |
| **Development**  | Tools & Data Collection, Studio Mastery, Advanced ABL                     |
| **Architecture** | Multi-Agent Design, Knowledge Architecture & RAG, Scalable Patterns       |
| **Operations**   | Testing & Safety, Enterprise Security, Administration, Quality Governance |
| **Integration**  | API & SDK Integration, Use Cases & Industry Applications                  |

---

## 6. Design Rationale & Trade-offs

**"There's no link between Academy completion and platform adoption metrics."**

The Academy's primary goal is to give builders a structured avenue to learn the platform -- not to serve as an adoption funnel with attributed conversion metrics. Tying learning directly to adoption KPIs would over-index the feature's purpose and create pressure to game completions rather than genuine understanding. That said, the architecture is explicitly designed to support this later: the `progress` data model already tracks per-module completion timestamps, quiz scores, and content versions. Adding an analytics layer that correlates Academy progress with platform usage (agents created, deployments, API calls) is a data join -- not a redesign. The extension path is open; the v1 scope is intentionally focused on learning quality.

**"Why build a custom LMS instead of using an off-the-shelf solution?"**

Three reasons. First, the content is deeply platform-specific -- ABL syntax, agent configuration blocks, multi-agent orchestration patterns -- and changes with every platform release. An external LMS would require a content sync pipeline and lose the ability to reference live platform constructs. Second, the Academy is designed to live _inside_ Studio, sharing auth, navigation, and context. Embedding a third-party LMS would break this seamless experience or require significant iframe/SSO integration work. Third, the implementation is intentionally lightweight: a single Express service (~15 endpoints), a single MongoDB collection, and static markdown content shipped inside an npm package. The total surface area is smaller than most LMS integration layers. The gamification engine (points, badges, ranks) is ~300 lines of pure functions -- not a platform unto itself.

**"Global leaderboard without tenant scoping breaks isolation principles."**

This is a deliberate design choice. Learning is a personal, cross-organizational activity -- a developer's ABL knowledge doesn't belong to their employer's tenant boundary. The progress document is keyed on `userId` only, and the leaderboard ranks individuals globally. This mirrors how developer certification programs work industry-wide (AWS certifications, Salesforce Trailhead). For enterprise customers who require tenant-scoped visibility, the data model supports it: adding a `tenantId` field to the progress schema and a filtered leaderboard query is additive. The current global-first design serves the common case without precluding the enterprise case.

---

## 7. Current Status & Roadmap

### Shipped (Alpha)

- Full content: 14 courses, 40 modules, 200 quiz questions across 3 personas
- Standalone service with MongoDB persistence
- Section-by-section content viewer with unified sidebar navigation
- Multi-persona switching (no lock-in)
- Complete gamification: points, 22 badges, 6 ranks, streaks, leaderboard
- Quiz stepper with animated transitions and detailed results
- Optional video content per section (YouTube embeds above markdown text, keyed by section slug in module.json)

### Near-Term

| Item                           | Description                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content versioning alerts**  | Schema already tracks `contentVersion` per module. Surface "content updated since you last completed this module" indicators and optional re-assessment prompts.                                                 |
| **Admin analytics dashboard**  | Completion rates, quiz pass/fail distributions, drop-off points, time-to-completion per module. Enables content authors to identify weak sections and iterate. Data already captured in the progress collection. |
| **Tenant-scoped leaderboards** | Additive: `tenantId` field on progress + filtered query. Lets enterprise customers see internal rankings alongside the global board.                                                                             |
| **E2E test coverage**          | Extend beyond API-layer tests to full UI E2E (section navigation, quiz flow, persona switching, gamification triggers).                                                                                          |
| **Production deployment**      | Helm chart, resource limits, horizontal pod autoscaling. Dockerfile exists; deployment configuration pending.                                                                                                    |

### Medium-Term

| Item                                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hands-on labs**                              | Interactive exercises that create real ABL projects in the user's workspace. Learners write agent definitions, run them, and see results -- all within the Academy flow. This is a primary reason the Academy lives inside the ABL monorepo: labs need direct access to the project system, runtime, and Studio editor.                                                                                                                                                                                                                                      |
| **Built-in authoring tools**                   | Admin-facing content editor for creating and updating courses, modules, and quiz questions without touching JSON/markdown files directly. Version control, preview, and publish workflow.                                                                                                                                                                                                                                                                                                                                                                    |
| **Learning-to-adoption correlation**           | Optional analytics layer that joins Academy progress (modules completed, quiz scores) with platform usage metrics (agents created, deployments, API calls). Architecture supports this as a data join -- no redesign required.                                                                                                                                                                                                                                                                                                                               |
| **Certification exports**                      | Downloadable/shareable certificates for completed paths. Verifiable via a public URL with the user's achievement record.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **AI-powered learning coach**                  | An intelligent coach that observes the user's activity across the platform -- agents built, tools configured, errors encountered, features used -- and proactively recommends relevant Academy courses and modules. Surfaces contextual nudges like "You just created your first multi-agent workflow -- take the Multi-Agent Design course to learn orchestration patterns." Turns the Academy from pull-based (user browses courses) to push-based (platform guides the user to what they need next).                                                      |
| **ABL-integrated labs & practical evaluation** | Hands-on lab exercises that go beyond reading and quizzes -- learners build real agents using ABL within a guided, sandboxed environment tied to their Academy progress. Enables practical evaluation of candidates: can they actually build a working agent, not just pass a quiz? Opens the door for hiring assessments, team onboarding benchmarks, and skill certification backed by demonstrated platform competency rather than theoretical knowledge. This is a key reason the Academy is integrated into ABL rather than built as a standalone tool. |
