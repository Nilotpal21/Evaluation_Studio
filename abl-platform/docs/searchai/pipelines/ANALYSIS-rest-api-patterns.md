# REST API Patterns and CRUD Conventions Analysis

**Task:** Pre-Check #60 - Explore existing REST API patterns and CRUD conventions
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

SearchAI uses **Express.js** with centralized auth middleware, Zod validation, and consistent REST patterns. All APIs follow resource-based routing with tenant isolation. This analysis documents patterns for implementing pipeline CRUD APIs.

**Key Finding:** Strong conventions established - tenant isolation mandatory, Zod validation, structured error responses, permission guards available but not yet enforced.

---

## 1. Express Server Setup

**Location:** `apps/search-ai/src/server.ts`

### Middleware Stack (in order)

```typescript
// 1. Security
app.use(helmet(helmetConfig));

// 2. CORS
app.use(cors(corsOptions));

// 3. Compression (threshold: 1KB)
app.use(compression({ threshold: 1024 }));

// 4. Body parsing (50mb limit for file uploads)
app.use(express.json({ limit: '50mb' }));

// 5. Request correlation ID
app.use(requestIdMiddleware());

// 6. Health checks (no auth)
app.use('/health', healthRouter);

// 7. Dev auth bypass (DEV_BYPASS_AUTH=true)
if (process.env.NODE_ENV === 'development' && process.env.DEV_BYPASS_AUTH === 'true') {
  app.use(devAuthBypass);
}

// 8. Authentication (ALL /api routes)
app.use('/api', authMiddleware);

// 9. Per-tenant rate limiting (after auth)
app.use('/api', searchAiRateLimit());

// 10. Routes
app.use('/api/indexes', indexesRouter);
app.use('/api/indexes', sourcesRouter);
// ... etc
```

**Pattern:** Health checks public, all `/api` routes require auth + rate limiting.

---

## 2. Route Registration Patterns

### Resource-Based Routing

```typescript
// Index resources
app.use('/api/indexes', indexesRouter);

// Nested resources (sources under indexes)
app.use('/api/indexes', sourcesRouter); // Routes: /:indexId/sources

// Nested resources (documents under indexes)
app.use('/api/indexes', documentsRouter); // Routes: /:indexId/documents

// Admin routes
app.use('/api/admin', adminRouter);

// Crawler routes
app.use('/api/crawl', crawlRouter);
app.use('/api/crawl', crawlHistoryRouter);
```

**Pattern:**

- Flat resources: `/api/{resource}`
- Nested resources: `/api/{parent}/{parentId}/{child}`
- Multiple routers can share a prefix (e.g., `/api/indexes`)

---

## 3. Authentication Pattern

**Location:** `apps/search-ai/src/middleware/auth.ts`

### Unified Auth Middleware

```typescript
import { createUnifiedAuthMiddleware, requireAuth } from '@agent-platform/shared';

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwt.secret,

  logger: {
    info: (msg, meta) => console.log(`[auth] ${msg}`, meta || ''),
    warn: (msg, meta) => console.warn(`[auth] ${msg}`, meta || ''),
    error: (msg, meta) => console.error(`[auth] ${msg}`, meta || ''),
  },

  onAuthEvent: (_event: AuthEvent) => {
    // Fire-and-forget audit logging
  },

  isSuperAdmin: (_userId: string): boolean => {
    return false;
  },

  getUserById: async (id: string): Promise<AuthUser | null> => {
    // FIXME: Trust JWT sub claim without database verification
    return {
      id,
      email: id.includes('@') ? id : `${id}@verified.local`,
      name: id,
    };
  },

  resolveTenantMembership: async (userId, tenantId) => {
    // FIXME: Trust JWT tenantId claim without database verification
    // Returns admin role to all authenticated users - proper RBAC needed
    return { role: 'admin', customRoleId: null };
  },

  resolveDefaultTenant: async (userId) => {
    // FIXME: Return null to force JWT to include tenantId claim
    return null;
  },

  resolvePermissions: async (_tenantId, _userId, _role, _customRoleId) => {
    // Return all permissions in dev/test; wire up RBAC in production
    return ['*'];
  },

  resolveApiKey: async (rawKey) => {
    // API key support (abl_* prefix)
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await ApiKey.findOne({ keyHash, revokedAt: null }).lean();
    if (!apiKey) return null;
    return {
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey._id,
      clientId: apiKey.clientId,
      createdBy: apiKey.createdBy,
      scopes: apiKey.scopes || [],
      projectIds: apiKey.projectIds || [],
      environments: apiKey.environments || [],
    };
  },
});

/**
 * Auth middleware that REQUIRES authentication.
 */
const _requireAuth = requireAuth();
export const authMiddleware: RequestHandler = (req, res, next) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    _requireAuth(req, res, next);
  });
};
```

**Auth Flows Supported:**

