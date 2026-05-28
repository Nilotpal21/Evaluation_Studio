# Story 4.6: Vocabulary API Endpoints

## Status: ready-for-dev

## Story

As a Frontend Developer,
I want API endpoints to fetch, review, and manage vocabulary terms,
So that the FieldsTab can display vocabulary status and accept user feedback.

## Context

**This is an ENHANCEMENT story.** Vocabulary CRUD routes already exist in `apps/search-ai/src/routes/vocabulary.ts` (406 lines), mounted at `/api/indexes` via `server.ts:143`. The existing endpoints are:

- `GET /:indexId/vocabulary` -- list all entries (no fieldRef filtering, no sort by confidence)
- `POST /:indexId/vocabulary` -- add single entry
- `POST /:indexId/vocabulary/bulk` -- bulk import (upsert by term)
- `DELETE /:indexId/vocabulary/:term` -- remove entry by term

**The gaps are:**

1. **GET by fieldRef** -- The existing `GET /:indexId/vocabulary` returns ALL entries. Story 4.6 requires a new `GET /:indexId/vocabulary/:fieldRef` endpoint that filters entries to a specific canonical field, sorted by confidence descending then frequency (usageCount) descending.
2. **Bulk review endpoint** -- No `POST /:indexId/vocabulary/review` endpoint exists for approving/rejecting terms. The existing bulk import (`/bulk`) upserts entire entries but does not support status-only review actions.
3. **fieldRef validation** -- Neither endpoint validates that `fieldRef` exists in the CanonicalSchema for the given SearchIndex.

All new routes are added to the existing `apps/search-ai/src/routes/vocabulary.ts` file. No new route file or server.ts registration is needed.

## Acceptance Criteria

- [ ] `GET /api/indexes/:indexId/vocabulary/:fieldRef` returns vocabulary terms filtered by fieldRef with source (`generatedBy`), confidence, and status (`enabled`)
- [ ] Terms are sorted by confidence descending, then usageCount descending
- [ ] `POST /api/indexes/:indexId/vocabulary/review` bulk updates term status (approve/reject) in DomainVocabulary
- [ ] Review endpoint logs audit event with user, timestamp, and affected term IDs
- [ ] Both endpoints validate that `fieldRef` exists in the active CanonicalSchema for the SearchIndex
- [ ] Both endpoints return 404 if SearchIndex not found or wrong tenant (not 403)
- [ ] Both endpoints return 404 if fieldRef not found in CanonicalSchema
- [ ] Consistent error format: `{ error: { code: string, message: string } }` on new endpoints
- [ ] Vocabulary cache invalidation broadcast after review mutations
- [ ] All queries scoped by tenantId

## Verified Service Signatures & Existing Code

### Existing GET /:indexId/vocabulary (vocabulary.ts:123-161)

```typescript
router.get('/:indexId/vocabulary', async (req: Request, res: Response) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
  if (!index) {
    res.status(404).json({ error: 'Index not found' });
    return;
  }

  const vocab = await DomainVocabulary.findOne({
    projectKnowledgeBaseId: indexId,
    tenantId,
  }).lean();

  const entries = (vocab?.entries ?? []).map((e: IVocabularyEntry, i: number) => ({
    _id: String(i),
    term: e.term,
    aliases: e.aliases,
    // ... etc
  }));

  res.json({ entries, total: entries.length });
});
```

**Gap:** No fieldRef filtering, no confidence/frequency sort, returns all entries.

### DomainVocabulary model (domain-vocabulary.model.ts)

```typescript
export interface IVocabularyEntry {
  id: string; // Unique identifier (e.g., "entry_abc123")
  term: string;
  aliases: string[];
  description?: string;
  fieldRef: string; // Canonical field name (e.g., "issue_priority")
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
  enabled: boolean;
  confidence?: number; // LLM generation confidence (0.0-1.0)
  generatedBy: 'auto' | 'manual';
  usageCount?: number;
  lastUsed?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IDomainVocabulary {
  _id: string;
  tenantId: string;
  projectKnowledgeBaseId: string; // References SearchIndex._id
  version: number;
  status: 'draft' | 'active' | 'inactive';
  entries: IVocabularyEntry[]; // Embedded subdocuments
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Key:** Entries are embedded subdocuments, not a separate collection. Filtering by fieldRef means filtering `vocab.entries` in-memory after fetching the document.

### CanonicalSchema field validation pattern (from mappings.ts:304-317)

```typescript
const schema = await CanonicalSchema.findOne({ _id: canonicalSchemaId, tenantId }).lean();
if (!schema) {
  res.status(404).json({ error: 'Canonical schema not found' });
  return;
}

