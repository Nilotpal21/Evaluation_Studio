# Tenant Isolation - Multi-Tenant Security

**Platform Principle #1:** Tenant Isolation
**Status:** ✅ Enforced
**Last Audit:** 2026-02-23

---

## Overview

Tenant isolation is the **highest-priority security concern** in the ATLAS platform. Every data path — read, write, query, cache, event — must be scoped to a tenant. **No cross-tenant data leakage is acceptable**, even in error paths, logs, or cache keys.

**Why This Matters:**

- **Data Privacy:** Tenant A must never see Tenant B's data
- **Compliance:** GDPR, HIPAA, SOC 2 require strict data isolation
- **Security:** Prevents unauthorized access via ID guessing or leakage
- **Trust:** Customers trust us to keep their data separate

---

## Core Principle

> **"DB-level tenant filtering, not application-level"**

**ALWAYS:**

```typescript
// ✅ CORRECT: Tenant filter at DB query level
const chunk = await SearchChunk.findOne({
  _id: chunkId,
  tenantId,
  indexId,
});
```

**NEVER:**

```typescript
// ❌ WRONG: Post-hoc application-level check
const chunk = await SearchChunk.findById(chunkId);
if (chunk.tenantId !== tenantId) {
  throw new Error('Unauthorized');
}
```

**Why?**

- Post-hoc checks create **timing side-channels**
- Attacker can distinguish "exists but wrong tenant" from "doesn't exist"
- Response timing reveals data presence across tenants
- DB-level filtering prevents this attack

---

## Multi-Tenant Data Model

### Data Hierarchy

```
Tenant (Organization)
  │
  ├─ Index 1 (Project/Environment)
  │    │
  │    ├─ Document 1
  │    │    ├─ Chunk 1
  │    │    ├─ Chunk 2
  │    │    └─ Chunk 3
  │    │
  │    └─ Document 2
  │         └─ Chunk 4
  │
  └─ Index 2 (Another Project)
       │
       └─ Document 3
            └─ Chunk 5
```

**Isolation Levels:**

1. **Tenant-level:** Complete isolation between tenants
2. **Index-level:** Within a tenant, indexes are isolated (project/environment separation)
3. **Document-level:** Within an index, documents are isolated (but queryable together)

**Storage Model:**

Every `SearchChunk` includes:

```typescript
{
  _id: ObjectId('...'),      // Unique chunk ID
  tenantId: string,          // Tenant identifier
  indexId: string,           // Index identifier
  documentId: string,        // Document identifier
  content: string,           // Chunk content
  embedding: number[],       // Vector embedding
  // ... other fields
}
```

---

## Secure Patterns

### ✅ Pattern 1: Always Include Tenant Filters

**MongoDB:**

```typescript
// Single chunk lookup
const chunk = await SearchChunk.findOne({
  _id: chunkId,
  tenantId,
  indexId,
});

// Multiple chunks
const chunks = await SearchChunk.find({
  _id: { $in: chunkIds },
  tenantId,
  indexId,
}).sort({ chunkIndex: 1 });

// Document chunks
const chunks = await SearchChunk.find({
  documentId,
  tenantId,
  indexId,
}).sort({ chunkIndex: 1 });
```

**ClickHouse:**

```sql
-- Single table query
SELECT * FROM structured_data
WHERE tenant_id = ?
  AND index_id = ?
  AND table_id = ?;

-- Cross-table JOIN
SELECT o.*, u.name
FROM structured_data o
INNER JOIN structured_data u ON
  JSON_EXTRACT(o.row_data, '$.user_id') = JSON_EXTRACT(u.row_data, '$.id')
WHERE o.tenant_id = ?      -- ✅ Tenant filter
  AND o.index_id = ?       -- ✅ Index filter
  AND u.tenant_id = ?      -- ✅ Tenant filter on joined table
  AND u.index_id = ?       -- ✅ Index filter on joined table
  AND o.table_id = 'orders'
  AND u.table_id = 'users';
```

**Redis:**

```typescript
// Prefix all keys with tenant ID
const key = `analysis:${tenantId}:${analysisId}`;
await redis.set(key, data, 'EX', 3600);

// Retrieve with tenant scope
const data = await redis.get(`analysis:${tenantId}:${analysisId}`);
```

---

### ✅ Pattern 2: Use Tenant-Scoped Methods

**Create:**

```typescript
const chunk = await SearchChunk.create({
  tenantId, // ✅ Always include
  indexId, // ✅ Always include
  documentId,
  chunkIndex: 0,
  content: '...',
  status: ChunkStatus.PENDING,
});
```

**Update:**