1. **User JWT** — `Authorization: Bearer <jwt>`
2. **API Key** — `Authorization: Bearer abl_*`
3. **SDK Session** — `X-SDK-Token: <token>` (if configured)

**Tenant Context:**

After auth, `req.tenantContext` is populated:

```typescript
interface TenantContextData {
  tenantId: string;
  userId: string;
  role: string;
  permissions: string[];
  authType: 'user' | 'sdk_session' | 'api_key';
  customRoleId?: string | null;
  orgId?: string;
  // For API keys:
  apiKeyId?: string;
  clientId?: string;
  projectScope?: string[]; // Allowed project IDs
  environmentScope?: string[]; // Allowed environments
}
```

**IMPORTANT NOTE:** Current implementation in search-ai has FIXME comments:

- Trusts JWT claims without database verification (temporary)
- Returns `admin` role to all users (proper RBAC needed)
- Dual-database challenge: `search-ai` connects to `search_ai` DB, but `TenantMember`/`User` tables are in `abl_platform` DB

**Recommendation:** JWT-only trust pattern acceptable for internal APIs (Studio as auth gateway).

---

## 4. Permission Guard Middleware

**Location:** `packages/shared/src/middleware/permission-guard.ts`

**Available (but not yet used in search-ai routes):**

```typescript
import {
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
} from '@agent-platform/shared';

// Require single permission
router.post('/pipelines', requirePermission('pipeline:create'), handler);

// Require all permissions
router.delete(
  '/pipelines/:id',
  requireAllPermissions(['pipeline:delete', 'pipeline:read']),
  handler,
);

// Require any permission
router.get('/admin/stats', requireAnyPermission(['admin:read', 'pipeline:list']), handler);
```

**Pattern:** Middleware checks `req.tenantContext.permissions` array.

**Current Search-AI:** Permissions not enforced (all users get `['*']` in dev mode).

---

## 5. Tenant Isolation Pattern

**CRITICAL:** ALL database queries MUST include `tenantId` filter.

### Example: indexes.ts

```typescript
router.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const filter: Record<string, unknown> = { tenantId };

  const indexes = await SearchIndex.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ indexes, total: indexes.length });
});

router.get('/:indexId', async (req: Request, res: Response) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
  if (!index) {
    res.status(404).json({ error: 'Index not found' });
    return;
  }
  // ...
});
```

**Pattern:**

1. Extract `tenantId` from `req.tenantContext!.tenantId`
2. Add to ALL Mongoose queries: `findOne({ _id, tenantId })`
3. **NEVER use** `findById()` (no tenant filter)
4. Return **404** for unauthorized access (not 403 - prevents existence leak)

### Nested Resource Verification

**Example: sources.ts**

```typescript
router.get('/:indexId/sources', async (req: Request, res: Response) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  // 1. Verify parent resource (index) belongs to tenant
  const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
  if (!index) {
    res.status(404).json({ error: 'Index not found' });
    return;
  }

  // 2. Query child resources
  const sources = await SearchSource.find({ indexId, tenantId }).sort({ createdAt: -1 }).lean();

  res.json({ sources, total: sources.length });
});
```

**Pattern:** Always verify parent resource ownership BEFORE querying children.

---

## 6. CRUD Patterns

### Standard CRUD Routes

| HTTP Method | Route                | Purpose           | Status Code |
| ----------- | -------------------- | ----------------- | ----------- |
| GET         | `/`                  | List all          | 200         |
| GET         | `/:id`               | Get single        | 200, 404    |
| POST        | `/`                  | Create new        | 201         |
| PATCH       | `/:id`               | Update existing   | 200, 404    |
| DELETE      | `/:id`               | Delete            | 204, 404    |
| POST        | `/:id/action`        | Trigger action    | 200         |
| GET         | `/:id/nested`        | Get nested        | 200, 404    |
| POST        | `/:id/nested`        | Create nested     | 201, 404    |
| DELETE      | `/:id/nested/:subId` | Delete nested     | 204, 404    |
| GET         | `/stats`             | Aggregate stats   | 200         |
| GET         | `/config`            | Get configuration | 200         |
| PATCH       | `/config`            | Update config     | 200         |

### List (GET /)

**Example: indexes.ts**

```typescript
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId, status } = req.query;

    const tenantId = req.tenantContext!.tenantId;
    const filter: Record<string, unknown> = { tenantId };
    if (projectId) filter.projectId = projectId;
    if (status) filter.status = status;

    const indexes = await SearchIndex.find(filter).sort({ createdAt: -1 }).lean();

    res.json({ indexes, total: indexes.length });
  } catch (error) {
    console.error('[indexes] Failed to list indexes:', error);
    res.status(500).json({ error: 'Failed to list indexes' });
  }
});
```

**Pattern:**

- Extract query params for filtering
- Always include `tenantId` in filter
- Sort by `createdAt: -1` (newest first)
- Use `.lean()` for performance (returns POJOs, not Mongoose documents)
- Response: `{ resources, total }`