const fieldExists = (schema.fields as any[]).some((f: any) => f.storageField === canonicalField);
if (!fieldExists) {
  res.status(404).json({ error: 'canonicalField not found in schema' });
  return;
}
```

**Note for Story 4.6:** `fieldRef` in DomainVocabulary is the alias name (`ICanonicalField.name`), NOT the storageField. Validation must check `f.name === fieldRef` (alias match).

### Models available via getLazyModel (vocabulary.ts:19-20)

```typescript
const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
```

**Need to add:** `CanonicalSchema` via `getLazyModel` for fieldRef validation.

### Auth pattern (vocabulary.ts:126-127)

```typescript
const tenantId = req.tenantContext!.tenantId;
const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
if (!index) {
  res.status(404).json({ error: 'Index not found' });
  return;
}
```

### Audit helper (audit-helpers.ts:183-191)

```typescript
export function auditVocabularyUpdated(event: VocabularyAuditEvent): void {
  writeAuditLog('search.vocabulary.updated', {
    tenantId: event.tenantId,
    userId: event.userId,
    projectKnowledgeBaseId: event.projectKnowledgeBaseId,
    version: event.version,
    entryCount: event.entryCount,
  });
}
```

### Cache invalidation (vocabulary.ts:53-68)

```typescript
async function invalidateVocabularyCache(indexId: string, tenantId: string): Promise<void> {
  const publisher = getRedisPublisher();
  if (!publisher) return;
  await publisher.publish(
    VOCABULARY_INVALIDATE_CHANNEL,
    JSON.stringify({ projectKbId: indexId, tenantId }),
  );
}
```

### Route registration (server.ts:143)

```typescript
app.use('/api/indexes', vocabularyRouter);
```

Routes mount as `/api/indexes/:indexId/vocabulary/...`.

## File List

| File                                                         | Action | Description                                                                                                    |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/vocabulary.ts`                    | MODIFY | Add GET /:indexId/vocabulary/:fieldRef, add POST /:indexId/vocabulary/review, add CanonicalSchema getLazyModel |
| `apps/search-ai/src/routes/__tests__/vocabulary-api.test.ts` | CREATE | Tests for new fieldRef GET and bulk review endpoints                                                           |

## Tasks

### Task 1: Add CanonicalSchema model import

Add the CanonicalSchema lazy model at the top of `vocabulary.ts` (after line 20):

```typescript
import type { ICanonicalSchema } from '@agent-platform/database/models';

const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
```

### Task 2: Add helper to validate fieldRef in CanonicalSchema

Add a shared helper function after the `sanitizeObject` function (after line 83):

```typescript
/**
 * Validate that a fieldRef (alias name) exists in the active CanonicalSchema
 * for the given SearchIndex. Returns the schema if valid, null otherwise.
 */
async function validateFieldRef(
  indexId: string,
  tenantId: string,
  fieldRef: string,
): Promise<ICanonicalSchema | null> {
  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId: indexId,
    tenantId,
    status: 'active',
  })
    .sort({ version: -1 })
    .lean();

  if (!schema) return null;

  // fieldRef is the alias name (ICanonicalField.name), not storageField
  const fieldExists = (schema.fields as any[]).some((f: any) => f.name === fieldRef);
  if (!fieldExists) return null;

  return schema as ICanonicalSchema;
}
```

### Task 3: Add GET /:indexId/vocabulary/:fieldRef

Add AFTER the existing `GET /:indexId/vocabulary` route (after line 161) and BEFORE `POST /:indexId/vocabulary` (line 167). This ensures the static `/bulk` and `/review` routes are not shadowed.

