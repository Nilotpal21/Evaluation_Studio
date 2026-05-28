# SearchAI Database Patterns Guide

Reference for dual-database architecture, model registration, lazy loading, query optimization, and test mocking patterns used across `search-ai` and `search-ai-runtime`.

---

## 1. Dual-Database Architecture

The platform uses two MongoDB databases to separate concerns:

| Database       | Purpose                | Models                                                                                                                                             |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abl_platform` | Shared platform config | `SearchIndex`, `TenantModel`, `LLMCredential`, `TenantLLMPolicy`                                                                                   |
| `search_ai`    | SearchAI content data  | `SearchChunk`, `SearchDocument`, `SearchSource`, `CanonicalSchema`, `DomainVocabulary`, `CapabilityRegistry`, `PipelineDefinition`, `JobExecution` |

Each database gets its own `mongoose.createConnection()` via `SearchAIDualConnection`. Models are **bound** to the correct connection so queries hit the right database.

### Environment Variables

```bash
# Platform database
PLATFORM_MONGO_URL=mongodb://localhost:27017
PLATFORM_MONGO_DATABASE=abl_platform

# Content database
SEARCH_AI_MONGO_URL=mongodb://localhost:27017
SEARCH_AI_MONGO_DATABASE=search_ai
```

In development, both URLs can point to the same MongoDB server — only the `dbName` differs. In production, they may point to separate clusters.

---

## 2. Model Registration

Model registration tells the system which database a model belongs to (**affinity**).

### Registration with ModelRegistry

```typescript
import { ModelRegistry } from '@agent-platform/database';

// Platform models → abl_platform
ModelRegistry.registerModelDefinition('SearchIndex', SearchIndex.schema, 'platform');
ModelRegistry.registerModelDefinition('TenantModel', TenantModel.schema, 'platform');

// Content models → search_ai
ModelRegistry.registerModelDefinition('CanonicalSchema', CanonicalSchema.schema, 'searchaicontent');
ModelRegistry.registerModelDefinition('SearchChunk', SearchChunk.schema, 'searchaicontent');
```

### Binding to Connections

After registration, models are bound to their respective connections:

```typescript
const boundModels = ModelRegistry.bindModelsForSearchAI(
  dualConnection.getPlatformConnection(), // → abl_platform
  dualConnection.getContentConnection(), // → search_ai
);
```

This creates actual Mongoose model instances that query the correct database. The bound models are stored in an internal map keyed by model name.

### Self-Registration Pattern

Some models self-register their affinity in their schema definition file:

```typescript
// In packages/database/src/models/search-chunk.ts
ModelRegistry.registerModelDefinition('SearchChunk', searchChunkSchema, 'searchaicontent');
```

These models don't need explicit registration in `initMongoBackend()`.

---

## 3. Model Access: `getModel` vs `getLazyModel`

### `getModel(name)` — Eager, Throws if Not Ready

```typescript
import { getModel } from '../../db/index.js';

function handleRequest() {
  const SearchChunk = getModel<ISearchChunk>('SearchChunk');
  return SearchChunk.find({ indexId }).lean();
}
```

- Looks up the model from the bound models map immediately
- **Throws** if the model isn't registered or connections aren't initialized
- Use **inside functions** that run after `initMongoBackend()` has completed

### `getLazyModel(name)` — Deferred via Proxy, Safe at Module Scope

```typescript
import { getLazyModel } from '../../db/index.js';

// Safe at module scope — no model lookup happens here
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