### Get Single (GET /:id)

**Example: indexes.ts**

```typescript
router.get('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();

    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Optionally fetch related data
    let resolvedLLMConfig = null;
    try {
      resolvedLLMConfig = await resolveIndexLLMConfig(index.tenantId, indexId);
    } catch (error) {
      console.warn('[indexes] Failed to resolve LLM config:', error);
      // Non-fatal - return index without resolved config
    }

    res.json({
      index,
      resolvedLLMConfig, // Optional enriched data
    });
  } catch (error) {
    console.error('[indexes] Failed to get index:', error);
    res.status(500).json({ error: 'Failed to get index' });
  }
});
```

**Pattern:**

- `findOne({ _id, tenantId })` with tenant isolation
- Return 404 if not found (not 403 - prevents existence leak)
- Optionally enrich response with related data
- Non-fatal errors: log warning and continue

### Create (POST /)

**Example: indexes.ts**

```typescript
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    // 1. Validate request body with Zod
    const validation = CreateIndexSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    const {
      projectId,
      slug,
      name,
      description,
      embeddingModel,
      embeddingDimensions,
      vectorStore,
      searchDefaults,
    } = validation.data;

    // 2. Check for duplicates
    const existing = await SearchIndex.findOne({ tenantId, projectId, slug }).lean();
    if (existing) {
      res.status(409).json({ error: `Index with slug "${slug}" already exists in this project` });
      return;
    }

    // 3. Apply defaults
    const finalEmbeddingModel = embeddingModel || 'text-embedding-3-small';
    const finalEmbeddingDimensions = embeddingDimensions || 1536;

    // 4. Custom validation
    const dimensionValidation = validateEmbeddingDimensions(
      finalEmbeddingModel,
      finalEmbeddingDimensions,
    );
    if (!dimensionValidation.valid) {
      res.status(400).json({ error: dimensionValidation.error });
      return;
    }

    // 5. Create resource
    const index = await SearchIndex.create({
      tenantId,
      projectId,
      slug,
      name,
      description: description || null,
      embeddingModel: finalEmbeddingModel,
      embeddingDimensions: finalEmbeddingDimensions,
      vectorStore: vectorStore || { provider: 'qdrant', collectionName: slug },
      searchDefaults: searchDefaults || {
        topK: 10,
        similarityThreshold: 0.7,
        includeMetadata: true,
        includeContent: true,
      },
      status: 'creating',
    });

    res.status(201).json({ index });
  } catch (error) {
    console.error('[indexes] Failed to create index:', error);
    res.status(500).json({ error: 'Failed to create index' });
  }
});
```

**Pattern:**

1. Check `req.tenantContext` exists (401 if missing)
2. Validate request body with Zod schema (400 with details if invalid)
3. Check for duplicates (409 if exists)
4. Apply defaults for optional fields
5. Run custom validation logic (400 if fails)
6. Create resource with `Model.create()`
7. Return 201 with created resource

### Update (PATCH /:id)

**Example: indexes.ts**

```typescript
router.patch('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // 1. Validate request body
    const validation = UpdateIndexSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    const updates = validation.data;

    // 2. Update with tenant isolation
    const index = await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      { $set: updates },
      { new: true, runValidators: true }, // Return updated doc, run Mongoose validators
    ).lean();

    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    res.json({ index });
  } catch (error) {
    console.error('[indexes] Failed to update index:', error);
    res.status(500).json({ error: 'Failed to update index' });
  }
});
```

**Pattern:**

1. Validate request body (partial updates allowed)
2. Use `findOneAndUpdate({ _id, tenantId }, { $set: updates }, { new: true, runValidators: true })`
3. Return 404 if not found
4. Return 200 with updated resource

### Delete (DELETE /:id)

**Example: indexes.ts**

```typescript
router.delete('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const index = await SearchIndex.findOneAndDelete({ _id: indexId, tenantId }).lean();

    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    res.json({ deleted: true, indexId });
  } catch (error) {
    console.error('[indexes] Failed to delete index:', error);
    res.status(500).json({ error: 'Failed to delete index' });
  }
});
```

**Pattern:**

- Use `findOneAndDelete({ _id, tenantId })`
- Return 404 if not found
- Return `{ deleted: true, id }` (some routes return 204 with no body)

**Cascade Delete Pattern (documents.ts):**

