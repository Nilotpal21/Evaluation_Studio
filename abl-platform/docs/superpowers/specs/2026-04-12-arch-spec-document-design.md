# Arch AI Spec Document — Design Specification

**Date:** 2026-04-12
**Status:** Draft
**Branch:** arch/knowledge
**Supersedes:** RFC-025 (partial), B54, B58

---

## Problem

Design decisions in Arch AI scatter across `session.metadata.topology`, `session.metadata.files`, journal entries, and conversation history. No single document says "what this project is, why it was designed this way, and what changed."

The current `Specification` type has only 5 fields (`projectName`, `description`, `channels`, `language`, `uploadedFiles`) and is embedded in the session document — it dies when the session is archived (30-day TTL). It is too slim to serve as a source of truth and too ephemeral to serve as a persistent artifact.

**Three gaps:**

1. **No persistent project document.** After project creation, the specification is gone. The journal captures events but is a chronological log, not a structured reference.
2. **No spec-driven development.** Users cannot write requirements first and then trigger architecture generation from those requirements. The only path is the chat-driven Interview.
3. **No downloadable artifact.** Users cannot export a single document that captures the full project — requirements, architecture, and implementation decisions.

## Solution

A **persistent spec document** that lives alongside the journal as a first-class Arch AI artifact. It captures both business requirements (what to build) and architecture decisions (how it's built), fills incrementally as phases progress, is directly editable, downloadable as Markdown, and serves as the primary input to all Arch specialists.

## Design Decisions

| #   | Decision                                                      | Rationale                                                                                                                            |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Unified document (business + architecture)                    | A single source of truth is easier to maintain and reason about than two separate docs                                               |
| D2  | Own MongoDB collection (`arch_spec_documents`)                | Same persistence model as journal — survives session archival, project-scoped after creation                                         |
| D3  | Hybrid edit flow (chat auto-fills + direct edit)              | Preserves the solid chat-driven Interview while enabling power-user spec-first path                                                  |
| D4  | Pragmatic core sections (~10)                                 | Enough structure to be useful, maps to existing phase data, no empty-shell syndrome                                                  |
| D5  | Markdown export (not PDF)                                     | Clean, version-control-friendly, renders anywhere. PDF can be added later                                                            |
| D6  | Simple version counter (no full history)                      | Journal already captures what changed and why. Version number tracks evolution count                                                 |
| D7  | Parallel writes (never replace existing paths)                | Zero disruption to the working chat-driven flow                                                                                      |
| D8  | v1 direct edits limited to `business.*` only                  | Architecture/implementation are AI-authored; allowing direct edits creates a second source of truth with no reconciliation rules yet |
| D9  | Spec lifecycle follows project after linking                  | Once `projectId` is set, session deletion must not cascade to the spec document                                                      |
| D10 | All business edits mirror to `session.metadata.specification` | `canExitInterview()` and project creation read from session metadata; dual-write is mandatory in both directions                     |
| D11 | Scoped routes only (no naked ID-based mutation)               | Follows platform access model — session-scoped during onboarding, project-scoped after creation; prevents cross-project leaks        |
| D12 | Idempotent creation and linking                               | Unique indexes + `findOneAndUpdate` with `upsert` prevent duplicates from retries or partial failures                                |

## Data Model

### Collection: `arch_spec_documents`

```typescript
interface IArchSpecDocument {
  _id: string; // uuidv7
  tenantId: string;
  userId: string; // creator
  sessionId: string; // originating session
  projectId: string | null; // null during onboarding, set at CREATE
  version: number; // auto-increment on each update (starts at 1)

  // ─── Business Context (filled during INTERVIEW) ───
  business: {
    projectName: string;
    objective: string | null;
    channels: string[];
    language: string;
    compliance: ComplianceEntry[];
    constraints: string[];
    personas: PersonaEntry[];
    slas: SLAEntry[];
    edgeCases: string[];
    notes: ConversationNote[]; // reuse existing type
  };

  // ─── Architecture (filled during BLUEPRINT) ───
  architecture: {
    pattern: string | null; // hub-spoke | pipeline | hierarchical | custom
    entryPoint: string | null;
    agentCount: number;
    agents: AgentSummary[];
    edges: EdgeSummary[];
    rationale: string | null;
  };

  // ─── Implementation (filled during BUILD) ───
  implementation: {
    tools: ToolSummary[];
    guardrails: GuardrailSummary[];
    buildStatus: string | null;
  };

  // ─── Decisions (curated from journal) ───
  decisions: DecisionEntry[];

  // ─── Metadata ───
  createdAt: Date;
  updatedAt: Date;
}
```

### Sub-types

```typescript
interface ComplianceEntry {
  standard: string; // e.g., "HIPAA", "PCI-DSS", "GDPR"
  severity: 'must' | 'should' | 'nice';
  detail: string;
}

interface PersonaEntry {
  name: string;
  description: string;
  context: string; // usage context, goals
}

interface SLAEntry {
  metric: string; // e.g., "First Response Time"
  target: string; // e.g., "< 5 seconds"
  unit: string; // e.g., "seconds"
}

interface AgentSummary {
  name: string;
  role: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  model: string | null;
  description: string;
  compileStatus: 'pending' | 'generated' | 'compiled' | 'warning' | 'error' | null;
}

interface EdgeSummary {
  from: string;
  to: string;
  type: 'delegate' | 'escalate' | 'transfer';
  condition: string;
}

interface ToolSummary {
  name: string;
  agent: string;
  type: string; // e.g., "http", "function", "mcp"
  description: string;
}

interface GuardrailSummary {
  rule: string;
  agent: string;
  severity: string;
  onFail: string;
}

interface DecisionEntry {
  date: string; // ISO 8601
  what: string;
  why: string;
  phase: string;
}
```

### Indexes

```
{ tenantId: 1, sessionId: 1 }          // session-scoped queries (onboarding)
  unique: true                          // one spec per session (idempotent creation)

{ tenantId: 1, projectId: 1 }          // project-scoped queries (in-project)
  unique: true                          // one spec per project (idempotent linking)
  partialFilterExpression:              // only applies when projectId is not null
    { projectId: { $type: 'string' } }

{ tenantId: 1, userId: 1 }             // user's spec docs (list view)
```

The unique `(tenantId, sessionId)` index guarantees idempotent creation — a retried `POST /sessions` that calls `create()` twice will hit a duplicate key error on the second attempt. The service uses `findOneAndUpdate` with `upsert: true` to make this a no-op rather than an error.

The partial unique `(tenantId, projectId)` index guarantees one spec per project — `linkToProject()` is safe to retry.

### Mongoose Schema Location

`packages/database/src/models/arch-spec-document.model.ts`

Follow the same patterns as `arch-journal.model.ts`:

- `tenantIsolationPlugin` applied
- `timestamps: true` for `createdAt` / `updatedAt`
- No TTL index (spec document is permanent — unlike sessions)

## Service Layer

### `SpecDocumentService`

Location: `packages/arch-ai/src/spec-document/spec-document-service.ts`

```typescript
export class SpecDocumentService {
  constructor(private model: Model<IArchSpecDocument>) {}

  /**
   * Create a new spec doc (called at session creation).
   * Idempotent: uses findOneAndUpdate with upsert keyed on (tenantId, sessionId).
   * If a spec already exists for this session, returns the existing doc.
   */
  async create(ctx: TenantContext, sessionId: string): Promise<IArchSpecDocument>;

  /** Update a specific field path (atomic $set + $inc version, returns new version) */
  async updateField(
    ctx: TenantContext,
    specId: string,
    path: string,
    value: unknown,
  ): Promise<number>; // returns new version via findOneAndUpdate returnDocument:'after'

  /**
   * Update a business field and mirror to session metadata.
   * This is the primary write path for business.* fields — it updates
   * both the spec document AND session.metadata.specification.
   * The mirror keeps canExitInterview() and project creation working.
   *
   * Transaction strategy: uses a MongoDB client session (startSession +
   * withTransaction) to wrap both writes in a single ACID transaction.
   * Both the ArchSpecDocument model and ArchSession model share the same
   * mongoose connection, so the transaction uses one session object.
   *
   * If the replica set does not support transactions (standalone dev),
   * falls back to ordered sequential writes (spec doc first, then session)
   * with a repair log: on partial failure, the next getBySession() call
   * detects divergence via a version mismatch flag and re-syncs from
   * the spec document (the authoritative source) to session metadata.
   *
   * @param sessionId - required to locate the session for mirroring
   * @param sessionFieldName - corresponding field in session.metadata.specification
   */
  async updateBusinessField(
    ctx: TenantContext,
    specId: string,
    sessionId: string,
    path: string,
    value: unknown,
    sessionFieldName: string,
  ): Promise<number>; // returns new version

  /** Push an entry to an array field (atomic $push, increments version) */
  async addEntry(ctx: TenantContext, specId: string, path: string, entry: unknown): Promise<number>; // returns new version

  /**
   * Update or insert an agent summary by name.
   * Uses MongoDB arrayFilters to target the element with matching name:
   *
   *   updateOne(
   *     { _id: specId },
   *     { $set: { 'architecture.agents.$[elem].compileStatus': status }, $inc: { version: 1 } },
   *     { arrayFilters: [{ 'elem.name': agentName }] }
   *   )
   *
   * If no agent with that name exists in the array, uses $push instead.
   * This is the BUILD phase's primary update path — called after
   * generate_agent and compile_abl to update compile status.
   */
  async upsertAgentSummary(
    ctx: TenantContext,
    specId: string,
    agentName: string,
    patch: Partial<AgentSummary>,
  ): Promise<number>; // returns new version

  /**
   * Replace an agent's derived tool and guardrail summaries.
   * Uses replace semantics (not append) — pulls all existing entries
   * for agentName, then pushes the new set:
   *
   *   bulkWrite([
   *     { updateOne: { $pull: { 'implementation.tools': { agent: agentName } } } },
   *     { updateOne: { $push: { 'implementation.tools': { $each: newTools } } } },
   *     { updateOne: { $pull: { 'implementation.guardrails': { agent: agentName } } } },
   *     { updateOne: { $push: { 'implementation.guardrails': { $each: newGuardrails } } } },
   *     { updateOne: { $inc: { version: 1 } } },
   *   ])
   *
   * This prevents duplicate accumulation when compile_abl reruns during
   * fixes or regeneration. Each compile produces a fresh set of tools
   * and guardrails for that agent — the old set is fully replaced.
   */
  async syncAgentDerivedData(
    ctx: TenantContext,
    specId: string,
    agentName: string,
    data: { tools: ToolSummary[]; guardrails: GuardrailSummary[] },
  ): Promise<number>; // returns new version

  /** Add a curated decision */
  async addDecision(ctx: TenantContext, specId: string, decision: DecisionEntry): Promise<number>; // returns new version

  /**
   * Bulk update from direct UI edit.
   * v1: only accepts paths under `business.*`. Rejects architecture.* and
   * implementation.* paths with a validation error.
   * Mirrors each mapped business field to session.metadata.specification.
   * Single version bump for the batch.
   *
   * Same transaction strategy as updateBusinessField(): wraps spec doc $set
   * and session metadata $set in a MongoDB client session transaction.
   * Falls back to ordered writes + repair on standalone.
   */
  async bulkUpdateBusiness(
    ctx: TenantContext,
    specId: string,
    sessionId: string,
    updates: Array<{ path: string; value: unknown }>,
  ): Promise<number>; // returns new version

  /** Get by session (onboarding) */
  async getBySession(ctx: TenantContext, sessionId: string): Promise<IArchSpecDocument | null>;

  /** Get by project (in-project) — requires unsafeProjectScope flag */
  async getByProject(
    ctx: TenantContext,
    projectId: string,
    opts: { unsafeProjectScope: true },
  ): Promise<IArchSpecDocument | null>;

  /**
   * Link to project (called at CREATE, mirrors journal pattern).
   * Idempotent: uses findOneAndUpdate with filter on (tenantId, sessionId).
   * Safe to retry — partial unique index on (tenantId, projectId) prevents
   * two different sessions from linking to the same project.
   */
  async linkToProject(ctx: TenantContext, sessionId: string, projectId: string): Promise<void>;

  /** Render to Markdown */
  renderMarkdown(spec: IArchSpecDocument): string;

  /**
   * Delete by session — ONLY if the spec is not yet linked to a project.
   * Once projectId is set, the spec's lifecycle follows the project,
   * not the session. This prevents session archival/deletion from
   * destroying a project's long-lived spec document.
   *
   * Returns true if deleted, false if skipped (already project-linked).
   */
  async deleteBySessionIfUnlinked(ctx: TenantContext, sessionId: string): Promise<boolean>;
}
```

### Path Validation (v1 Editability Rules)

Direct edits via the UI are restricted to `business.*` paths in v1:

```typescript
const V1_EDITABLE_PATHS = new Set([
  'business.projectName',
  'business.objective',
  'business.channels',
  'business.language',
  'business.compliance',
  'business.constraints',
  'business.personas',
  'business.slas',
  'business.edgeCases',
]);

function validateEditablePath(path: string): void {
  if (!V1_EDITABLE_PATHS.has(path)) {
    throw new ValidationError(
      `Direct edits to '${path}' are not allowed in v1. ` +
        `Only business.* fields are directly editable.`,
    );
  }
}
```

Architecture and implementation sections are **read-only in the UI** — they are filled exclusively by the coordinator during BLUEPRINT and BUILD phases. This avoids a second editable source of truth for topology, generated files, and build status, which would require reconciliation rules we haven't designed yet.

### Business Field Mirroring

The dual-write between spec document and session metadata is **mandatory in both directions**:

**Chat → spec doc (existing direction):** The `update_specification` tool writes to `session.metadata.specification` first (existing behavior), then mirrors to `specDocument.business.*` via `specUpdateAndEmit()`.

**Direct edit → session metadata (new direction):** The `bulkUpdateBusiness()` method writes to the spec document, then mirrors each field back to `session.metadata.specification` using the field mapping:

```typescript
const SPEC_TO_SESSION_FIELD_MAP: Record<string, string> = {
  'business.projectName': 'projectName',
  'business.objective': 'description', // spec.objective maps to session.description
  'business.channels': 'channels',
  'business.language': 'language',
};
```

This ensures:

- `canExitInterview()` works regardless of how `projectName` was filled (chat or direct edit)
- Project creation reads the correct name/channels/language from session metadata
- The `projectExistsByName()` dedup check runs on direct name edits too

### Coordinator Helper

In `apps/studio/src/app/api/arch-ai/message/route.ts`:

```typescript
async function specUpdateAndEmit(
  ctx: TenantContext,
  specId: string,
  path: string,
  value: unknown,
  emit?: (event: SSEEvent) => void,
  sessionId?: string,
  sessionFieldName?: string, // for business fields that need mirroring
) {
  let newVersion: number;
  if (sessionFieldName && sessionId) {
    // Business field: dual-write to spec doc + session metadata
    newVersion = await specDocumentService.updateBusinessField(
      ctx,
      specId,
      sessionId,
      path,
      value,
      sessionFieldName,
    );
  } else {
    // Architecture/implementation field: spec doc only
    newVersion = await specDocumentService.updateField(ctx, specId, path, value);
  }
  emit?.({ type: 'spec_document_update', path, value, version: newVersion });
}
```

This is called alongside `journalAppendAndEmit` at the same trigger points — parallel writes, never replacing existing code paths. The `version` is returned from the atomic `$inc` operation and threaded through the SSE event to the frontend store.

## Integration Points

### Phase-to-Spec Mapping

Every existing trigger point that writes to the journal or session metadata also writes to the spec document:

| Existing Trigger            | Code Location                      | Spec Update Method                                | Details                                                                                                                                           |
| --------------------------- | ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_specification` tool | `message/route.ts` ~L1320          | `updateBusinessField()`                           | `business.projectName`, `business.objective`, `business.channels`, `business.language` — mirrors to session metadata                              |
| `conversationNotes` added   | `message/route.ts` ~L1351          | `addEntry()`                                      | `business.notes` (push)                                                                                                                           |
| Compliance widget answer    | `message/route.ts` (gate response) | `addEntry()`                                      | `business.compliance` (push)                                                                                                                      |
| `generate_topology` tool    | `message/route.ts` ~L1444          | `updateField()`                                   | `architecture.agents` (full array replace), `architecture.edges`, `architecture.entryPoint`, `architecture.pattern`, `architecture.agentCount`    |
| Topology approved           | `phase-transition.ts` ~L88         | `updateField()`                                   | `architecture.rationale` (from gate response)                                                                                                     |
| `generate_agent` tool       | `message/route.ts` ~L1643          | `upsertAgentSummary()`                            | `upsertAgentSummary(agentName, { compileStatus: 'generated' })` — uses `arrayFilters`                                                             |
| `compile_abl` tool          | `message/route.ts` ~L1709          | `upsertAgentSummary()` + `syncAgentDerivedData()` | Agent: `upsertAgentSummary(agentName, { compileStatus })`. Tools/guardrails: `syncAgentDerivedData(agentName, { tools, guardrails })` — see below |
| Key journal decisions       | Various                            | `addDecision()`                                   | `decisions` (push curated subset)                                                                                                                 |
| Project created             | `create-project.ts`                | `linkToProject()`                                 | Sets `projectId` via idempotent `findOneAndUpdate`                                                                                                |

### Spec as LLM Context

The codebase has **two separate prompt builders** (see `packages/arch-ai/src/prompts/index.ts`):

- `composeSystemPrompt(specialist, phase, pageContext, userMessage)` — used during ONBOARDING (INTERVIEW, BLUEPRINT, BUILD, CREATE)
- `composeInProjectPrompt(specialist, pageContext, userMessage)` — used during IN_PROJECT mode

Both must inject the spec document. To avoid duplication, a shared helper builds the spec context section:

```typescript
/**
 * Shared helper — called by both prompt builders.
 * Produces a concise structured summary optimized for LLM context,
 * not the full Markdown export.
 */
function renderSpecContext(specDocument: IArchSpecDocument): string {
  // Highlights: constraints, SLAs, compliance, architecture decisions,
  // agent roles. Omits empty sections. Phase-aware: during INTERVIEW
  // skips architecture (not yet filled), during BUILD includes full
  // agent inventory for cross-referencing.
}
```

**Onboarding path** — `composeSystemPrompt()` gains an optional `specDocument` parameter:

```typescript
export function composeSystemPrompt(
  specialist: SpecialistId,
  phase: ArchPhase,
  pageContext?: PageContext,
  userMessage?: string,
  specDocument?: IArchSpecDocument, // NEW
): string {
  const parts = [BASE_PROMPT];
  // ... existing layers ...
  if (specDocument) parts.push(renderSpecContext(specDocument));
  return parts.join('\n\n');
}
```

**In-project path** — `composeInProjectPrompt()` gains the same parameter:

```typescript
export function composeInProjectPrompt(
  specialist: AnySpecialistId,
  pageContext?: PageContext,
  userMessage?: string,
  specDocument?: IArchSpecDocument, // NEW
): string {
  const parts = [BASE_PROMPT];
  // ... existing layers ...
  if (specDocument) parts.push(renderSpecContext(specDocument));
  return parts.join('\n\n');
}
```

**Caller changes in `message/route.ts`:**

- Onboarding path (~L5041): load spec doc via `getBySession()`, pass to `composeSystemPrompt()`
- In-project path (~L3351): load spec doc via `getByProject()`, pass to `composeInProjectPrompt()`

Both paths fetch the spec doc once per request and pass it through. The spec doc is project-scoped after creation, so in-project specialists (diagnostician, analyst, observer, etc.) all see the full spec — compliance constraints, SLA targets, architecture decisions — enabling spec-aware analysis and modification proposals.

### Existing Specification Compatibility

The current `Specification` type in `packages/arch-ai/src/types/specification.ts` is not removed. It continues to exist as the lightweight data backing `session.metadata.specification`. The spec document's `business` section is the authoritative version — `session.metadata.specification` is kept in sync as a derived view.

**Dual-write is mandatory in both directions:**

**Direction 1: Chat → spec doc.** The `update_specification` tool writes to `session.metadata.specification` first (existing behavior, unchanged), then mirrors to `specDocument.business.*` fields via `specUpdateAndEmit()`.

**Direction 2: Direct edit → session metadata.** The `bulkUpdateBusiness()` method writes to the spec document, then mirrors each mapped field back to `session.metadata.specification` using `SPEC_TO_SESSION_FIELD_MAP`. Direct edits to `business.projectName` also run the existing `projectExistsByName()` dedup check before persisting.

This preserves backward compatibility:

- `canExitInterview()` continues to read from `session.metadata.specification` — works for both chat and direct-edit paths
- Project creation reads name/channels/language from session metadata — always in sync
- The `update_specification` tool's existing validation (project name uniqueness, channel normalization) runs on direct edits too

## API Routes

All routes are scoped through the session or project — no naked spec-document-ID routes. This follows the platform access model (session owner check or `requireProjectAccess()`) and prevents cross-project existence leaks.

### Session-scoped (onboarding)

```
GET  /api/arch-ai/sessions/:id/spec-document
PUT  /api/arch-ai/sessions/:id/spec-document
GET  /api/arch-ai/sessions/:id/spec-document/download
```

File: `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/route.ts`

**GET:** Returns the spec document for the given session. Auth: verifies `session.userId === auth.id`. Returns 404 if no spec exists for this session.

**PUT:** Direct edit of `business.*` fields. Body: `{ updates: [{ path: string, value: unknown }] }`. Validates all paths against `V1_EDITABLE_PATHS`. Calls `bulkUpdateBusiness()` which mirrors to `session.metadata.specification`. Auth: session owner. Returns 400 if any path is outside `business.*`.

File: `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/download/route.ts`

**GET (download):** Calls `renderMarkdown()`, returns `Content-Disposition: attachment; filename="{projectName}-spec.md"` with `Content-Type: text/markdown`. Auth: session owner.

### Project-scoped (in-project)

```
GET  /api/arch-ai/projects/:projectId/spec-document
PUT  /api/arch-ai/projects/:projectId/spec-document
GET  /api/arch-ai/projects/:projectId/spec-document/download
```

File: `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts`

Same operations as session-scoped but uses `requireProjectAccess()` and queries by `projectId`. The PUT route also validates against `V1_EDITABLE_PATHS`. Note: project-scoped PUT does not mirror to session metadata (the session is archived at this point).

File: `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/download/route.ts`

**GET (download):** Same as session-scoped but with project auth.

### Auth sequence (404-safe)

Both GET and PUT routes follow this pattern to avoid leaking existence:

```typescript
// Session-scoped
const session = await sessionService.findOne({ _id: sessionId, tenantId, userId });
if (!session) return NextResponse.json({ success: false }, { status: 404 });
const spec = await specDocumentService.getBySession(ctx, sessionId);
if (!spec) return NextResponse.json({ success: false }, { status: 404 });

// Project-scoped
await requireProjectAccess(req, projectId); // throws 404 on no access
const spec = await specDocumentService.getByProject(ctx, projectId, { unsafeProjectScope: true });
if (!spec) return NextResponse.json({ success: false }, { status: 404 });
```

## Update Transport

There are **two update paths** with different transport models:

### Chat-driven updates (SSE)

When the coordinator updates the spec during a streaming chat response (e.g., `update_specification` tool fires during INTERVIEW), `specUpdateAndEmit()` pushes a `spec_document_update` event through the existing SSE stream. This works because the SSE connection is already open during `/api/arch-ai/message` processing.

New event type added to `packages/arch-ai/src/types/sse-events.ts`:

```typescript
export const SpecDocumentUpdateEventSchema = z.object({
  type: z.literal('spec_document_update'),
  path: z.string(),
  value: z.unknown(),
  version: z.number(),
});
```

Handled in `useArchChat.ts` alongside existing event handlers.

### Direct UI edits (optimistic local + response payload)

When the user directly edits a field in the `SpecDocumentPanel`, the PUT route **cannot** push SSE events — the SSE stream only exists while `/api/arch-ai/message` is actively streaming a chat response. Instead, direct edits use the standard optimistic update pattern:

1. **Optimistic local update:** The `SpecDocumentPanel` calls `useArchAIStore.getState().updateSpecDocument(path, value, currentVersion + 1)` immediately on field change (debounced 300ms for text fields).
2. **PUT request:** `PUT /api/arch-ai/sessions/:id/spec-document` with `{ updates: [{ path, value }] }`.
3. **Authoritative reconciliation:** The PUT response returns the full updated spec document: `{ success: true, data: IArchSpecDocument }`. The store replaces its local state with the authoritative document. This is necessary because server-side normalization (channel normalization via `normalizeChannels()`, project name dedup check, etc.) can produce canonical values that differ from the optimistic input.
4. **Error rollback:** On 4xx/5xx, the store calls `setSpecDocument()` with the pre-edit snapshot to revert all optimistic changes.

```typescript
// In SpecDocumentPanel — field change handler
async function handleFieldChange(path: string, value: unknown) {
  const store = useArchAIStore.getState();
  const snapshot = structuredClone(store.specDocument); // pre-edit snapshot

  // 1. Optimistic update
  store.updateSpecDocument(path, value, store.specDocumentVersion + 1);

  try {
    // 2. Persist
    const res = await fetch(`/api/arch-ai/sessions/${sessionId}/spec-document`, {
      method: 'PUT',
      body: JSON.stringify({ updates: [{ path, value }] }),
    });
    const json = await res.json();

    // 3. Reconcile with authoritative document
    if (json.success) {
      store.setSpecDocument(json.data); // replaces local state with normalized values
    } else {
      // 4. Rollback
      if (snapshot) store.setSpecDocument(snapshot);
    }
  } catch {
    if (snapshot) store.setSpecDocument(snapshot);
  }
}
```

**Multi-tab sync is out of scope for v1.** A second browser tab will not see direct edits from the first tab in real-time. This is acceptable because Arch sessions are single-user. If multi-tab sync is needed later, a dedicated WebSocket or polling channel can be added.

## Frontend

### SpecDocumentPanel Component

Location: `apps/studio/src/components/arch-v3/panels/SpecDocumentPanel.tsx`

**Replaces** the current "Specification" tab in both `OnboardingArtifactPanel` and `InProjectArtifactPanel`.

#### Layout

```
┌──────────────────────────────────────┐
│ Spec Document              v3  ⬇    │  header: version badge + download btn
├──────────────────────────────────────┤
│ ▼ Business Context          ● draft │  EDITABLE section
│   Project Name: [editable field]    │
│   Objective:    [editable textarea] │
│   Channels:     [tag editor]        │
│   Language:     [dropdown]          │
│   Compliance:   [table: +add row]   │
│   Constraints:  [list: +add item]   │
│   Personas:     [cards: +add]       │
│   SLAs:         [table: +add row]   │
│   Edge Cases:   [list: +add item]   │
│   Notes:        [read-only list]    │
├──────────────────────────────────────┤
│ ▶ Architecture    🔒     ○ empty    │  READ-ONLY (v1), auto-expands when filled
├──────────────────────────────────────┤
│ ▶ Implementation  🔒     ○ empty    │  READ-ONLY (v1), auto-expands when filled
├──────────────────────────────────────┤
│ ▼ Key Decisions                     │  always visible, read-only
│   2026-04-12 • Chose hub-spoke      │
│     because compliance requires...  │
│   2026-04-12 • Added HIPAA guard    │
│     because user specified must...  │
└──────────────────────────────────────┘
```

Architecture and Implementation sections display data filled by the coordinator during BLUEPRINT/BUILD but do not offer inline editing in v1. A subtle lock icon or "Managed by Arch" label indicates this.

#### Section Status Logic

```typescript
type SectionStatus = 'empty' | 'draft' | 'complete';

function getBusinessStatus(business: Business): SectionStatus {
  if (!business.projectName) return 'empty';
  if (!business.objective) return 'draft';
  return 'complete';
}

function getArchitectureStatus(arch: Architecture): SectionStatus {
  if (arch.agents.length === 0) return 'empty';
  if (!arch.entryPoint) return 'draft';
  return 'complete';
}

function getImplementationStatus(impl: Implementation): SectionStatus {
  if (impl.tools.length === 0 && impl.guardrails.length === 0) return 'empty';
  if (!impl.buildStatus) return 'draft';
  return 'complete';
}
```

#### Store and Update Integration

The Zustand store gains:

- `specDocument: IArchSpecDocument | null`
- `specDocumentVersion: number` — tracks latest version for optimistic UI + stale-check
- `updateSpecDocument(path: string, value: unknown, version: number)` — immutable update at path, sets version
- `setSpecDocument(doc: IArchSpecDocument)` — full doc set (initial load, sets version from doc)
- `setSpecDocumentVersion(version: number)` — reconcile version after PUT response

**Chat-driven updates (SSE path):** In `useArchChat.ts`, add a handler for `spec_document_update`:

```typescript
case 'spec_document_update':
  useArchAIStore.getState().updateSpecDocument(
    parsed.path,
    parsed.value,
    parsed.version   // version threaded from service → SSE → store
  );
  break;
```

The `version` field flows end-to-end: `SpecDocumentService.updateField()` returns the new version via `$inc` + `returnDocument: 'after'` → `specUpdateAndEmit()` includes it in the SSE event → `useArchChat.ts` parses it → store action sets `specDocumentVersion` → `SpecDocumentPanel` renders it in the header badge.

**Direct UI edits (optimistic path):** Handled in `SpecDocumentPanel` — see the "Direct UI edits" section above under Update Transport. The store is updated optimistically, then reconciled with the PUT response version.

#### Data Loading

`SpecDocumentPanel` follows the same dual-source pattern as `JournalPanel`:

1. On mount: fetch from API (session or project endpoint)
2. Live updates: subscribe to store for SSE-driven updates
3. Merge and deduplicate

### Tab Registration

In `OnboardingArtifactPanel`:

- Replace `{ type: 'specification' }` tab with `{ type: 'spec-document' }`
- Mount `<SpecDocumentPanel>` instead of `<SpecificationCard>`

In `InProjectArtifactPanel`:

- Add `{ type: 'spec-document' }` tab (alongside journal)
- Mount `<SpecDocumentPanel>` with `projectId`

### SpecificationCard Migration

`SpecificationCard` is not deleted. It becomes an internal sub-component of the Business section in `SpecDocumentPanel`, reusing its field editors (`EditableField`, `ChannelTags`, `LanguageSelect`). The data source changes from `session.metadata.specification` to `specDocument.business`.

## The Spec-First Flow

### Entry Point

When a user creates a new session, the spec document is created alongside (empty, with defaults). The user sees the `SpecDocumentPanel` in the artifact panel.

**Path A (existing chat flow):**

1. User chats with Arch in Interview
2. Arch updates spec fields via `update_specification` tool
3. Spec document auto-fills via parallel writes
4. User reviews spec in panel, can directly edit
5. Clicks "Continue" when ready

**Path B (spec-first flow — new):**

1. User opens spec document panel
2. Directly fills business sections (project name, objective, compliance, SLAs, etc.)
3. Each edit is applied optimistically in the store, persisted via PUT, reconciled from the authoritative response
4. When `canExitInterview()` passes (projectName filled), "Continue" button enables
5. User clicks "Continue" — BLUEPRINT specialist receives full spec as context
6. Architecture is generated informed by all spec sections, not just a 5-field summary

**Path C (upload-and-parse — future):**

1. User uploads a requirements document (PDF, markdown, etc.)
2. Arch parses and populates spec sections from the document
3. User reviews, edits, continues

Path C is listed for completeness but is out of scope for v1. Paths A and B are the v1 deliverables.

### Re-generation After Spec Update

When a user updates business fields after architecture is generated:

1. The PUT endpoint detects which `business.*` fields changed
2. If business fields changed during BLUEPRINT or later:
   - Arch acknowledges in chat: "I see you updated the compliance requirements. This may affect the architecture."
   - If the change is significant (new compliance requirement, new channel), the system suggests re-running BLUEPRINT
   - Uses the existing `classifyMutationScope()` pattern to determine LARGE vs SMALL
3. The user is never forced to regenerate — they can acknowledge and continue

**v1 restriction:** Architecture and implementation sections are read-only in the UI. They are filled exclusively by the coordinator during BLUEPRINT and BUILD. Direct editing of these sections is deferred to v2 when reconciliation rules (how a manually edited topology syncs with `session.metadata.topology` and `buildProgress`) are designed.

## Markdown Renderer

`SpecDocumentService.renderMarkdown()` produces a clean, downloadable Markdown document:

```markdown
# {projectName} — Project Specification

> Version {version} | Created {createdAt} | Last updated {updatedAt}

## Business Context

**Objective:** {objective}

**Channels:** {channels as comma-separated list}

**Language:** {language}

### Compliance

| Standard | Severity | Detail |
| -------- | -------- | ------ |
| HIPAA    | must     | ...    |

### Constraints

- {constraint 1}
- {constraint 2}

### User Personas

**{persona.name}** — {persona.description}
{persona.context}

### SLA Targets

| Metric              | Target | Unit    |
| ------------------- | ------ | ------- |
| First Response Time | < 5    | seconds |

### Edge Cases

- {edge case 1}
- {edge case 2}

## Architecture

**Pattern:** {pattern}
**Entry Point:** {entryPoint}
**Agent Count:** {agentCount}

### Agents

| Agent  | Role      | Mode      | Model  | Status   |
| ------ | --------- | --------- | ------ | -------- |
| Triage | Routes... | reasoning | gpt-4o | compiled |

### Topology

| From   | To      | Type     | Condition      |
| ------ | ------- | -------- | -------------- |
| Triage | Billing | delegate | billing intent |

**Rationale:** {rationale}

## Implementation

### Tools

| Tool           | Agent   | Type | Description |
| -------------- | ------- | ---- | ----------- |
| lookup_account | Billing | http | ...         |

### Guardrails

| Rule           | Agent | Severity | On Fail |
| -------------- | ----- | -------- | ------- |
| No PII in logs | All   | critical | block   |

**Build Status:** {buildStatus}

## Key Decisions

| Date       | Decision        | Rationale              | Phase     |
| ---------- | --------------- | ---------------------- | --------- |
| 2026-04-12 | Chose hub-spoke | Compliance requires... | BLUEPRINT |
```

## File Inventory

### New Files

| File                                                                                   | Purpose                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/database/src/models/arch-spec-document.model.ts`                             | Mongoose model + schema + unique indexes         |
| `packages/arch-ai/src/spec-document/spec-document-service.ts`                          | Service layer (CRUD, scoping, mirroring, render) |
| `packages/arch-ai/src/spec-document/types.ts`                                          | Sub-types (ComplianceEntry, PersonaEntry, etc.)  |
| `packages/arch-ai/src/spec-document/index.ts`                                          | Package exports                                  |
| `packages/arch-ai/src/spec-document/markdown-renderer.ts`                              | `renderMarkdown()` implementation                |
| `packages/arch-ai/src/spec-document/field-map.ts`                                      | `V1_EDITABLE_PATHS`, `SPEC_TO_SESSION_FIELD_MAP` |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/route.ts`                 | GET + PUT by session (scoped)                    |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/spec-document/download/route.ts`        | GET Markdown download (session-scoped)           |
| `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts`          | GET + PUT by project (scoped)                    |
| `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/download/route.ts` | GET Markdown download (project-scoped)           |
| `apps/studio/src/components/arch-v3/panels/SpecDocumentPanel.tsx`                      | Main UI panel                                    |
| `apps/studio/src/components/arch-v3/spec-document/BusinessSection.tsx`                 | Business section editor (editable)               |
| `apps/studio/src/components/arch-v3/spec-document/ArchitectureSection.tsx`             | Architecture section (read-only in v1)           |
| `apps/studio/src/components/arch-v3/spec-document/ImplementationSection.tsx`           | Implementation section (read-only in v1)         |
| `apps/studio/src/components/arch-v3/spec-document/DecisionsSection.tsx`                | Decisions list (read-only)                       |
| `apps/studio/src/components/arch-v3/spec-document/SectionHeader.tsx`                   | Collapsible section with status + lock icon      |

### Modified Files

| File                                                                         | Change                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/index.ts`                                             | Export `ArchSpecDocument` model                                                                                                                                             |
| `packages/arch-ai/src/types/sse-events.ts`                                   | Add `SpecDocumentUpdateEventSchema` (with `version` field)                                                                                                                  |
| `packages/arch-ai/src/prompts/index.ts`                                      | Add `specDocument` param to both `composeSystemPrompt()` and `composeInProjectPrompt()`, add shared `renderSpecContext()` helper                                            |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                           | Add `specUpdateAndEmit()` calls at trigger points; load spec doc and pass to `composeSystemPrompt()` ~L5041 (onboarding) and `composeInProjectPrompt()` ~L3351 (in-project) |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts`                          | Create spec document on session creation (idempotent)                                                                                                                       |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/route.ts`                     | Cascade delete spec document **only if unlinked** (`deleteBySessionIfUnlinked`)                                                                                             |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/archive/route.ts`             | No spec archive (spec is permanent)                                                                                                                                         |
| `apps/studio/src/lib/arch-ai/tools/create-project.ts`                        | Call `specDocumentService.linkToProject()` (idempotent)                                                                                                                     |
| `apps/studio/src/hooks/useArchChat.ts`                                       | Handle `spec_document_update` SSE event with `version`                                                                                                                      |
| `apps/studio/src/store/arch-ai-store.ts`                                     | Add `specDocument`, `specDocumentVersion` state + actions                                                                                                                   |
| `apps/studio/src/hooks/usePreloadOrchestrator.ts` ~L104                      | Change tab type from `'specification'` to `'spec-document'`, load spec doc data                                                                                             |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` ~L27 | Replace `'specification'` in `ARTIFACT_TAB_TYPES` with `'spec-document'`, mount `SpecDocumentPanel`                                                                         |
| `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`       | Add `'spec-document'` tab (alongside journal)                                                                                                                               |

## Scope Boundaries

### In Scope (v1)

- MongoDB model + service with unique indexes (idempotent creation/linking)
- Scoped API routes (GET/PUT/download via session and project paths — no naked ID routes)
- SSE event with version threading (service → SSE → store → UI badge)
- Parallel writes from existing coordinator trigger points
- SpecDocumentPanel: business section editable, architecture/implementation read-only
- Bidirectional mirroring between spec doc business fields and `session.metadata.specification`
- Markdown download via session-scoped and project-scoped endpoints
- Spec injected into LLM context
- Version counter
- Spec survives session archival/deletion once linked to a project (`deleteBySessionIfUnlinked`)

### Out of Scope (future)

- Direct editing of `architecture.*` and `implementation.*` sections (requires reconciliation rules for topology/buildProgress sync)
- Upload-and-parse (Path C — parse requirements doc into spec sections)
- Full version history with diff view
- Drift detection (RFC-025 concept — flag when implementation diverges from spec)
- Multi-user spec editing (concurrent edit conflict resolution)
- Spec-to-test generation (acceptance criteria to test scenarios)
- Expert agent (RFC-025 — separate business-facing agent)
- Approval workflows for spec changes
- PDF export

## Testing Strategy

- Unit tests: `SpecDocumentService` methods, `renderMarkdown()`, section status logic
- Integration tests: API routes with real MongoDB, scoping/isolation
- E2E: Create session -> fill spec via chat -> verify spec doc populated -> download -> verify Markdown content
- E2E: Direct edit flow -> PUT returns authoritative doc with version increment -> optimistic UI reconciles
- Integration: `syncAgentDerivedData()` replace semantics — compile twice, verify no duplicates in tools/guardrails
- Integration: `bulkUpdateBusiness()` transaction — verify both spec doc and session metadata updated atomically