```typescript
// ✅ CORRECT: Filter by _id AND tenant
await SearchChunk.findOneAndUpdate(
  { _id: chunkId, tenantId, indexId },
  { $set: { status: ChunkStatus.COMPLETED } },
);

// ❌ WRONG: No tenant filter
await SearchChunk.findByIdAndUpdate(chunkId, { $set: { status: ChunkStatus.COMPLETED } });
```

**Delete:**

```typescript
// ✅ CORRECT: Filter by _id AND tenant
await SearchChunk.findOneAndDelete({
  _id: chunkId,
  tenantId,
  indexId,
});

// ❌ WRONG: No tenant filter
await SearchChunk.findByIdAndDelete(chunkId);
```

---

### ✅ Pattern 3: Tenant Context Enforcement in Workers

**Worker Setup:**

```typescript
async function processJob(job: Job<JobData>) {
  const { tenantId, indexId, ...data } = job.data;

  // Enforce tenant context for entire job
  await withTenantContext({ tenantId }, async () => {
    try {
      // All DB queries within this context automatically scoped
      // (if using mongoose plugins)

      // Verify index exists and belongs to tenant
      const index = await SearchIndex.findOne({
        _id: indexId,
        tenantId,
      }).lean();

      if (!index) {
        throw new Error(`Index ${indexId} not found for tenant ${tenantId}`);
      }

      // Process job...
      await processData(data, tenantId, indexId);
    } catch (error) {
      workerError('worker-name', 'Job failed', error);
      throw error;
    }
  });
}
```

---

### ✅ Pattern 4: API Route Tenant Resolution

**Middleware:**

```typescript
import { requireAuth } from '@agent-platform/shared/auth';

router.get('/api/:indexId/documents', requireAuth(), async (req, res) => {
  // Tenant context automatically set by requireAuth middleware
  const { tenantId } = req.tenantContext;
  const { indexId } = req.params;

  // Verify user has access to this index
  const index = await SearchIndex.findOne({
    _id: indexId,
    tenantId,
  });

  if (!index) {
    return res.status(404).json({ error: 'Index not found' });
  }

  // Query documents with tenant filter
  const documents = await SearchDocument.find({
    indexId,
    tenantId,
  }).sort({ createdAt: -1 });

  res.json({ documents });
});
```

---

## Anti-Patterns (Security Violations)

### ❌ Anti-Pattern 1: findById Without Tenant Check

**Problem:**

```typescript
// ❌ SECURITY VIOLATION
const chunk = await SearchChunk.findById(chunkId);
```

**Why It's Dangerous:**

- No tenant filter
- If attacker guesses or leaks `chunkId`, they can access any tenant's data
- Timing side-channel reveals data existence across tenants

**Fix:**

```typescript
// ✅ SECURE
const chunk = await SearchChunk.findOne({
  _id: chunkId,
  tenantId,
  indexId,
});

if (!chunk) {
  return res.status(404).json({ error: 'Chunk not found' });
}
```

---

### ❌ Anti-Pattern 2: Post-Hoc Tenant Validation

**Problem:**

```typescript
// ❌ SECURITY VIOLATION (timing side-channel)
const chunk = await SearchChunk.findById(chunkId);

if (!chunk) {
  return res.status(404).json({ error: 'Not found' });
}

if (chunk.tenantId !== tenantId) {
  return res.status(403).json({ error: 'Unauthorized' });
}
```

**Timing Attack:**

```
Request for Tenant A's chunk from Tenant B:
  1. Query DB: 50ms
  2. Check fails: 1ms
  Total: 51ms → Attacker knows chunk EXISTS

Request for non-existent chunk:
  1. Query DB: 50ms (no result)
  Total: 50ms → Attacker knows chunk DOESN'T EXIST

→ Timing difference reveals data existence across tenants
```

**Fix:**

```typescript
// ✅ SECURE (consistent timing, no leak)
const chunk = await SearchChunk.findOne({
  _id: chunkId,
  tenantId,
  indexId,
});

if (!chunk) {
  // Same response for "wrong tenant" and "doesn't exist"
  return res.status(404).json({ error: 'Chunk not found' });
}
```

---

### ❌ Anti-Pattern 3: Missing Tenant Filter in Queries

**Problem:**

```typescript
// ❌ SECURITY VIOLATION
const chunks = await SearchChunk.find({
  documentId,
});
```

**Why It's Dangerous:**

- If `documentId` is leaked or guessed, returns chunks from any tenant
- No tenant boundary enforcement

**Fix:**

```typescript
// ✅ SECURE
const chunks = await SearchChunk.find({
  documentId,
  tenantId,
  indexId,
});
```

---

### ❌ Anti-Pattern 4: Tenant-Agnostic Cache Keys

**Problem:**

```typescript
// ❌ SECURITY VIOLATION
const key = `chunk:${chunkId}`;
await redis.set(key, JSON.stringify(chunk));

// Later, different tenant requests same chunkId:
const cachedChunk = await redis.get(`chunk:${chunkId}`);
// Returns Tenant A's data to Tenant B!
```