```typescript
router.delete('/:indexId/documents/:documentId', async (req: Request, res: Response) => {
  try {
    const { indexId, documentId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // 1. Verify parent resource ownership
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // 2. Verify document exists
    const document = await SearchDocument.findOne({ _id: documentId, indexId, tenantId }).lean();
    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    // 3. Delete related resources (best-effort external cleanup)
    const chunks = await SearchChunk.find({ documentId, tenantId }).select('_id').lean();
    const chunkIds = chunks.map((c) => String(c._id));

    if (chunkIds.length > 0) {
      try {
        await vectorStore.delete(vsIndexName, chunkIds); // External cleanup
      } catch (err) {
        console.warn('[documents] Vector store cleanup failed (continuing):', err);
      }
    }

    // 4. Cascade delete (MongoDB)
    await SearchChunk.deleteMany({ documentId, tenantId });
    await SearchDocument.deleteOne({ _id: documentId, tenantId });

    // 5. Update parent counters
    await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      { $inc: { documentCount: -1, chunkCount: -chunkCount } },
    );

    res.status(204).send();
  } catch (error) {
    console.error('[documents] Failed to delete document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});
```

**Cascade Delete Pattern:**

1. Verify parent ownership
2. Verify resource exists
3. Clean up external systems (best-effort, log failures)
4. Delete child resources in MongoDB
5. Delete main resource
6. Update parent counters

### Action Routes (POST /:id/action)

**Example: indexes.ts**

```typescript
router.post('/:indexId/rebuild', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Update status
    await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      { $set: { status: 'rebuilding', indexError: null } },
    );

    // TODO: Enqueue rebuild job via BullMQ

    res.json({
      message: 'Rebuild initiated',
      indexId,
      status: 'rebuilding',
    });
  } catch (error) {
    console.error('[indexes] Failed to trigger rebuild:', error);
    res.status(500).json({ error: 'Failed to trigger rebuild' });
  }
});
```

**Pattern:**

- Use POST (not PUT/PATCH) for actions
- Verify resource exists
- Update resource status
- Enqueue background job if needed
- Return success message with metadata

### Nested Resource Routes

**Example: sources.ts**

```typescript
// Create nested resource
router.post('/:indexId/sources', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { name, sourceType, sourceConfig, extractionConfig, enrichmentConfig, syncSchedule } =
      req.body;

    // Verify parent exists
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    if (!name || !sourceType) {
      res.status(400).json({ error: 'name and sourceType are required' });
      return;
    }

    const source = await SearchSource.create({
      tenantId,
      indexId,
      name,
      sourceType,
      sourceConfig: sourceConfig || null,
      extractionConfig: extractionConfig || null,
      enrichmentConfig: enrichmentConfig || null,
      syncSchedule: syncSchedule || null,
      status: 'pending',
    });

    // Update parent counter
    await SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $inc: { sourceCount: 1 } });

    res.status(201).json({ source });
  } catch (error) {
    console.error('[sources] Failed to add source:', error);
    res.status(500).json({ error: 'Failed to add source' });
  }
});

// Delete nested resource
router.delete('/:indexId/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const source = await SearchSource.findOneAndDelete({
      _id: sourceId,
      indexId,
      tenantId,
    }).lean();

    if (!source) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    // Update parent counter
    await SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $inc: { sourceCount: -1 } });

    res.json({ deleted: true, sourceId });
  } catch (error) {
    console.error('[sources] Failed to remove source:', error);
    res.status(500).json({ error: 'Failed to remove source' });
  }
});
```

**Pattern:**

- Always verify parent resource exists first
- Include both `parentId` and `tenantId` in nested resource queries
- Update parent counters on create/delete

---

## 7. Validation Pattern (Zod)

**Location:** `apps/search-ai/src/validation/index-schemas.ts`

### Zod Schema Definition

```typescript
import { z } from 'zod';

/**
 * Create Index Request Body Validation
 */
export const CreateIndexSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  slug: z
    .string()
    .min(1, 'slug is required')
    .max(50, 'slug cannot exceed 50 characters')
    .regex(/^[a-z0-9-]+$/, 'slug must only contain lowercase letters, numbers, and hyphens'),
  name: z.string().min(1, 'name is required').max(100, 'name cannot exceed 100 characters'),
  description: z
    .string()
    .max(500, 'description cannot exceed 500 characters')
    .optional()
    .nullable(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().optional(),
  vectorStore: VectorStoreSchema.optional(),
  searchDefaults: SearchDefaultsSchema.optional(),
});

/**
 * Update Index Request Body Validation
 */
export const UpdateIndexSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  searchDefaults: SearchDefaultsSchema.optional(),
  status: z.enum(['creating', 'active', 'indexing', 'error']).optional(),
});
```

### Nested Schema Pattern

```typescript
/**
 * Vector Store Validation
 */
export const VectorStoreSchema = z.object({
  provider: z.enum(['opensearch', 'qdrant', 'pinecone', 'pgvector', 'weaviate'], {
    errorMap: () => ({
      message: 'provider must be one of: opensearch, qdrant, pinecone, pgvector, weaviate',
    }),
  }),
  collectionName: z
    .string()
    .min(1, 'collectionName is required')
    .max(100, 'collectionName cannot exceed 100 characters')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'collectionName must only contain letters, numbers, hyphens, and underscores',
    ),
  connectionConfig: z.record(z.unknown()).optional(),
});

/**
 * Use in parent schema
 */
export const CreateIndexSchema = z.object({
  // ...
  vectorStore: VectorStoreSchema.optional(),
});
```

