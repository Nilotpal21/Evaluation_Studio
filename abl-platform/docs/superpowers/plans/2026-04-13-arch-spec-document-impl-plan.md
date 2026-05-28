# Arch AI Spec Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, unified spec document to Arch AI that captures business requirements + architecture decisions, supports direct editing, Markdown download, and serves as LLM context for all specialists.

**Architecture:** New `arch_spec_documents` MongoDB collection following the journal pattern. `SpecDocumentService` in `packages/arch-ai` handles CRUD with idempotent creation, transactional business-field mirroring, and scoped access. API routes scoped via session/project. Frontend `SpecDocumentPanel` replaces the slim SpecificationCard.

**Tech Stack:** MongoDB + Mongoose, Zod validation, Next.js API routes (App Router), Zustand store, React (existing component patterns), SSE for chat-driven updates, optimistic PUT for direct edits.

**Design Spec:** `docs/superpowers/specs/2026-04-12-arch-spec-document-design.md`

**CRITICAL RULES FOR AGENTS:**

- Run `npx prettier --write <files>` on ALL changed files before finishing your task.
- Run `pnpm build --filter=<package>` after every file change to catch type errors immediately.
- BEFORE using any existing component/function/type, READ its source file to verify the actual signature.
- NEVER mock platform components (vi.mock of @agent-platform/_, @abl/_, or relative imports).
- Use `createLogger('module')` — never `console.log` in server code.
- Use `z.string().min(1)` for ID fields — never format-specific validators.
- One concern per commit. Max 40 files per commit. Feature commits must be additive.

---

## Task 1: Types + Field Map (Pure Data, Zero Dependencies)

**Files:**

- Create: `packages/arch-ai/src/spec-document/types.ts`
- Create: `packages/arch-ai/src/spec-document/field-map.ts`
- Create: `packages/arch-ai/src/spec-document/index.ts`
- Modify: `packages/arch-ai/src/index.ts` (~L176, add re-export)

Pure type definitions and constants — no runtime dependencies.

- [ ] **Step 1: Create `types.ts`** — All sub-types (`ComplianceEntry`, `PersonaEntry`, `SLAEntry`, `AgentSummary`, `EdgeSummary`, `ToolSummary`, `GuardrailSummary`, `DecisionEntry`), section schemas (`BusinessSectionSchema`, `ArchitectureSectionSchema`, `ImplementationSectionSchema`), `IArchSpecDocument` interface, and section status functions (`getBusinessStatus`, `getArchitectureStatus`, `getImplementationStatus`). See design spec "Data Model" section for exact shapes.
- [ ] **Step 2: Create `field-map.ts`** — `V1_EDITABLE_PATHS` set, `SPEC_TO_SESSION_FIELD_MAP` record, `ValidationError` class, `validateEditablePath()`. See design spec "Path Validation" and "Business Field Mirroring" sections.
- [ ] **Step 3: Create `index.ts`** — Barrel export of all types, schemas, and field map utilities.
- [ ] **Step 4: Add re-export** in `packages/arch-ai/src/index.ts` alongside journal export (~L176). Export `SpecDocumentService` (will resolve in Task 3), types, and field map.
- [ ] **Step 5: Build** — `pnpm build --filter=@agent-platform/arch-ai`. Types compile cleanly.
- [ ] **Step 6: Commit** — `[ABLP-XXX] feat(arch-ai): add spec document types and field map`

---

## Task 2: Mongoose Model + Database Export

**Files:**

- Create: `packages/database/src/models/arch-spec-document.model.ts`
- Modify: `packages/database/src/models/index.ts` (~L100, add export)

Follow exact patterns from `arch-journal.model.ts`: `uuidv7` ID, `tenantIsolationPlugin`, `timestamps: true`.