export class MyService {
  async query() {
    // Model lookup happens HERE on first property access
    return SearchChunk.find({ indexId }).lean();
  }
}
```

Returns a `Proxy` that defers `getModel()` until the first property access (`.find()`, `.aggregate()`, etc.).

#### Why This Exists

**Problem:** When Node.js loads ES modules, top-level code runs immediately — before server startup. A top-level `getModel('SearchChunk')` would execute before `initMongoBackend()`, causing a crash.

**Solution:** `getLazyModel` returns a lightweight Proxy immediately. The real model is only resolved when first _used_, which happens during request handling — safely after initialization.

```typescript
// Internal implementation
export function getLazyModel<T>(modelName: string): Model<T> {
  let cachedModel: Model<T> | null = null;
  return new Proxy({} as Model<T>, {
    get(_target, prop) {
      if (!cachedModel) {
        cachedModel = getModel<T>(modelName); // Deferred until first use
      }
      const value = cachedModel[prop];
      return typeof value === 'function' ? value.bind(cachedModel) : value;
    },
  });
}
```

### Decision Table

| Location                   | Pattern                                  | Why                                  |
| -------------------------- | ---------------------------------------- | ------------------------------------ |
| Module scope (top of file) | `getLazyModel(name)`                     | Defers lookup until after init       |
| Inside a function body     | `getModel(name)` or `getLazyModel(name)` | Both work; `getModel` is simpler     |
| Dynamic import handler     | `getModel(name)`                         | Module already loaded, init complete |

---

## 4. `.lean()` — Query Optimization

Mongoose `.lean()` returns plain JavaScript objects (POJOs) instead of full Mongoose documents.

### With vs Without `.lean()`

```typescript
// WITHOUT lean: Full Mongoose document (heavyweight)
const doc = await SearchIndex.findOne({ _id, tenantId });
doc.save(); // Works — full document with change tracking
doc.validate(); // Works — has Mongoose methods
// ~5x slower, more memory

// WITH lean: Plain JavaScript object (lightweight)
const doc = await SearchIndex.findOne({ _id, tenantId }).lean();
doc.save(); // ERROR — it's just a plain object
// ~5x faster, less memory
```

### When to Use `.lean()`

| Scenario                               | Use `.lean()`? | Reason                               |
| -------------------------------------- | -------------- | ------------------------------------ |
| API response (read-only)               | **Yes**        | No need for Mongoose overhead        |
| Cache population                       | **Yes**        | Storing plain objects is cheaper     |
| Aggregation pipelines                  | N/A            | `.aggregate()` already returns POJOs |
| Modify and `.save()` back              | **No**         | Need Mongoose document methods       |
| Plugin hooks needed (e.g., encryption) | **No**         | Plugins run on Mongoose documents    |
| Mongoose virtuals/getters              | **No**         | Only available on full documents     |

### Real Examples

```typescript
// ✅ Read-only lookup for API response — use .lean()
const capabilities = await CapabilityRegistry.find(query).sort({ type: 1, name: 1 }).lean().exec();

// ✅ Vocabulary lookup for caching — use .lean()
const doc = await DomainVocabulary.findOne({ projectKnowledgeBaseId, tenantId, status: 'active' })
  .sort({ version: -1 })
  .lean();

// ❌ Credential with encryption plugin — do NOT use .lean()
// The encryption plugin decrypts encryptedApiKey in a post-find hook
const credential = await LLMCredential.findOne({ _id: credentialId, tenantId });

// ❌ Document that will be modified and saved — do NOT use .lean()
const capability = await CapabilityRegistry.findOne({ _id: capabilityId, tenantId }).exec();
capability.description = updates.description;
capability.metadata.version += 1;
await capability.save();
```

---

## 5. Test Mocking Patterns

### Unit Tests — Mock `db/index.js`

For unit tests that mock database calls, use `vi.hoisted()` + `vi.mock()` on `db/index.js`:

```typescript
// 1. Hoist mock objects so they're available during module evaluation
const { mockSearchChunk } = vi.hoisted(() => ({
  mockSearchChunk: {
    find: vi.fn(),
    findOne: vi.fn(),
    aggregate: vi.fn(),
  },
}));

// 2. Mock getLazyModel to return mock objects by name
vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  },
}));

// 3. Import the module under test AFTER mocks are set up
import { StructuredQueryService } from '../query/structured-query.js';
```

For models that act as constructors (e.g., `new CapabilityRegistry({...})`), use `Object.assign`:

```typescript
const { mockCapabilityRegistry } = vi.hoisted(() => {
  const mockConstructor = vi.fn();
  return {
    mockCapabilityRegistry: Object.assign(mockConstructor, {
      find: vi.fn(),
      findOne: vi.fn(),
      deleteOne: vi.fn(),
    }),
  };
});
```

### Integration Tests — Real MongoDB with Model Delegation

For integration tests using `MongoMemoryServer`, mock `db/index.js` to delegate to real models registered on the default mongoose connection:

```typescript
// 1. Create a model map (populated in beforeAll)
const { modelMap } = vi.hoisted(() => {
  const map = new Map<string, any>();
  return { modelMap: map };
});