**Fix:**

```typescript
// ✅ SECURE
const key = `chunk:${tenantId}:${indexId}:${chunkId}`;
await redis.set(key, JSON.stringify(chunk), 'EX', 3600);

// Retrieval always scoped to tenant
const cachedChunk = await redis.get(`chunk:${tenantId}:${indexId}:${chunkId}`);
```

---

### ❌ Anti-Pattern 5: Cross-Tenant Aggregations

**Problem:**

```typescript
// ❌ SECURITY VIOLATION (leaks stats across tenants)
const stats = await SearchChunk.aggregate([
  { $match: { indexId } }, // Missing tenantId!
  { $group: { _id: '$status', count: { $sum: 1 } } },
]);
```

**Fix:**

```typescript
// ✅ SECURE
const stats = await SearchChunk.aggregate([
  { $match: { tenantId, indexId } }, // ✅ Tenant filter
  { $group: { _id: '$status', count: { $sum: 1 } } },
]);
```

---

## Testing Tenant Isolation

### Unit Test Pattern

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SearchChunk } from '../models/SearchChunk';

describe('Tenant Isolation - SearchChunk Queries', () => {
  const TENANT_A = 'tenant-a';
  const TENANT_B = 'tenant-b';
  const INDEX_A = 'index-a';
  const INDEX_B = 'index-b';

  let chunkA: any;
  let chunkB: any;

  beforeEach(async () => {
    // Create chunk for Tenant A
    chunkA = await SearchChunk.create({
      tenantId: TENANT_A,
      indexId: INDEX_A,
      documentId: 'doc-a',
      chunkIndex: 0,
      content: 'Tenant A data',
    });

    // Create chunk for Tenant B
    chunkB = await SearchChunk.create({
      tenantId: TENANT_B,
      indexId: INDEX_B,
      documentId: 'doc-b',
      chunkIndex: 0,
      content: 'Tenant B data',
    });
  });

  it('should NOT return chunk from different tenant', async () => {
    // Tenant B tries to access Tenant A's chunk
    const result = await SearchChunk.findOne({
      _id: chunkA._id,
      tenantId: TENANT_B, // Wrong tenant
      indexId: INDEX_B,
    });

    expect(result).toBeNull(); // Should return null, not throw
  });

  it('should NOT return chunk from different index (same tenant)', async () => {
    // Tenant A, Index B tries to access Tenant A, Index A's chunk
    const result = await SearchChunk.findOne({
      _id: chunkA._id,
      tenantId: TENANT_A, // Correct tenant
      indexId: INDEX_B, // Wrong index
    });

    expect(result).toBeNull();
  });

  it('should return chunk for correct tenant and index', async () => {
    const result = await SearchChunk.findOne({
      _id: chunkA._id,
      tenantId: TENANT_A,
      indexId: INDEX_A,
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe('Tenant A data');
  });

  it('should NOT leak chunks in find() queries', async () => {
    // Query without tenant filter should not work
    const chunks = await SearchChunk.find({
      tenantId: TENANT_A,
      indexId: INDEX_A,
      documentId: 'doc-a',
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Tenant A data');

    // Should NOT include Tenant B's chunks
    expect(chunks).not.toContainEqual(expect.objectContaining({ content: 'Tenant B data' }));
  });
});
```

---

### Integration Test Pattern

```typescript
describe('API Tenant Isolation', () => {
  it('should return 404 for cross-tenant chunk access', async () => {
    // Create chunk for Tenant A
    const chunkA = await createChunk({
      tenantId: 'tenant-a',
      indexId: 'index-a',
    });

    // Tenant B tries to access it
    const response = await request(app)
      .get(`/api/index-b/chunks/${chunkA._id}`)
      .set('Authorization', `Bearer ${tenantBToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Chunk not found');
  });

  it('should return 200 for same-tenant chunk access', async () => {
    const chunkA = await createChunk({
      tenantId: 'tenant-a',
      indexId: 'index-a',
    });

    const response = await request(app)
      .get(`/api/index-a/chunks/${chunkA._id}`)
      .set('Authorization', `Bearer ${tenantAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.chunk._id).toBe(String(chunkA._id));
  });
});
```

---

## Audit Checklist

When adding new features or modifying existing code, verify:

### Queries

- [ ] All `SearchChunk.find()` queries include `tenantId` and `indexId`
- [ ] All `SearchChunk.findOne()` queries include `tenantId` and `indexId`
- [ ] No use of `SearchChunk.findById()` (use `findOne` with filters instead)
- [ ] No use of `SearchChunk.findByIdAndUpdate()` (use `findOneAndUpdate` instead)
- [ ] No use of `SearchChunk.findByIdAndDelete()` (use `findOneAndDelete` instead)
- [ ] All ClickHouse queries include `WHERE tenant_id = ? AND index_id = ?`
- [ ] All Redis keys prefixed with `{tenantId}:{indexId}:`

### Workers

- [ ] Job data includes `tenantId` and `indexId`
- [ ] Worker validates index belongs to tenant before processing
- [ ] All DB operations within worker use tenant filters
- [ ] Errors logged with tenant context (but never log tenant data)

### API Routes

- [ ] All routes use `requireAuth()` middleware
- [ ] Route params validated against tenant context
- [ ] 404 returned for cross-tenant access (not 403)
- [ ] No tenant data in error messages

### Cache

- [ ] Cache keys include tenant ID and index ID
- [ ] Cache entries have TTL (no indefinite caching)
- [ ] Cache invalidation scoped to tenant

---

## Recent Audit Findings (2026-02-23)

**Scope:** All SearchChunk operations across all workers

**Found:** 8 critical security violations
**Fixed:** All 8 violations corrected
**Status:** ✅ All workers now secure

**Violations Fixed:**

| File                                   | Line | Issue                         | Fix                               |
| -------------------------------------- | ---- | ----------------------------- | --------------------------------- |
| `document-visual-enrichment-worker.ts` | 61   | Missing `tenantId`, `indexId` | Added filters                     |
| `visual-enrichment-worker.ts`          | 111  | `findById` without tenant     | Changed to `findOne` with filters |
| `visual-enrichment-worker.ts`          | 133  | Missing `tenantId`, `indexId` | Added filters                     |
| `visual-enrichment-worker.ts`          | 331  | Missing `tenantId`, `indexId` | Added filters                     |
| `embedding-worker.ts`                  | 120  | Missing `tenantId`            | Added filter                      |
| `enrichment-worker.ts`                 | 61   | Missing `tenantId`            | Added filter                      |
| `multimodal-worker.ts`                 | 76   | Missing `tenantId`            | Added filter                      |
| `knowledge-graph-worker.ts`            | 69   | Missing `tenantId`            | Added filter                      |

**Verified Secure:**

- ✅ `structured-data-ingestion-worker.ts`
- ✅ `page-processing-worker.ts`
- ✅ `canonical-mapper-worker.ts`
- ✅ `question-synthesis-worker.ts`
- ✅ All API routes

**Full Audit Report:** [tenant-isolation-audit-final.md](../tenant-isolation-audit-final.md)

---

## Recommendations

### For Developers

1. **Always start with tenant context**
   - Extract `tenantId` and `indexId` first
   - Pass them to all function calls
   - Never omit tenant filters

2. **Never use `findById`-style methods**
   - Use `findOne({ _id, tenantId, indexId })` instead
   - Same for `findByIdAndUpdate`, `findByIdAndDelete`

3. **Test tenant isolation explicitly**
   - Add multi-tenant tests for every data access path
   - Verify cross-tenant queries return empty/404

4. **Review diffs for tenant filters**
   - When reviewing PRs, check all DB queries
   - Verify tenant/index filters present

### For Security Team

1. **Regular audits**
   - Quarterly audit of all DB queries
   - Automated linting rules for tenant filters
   - grep for `findById`, `findByIdAndUpdate`, `findByIdAndDelete`

2. **Automated testing**
   - Add CI check for tenant isolation tests
   - Fail build if tenant tests missing for new endpoints

3. **Monitoring**
   - Log all DB queries with tenant context
   - Alert on queries without tenant filters
   - Monitor for unusual cross-tenant patterns

### For Future Improvements

1. **Mongoose Plugin**
   - Auto-inject tenant filters on all queries
   - Fail loudly if tenant context missing
   - Require opt-out for non-tenant queries

2. **ESLint Rule**
   - Detect `findById` usage
   - Require `tenantId` in all `.find()` calls
   - Enforce cache key prefixing

3. **Type Safety**
   - TypeScript types require tenant context
   - Compile-time errors for missing filters

---

## Related Documentation

- [Architecture Overview](./10-architecture-overview.md) - System architecture
- [Audit Report](../tenant-isolation-audit-final.md) - Full audit findings
- [CLAUDE.md](../../CLAUDE.md) - Platform principles

---

## Summary

**Tenant isolation is non-negotiable.**

- ✅ Always filter by `tenantId` and `indexId` at the database level
- ✅ Never use `findById` without tenant filters
- ✅ Test cross-tenant access explicitly
- ✅ Return 404 for cross-tenant access (not 403)
- ✅ Prefix all cache keys with tenant ID
- ✅ Audit regularly

**Any violation of tenant isolation is a critical security bug and must be fixed immediately.**

---

**Next:** [Retrieval Checklist](./20-retrieval-checklist.md) →