- [ ] **Step 1: Read `arch-journal.model.ts`** to verify current patterns (Schema constructor, plugin, indexes, model export).
- [ ] **Step 2: Create `arch-spec-document.model.ts`** — `IArchSpecDocument` interface (database-level), sub-schemas for each section type (ComplianceEntry, AgentSummary, etc. as `_id: false` sub-schemas), main schema with `collection: 'arch_spec_documents'`. Three indexes: unique `(tenantId, sessionId)`, partial unique `(tenantId, projectId)` with `$type: 'string'` filter, and `(tenantId, userId)`. See design spec "Indexes" section for exact shapes.
- [ ] **Step 3: Add export** to `packages/database/src/models/index.ts` after ArchJournal (~L100): `export { ArchSpecDocument, type IArchSpecDocument } from './arch-spec-document.model.js';`
- [ ] **Step 4: Build** — `pnpm build --filter=@agent-platform/database`. Compiles cleanly.
- [ ] **Step 5: Commit** — `[ABLP-XXX] feat(database): add arch_spec_documents model with idempotent indexes`

---

## Task 3: SpecDocumentService + Markdown Renderer

**Files:**

- Create: `packages/arch-ai/src/spec-document/spec-document-service.ts`
- Create: `packages/arch-ai/src/spec-document/markdown-renderer.ts`
- Modify: `packages/arch-ai/src/spec-document/index.ts` (add exports)
- Modify: `packages/arch-ai/src/index.ts` (update re-export)

**IMPORTANT:** Before writing, READ `journal-service.ts` for scoping patterns, and `arch-session.model.ts` for session model shape.

- [ ] **Step 1: Create `spec-document-service.ts`** — Constructor takes `(model, sessionModel, connection)`. Implements all methods from design spec "Service Layer" section: `create()` (idempotent upsert), `updateField()` (returns version), `updateBusinessField()` (transaction with fallback), `addEntry()`, `upsertAgentSummary()` (arrayFilters), `syncAgentDerivedData()` (pull+push replace), `addDecision()`, `bulkUpdateBusiness()` (transaction + validation), `getBySession()`, `getByProject()` (unsafeProjectScope), `linkToProject()`, `deleteBySessionIfUnlinked()`. Use `createLogger('spec-document-service')`.
- [ ] **Step 2: Create `markdown-renderer.ts`** — `renderMarkdown(spec: IArchSpecDocument): string`. Renders each section to clean Markdown tables/lists. See design spec "Markdown Renderer" section for exact output format.
- [ ] **Step 3: Update `index.ts`** — Add exports for `SpecDocumentService`, `ProjectScopeAccessRequiredError`, `renderMarkdown`.
- [ ] **Step 4: Update `packages/arch-ai/src/index.ts`** — Ensure the re-export from Task 1 Step 4 resolves now.
- [ ] **Step 5: Build** — `pnpm build --filter=@agent-platform/arch-ai`. Compiles.
- [ ] **Step 6: Commit** — `[ABLP-XXX] feat(arch-ai): add SpecDocumentService with transactional mirroring and markdown renderer`

---

## Task 4: SSE Event Schema

**Files:**

- Modify: `packages/arch-ai/src/types/sse-events.ts`

- [ ] **Step 1: Read `sse-events.ts`** to verify discriminated union structure.
- [ ] **Step 2: Add `SpecDocumentUpdateEventSchema`** before the union (~L274): `z.object({ type: z.literal('spec_document_update'), path: z.string(), value: z.unknown(), version: z.number() })`.
- [ ] **Step 3: Register** in `ArchSSEEventSchema` array.
- [ ] **Step 4: Add type export**: `export type SpecDocumentUpdateEvent = z.infer<typeof SpecDocumentUpdateEventSchema>;`
- [ ] **Step 5: Build** — `pnpm build --filter=@agent-platform/arch-ai`.
- [ ] **Step 6: Commit** — `[ABLP-XXX] feat(arch-ai): add spec_document_update SSE event schema`

---

## Task 5: API Routes (GET, PUT, Download)

**Files:**