### Custom Validation Functions

```typescript
/**
 * Validate embedding dimensions match model capabilities
 */
export function validateEmbeddingDimensions(
  model: string,
  dimensions: number,
): { valid: boolean; error?: string } {
  const knownModels: Record<string, number[]> = {
    'text-embedding-3-small': [512, 1536],
    'text-embedding-3-large': [256, 1024, 3072],
    'text-embedding-ada-002': [1536],
  };

  const supportedDimensions = knownModels[model];
  if (!supportedDimensions) {
    // Unknown model, allow any valid dimension
    return { valid: true };
  }

  if (!supportedDimensions.includes(dimensions)) {
    return {
      valid: false,
      error: `Model "${model}" supports dimensions: ${supportedDimensions.join(', ')}. Got: ${dimensions}`,
    };
  }

  return { valid: true };
}
```

### Usage in Route Handler

```typescript
router.post('/', async (req: Request, res: Response) => {
  // 1. Validate request body
  const validation = CreateIndexSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: validation.error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message,
      })),
    });
    return;
  }

  const validatedData = validation.data;

  // 2. Run custom validation
  const dimensionValidation = validateEmbeddingDimensions(
    validatedData.embeddingModel,
    validatedData.embeddingDimensions,
  );
  if (!dimensionValidation.valid) {
    res.status(400).json({ error: dimensionValidation.error });
    return;
  }

  // 3. Proceed with creation
  // ...
});
```

**Pattern:**

1. Define Zod schema with `.min()`, `.max()`, `.regex()`, `.enum()`, `.optional()`, `.nullable()`
2. Use `.safeParse()` in handler (returns `{ success, data?, error? }`)
3. Return 400 with structured error details if validation fails
4. Use `validation.data` (fully typed) for downstream logic
5. Run custom validation functions for complex business rules

---

## 8. Error Response Pattern

### Standard Error Format

```typescript
// 400 Bad Request
res.status(400).json({
  error: 'Invalid request body',
  details: [
    { path: 'slug', message: 'slug must only contain lowercase letters, numbers, and hyphens' },
    { path: 'embeddingDimensions', message: 'embeddingDimensions must be at least 128' },
  ],
});

// 401 Unauthorized
res.status(401).json({ error: 'Tenant context required' });

// 403 Forbidden (permission denied)
res.status(403).json({
  error: 'Forbidden',
  required: 'pipeline:create',
  authType: 'user',
});

// 404 Not Found (resource doesn't exist OR unauthorized access)
res.status(404).json({ error: 'Index not found' });

// 409 Conflict (duplicate resource)
res.status(409).json({ error: `Index with slug "${slug}" already exists in this project` });

// 429 Rate Limit Exceeded
res.status(429).json({
  error: 'Rate limit exceeded',
  operation: 'request',
  limit: 120,
  retryAfterMs: 45000,
});

// 500 Internal Server Error
res.status(500).json({ error: 'Failed to create index' });

// 503 Service Unavailable
res.status(503).json({
  success: false,
  error: { code: 'CRAWL_QUEUE_UNAVAILABLE', message: 'Crawl queue is temporarily unavailable' },
});
```

**Pattern:**

- **400:** Validation errors (with `details` array for Zod errors)
- **401:** Authentication required (missing/invalid credentials)
- **403:** Permission denied (authenticated but insufficient permissions)
- **404:** Resource not found (includes unauthorized access to prevent existence leak)
- **409:** Duplicate resource (unique constraint violation)
- **429:** Rate limit exceeded (with `retryAfterMs`)
- **500:** Generic server error (log details server-side, return generic message)
- **503:** Service unavailable (external dependency failure)

### Detailed Error Format (errors.ts)

**Example: Error tracking API**

```typescript
router.get('/', async (req: Request, res: Response) => {
  try {
    // ... logic
    res.status(200).json({
      success: true,
      errors: [...],
      total: 10,
      limit: 100,
      offset: 0,
    });
  } catch (error) {
    console.error('[errors] Failed to query errors:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'ERROR_QUERY_FAILED',
        message: error instanceof Error ? error.message : 'Failed to query errors',
      },
    });
  }
});
```

**Pattern for complex APIs:**

```typescript
// Success response
res.status(200).json({
  success: true,
  data: { ... },
  metadata: { total, limit, offset }
});

// Error response
res.status(500).json({
  success: false,
  error: {
    code: 'ERROR_CODE',
    message: 'Human-readable message',
    details: [...] // Optional additional context
  }
});
```

---

## 9. Rate Limiting Pattern

**Location:** `apps/search-ai/src/middleware/rate-limit.ts`