// 2. Mock getLazyModel with a Proxy that delegates to real models
vi.mock('../db/index.js', () => ({
  getLazyModel: (name: string) => {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          const model = modelMap.get(name);
          if (!model) throw new Error(`Model '${name}' not registered`);
          const val = model[prop];
          return typeof val === 'function' ? val.bind(model) : val;
        },
      },
    );
  },
  getModel: (name: string) => modelMap.get(name),
  isDatabaseAvailable: () => true,
  disconnectDatabase: async () => {},
  initMongoBackend: async () => {},
}));

// 3. In beforeAll, after setupTestMongo(), register real models
beforeAll(async () => {
  await setupTestMongo();
  const { SearchIndex, SearchChunk, DomainVocabulary } =
    await import('@agent-platform/database/models');
  modelMap.set('SearchIndex', SearchIndex);
  modelMap.set('SearchChunk', SearchChunk);
  modelMap.set('DomainVocabulary', DomainVocabulary);
});
```

---

## 6. Common Anti-Patterns

### ❌ Direct Model Import in Runtime Services

```typescript
// BAD — bypasses dual-database routing
import { SearchChunk } from '@agent-platform/database/models';
const chunks = await SearchChunk.find({ indexId });
```

```typescript
// GOOD — uses getLazyModel which routes to correct database
import { getLazyModel } from '../../db/index.js';
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
const chunks = await SearchChunk.find({ indexId });
```

### ❌ `getModel()` at Module Scope

```typescript
// BAD — crashes because initMongoBackend() hasn't run yet
const SearchChunk = getModel<ISearchChunk>('SearchChunk');
```

```typescript
// GOOD — deferred until first use
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
```

### ❌ `.lean()` When Mongoose Hooks Are Needed

```typescript
// BAD — encryption plugin's post-find hook won't run
const credential = await LLMCredential.findOne({ _id, tenantId }).lean();
// credential.encryptedApiKey is still encrypted!
```

```typescript
// GOOD — full Mongoose document, hooks run
const credential = await LLMCredential.findOne({ _id, tenantId });
// credential.encryptedApiKey is decrypted by plugin
```

### ❌ Missing `.lean()` on Read-Only Queries

```typescript
// BAD — unnecessary Mongoose overhead for a read-only lookup
const capabilities = await CapabilityRegistry.find(query).exec();
```

```typescript
// GOOD — lean POJO, faster and less memory
const capabilities = await CapabilityRegistry.find(query).lean().exec();
```

### ❌ Mocking Old Import Paths in Tests

```typescript
// BAD — source file no longer imports from this path
vi.mock('@agent-platform/database/models', () => ({
  SearchChunk: { find: vi.fn() },
}));
```

```typescript
// GOOD — mock the actual import path used by source code
vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  },
}));
```

---

## 7. Initialization Flow

```
Server startup
  │
  ├─ Read env vars (PLATFORM_MONGO_URL, SEARCH_AI_MONGO_URL, etc.)
  │
  ├─ initMongoBackend({ platformDb, contentDb })
  │   ├─ Register model definitions with ModelRegistry (name → schema → affinity)
  │   ├─ SearchAIDualConnection.initialize()
  │   │   ├─ mongoose.createConnection(platformUrl, { dbName: 'abl_platform' })
  │   │   └─ mongoose.createConnection(contentUrl, { dbName: 'search_ai' })
  │   └─ ModelRegistry.bindModelsForSearchAI(platformConn, contentConn)
  │       └─ Creates Model instances bound to correct connection
  │
  ├─ Start Express server
  │
  └─ Request arrives
      └─ Service calls SearchChunk.find(...)
          └─ getLazyModel Proxy triggers
              └─ getModel('SearchChunk') → returns bound model from registry
                  └─ Query runs on search_ai database ✓
```