- Create: `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/route.ts`
- Create: `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/download/route.ts`
- Create: `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts`
- Create: `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/download/route.ts`

**IMPORTANT:** Read journal route files first to match exact auth/import patterns.

- [ ] **Step 1: Read session journal route** (`sessions/[id]/journal/route.ts`) for auth pattern.
- [ ] **Step 2: Read project journal route** (`projects/[projectId]/journal/route.ts`) for project-scoped auth.
- [ ] **Step 3: Create session-scoped GET + PUT** — GET returns spec doc, PUT validates paths against `V1_EDITABLE_PATHS`, runs `projectExistsByName()` for name changes, calls `bulkUpdateBusiness()`, returns `{ success: true, data: <full doc> }`. See design spec "Auth sequence" for 404-safe pattern.
- [ ] **Step 4: Create session-scoped download** — Calls `renderMarkdown()`, returns with `Content-Disposition: attachment; filename="{name}-spec.md"`.
- [ ] **Step 5: Create project-scoped GET + PUT** — Same as session but uses `requireProjectAccess()`. PUT does NOT mirror to session metadata.
- [ ] **Step 6: Create project-scoped download** — Same download with project auth.
- [ ] **Step 7: Build** — `pnpm build --filter=studio`.
- [ ] **Step 8: Commit** — `[ABLP-XXX] feat(studio): add spec document API routes (GET, PUT, download)`

---

