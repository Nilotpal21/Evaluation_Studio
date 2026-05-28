# Story 3.8: FieldsTab API Routes

## Status: ready-for-dev

## Story

As a SearchAI administrator,
I want REST API endpoints optimized for FieldsTab data fetching,
So that UI components can load mapping data with proper tenant isolation, pagination, and tab badge counts.

## Context

**This is an ENHANCEMENT story.** Most endpoints already exist in `apps/search-ai/src/routes/mappings.ts` (905 lines) and `apps/search-ai/src/routes/schemas.ts`. The gaps are:

1. **Tab badge stats endpoint** — Current `GET /stats/:canonicalSchemaId` returns review stats but NOT the unmapped count needed for the third tab badge.
2. **Pagination on GET /mappings** — Current endpoint returns all mappings without skip/limit.
3. **No `GET /mappings/:mappingId`** — Single-mapping detail endpoint doesn't exist.

## Acceptance Criteria

- [ ] `GET /api/mappings` supports `?skip=0&limit=50` pagination with `{ mappings, total, pagination: { skip, limit, hasMore } }` response
- [ ] `GET /api/mappings/:mappingId` returns single FieldMapping with alias enrichment, 404 if not found or wrong tenant
- [ ] `GET /api/mappings/tab-stats?knowledgeBaseId={id}` returns `{ confirmedCount, suggestedCount, unmappedCount, totalFields }` for tab badges
- [ ] Tab-stats computes unmappedCount by cross-referencing DiscoveredSchema fields against existing FieldMappings
- [ ] All new/modified endpoints enforce tenantId scoping
- [ ] All endpoints return 404 (not 403) for cross-tenant access
- [ ] Consistent error format: `{ error: { code: string, message: string } }` on new endpoints

## Verified Service Signatures & Existing Code

### Existing GET / endpoint (mappings.ts:65-106)

```typescript
router.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const { schemaId, connectorId, status } = req.query;
  const filter: Record<string, unknown> = { tenantId };
  if (schemaId) filter.canonicalSchemaId = schemaId;
  if (connectorId) filter.connectorId = connectorId;
  if (status) filter.status = status;
  const mappings = await FieldMapping.find(filter).sort({ createdAt: -1 }).lean();
  // ... alias enrichment ...
  res.json({ mappings: enrichedMappings, total: enrichedMappings.length });
});
```

**Gap:** No `.skip()` / `.limit()` / `countDocuments()`. Returns all results.

### Existing GET /stats/:canonicalSchemaId (mappings.ts:889-903)

```typescript
router.get('/stats/:canonicalSchemaId', async (req: Request, res: Response) => {
  const stats = await batchReviewService.getReviewStats(tenantId, canonicalSchemaId);
  res.json(stats);
});
```

**Gap:** Returns `{ total, suggested, confirmed, rejected, needsReview, avgConfidence }` but NOT `unmappedCount` or `totalFields`. The UI needs unmapped count for the third tab badge.

### Models available via getLazyModel

```typescript
const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const DiscoveredSchema = getLazyModel<IDiscoveredSchema>('DiscoveredSchema');
```

### Auth pattern (from existing endpoints)

```typescript
const tenantId = req.tenantContext!.tenantId;
// Every query includes tenantId
const mapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
if (!mapping) return res.status(404).json({ error: 'Mapping not found' });
```

### Route registration (server.ts:137)

```typescript
app.use('/api/mappings', mappingsRouter);
```

## File List

| File                                                             | Action | Description                                                      |
| ---------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `apps/search-ai/src/routes/mappings.ts`                          | MODIFY | Add pagination to GET /, add GET /:mappingId, add GET /tab-stats |
| `apps/search-ai/src/routes/__tests__/mappings-tab-stats.test.ts` | CREATE | Tests for new tab-stats endpoint                                 |

## Tasks

### Task 1: Add pagination to GET /mappings

Modify the existing `GET /` handler (mappings.ts:65-106):

```typescript
const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
const skip = parseInt(req.query.skip as string) || 0;

const [mappings, total] = await Promise.all([
  FieldMapping.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  FieldMapping.countDocuments(filter),
]);

// ... existing alias enrichment unchanged ...

res.json({
  mappings: enrichedMappings,
  total,
  pagination: { skip, limit, hasMore: skip + limit < total },
});
```

