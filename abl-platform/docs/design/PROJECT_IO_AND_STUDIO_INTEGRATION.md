# Project I/O & Studio Integration — Comprehensive Documentation

> Covers features, UI/UX flows, API surface, data flows, strengths, and limitations.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Package Architecture — `@agent-platform/project-io`](#2-package-architecture)
3. [Feature Reference](#3-feature-reference)
   - 3.1 Export
   - 3.2 Import
   - 3.3 Diff & Section Splicing
   - 3.4 Dependency Analysis
   - 3.5 Ownership & Locking
   - 3.6 Git Integration
4. [Studio UI/UX](#4-studio-uiux)
   - 4.1 App Shell & Navigation
   - 4.2 Project Dashboard
   - 4.3 Agent Detail & Editor
   - 4.4 Session Debugging
   - 4.5 Arch AI Assistant
   - 4.6 Lifecycle Wizard
   - 4.7 Topology Canvas
5. [API Reference](#5-api-reference)
   - 5.1 Export & Import
   - 5.2 Git Integration
   - 5.3 Dependencies
   - 5.4 Locking
   - 5.5 Ownership & Permissions
   - 5.6 Agent Editing (Diff/Splice)
   - 5.7 Webhooks
   - 5.8 Arch AI
   - 5.9 Authentication & Tenancy
6. [End-to-End API Flows](#6-end-to-end-api-flows)
7. [Strengths](#7-strengths)
8. [Limitations & Gaps](#8-limitations-and-gaps)

---

## 1. Overview

The Agent Platform is a monorepo (`pnpm` + Turbo) for building, testing, and operating multi-agent AI systems defined in ABL (Agent-Based Language). Two pillars are covered here:

| Component                        | Role                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@agent-platform/project-io`** | Pure-logic library for project export/import, ABL diffing, dependency graphs, ownership/locking, and git provider integration. Zero UI dependencies.            |
| **Studio** (`apps/studio`)       | Next.js 15 web app providing the visual IDE — project management, ABL editor, chat, debugging, Arch AI assistant, and all API routes that consume `project-io`. |

**Sole runtime dependency of `project-io`:** `@agent-platform/database` (Mongoose models).
**No external npm packages** — all algorithms are self-contained for portability.

---

## 2. Package Architecture

```
packages/project-io/
├── src/
│   ├── index.ts                    # Re-exports all submodules
│   ├── export/
│   │   ├── index.ts                # exportProject, buildFileMap, generateManifest,
│   │   │                           #   generateLockfile, computeSourceHash,
│   │   │                           #   verifyLockfileIntegrity, exportDeployments
│   │   ├── folder-builder.ts       # Canonical folder structure + collision handling
│   │   ├── lockfile-generator.ts   # SHA-256 hashes + integrity verification
│   │   ├── manifest-generator.ts   # project.json generation
│   │   └── project-exporter.ts     # Orchestrator
│   ├── import/
│   │   ├── index.ts                # importProject, readFolder, validateImport,
│   │   │                           #   validateManifest, validateAgentSyntax,
│   │   │                           #   computeApplyOperations
│   │   ├── folder-reader.ts        # Parse folder into typed maps
│   │   ├── import-validator.ts     # Syntax + dependency validation
│   │   ├── manifest-validator.ts   # Schema + reference checks
│   │   └── project-importer.ts     # Pipeline orchestrator
│   ├── diff/
│   │   ├── index.ts                # diffABL, identifySections, spliceSection,
│   │   │                           #   spliceSections, calculateImportDiffs
│   │   ├── abl-differ.ts           # Section-by-section diff engine
│   │   └── section-splicer.ts      # Byte-perfect section editing
│   ├── dependencies/
│   │   ├── index.ts                # buildDependencyGraph, validateDependencies,
│   │   │                           #   getAgentDependencies, getAgentDependents,
│   │   │                           #   extractDependencies, detectCircularDependencies
│   │   ├── dependency-extractor.ts # Regex-based DSL scanning
│   │   └── dependency-graph.ts     # Graph building + DFS cycle detection
│   ├── ownership/
│   │   ├── index.ts                # LockService, OwnershipService,
│   │   │                           #   resolvePermissions, canPerform
│   │   ├── lock-service.ts         # Advisory locks with TTL + race handling
│   │   ├── ownership-service.ts    # Agent ownership + transfer
│   │   └── permission-checker.ts   # Cascading resolution (owner→team→role)
│   └── git/
│       ├── index.ts                # GitSyncService, all providers,
│       │                           #   webhook-handler, conflict-resolver
│       ├── git-provider.ts         # Abstract GitProvider interface
│       ├── github-provider.ts      # GitHub REST API v2022-11-28
│       ├── gitlab-provider.ts      # GitLab REST API v4
│       ├── bitbucket-provider.ts   # Bitbucket Cloud REST API 2.0
│       ├── generic-provider.ts     # Placeholder (clone-based, not implemented)
│       ├── git-sync-service.ts     # Push/pull orchestrator with conflict detection
│       ├── conflict-resolver.ts    # Three-way merge logic
│       └── webhook-handler.ts      # Signature verification + payload parsing
```

**Subpath exports** (from `package.json`):

| Import Path                               | Contents                             |
| ----------------------------------------- | ------------------------------------ |
| `@agent-platform/project-io`              | Everything                           |
| `@agent-platform/project-io/export`       | Export pipeline + lockfile utilities |
| `@agent-platform/project-io/import`       | Import pipeline + validation         |
| `@agent-platform/project-io/diff`         | ABL diff + section splicing          |
| `@agent-platform/project-io/dependencies` | Dependency graph + cycle detection   |
| `@agent-platform/project-io/ownership`    | Lock service + permission checker    |
| `@agent-platform/project-io/git`          | All git providers + sync + webhooks  |

---

## 3. Feature Reference

### 3.1 Export

**Purpose:** Convert project state (agents, tools, configs, deployments) into a portable folder archive.

**Pipeline:**

```
ProjectData → exportProject()
  ├─ buildDependencyGraph()      # Validate references
  ├─ detectEntryAgent()          # Auto-detect SUPERVISOR
  ├─ buildFileMap()              # Canonical folder layout
  ├─ generateManifest()          # project.json metadata
  ├─ generateLockfile()          # abl.lock with integrity hash
  └─ exportDeployments()         # Deployment JSON files
  → ExportResult { files, manifest, lockfile, warnings }
```

**Canonical folder layout:**

```
<project-slug>/
  project.json              # Manifest
  abl.lock                  # Lockfile with source hashes
  agents/
    supervisor.agent.abl    # Normalized: lowercase, underscores
    booking_manager.agent.abl
  tools/
    hotels_api.tools.abl
  config/
    models.json
  deployments/
    prod.deployment.json
```

**Collision handling:** If two agent names normalize identically (e.g., `BookingManager` and `booking_manager`), the second gets a `_2` suffix.

**Lockfile integrity:**

- Each agent/tool gets a SHA-256 source hash (truncated to 16 hex chars for space).
- A full SHA-256 integrity hash covers the deterministically-sorted JSON of all hashes.
- `verifyLockfileIntegrity(lockfile)` recomputes and compares.

---

### 3.2 Import

**Purpose:** Validate and apply a folder-exported project, with dry-run preview support.

**Pipeline:**

```
Map<string, string> → importProject(files, existingState, { dryRun })
  ├─ readFolder()                # Classify files by type
  ├─ validateManifest()          # Schema + file reference checks
  ├─ validateImport()            # ABL syntax + dependency validation
  │   ├─ validateAgentSyntax()   # AGENT:/SUPERVISOR: header required
  │   └─ buildDependencyGraph()  # Check for missing/circular deps
  ├─ calculateImportDiffs()      # Section-aware per-agent diffs
  └─ computeApplyOperations()    # CREATE/UPDATE/DELETE operations
  → ImportResult { preview, operations, success }
```

**Dry-run mode** (`dryRun: true`): Returns the full preview without executing DB operations. Used by the import preview API route.

**Apply mode:** Operations are:

- **CREATE** — agent in import but not in DB
- **UPDATE** — agent in both, DSL content differs
- **DELETE** — agent in DB but not in import

---

### 3.3 Diff & Section Splicing

**ABL sections** (30 recognized):

```
AGENT, SUPERVISOR, VERSION, DESCRIPTION, MODE, LANGUAGE,
GOAL, PERSONA, IDENTITY, LIMITATIONS, TOOLS, TOOLIMPORTS,
GATHER, MEMORY, CONSTRAINTS, GUARDRAILS, FLOW,
DELEGATE, HANDOFF, ESCALATE, COMPLETE, ON_ERROR, ON_START,
MESSAGES, TEMPLATES, HOOKS, EXECUTION, NLU, VOICE
```

**`diffABL(before, after)`** — Section-by-section comparison returning per-section status (`added | removed | modified | unchanged`).

**`spliceSection(content, sectionName, newContent)`** — Replace, add, or remove a single section while keeping all other lines **byte-identical**. Preserves CRLF/LF line endings.

**`spliceSections(content, edits[])`** — Multi-edit in a single pass. Reverse-order splicing preserves offsets. O(n) optimized path for 2+ edits.

**Why it matters:** When Arch AI suggests a GOAL change, git diff shows only:

```diff
 GOAL: Manage booking
-Old GOAL content
+New GOAL content
 PERSONA: Professional assistant
```

---

### 3.4 Dependency Analysis

**`buildDependencyGraph(agents, toolFiles)`** — Directed graph of agent-to-agent and agent-to-tool references.

**Dependency types:**
| Type | Source Pattern |
|------|---------------|
| `handoff` | `HANDOFF:` section → `TO: AgentName` |
| `delegate` | `DELEGATE:` section → `AGENT: AgentName` |
| `tool_import` | `TOOLS:` section → `FROM "path" USE: ...` |
| `inline_handoff` | `ON_ERROR`, `CONSTRAINTS`, `ESCALATE` → `HANDOFF AgentName` |

**`validateDependencies(graph)`** — Checks for missing targets and circular references. Cycle detection uses DFS coloring (white/gray/black) with cycle path normalization to avoid duplicates.

**`getAgentDependents(graph, name)`** / **`getAgentDependencies(graph, name)`** — Reverse/forward adjacency lookups for cascade analysis.

---

### 3.5 Ownership & Locking

#### Lock Service

Advisory locks with optimistic concurrency control:

- **TTL:** 30 minutes default (`DEFAULT_LOCK_TTL_MS`)
- **Lock types:** `edit` | `deploy`
- **Race handling:** Create-first pattern with unique constraint on `(projectId, agentId, lockType)`. Duplicate key error (code 11000) → fetch conflicting lock → return `LockConflictError`.
- **Auto-cleanup:** `getLock()` and `listLocks()` auto-remove expired locks.
- **Force-break:** Admin operation with full audit logging (agent, project, previousHolder, brokenBy).

#### Ownership & Permissions

**Cascading resolution order:**

| Priority | Check                         | Permissions Granted                              |
| -------- | ----------------------------- | ------------------------------------------------ |
| 1        | Project owner                 | `view, edit, deploy, delete, transfer_ownership` |
| 2        | Agent owner (individual)      | Full access                                      |
| 3        | Team owner — lead role        | `view, edit, deploy, delete`                     |
| 3        | Team owner — member role      | `view, edit`                                     |
| 4        | Explicit grants (non-expired) | Granted operations                               |
| 5        | Project member — admin        | Full access                                      |
| 5        | Project member — developer    | `view, edit`                                     |
| 5        | Project member — viewer       | `view`                                           |
| 6        | No match                      | Empty (no permissions)                           |

---

### 3.6 Git Integration

#### Multi-Provider Support

| Provider      | Auth                     | API              | Batch Push                             | File Lists in Webhooks |
| ------------- | ------------------------ | ---------------- | -------------------------------------- | ---------------------- |
| **GitHub**    | Bearer token             | REST v2022-11-28 | Trees API (blob → tree → commit → ref) | Yes                    |
| **GitLab**    | PRIVATE-TOKEN            | REST v4          | `/commits` with actions array          | Yes                    |
| **Bitbucket** | Basic (user:appPassword) | REST 2.0         | FormData POST to `/src`                | Often absent           |
| **Generic**   | —                        | —                | Not implemented                        | —                      |

**All providers:**

- 30-second timeout via `AbortSignal.timeout(30_000)`
- Error sanitization: API response body **never** leaked in thrown errors; logged via `console.error` for debugging.
- URL encoding of branch names and file paths.

#### Git Sync Service

**Push flow:**

```
exportProject() → provider.pullProject() → checkConflicts()
  → provider.createBranch() → provider.pushFiles()
  → provider.createPullRequest()
```

**Pull flow:**

```
provider.pullProject() → importProject(files, existing, { dryRun })
```

**Three-way conflict detection** (base vs local vs remote):

| base === local | base === remote | local === remote | Result                           |
| -------------- | --------------- | ---------------- | -------------------------------- |
| ✓              | —               | —                | Accept remote (no local changes) |
| —              | ✓               | —                | Keep local (no remote changes)   |
| —              | —               | ✓                | Identical (same changes)         |
| ✗              | ✗               | ✗                | **CONFLICT**                     |

**Auto-resolution strategies:** `local_wins` | `remote_wins` | `manual`

#### Webhook Handling

| Provider  | Signature Header      | Verification                        |
| --------- | --------------------- | ----------------------------------- |
| GitHub    | `x-hub-signature-256` | HMAC-SHA256, timing-safe compare    |
| GitLab    | `x-gitlab-token`      | Token equality, timing-safe compare |
| Bitbucket | `x-hub-signature`     | HMAC-SHA256, timing-safe compare    |

**Relevance filter** — only triggers sync for ABL-related file patterns:

```
*.agent.abl, *.tools.abl, project.json, config/*, deployments/*
```

---

## 4. Studio UI/UX

### 4.1 App Shell & Navigation

```
┌─────────────────────────────────────────────────────┐
│ Header (h-12)                                        │
│ Logo │ Breadcrumbs │ Status │ Arch │ Theme │ User   │
├──────────────┬──────────────────────────────────────┤
│              │                                      │
│   Sidebar    │    Page Content                      │
│  (280px)     │    (flex-1, animated transitions)    │
│              │                          ┌──────────┐│
│              │                          │ArchPanel ││
│              │                          │ (340px)  ││
│              │                          └──────────┘│
└──────────────┴──────────────────────────────────────┘
```

**Key features:**

- Framer Motion page transitions (opacity + Y slide, 200ms spring easing)
- WebSocket connection status indicator (green/red dot)
- Collapsible sidebar with mobile hamburger drawer
- Three areas: `projects` (dashboard), `project` (with sidebar), `admin` (workspace)

### 4.2 Project Dashboard

- Grid of project cards (1→3 columns by breakpoint) with staggered entrance animations
- Search filter by name/description
- **New Project** dropdown: "Start with Arch" (recommended) | "Blank Project" | "From Template"
- Color-coded icons (6 rotating pastel colors based on project ID hash)
- Empty states with appropriate CTAs

### 4.3 Agent Detail & Editor

**Tabs:** Overview | Versions | DSL Editor | Model | Chat

- **DSL Editor:** ABL code editor with syntax highlighting and section-aware editing via `spliceSections()`
- **Chat tab:** Split layout — chat fills left, DebugTabs panel on right (togglable, resizable)
- **Context awareness:** Arch panel updates context when viewing an agent (agentId, agentName, currentAbl)

### 4.4 Session Debugging

```
┌──────────────────────────────────────────────┐
│  Agent Conversation Tree  │  Summary Panel   │
│  (35%, clickable nodes)   │  (top 50%)       │
│                           ├──────────────────│
│                           │  DebugTabs       │
│                           │  (bottom 50%)    │
└──────────────────────────────────────────────┘
```

**Debug tabs:** Timeline | Spans | Flow | State Machine | Constraints | LLM Calls | Gather Progress | Analysis

Both horizontal and vertical dividers are resizable (drag). All trace data consumed from `observatoryStore`.

### 4.5 Arch AI Assistant

**Panel:** 340px fixed right overlay (z-30), minimizable to floating circle.

**Modes:** Assisted (guided) | Pro (direct)

**Context-aware suggestions** based on current page:

- **Agents:** "Explain code", "Add error handling", "Suggest improvements", "Generate tests"
- **Sessions:** "Analyze session", "Suggest a fix"
- **Overview:** "Summarize health", "Find bottlenecks"

**Chat features:**

- Basic markdown rendering (bold, code, lists, code blocks)
- Inline diffs (ArchDiffView) with Apply/Reject actions
- Suggestion chips with category-specific icons and colors
- File upload support (.pdf, .md, .json, .yaml, .yml, .txt, .docx)
- Streaming cursor animation

**Message flow:** User input → `archStore.addMessage()` → `POST /api/arch/chat` → Arch response with optional suggestions/diffs/topology

### 4.6 Lifecycle Wizard

Full-screen overlay for AI-guided project creation:

```
IDEATE ──── DESIGN ──── REVIEW & CREATE
```

**Ideate Stage:** ArchChat (left 55%) + Project Brief panel (right 45%) with completeness progress tracking across 6 fields (domain, problem, useCases, targetUsers, channels, tone).

**Design Stage:** Topology proposal with interactive canvas. User can approve or iterate.

**Review & Create:** Brief summary + generated agents with ABL previews. Create button finalizes.

### 4.7 Topology Canvas

SVG-based hierarchical graph:

- BFS layout from entry node
- Node types: supervisor (square) | agent (rounded)
- Edge types: routing | handoff | escalation (distinct styles)
- Health status coloring (green/amber/red)
- Framer Motion entrance animations
- Click-to-select with hover effects

---

## 5. API Reference

### 5.1 Export & Import

| Method | Path                               | Purpose                   |
| ------ | ---------------------------------- | ------------------------- |
| `GET`  | `/api/projects/:id/export`         | Export project as archive |
| `POST` | `/api/projects/:id/export/preview` | Preview export metadata   |
| `POST` | `/api/projects/:id/import/preview` | Preview import (dry-run)  |
| `POST` | `/api/projects/:id/import/apply`   | Apply import to DB        |

**Import validation (both preview and apply):**

- Max 500 files
- Max 1 MB per file
- Max 50 MB total
- Path traversal protection: reject `..` and leading `/`
- Non-string content rejected

**Apply atomicity:** Tracks `createdAgentIds` for rollback. If any operation fails, all created agents are deleted. Returns `IMPORT_APPLY_FAILED` on failure.

### 5.2 Git Integration

| Method   | Path                            | Purpose                              |
| -------- | ------------------------------- | ------------------------------------ |
| `GET`    | `/api/projects/:id/git`         | Get current integration              |
| `POST`   | `/api/projects/:id/git`         | Set up integration                   |
| `PATCH`  | `/api/projects/:id/git`         | Update settings (whitelist enforced) |
| `DELETE` | `/api/projects/:id/git`         | Disconnect integration               |
| `GET`    | `/api/projects/:id/git/status`  | Local vs remote status               |
| `POST`   | `/api/projects/:id/git/push`    | Push to remote                       |
| `POST`   | `/api/projects/:id/git/pull`    | Pull from remote                     |
| `GET`    | `/api/projects/:id/git/history` | Sync history (paginated)             |

**PATCH whitelist:** Only `defaultBranch`, `syncPath`, `syncConfig` can be updated. All other fields (token, repositoryUrl, provider) are silently stripped. If only disallowed fields are sent → 400 "No valid fields".

### 5.3 Dependencies

| Method | Path                             | Purpose               |
| ------ | -------------------------------- | --------------------- |
| `GET`  | `/api/projects/:id/dependencies` | Full dependency graph |

**Guard:** Max 1000 agents per project. Exceeding → 400 "Too many agents".

**Response:** `{ agents: [{ name, dependsOn, dependents }], edges, validation: { valid, missing, circular } }`

### 5.4 Locking

| Method   | Path                                     | Purpose               |
| -------- | ---------------------------------------- | --------------------- |
| `POST`   | `/api/projects/:id/agents/:agentId/lock` | Acquire lock          |
| `DELETE` | `/api/projects/:id/agents/:agentId/lock` | Release lock          |
| `GET`    | `/api/projects/:id/locks`                | List all active locks |

**Lock behavior:**

- 201 on acquire, 409 if held by another user
- Same user → auto-refresh existing lock
- Release → 404 if no active lock, 403 if held by another user

### 5.5 Ownership & Permissions

| Method | Path                                            | Purpose                   |
| ------ | ----------------------------------------------- | ------------------------- |
| `GET`  | `/api/projects/:id/agents/:agentId/ownership`   | Get ownership             |
| `PUT`  | `/api/projects/:id/agents/:agentId/ownership`   | Assign/transfer ownership |
| `POST` | `/api/projects/:id/agents/:agentId/permissions` | Grant permission          |

**Authorization:** Only project owner or admin can grant permissions. Non-owner non-admin → 403.

### 5.6 Agent Editing (Diff/Splice)

| Method | Path                                     | Purpose               |
| ------ | ---------------------------------------- | --------------------- |
| `POST` | `/api/projects/:id/agents/:agentId/diff` | Compute ABL diff      |
| `POST` | `/api/projects/:id/agents/:agentId/edit` | Apply section edits   |
| `PUT`  | `/api/projects/:id/agents/:agentId/dsl`  | Save full DSL content |

**Edit route** uses `spliceSections()` for surgical section edits without rewriting the entire file:

```json
{
  "edits": [
    { "section": "GOAL", "content": "New goal text" },
    { "section": "CONSTRAINTS", "content": null }
  ]
}
```

### 5.7 Webhooks

| Method | Path                           | Purpose                      |
| ------ | ------------------------------ | ---------------------------- |
| `POST` | `/api/webhooks/git/:projectId` | Receive git provider webhook |

**Unauthenticated** — verified via cryptographic signature. If `autoSync` enabled and branch matches, queues a pull.

### 5.8 Arch AI

| Method | Path                 | Purpose                        |
| ------ | -------------------- | ------------------------------ |
| `POST` | `/api/arch/chat`     | Chat with Arch assistant       |
| `POST` | `/api/arch/generate` | Generate topology/agents/tests |

**Chat:** Stage-specific system prompts (ideate/design/build/test/deploy/evolve). ABL quick reference injected into context. Falls back to stub response when LLM not configured.

**Generate types:**

- `topology` — generates node/edge structure from project brief
- `agents` — generates ABL code for each topology node (requires topology)
- `tests` — placeholder (TODO)

### 5.9 Authentication & Tenancy

| Area      | Routes                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Auth      | `POST /api/auth/login`, `/signup`, `/verify-email`, `/refresh`, `/logout`, `/me`, `/forgot-password`, `/reset-password` |
| OAuth     | `POST /api/auth/google`, `/callback`                                                                                    |
| Device    | `POST /api/auth/device`, `/device/authorize`, `/device/token`, `GET /device/lookup`                                     |
| MFA       | `POST /api/mfa/setup`, `/confirm`, `/verify`, `/disable`, `GET /status`                                                 |
| Workspace | `GET /api/workspaces/:tenantId/members`, `POST /invitations`                                                            |
| SSO       | `POST /api/sso/init`, `/saml/callback`, `/oidc/callback`                                                                |

**Rate limits:** Login 10/15min/IP, Signup 5/15min/IP.

**Roles:** OWNER → ADMIN → OPERATOR → MEMBER → VIEWER.

---

## 6. End-to-End API Flows

### 6.1 Export & Download

```
User clicks "Export" in Studio
  → GET /api/projects/:id/export?format=zip
    → requireAuth() → requireProjectAccess()
    → Fetch all ProjectAgent documents
    → exportProject(agents, tools, deployments)
      ├─ buildFileMap()           # Canonical folder structure
      ├─ generateManifest()       # project.json
      └─ generateLockfile()       # abl.lock with integrity hash
    → Return { files, manifest, lockfile, warnings }
  ← Client creates ZIP from file map
```

### 6.2 Import (Preview → Apply)

```
User selects files for import
  → POST /api/projects/:id/import/preview
    → Validate (count ≤500, size ≤1MB each, ≤50MB total, no path traversal)
    → importProject(files, existing, { dryRun: true })
      ├─ readFolder()             # Classify files
      ├─ validateManifest()       # Schema + references
      ├─ validateImport()         # Syntax + cycles
      └─ calculateImportDiffs()   # Per-agent section diffs
    → Return { preview: { changes: { agents, tools } } }

User reviews preview, clicks "Apply"
  → POST /api/projects/:id/import/apply
    → Same validation
    → importProject(files, existing, { dryRun: false })
    → For each operation:
        CREATE → ProjectAgent.create() + computeSourceHash()
        UPDATE → ProjectAgent.findOneAndUpdate()
        DELETE → ProjectAgent.deleteOne()
    → Atomic rollback on failure
    → Return { applied: { created, updated, deleted } }
```

### 6.3 Git Push with Conflict Detection

```
User clicks "Push to Git"
  → POST /api/projects/:id/git/push
    → Fetch GitIntegration (provider, credentials, branch)
    → Create GitSyncService(provider)
    → syncService.push({
        projectData,
        lastSyncCommit: integration.lastSyncCommit,
        branch, commitMessage
      })
      ├─ exportProject()          # Local state → files
      ├─ provider.pullProject()   # Remote state → files
      ├─ checkConflicts()         # Three-way comparison
      │   └─ For each file: base vs local vs remote
      │       → identical | accept_theirs | keep_ours | CONFLICT
      ├─ provider.pushFiles()     # If no conflicts
      └─ Update lastSyncCommit, lastSyncAt
    → Return { commitSha, changes, conflicts }
    → Create GitSyncHistory record
```

### 6.4 Webhook-Triggered Auto-Sync

```
Git provider pushes webhook
  → POST /api/webhooks/git/:projectId
    → Fetch GitIntegration by projectId
    → verifyWebhookSignature(provider, rawBody, signature, secret)
    → parseWebhookPayload(provider, body)
    → Check branch === syncBranch
    → hasRelevantChanges(changedFiles)
    → If autoSync enabled → queue pull operation
    → Return { processed, branch, commit, changedFiles }
```

### 6.5 Agent Locking During Edit

```
User opens agent editor
  → POST /api/projects/:id/agents/:agentId/lock
    → lockService.acquireLock(projectId, agentId, agentName, userId, 'edit')
      ├─ Check existing lock
      │   Same user? → refresh expiry → return lock
      │   Different user? → return LockConflictError (409)
      │   Expired? → delete → continue
      └─ createLock() with unique constraint
          Duplicate key? → another request won race → 409
    → Return { lock: { lockedBy, expiresAt } }

User saves and closes
  → DELETE /api/projects/:id/agents/:agentId/lock
    → lockService.releaseLock()
    → Return { success: true }
```

### 6.6 Section-Aware Edit via Arch AI

```
Arch suggests GOAL change
  → POST /api/projects/:id/agents/:agentId/edit
    → { edits: [{ section: "GOAL", content: "New GOAL text" }] }
    → Fetch current dslContent
    → spliceSections(dslContent, edits)
      ├─ identifySections()       # Find all section boundaries
      ├─ Apply replacements in reverse order (preserve offsets)
      └─ Preserve CRLF/LF + untouched sections byte-for-byte
    → Save updated dslContent
    → diffABL(before, after)     # Compute diff for UI
    → Return { dslContent, diff }
```

### 6.7 Permission Check

```
User requests agent operation
  → resolvePermissions({
      userId, projectOwnerId, projectMemberRole,
      agentOwnerId, agentOwnerTeamId,
      userTeamMemberships, explicitPermissions
    })
    Priority 1: project owner → full access
    Priority 2: agent owner (individual) → full access
    Priority 3: team owner membership → lead:full / member:view+edit
    Priority 4: explicit grants (check expiry) → granted ops
    Priority 5: project role → admin:full / dev:view+edit / viewer:view
    Priority 6: no match → []
  → canPerform(ctx, 'edit') → boolean
```

---

## 7. Strengths

### Architecture

1. **Clean separation** — `project-io` is a pure-logic library with zero UI dependencies. All services accept store interfaces, enabling full unit testing without databases.

2. **Subpath exports** — Consumers import only what they need (`/export`, `/diff`, `/git`), enabling tree-shaking and clear dependency graphs.

3. **Single database dependency** — Only `@agent-platform/database` for Mongoose models. All algorithms are self-contained.

### Export/Import

4. **Deterministic output** — Sorted keys in lockfile JSON, normalized agent paths, canonical folder structure. Same input always produces the same archive.

5. **Integrity verification** — SHA-256 lockfile integrity hash detects tampering or corruption across transport.

6. **Dry-run preview** — Full import pipeline executes without DB writes, giving users confidence before applying changes.

7. **Atomic rollback** — Import apply tracks created agent IDs and deletes them if any operation fails.

### Diff & Editing

8. **Section-aware diffing** — Changes to one ABL section don't pollute diffs of unrelated sections. Clean git history.

9. **Byte-perfect preservation** — Section splicing preserves CRLF/LF line endings and untouched sections byte-for-byte. No reformatting side effects.

10. **Multi-edit optimization** — `spliceSections()` applies multiple edits in a single pass with O(n) optimized path for 2+ edits.

### Git Integration

11. **Multi-provider abstraction** — GitHub, GitLab, Bitbucket behind a single `GitProvider` interface. Adding a new provider requires only implementing the interface.

12. **Three-way conflict detection** — Real merge conflict detection (not just "files differ") using base/local/remote comparison.

13. **Error sanitization** — API response bodies never leak in thrown errors. Prevents credential/token exposure in logs.

14. **Webhook security** — Provider-specific cryptographic verification with timing-safe comparison. No unauthenticated auto-sync.

### Ownership & Locking

15. **Optimistic concurrency** — Lock acquisition uses create-first + unique constraint, handling race conditions without distributed locks.

16. **Cascading permissions** — Six-level resolution (owner → team → role) with expiring grants. Flexible yet predictable.

17. **Auto-cleanup** — Expired locks transparently removed on read. No background job required for basic cleanup.

### Security

18. **Input validation at boundaries** — File count/size limits, path traversal protection, PATCH field whitelisting, agent count guards.

19. **Rate limiting** — Login (10/15min) and signup (5/15min) per IP.

20. **Tenant isolation** — `requireProjectAccess()` enforces owner check → tenant match → membership check → fail-safe deny.

---

## 8. Limitations and Gaps

### Export/Import

1. **JSON-only transport** — Export returns `{ files: { path: content } }` as JSON. Client must create ZIP/tar.gz. No server-side streaming for large projects.

2. **No incremental export** — Always exports all agents. For projects with 500+ agents, this may be slow. No delta/patch export.

3. **No binary file support** — All file content is string. Binary assets (images, trained models) cannot be part of the export.

4. **Import is all-or-nothing** — Cannot selectively import specific agents. The entire file set is processed as one unit.

### Git Integration

5. **Generic provider unimplemented** — `GenericGitProvider` throws on all methods. Self-hosted git (Gitea, Gogs) not supported.

6. **No merge conflict UI** — Three-way conflicts are detected but the Studio has no visual merge editor. User must resolve externally.

7. **Bitbucket file list gap** — Bitbucket push webhooks often omit changed file lists. All pushes treated as potentially relevant, causing unnecessary sync checks.

8. **No incremental sync** — Push/pull always processes all agents. No commit-level tracking of which specific agents changed since last sync.

9. **Single-branch sync** — Git integration syncs against one configured branch. No multi-branch or feature-branch workflow support.

10. **No webhook retry** — If webhook processing fails, there's no retry queue. The event is lost.

### Locking

11. **No WebSocket lock notifications** — When a lock is acquired/released, other users aren't notified in real-time. They discover conflicts only on save attempt.

12. **30-minute fixed TTL** — Lock TTL is a constant, not configurable per project or per operation type. Long editing sessions require periodic refresh.

13. **No lock queue** — If an agent is locked, other users can only retry. No waiting/notification mechanism.

### Permissions

14. **No field-level permissions** — Permissions are agent-level operations (`view`, `edit`, `deploy`, `delete`). Cannot restrict to specific sections (e.g., allow editing GOAL but not CONSTRAINTS).

15. **No permission audit trail** — Permission grants/revokes are not logged to the audit system.

### Dependencies

16. **Regex-based extraction** — Dependency extraction uses regex pattern matching on DSL content, not the compiled IR. May miss edge cases in complex DSL syntax.

17. **No cross-project dependencies** — Dependency graph is scoped to a single project. No tracking of agent references across projects.

### Arch AI

18. **Test generation not implemented** — `POST /api/arch/generate` with `type: 'tests'` is a placeholder returning empty results.

19. **No persistent Arch context** — Arch conversations are stored in client-side Zustand store (localStorage). Clearing browser data loses conversation history.

20. **Stub fallback when no LLM** — Without configured LLM credentials, Arch returns hardcoded stub responses. No indication in the UI that AI is not actually being used.

### General

21. **No real-time collaboration** — Multiple users can edit the same project but there's no live cursor/presence or operational transform. Locking is the only coordination mechanism.

22. **No undo/redo** — Section edits and import applies have no undo capability beyond git revert.

23. **No versioning in import** — Import apply overwrites current agent content. Previous versions only preserved if git integration is configured.

---

## Database Models Referenced

| Model            | Key Fields                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `Project`        | name, slug, ownerId, tenantId, entryAgentName, gitIntegrationId                           |
| `ProjectAgent`   | projectId, name, domain, dslContent, sourceHash, ownerId, ownerTeamId                     |
| `AgentLock`      | projectId, agentId, lockedBy, expiresAt, lockType                                         |
| `AgentOwnership` | projectId, agentId, ownerId, ownerTeamId, permissions[]                                   |
| `GitIntegration` | projectId, provider, repositoryUrl, defaultBranch, credentials, syncConfig, webhookSecret |
| `GitSyncHistory` | projectId, direction, commitSha, branch, status, changesSummary                           |
| `Team`           | tenantId, name, slug, members[]                                                           |
| `ProjectMember`  | projectId, userId, role                                                                   |

---

## Test Coverage

| Test File                               | Tests | Scope                                      |
| --------------------------------------- | ----- | ------------------------------------------ |
| `project-exporter.test.ts`              | ~15   | Export pipeline E2E                        |
| `project-importer.test.ts`              | ~15   | Import pipeline E2E                        |
| `abl-differ.test.ts`                    | ~12   | Section-aware diffing                      |
| `section-splicer.test.ts`               | ~21   | Section splicing + CRLF                    |
| `dependency-extractor.test.ts`          | ~10   | DSL pattern matching                       |
| `dependency-graph.test.ts`              | ~10   | Graph + cycle detection                    |
| `conflict-resolver.test.ts`             | ~8    | Three-way merge                            |
| `lock-service.test.ts`                  | ~17   | Locking + race conditions                  |
| `permission-checker.test.ts`            | ~12   | Cascading resolution                       |
| `audit-fixes.test.ts`                   | ~29   | Folder builder, lockfile, import validator |
| `webhook-handler.test.ts`               | ~24   | Signature verification + null safety       |
| `git-providers.test.ts`                 | 30    | All 3 providers: auth, encoding, errors    |
| `git-sync-service.test.ts`              | ~8    | Push/pull orchestration                    |
| `project-access.test.ts` (Studio)       | 8     | Authorization gate                         |
| `api-route-validation.test.ts` (Studio) | 12    | Input validation across routes             |

**Total: ~240+ tests** across project-io and Studio.