### Per-Tenant Rate Limiting

```typescript
import { searchAiRateLimit } from './middleware/rate-limit.js';

// Apply to all /api routes
app.use('/api', searchAiRateLimit());

// Custom limits for specific routes
app.use('/api/heavy', searchAiRateLimit({ limit: 30, windowMs: 60_000 }));
```

**Default:** 120 requests/minute/tenant

**Implementation:**

- Redis-backed fixed-window rate limiting (atomic Lua script)
- Fallback to in-memory Map if Redis unavailable
- Scoped by `tenantId` (from `req.tenantContext`)

**Rate Limit Headers:**

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1678901234
```

**429 Response:**

```json
{
  "error": "Rate limit exceeded",
  "operation": "request",
  "limit": 120,
  "retryAfterMs": 45000
}
```

---

## 10. Pagination Pattern

**Location:** `apps/search-ai/src/routes/errors.ts`

```typescript
router.get('/', async (req: Request, res: Response) => {
  const { limit = '100', offset = '0' } = req.query;

  // Parse and validate pagination params
  const limitNum = Math.min(parseInt(limit as string, 10) || 100, 1000);
  const offsetNum = parseInt(offset as string, 10) || 0;

  // Query with pagination
  const [documents, total] = await Promise.all([
    SearchDocument.find(filter).sort({ updatedAt: -1 }).limit(limitNum).skip(offsetNum).lean(),
    SearchDocument.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    errors: documents,
    total,
    limit: limitNum,
    offset: offsetNum,
  });
});
```

**Pattern:**

- Query params: `limit` (default 100, max 1000), `offset` (default 0)
- Use `Promise.all()` to run query + count in parallel
- Response includes: `data, total, limit, offset`

**Alternative Cursor-Based Pagination (not yet used):**

```typescript
// Query param: cursor (last seen ID)
const cursor = req.query.cursor as string | undefined;
const filter = cursor ? { _id: { $gt: cursor }, ...otherFilters } : { ...otherFilters };

const documents = await SearchDocument.find(filter).sort({ _id: 1 }).limit(limitNum).lean();

res.json({
  documents,
  nextCursor: documents.length === limitNum ? documents[documents.length - 1]._id : null,
});
```

---

## 11. Query Filtering Pattern

**Example: indexes.ts**

```typescript
router.get('/', async (req: Request, res: Response) => {
  const { projectId, status } = req.query;

  const tenantId = req.tenantContext!.tenantId;
  const filter: Record<string, unknown> = { tenantId };

  if (projectId) filter.projectId = projectId;
  if (status) filter.status = status;

  const indexes = await SearchIndex.find(filter).sort({ createdAt: -1 }).lean();

  res.json({ indexes, total: indexes.length });
});
```

**Pattern:**

- Build filter object dynamically based on query params
- Always start with `{ tenantId }`
- Add optional filters conditionally

**Advanced Filtering (errors.ts):**

```typescript
const { indexId, since, until } = req.query;

const filter: any = {
  status: DocumentStatus.ERROR,
  processingError: { $ne: null },
};

if (indexId) {
  filter.indexId = indexId;
}

if (since || until) {
  filter.updatedAt = {};
  if (since) {
    filter.updatedAt.$gte = new Date(since as string);
  }
  if (until) {
    filter.updatedAt.$lte = new Date(until as string);
  }
}
```

**Pattern:** Build nested filters for date ranges, arrays, etc.

---

## 12. Aggregation Pattern

**Example: errors.ts - Stats endpoint**

```typescript
router.get('/stats', async (req: Request, res: Response) => {
  const { indexId, since, until } = req.query;

  // Build time window filter
  const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 86_400_000);
  const untilDate = until ? new Date(until as string) : new Date();

  const filter: any = {
    status: DocumentStatus.ERROR,
    processingError: { $ne: null },
    updatedAt: { $gte: sinceDate, $lte: untilDate },
  };

  if (indexId) {
    filter.indexId = indexId;
  }

  // Query error documents
  const documents = await SearchDocument.find(filter)
    .select('indexId processingError updatedAt')
    .lean();

  // Aggregate by index
  const byIndex: Record<string, number> = {};
  for (const doc of documents) {
    byIndex[doc.indexId] = (byIndex[doc.indexId] || 0) + 1;
  }

  // Aggregate by error type (extract first line of error message)
  const byErrorType: Record<string, number> = {};
  for (const doc of documents) {
    if (!doc.processingError) continue;
    const errorType = doc.processingError.split('\n')[0].substring(0, 100);
    byErrorType[errorType] = (byErrorType[errorType] || 0) + 1;
  }

  res.status(200).json({
    success: true,
    stats: {
      total: documents.length,
      byIndex,
      byErrorType,
    },
    timeWindow: {
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
    },
  });
});
```

**Pattern:**

- Fetch documents with `.select()` to limit fields
- Aggregate in memory (acceptable for <10K documents)
- For large datasets, use MongoDB aggregation pipeline

**Alternative: MongoDB Aggregation Pipeline**

```typescript
const stats = await SearchDocument.aggregate([
  { $match: filter },
  {
    $group: {
      _id: '$indexId',
      count: { $sum: 1 },
      lastError: { $last: '$processingError' },
    },
  },
  { $sort: { count: -1 } },
]);
```

---

## 13. Mongoose Usage Patterns

### Query Performance

```typescript
// ✅ GOOD - Use .lean() for read-only queries (5-10x faster)
const indexes = await SearchIndex.find(filter).lean();