**IMPORTANT:** The existing response shape `{ mappings, total }` is preserved. `pagination` is additive. Frontend `useSearchAIMappings` hook will continue working.

### Task 2: Add GET /mappings/:mappingId

Add BEFORE the `/:mappingId/confirm` route (route order matters — static routes before parameterized):

```typescript
router.get('/:mappingId', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const { mappingId } = req.params;

  const mapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
  if (!mapping)
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });

  // Alias enrichment (same pattern as GET /)
  const schema = await CanonicalSchema.findOne({ _id: mapping.canonicalSchemaId, tenantId }).lean();
  const aliasField = schema?.fields?.find((f: any) => f.storageField === mapping.canonicalField);

  res.json({
    mapping: {
      ...mapping,
      aliasName: aliasField?.name ?? null,
      aliasLabel: aliasField?.label ?? null,
    },
  });
});
```

**Route ordering:** This `GET /:mappingId` must be registered AFTER `GET /stats/:canonicalSchemaId`, `GET /review`, and the new `GET /tab-stats` to avoid capturing those paths as mappingId.

### Task 3: Add GET /mappings/tab-stats

Add BEFORE `GET /:mappingId` (static route must come first):

```typescript
router.get('/tab-stats', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const { knowledgeBaseId } = req.query;

  if (!knowledgeBaseId) {
    return res
      .status(400)
      .json({ error: { code: 'MISSING_PARAM', message: 'knowledgeBaseId required' } });
  }

  // Get canonical schema for this knowledge base
  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId,
    tenantId,
    status: 'active',
  }).lean();
  if (!schema) {
    return res.json({ confirmedCount: 0, suggestedCount: 0, unmappedCount: 0, totalFields: 0 });
  }

  // Count mappings by status
  const [confirmedCount, suggestedCount] = await Promise.all([
    FieldMapping.countDocuments({ canonicalSchemaId: schema._id, tenantId, status: 'active' }),
    FieldMapping.countDocuments({ canonicalSchemaId: schema._id, tenantId, status: 'suggested' }),
  ]);

  // Count unmapped: sum of discovered fields minus mapped fields across all connectors
  const discoveredSchemas = await DiscoveredSchema.find({ knowledgeBaseId, tenantId }).lean();
  let totalDiscoveredFields = 0;
  let mappedFieldCount = 0;

  for (const ds of discoveredSchemas) {
    totalDiscoveredFields += ds.fields?.length ?? 0;
    const mappedForConnector = await FieldMapping.countDocuments({
      canonicalSchemaId: schema._id,
      connectorId: ds.connectorId,
      tenantId,
    });
    mappedFieldCount += mappedForConnector;
  }

  const unmappedCount = Math.max(0, totalDiscoveredFields - mappedFieldCount);

  res.json({
    confirmedCount,
    suggestedCount,
    unmappedCount,
    totalFields: totalDiscoveredFields,
  });
});
```

### Task 4: Write tests for tab-stats endpoint

Test file: `apps/search-ai/src/routes/__tests__/mappings-tab-stats.test.ts`

Tests:

- Returns correct counts when schema exists with mappings
- Returns zeros when no schema found
- Returns 400 when knowledgeBaseId missing
- Tenant isolation: returns 0 for different tenant's data
- Unmapped count correct: totalDiscoveredFields - mappedFields

## Previous Story Intelligence

- **`getLazyModel` is MANDATORY** in apps/search-ai — never import models directly from `@agent-platform/database/models` (Epic 1 retro)
- **Error format inconsistency exists** — older endpoints use `{ error: 'string' }`, newer use `{ error: { code, message } }`. Use the newer format for new endpoints. Don't change existing endpoints (breaking change).
- **Route order matters** — static routes (GET /tab-stats, GET /review, GET /stats/:id) must register BEFORE parameterized routes (GET /:mappingId)
- **Logger pattern**: `logger.error('message', { error: error instanceof Error ? error.message : String(error) })`
- **Pagination pattern** from documents.ts: `{ items, total, pagination: { skip, limit, hasMore } }`

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/search-ai
pnpm vitest run apps/search-ai/src/routes/__tests__/mappings-tab-stats.test.ts
npx prettier --write <changed files>
```