## Task 6: Coordinator Integration (Parallel Writes + LLM Context)

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`
- Modify: `apps/studio/src/app/api/arch-ai/sessions/route.ts`
- Modify: `apps/studio/src/app/api/arch-ai/sessions/[id]/route.ts`
- Modify: `apps/studio/src/lib/arch-ai/tools/create-project.ts`
- Modify: `packages/arch-ai/src/prompts/index.ts`

**CRITICAL:** This modifies the coordinator. Read each target location BEFORE editing. Add parallel writes ALONGSIDE existing code.

- [ ] **Step 1: Wire `SpecDocumentService` instance** in `message/route.ts`. Import `ArchSpecDocument`, `ArchSession` from database/models. Instantiate service at module scope like `journalService`. Add `specUpdateAndEmit()` helper (see design spec "Coordinator Helper").
- [ ] **Step 2: Create spec doc on session creation** — In `sessions/route.ts`, add `specDocumentService.create()` after session creation (idempotent).
- [ ] **Step 3: Add delete cascade** — In `sessions/[id]/route.ts` DELETE handler, add `specDocumentService.deleteBySessionIfUnlinked()`.
- [ ] **Step 4: Add `linkToProject`** — In `create-project.ts`, add `specDocumentService.linkToProject()` alongside `journalService.linkToProject()`.
- [ ] **Step 5: INTERVIEW parallel writes** — At `update_specification` (~L1320) and `conversationNotes` (~L1351): add `specUpdateAndEmit()` calls for `business.*` fields.
- [ ] **Step 6: BLUEPRINT parallel writes** — At `generate_topology` (~L1444) and topology approval: add `specUpdateAndEmit()` for `architecture.*` fields.
- [ ] **Step 7: BUILD parallel writes** — At `generate_agent` (~L1643) and `compile_abl` (~L1709): use `upsertAgentSummary()` and `syncAgentDerivedData()`.
- [ ] **Step 8: Inject spec into LLM context** — In `prompts/index.ts`, add `specDocument` param to both `composeSystemPrompt()` and `composeInProjectPrompt()`. Add shared `renderSpecContext()` helper. In `message/route.ts`, load spec doc and pass to both prompt builders (~L5041 onboarding, ~L3351 in-project).
- [ ] **Step 9: Build** — `pnpm build --filter=studio`.
- [ ] **Step 10: Commit** — `[ABLP-XXX] feat(studio): wire spec document parallel writes into coordinator and LLM context`

---

## Task 7: Frontend — Store, SSE Handler, SpecDocumentPanel

**Files:**

- Modify: `apps/studio/src/store/arch-ai-store.ts`
- Modify: `apps/studio/src/hooks/useArchChat.ts`
- Modify: `apps/studio/src/hooks/usePreloadOrchestrator.ts`
- Create: `apps/studio/src/components/arch-v3/spec-document/SectionHeader.tsx`
- Create: `apps/studio/src/components/arch-v3/spec-document/BusinessSection.tsx`
- Create: `apps/studio/src/components/arch-v3/spec-document/ArchitectureSection.tsx`
- Create: `apps/studio/src/components/arch-v3/spec-document/ImplementationSection.tsx`
- Create: `apps/studio/src/components/arch-v3/spec-document/DecisionsSection.tsx`
- Create: `apps/studio/src/components/arch-v3/panels/SpecDocumentPanel.tsx`
- Modify: `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`
- Modify: `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`

**IMPORTANT:** Read `arch-ai-store.ts`, `useArchChat.ts` (journal_entry handler), `JournalPanel.tsx` (dual-source pattern), `SpecificationCard.tsx` (field editors), `OnboardingArtifactPanel.tsx` (tab registration) BEFORE writing. Use semantic design tokens — no hardcoded Tailwind colors.

Split into 2 commits if file count exceeds 40.

- [ ] **Step 1: Add store state** — `specDocument`, `specDocumentVersion`, `'spec-document'` to `ArtifactTabType`, `setSpecDocument()`, `updateSpecDocument()`, `setSpecDocumentVersion()`.
- [ ] **Step 2: Add SSE handler** — In `useArchChat.ts`, add `case 'spec_document_update':` alongside journal handler.
- [ ] **Step 3: Update preload** — In `usePreloadOrchestrator.ts`, change `'specification'` to `'spec-document'` tab type.
- [ ] **Step 4: Create `SectionHeader.tsx`** — Collapsible header with status indicator + optional lock icon.
- [ ] **Step 5: Create `BusinessSection.tsx`** — Editable section reusing existing field editors. Optimistic PUT + authoritative reconciliation pattern for field changes.
- [ ] **Step 6: Create `ArchitectureSection.tsx`** — Read-only agents/edges/topology tables with lock icon.
- [ ] **Step 7: Create `ImplementationSection.tsx`** — Read-only tools/guardrails tables with lock icon.
- [ ] **Step 8: Create `DecisionsSection.tsx`** — Read-only chronological decision list.
- [ ] **Step 9: Create `SpecDocumentPanel.tsx`** — Fetches spec doc on mount, subscribes to store for SSE updates. Header with version badge + download button. Renders 4 sections.
- [ ] **Step 10: Wire into `OnboardingArtifactPanel`** — Replace `'specification'` with `'spec-document'` in `ARTIFACT_TAB_TYPES`.
- [ ] **Step 11: Wire into `InProjectArtifactPanel`** — Add `'spec-document'` tab.
- [ ] **Step 12: Build** — `pnpm build --filter=studio`.
- [ ] **Step 13: Commit** — Split into store/hooks commit + components commit if needed.

---

## Parallelization

## Task Overview

| Task | Focus                   | New Files | Modified Files | Packages        |
| ---- | ----------------------- | --------- | -------------- | --------------- |
| 1    | Types + field map       | 3         | 1              | arch-ai         |
| 2    | Mongoose model          | 1         | 1              | database        |
| 3    | Service + renderer      | 2         | 2              | arch-ai         |
| 4    | SSE event schema        | 0         | 1              | arch-ai         |
| 5    | API routes              | 4         | 0              | studio          |
| 6    | Coordinator integration | 0         | 5              | studio, arch-ai |
| 7    | Frontend                | 5         | 5              | studio          |

Tasks 1-4 are backend-only and can be executed in parallel by separate agents.
Task 5 depends on Tasks 1-3.
Task 6 depends on Tasks 3-4.
Task 7 depends on Task 6 (needs SSE event + store contract).