**IMPORTANT:** This route MUST be placed AFTER `GET /:indexId/vocabulary` but BEFORE `POST /:indexId/vocabulary`. Express matches routes in registration order, and `/:fieldRef` is a parameterized segment that could capture `bulk` or `review` if misplaced. However, since `bulk` and `review` are POST routes, GET `/:fieldRef` will not conflict with them.

```typescript
// =============================================================================
// GET /:indexId/vocabulary/:fieldRef --- Get terms for a specific field
// =============================================================================

router.get('/:indexId/vocabulary/:fieldRef', async (req: Request, res: Response) => {
  try {
    const { indexId, fieldRef } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Validate SearchIndex exists and belongs to tenant
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
    }

    // Validate fieldRef exists in CanonicalSchema
    const schema = await validateFieldRef(indexId, tenantId, fieldRef);
    if (!schema) {
      return res
        .status(404)
        .json({ error: { code: 'FIELD_NOT_FOUND', message: 'fieldRef not found in schema' } });
    }

    // Fetch vocabulary document
    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    }).lean();

    // Filter entries by fieldRef, sort by confidence desc then usageCount desc
    const filtered = (vocab?.entries ?? [])
      .filter((e: IVocabularyEntry) => e.fieldRef === fieldRef)
      .sort((a: IVocabularyEntry, b: IVocabularyEntry) => {
        const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
        if (confDiff !== 0) return confDiff;
        return (b.usageCount ?? 0) - (a.usageCount ?? 0);
      })
      .map((e: IVocabularyEntry) => ({
        id: e.id,
        term: e.term,
        aliases: e.aliases,
        description: e.description,
        fieldRef: e.fieldRef,
        capabilities: e.capabilities,
        enabled: e.enabled,
        confidence: e.confidence ?? null,
        generatedBy: e.generatedBy,
        usageCount: e.usageCount ?? 0,
        lastUsed: e.lastUsed ?? null,
        createdAt: e.createdAt ?? null,
        updatedAt: e.updatedAt ?? null,
      }));

    res.json({ entries: filtered, total: filtered.length, fieldRef });
  } catch (error) {
    logger.error('Failed to get vocabulary entries by fieldRef', {
      indexId: req.params.indexId,
      fieldRef: req.params.fieldRef,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get vocabulary entries' },
    });
  }
});
```

### Task 4: Add POST /:indexId/vocabulary/review

Add BEFORE the existing `POST /:indexId/vocabulary` route (before line 167). Static route `/review` must register before parameterized routes, though since POST `/:indexId/vocabulary` uses a different path structure this is mainly for clarity.

```typescript
// =============================================================================
// POST /:indexId/vocabulary/review --- Bulk approve/reject terms
// =============================================================================

router.post('/:indexId/vocabulary/review', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { action, termIds } = req.body;

    // Validate action
    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        error: { code: 'INVALID_ACTION', message: 'action must be approve or reject' },
      });
    }

    // Validate termIds
    if (!termIds || !Array.isArray(termIds) || termIds.length === 0) {
      return res.status(400).json({
        error: { code: 'INVALID_TERM_IDS', message: 'termIds must be a non-empty array' },
      });
    }

    if (termIds.length > 500) {
      return res.status(400).json({
        error: { code: 'TOO_MANY_TERMS', message: 'termIds array must not exceed 500 items' },
      });
    }

    // Validate SearchIndex exists and belongs to tenant
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
    }

    // Fetch vocabulary document (mutable -- need to save)
    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    });

    if (!vocab) {
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Vocabulary not found' } });
    }

    // Build a lookup set of requested term IDs
    const requestedIds = new Set(termIds as string[]);

    // Track which IDs were actually found and updated
    const updatedIds: string[] = [];
    const newEnabled = action === 'approve';

    for (const entry of vocab.entries as IVocabularyEntry[]) {
      if (requestedIds.has(entry.id)) {
        entry.enabled = newEnabled;
        (entry as any).updatedAt = new Date();
        updatedIds.push(entry.id);
      }
    }

    // Check if any requested IDs were not found
    const notFoundIds = termIds.filter((id: string) => !updatedIds.includes(id));
    if (updatedIds.length === 0) {
      return res.status(404).json({
        error: { code: 'TERMS_NOT_FOUND', message: 'No matching term IDs found' },
      });
    }

    await vocab.save();

    // Invalidate cache across all pods
    await invalidateVocabularyCache(indexId, tenantId);

    // Audit logging
    const userId = (req as any).userId || 'user';
    auditVocabularyUpdated({
      tenantId,
      userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    logger.info('Vocabulary review completed', {
      tenantId,
      indexId,
      action,
      updatedCount: updatedIds.length,
      userId,
    });

    res.json({
      success: true,
      action,
      updatedCount: updatedIds.length,
      updatedIds,
      notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined,
    });
  } catch (error) {
    logger.error('Failed to review vocabulary terms', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to review vocabulary terms' },
    });
  }
});
```