// ❌ BAD - Mongoose documents with virtuals/methods (slower)
const indexes = await SearchIndex.find(filter);

// ✅ GOOD - Select only needed fields
const documents = await SearchDocument.find(filter).select('_id originalReference status').lean();

// ❌ BAD - Fetch all fields
const documents = await SearchDocument.find(filter).lean();
```

### Tenant Isolation

```typescript
// ✅ GOOD - Always use findOne/find with tenantId
const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();

// ❌ BAD - findById bypasses tenant isolation
const index = await SearchIndex.findById(indexId).lean();

// ✅ GOOD - findOneAndUpdate with tenantId
const index = await SearchIndex.findOneAndUpdate(
  { _id: indexId, tenantId },
  { $set: updates },
  { new: true },
).lean();

// ❌ BAD - findByIdAndUpdate bypasses tenant isolation
const index = await SearchIndex.findByIdAndUpdate(indexId, updates, { new: true }).lean();
```

### Update Patterns

```typescript
// ✅ GOOD - Partial updates with $set
await SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $set: { status: 'active' } });

// ✅ GOOD - Increment/decrement counters with $inc
await SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $inc: { sourceCount: 1 } });

// ✅ GOOD - Array operations
await SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $push: { errors: errorEntry } });
```

---

## 14. Recommendations for Pipeline APIs

Based on existing patterns, pipeline APIs should follow:

### Route Structure

```
/api/indexes/:indexId/pipelines              — List all pipelines for index
/api/indexes/:indexId/pipelines              — Create pipeline (POST)
/api/indexes/:indexId/pipelines/:pipelineId  — Get single pipeline
/api/indexes/:indexId/pipelines/:pipelineId  — Update pipeline (PATCH)
/api/indexes/:indexId/pipelines/:pipelineId  — Delete pipeline (DELETE)

/api/indexes/:indexId/pipelines/:pipelineId/flows         — List flows
/api/indexes/:indexId/pipelines/:pipelineId/flows/:flowId — Get/Update/Delete flow

/api/indexes/:indexId/pipelines/:pipelineId/validate      — Validate pipeline config (POST)
/api/indexes/:indexId/pipelines/:pipelineId/simulate      — Simulate document routing (POST)
/api/indexes/:indexId/pipelines/:pipelineId/activate      — Activate pipeline (POST)
/api/indexes/:indexId/pipelines/:pipelineId/deactivate    — Deactivate pipeline (POST)

/api/admin/pipelines/templates                             — List default templates
/api/admin/pipelines/providers                             — List available stage providers
```

### Validation Schema Example

```typescript
import { z } from 'zod';

export const FlowSchema = z.object({
  name: z.string().min(1).max(100),
  priority: z.number().int().min(1).max(100),
  selectionRules: z.string().nullable().optional(), // CEL expression
  stages: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      provider: z.string(),
      config: z.record(z.unknown()),
      order: z.number().int(),
    }),
  ),
});

export const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  flows: z.array(FlowSchema).min(1, 'At least one flow is required'),
  sharedStages: z
    .array(z.object({ id: z.string(), type: z.string(), config: z.record(z.unknown()) }))
    .optional(),
});

export const UpdatePipelineSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  flows: z.array(FlowSchema).optional(),
  sharedStages: z
    .array(z.object({ id: z.string(), type: z.string(), config: z.record(z.unknown()) }))
    .optional(),
  status: z.enum(['draft', 'active', 'inactive']).optional(),
});
```

### Route Handler Pattern

```typescript
router.post('/:indexId/pipelines', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // 1. Validate request body
    const validation = CreatePipelineSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid pipeline configuration',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    // 2. Verify index exists
    const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // 3. Check for duplicate name
    const existing = await PipelineDefinition.findOne({
      tenantId,
      indexId,
      name: validation.data.name,
    }).lean();
    if (existing) {
      res
        .status(409)
        .json({ error: `Pipeline with name "${validation.data.name}" already exists` });
      return;
    }

    // 4. Run pipeline validation (18 validation rules from RFC-004)
    const validationResult = await validatePipeline(validation.data, { tenantId, indexId });
    if (!validationResult.valid) {
      res.status(400).json({
        error: 'Pipeline validation failed',
        validationErrors: validationResult.errors,
        validationWarnings: validationResult.warnings,
      });
      return;
    }

    // 5. Generate flow IDs if not provided
    const flows = validation.data.flows.map((flow) => ({
      ...flow,
      id: flow.id || uuidv7(),
      stages: flow.stages.map((stage) => ({ ...stage, id: stage.id || uuidv7() })),
    }));

    // 6. Create pipeline
    const pipeline = await PipelineDefinition.create({
      tenantId,
      indexId,
      name: validation.data.name,
      description: validation.data.description || null,
      flows,
      sharedStages: validation.data.sharedStages || [],
      status: 'draft',
      version: 1,
    });

    res.status(201).json({ pipeline });
  } catch (error) {
    console.error('[pipelines] Failed to create pipeline:', error);
    res.status(500).json({ error: 'Failed to create pipeline' });
  }
});
```

### Permission Guards (Future)

```typescript
import { requirePermission } from '@agent-platform/shared';