### Task 5: Write tests

Test file: `apps/search-ai/src/routes/__tests__/vocabulary-api.test.ts`

Tests for `GET /:indexId/vocabulary/:fieldRef`:

- Returns filtered entries sorted by confidence desc, then usageCount desc
- Returns empty entries array when fieldRef has no vocabulary terms
- Returns 404 when SearchIndex not found or wrong tenant
- Returns 404 when fieldRef does not exist in CanonicalSchema
- Response shape includes `{ entries, total, fieldRef }`

Tests for `POST /:indexId/vocabulary/review`:

- Approves terms: sets `enabled: true` on matched entries
- Rejects terms: sets `enabled: false` on matched entries
- Returns 400 when action is invalid
- Returns 400 when termIds is empty or missing
- Returns 400 when termIds exceeds 500
- Returns 404 when SearchIndex not found
- Returns 404 when vocabulary document not found
- Returns 404 when no matching term IDs found
- Partial match: returns `updatedIds` and `notFoundIds`
- Tenant isolation: returns 404 for different tenant's data

## Previous Story Intelligence

- **`getLazyModel` is MANDATORY** in apps/search-ai -- never import models directly from `@agent-platform/database/models` (Epic 1 retro). Use `getLazyModel<ICanonicalSchema>('CanonicalSchema')`.
- **Error format: `{ error: { code, message } }`** for new endpoints. Older endpoints use `{ error: 'string' }` -- do not change those (breaking change).
- **Express route ordering: static routes before parameterized routes.** `POST /:indexId/vocabulary/review` must register BEFORE `POST /:indexId/vocabulary` (the single-entry create). Since `/review` is a more specific sub-path, Express will match it first only if it is registered first.
- **Logger pattern**: `createLogger('module')` from `@abl/compiler/platform`. Error logging: `logger.error('message', { error: error instanceof Error ? error.message : String(error) })`.
- **Tenant isolation**: every query includes `tenantId`, return 404 (not 403) for cross-tenant access to avoid leaking resource existence.
- **Run `npx prettier --write` before finishing** -- the pre-commit hook runs lint-staged with `prettier --check`. If check fails, lint-staged stash/restore will silently revert edits.
- **`fieldRef` is the alias name** (`ICanonicalField.name`), not the storage field. Validate against `schema.fields[].name`, not `schema.fields[].storageField`. This is consistent with the MEMORY.md note: "DomainVocabulary.fieldRef = alias name (from CanonicalSchema.fields[].name)".
- **Vocabulary entries are embedded subdocuments**, not a separate collection. All filtering happens in-memory after fetching the parent `DomainVocabulary` document. This means fieldRef validation against CanonicalSchema is a separate query, not a join.
- **MAPPING_STATUS constants** (`'active'`, `'suggested'`, `'rejected'`) are used in mappings. For vocabulary, the equivalent is `entry.enabled` (boolean) toggled by `approve`/`reject` actions.

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/search-ai
pnpm vitest run apps/search-ai/src/routes/__tests__/vocabulary-api.test.ts
npx prettier --write apps/search-ai/src/routes/vocabulary.ts apps/search-ai/src/routes/__tests__/vocabulary-api.test.ts
```