// Require specific permissions (when RBAC is enabled)
router.post('/:indexId/pipelines', requirePermission('pipeline:create'), handler);
router.patch('/:indexId/pipelines/:pipelineId', requirePermission('pipeline:update'), handler);
router.delete('/:indexId/pipelines/:pipelineId', requirePermission('pipeline:delete'), handler);
router.post(
  '/:indexId/pipelines/:pipelineId/activate',
  requirePermission('pipeline:activate'),
  handler,
);
```

---

## 15. Testing Patterns

**Location:** `apps/search-ai/src/routes/__tests__/`

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';

describe('Indexes API', () => {
  let authToken: string;
  let tenantId: string;
  let projectId: string;

  beforeEach(async () => {
    // Set up test data
    const user = await createTestUser();
    authToken = generateTestJWT(user);
    tenantId = user.tenantId;
    projectId = await createTestProject(tenantId);
  });

  afterEach(async () => {
    // Clean up test data
    await cleanupTestData(tenantId);
  });

  describe('POST /api/indexes', () => {
    it('should create a new index', async () => {
      const res = await request(app)
        .post('/api/indexes')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId,
          slug: 'test-index',
          name: 'Test Index',
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
        })
        .expect(201);

      expect(res.body.index).toBeDefined();
      expect(res.body.index.slug).toBe('test-index');
      expect(res.body.index.tenantId).toBe(tenantId);
    });

    it('should reject invalid slug format', async () => {
      const res = await request(app)
        .post('/api/indexes')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId,
          slug: 'Invalid_Slug',
          name: 'Test Index',
        })
        .expect(400);

      expect(res.body.error).toBe('Invalid request body');
      expect(res.body.details).toContainEqual({
        path: 'slug',
        message: 'slug must only contain lowercase letters, numbers, and hyphens',
      });
    });

    it('should reject duplicate slug', async () => {
      await createTestIndex(tenantId, projectId, 'duplicate-slug');

      const res = await request(app)
        .post('/api/indexes')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId,
          slug: 'duplicate-slug',
          name: 'Test Index',
        })
        .expect(409);

      expect(res.body.error).toContain('already exists');
    });

    it('should require authentication', async () => {
      await request(app)
        .post('/api/indexes')
        .send({ projectId, slug: 'test', name: 'Test' })
        .expect(401);
    });

    it('should enforce tenant isolation', async () => {
      const otherTenant = await createTestUser();
      const otherToken = generateTestJWT(otherTenant);

      await createTestIndex(tenantId, projectId, 'my-index');

      const res = await request(app)
        .get('/api/indexes/my-index-id')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404); // Not 403 - prevents existence leak

      expect(res.body.error).toBe('Index not found');
    });
  });
});
```

---

## Conclusion

**Key Patterns for Pipeline APIs:**

1. ✅ **Route structure:** `/api/indexes/:indexId/pipelines` (nested under index)
2. ✅ **Tenant isolation:** ALWAYS filter by `tenantId` (from `req.tenantContext`)
3. ✅ **Validation:** Zod schemas with detailed error responses
4. ✅ **CRUD:** Standard REST verbs (GET, POST, PATCH, DELETE)
5. ✅ **Error responses:** Structured JSON with status codes (400, 401, 404, 409, 500)
6. ✅ **Pagination:** `limit`/`offset` query params with `total` in response
7. ✅ **Filtering:** Build dynamic filter objects from query params
8. ✅ **Actions:** POST to `/:id/action` for state changes
9. ✅ **Auth:** `createUnifiedAuthMiddleware()` with JWT/API key support
10. ✅ **Rate limiting:** Per-tenant Redis-backed rate limiting
11. ✅ **Permission guards:** `requirePermission()` middleware (future)
12. ✅ **Cascade deletes:** Clean up related resources + update parent counters

**Next:** Proceed to Task #39 (Backend Design: Data models) using these patterns.

---

**Analysis complete.** Ready for pipeline API design implementation.
