# TypeScript Errors Analysis - Post-Merge

**Date:** 2026-03-04
**Branch:** feat/canonical-mapping-phase1 (after merging develop)
**Total Errors:** 19

---

## Error Categories

### Category 1: Missing Type Annotations (11 errors)

**Files:** `apps/search-ai/src/routes/schemas.ts` (lines 156-177)

**Root Cause:** Using `.lean()` on Mongoose queries removes type information.

```typescript
// Current code (lines 156-160):
const oldFieldMap = new Map(oldSchema.fields.map((f) => [f.path, f]));
const newFieldMap = new Map(newSchema.fields.map((f) => [f.path, f]));
const addedFields = newSchema.fields.filter((f) => !oldFieldMap.has(f.path));
const removedFields = oldSchema.fields.filter((f) => !newFieldMap.has(f.path));
```

**TypeScript Errors:**

```
src/routes/schemas.ts(156,55): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/routes/schemas.ts(157,55): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/routes/schemas.ts(159,50): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/routes/schemas.ts(160,52): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/routes/schemas.ts(162,16): error TS7006: Parameter 'newField' implicitly has an 'any' type.
src/routes/schemas.ts(164,37): error TS2339: Property 'type' does not exist on type '{}'.
src/routes/schemas.ts(166,13): error TS7006: Parameter 'newField' implicitly has an 'any' type.
src/routes/schemas.ts(168,50): error TS2339: Property 'type' does not exist on type '{}'.
src/routes/schemas.ts(176,39): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/routes/schemas.ts(177,43): error TS7006: Parameter 'f' implicitly has an 'any' type.
```

**Impact:** Medium - Type safety lost but runtime behavior correct

---

### Category 2: Wrong Type Import Name (1 error)

**File:** `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts:10`

**Root Cause:** Importing non-existent type name

```typescript
// Current (WRONG):
import {
  type IConnectorSchemaField,
  type ICanonicalSchemaField, // ← Does not exist
  type IFieldMapping,
} from '@agent-platform/database/models';
```

**Correct:**

```typescript
// Should be:
import {
  type IConnectorSchemaField,
  type ICanonicalField, // ← Correct name
  type IFieldMapping,
} from '@agent-platform/database/models';
```

**TypeScript Error:**

```
src/services/mapping-suggestion/mapping-suggestion.service.ts(10,8): error TS2724: '"@agent-platform/database/models"' has no exported member named 'ICanonicalSchemaField'. Did you mean 'ICanonicalSchema'?
```

**Impact:** HIGH - Compilation failure

---

### Category 3: Missing Dependency (1 error)

**File:** `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts:15`

**Root Cause:** `@anthropic-ai/sdk` not installed

```typescript
import Anthropic from '@anthropic-ai/sdk'; // ← Package not in package.json
```

**TypeScript Error:**

```
src/services/mapping-suggestion/mapping-suggestion.service.ts(15,23): error TS2307: Cannot find module '@anthropic-ai/sdk' or its corresponding type declarations.
```

**Check:**

```bash
$ grep "@anthropic-ai/sdk" apps/search-ai/package.json
# (no output - not installed)
```

**Impact:** HIGH - Compilation failure

---

### Category 4: Missing Interface Property (1 error)

**File:** `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts:174`

**Root Cause:** `ResolvedIndexLLMConfig` interface doesn't have `enabled` property

**Current Interface:** (`apps/search-ai/src/services/llm-config/resolver.ts`)

```typescript
export interface ResolvedIndexLLMConfig {
  tenantId: string;
  provider: string;
  apiKey: string;
  monthlyTokenBudget: number;
  dailyTokenBudget: number;
  maxRequestsPerMinute: number;
  allowedProviders: string[];
  indexId: string;
  embeddingModel: string;
  embeddingDimensions: number;
  useCases: Record<string, ResolvedUseCaseConfig>;
  // ← No 'enabled' property
}
```

**Usage in mapping-suggestion.service.ts:174:**

```typescript
if (!llmConfig.enabled || !llmConfig.apiKey) {
  // ← llmConfig.enabled doesn't exist
  return { suggestions: [], totalProcessed: 0, averageConfidence: 0 };
}
```

**TypeScript Error:**

```
src/services/mapping-suggestion/mapping-suggestion.service.ts(174,20): error TS2339: Property 'enabled' does not exist on type 'ResolvedIndexLLMConfig'.
```

**Impact:** MEDIUM - Logic error (should check if apiKey is truthy instead)

---

### Category 5: Missing Field Mapping Properties (2 errors)

**File:** `apps/search-ai/src/services/canonical-mapping/canonical-mapper.service.ts:258`

**Root Cause:** `IFieldMapping` interface missing `transformType` and `transformConfig`

**Current Code:**

```typescript
transformType: mapping.transformType || 'direct',
transformConfig: mapping.transformConfig || {},
```

**TypeScript Errors:**

```
src/services/canonical-mapping/canonical-mapper.service.ts(258,13): error TS2339: Property 'transformType' does not exist on type 'IFieldMapping'.
src/services/canonical-mapping/canonical-mapper.service.ts(258,28): error TS2339: Property 'transformConfig' does not exist on type 'IFieldMapping'.
```

**IFieldMapping Interface:** (`packages/database/src/models/field-mapping.model.ts`)

```typescript
export interface IFieldMapping {
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: string;
  connectorId: string;
  sourcePath: string;
  transform: {
    type: string;
    valueMap?: Record<string, string>;
    delimiter?: string;
    sourceFormat?: string;
  };
  confidence: number;
  status: string;
  suggestedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Analysis:** The interface has `transform` (nested object) but code is trying to access `transformType` and `transformConfig` (flat properties).

**Impact:** HIGH - Field structure mismatch

---

### Category 6: Missing Export (1 error)

**File:** `apps/search-ai/src/services/schema-discovery/index.ts:16`

**Root Cause:** `BaseSchemaDiscoveryService` class not exported

**TypeScript Error:**

```
src/services/schema-discovery/index.ts(16,61): error TS2304: Cannot find name 'BaseSchemaDiscoveryService'.
```

**Current exports:** (`apps/search-ai/src/services/schema-discovery/index.ts`)

```typescript
export { getDiscoveryService };
// ← BaseSchemaDiscoveryService not exported
```

**Impact:** MEDIUM - Type reference failure

---

### Category 7: Pre-Existing Script Errors (2 errors)

**File:** `apps/search-ai/src/scripts/backfill-connector-id.ts`

**Root Cause:** Script references removed/renamed exports

**TypeScript Errors:**

```
src/scripts/backfill-connector-id.ts(17,24): error TS2305: Module '"../db/index.js"' has no exported member 'bindModelsForSearchAI'.
src/scripts/backfill-connector-id.ts(115,40): error TS2339: Property 'connectorId' does not exist on type...
```

**Impact:** LOW - Migration script, not runtime code

---

### Category 8: Type Inference Issue (1 error)

**File:** `apps/search-ai/src/routes/mappings.ts:415`

**Root Cause:** TypeScript can't infer `connectorId` type despite cast

**Current Code:**

```typescript
const connectorIds = [...new Set(updatedMappings.map((m: any) => m.connectorId as string))];
for (const connectorId of connectorIds) {
  await service.invalidateCache(connectorId, tenantId); // ← connectorId inferred as unknown
}
```

**TypeScript Error:**

```
src/routes/mappings.ts(415,39): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.
```

**Impact:** LOW - Type cast issue, runtime correct

---

## Summary by Severity

| Severity   | Count | Category                                                  |
| ---------- | ----- | --------------------------------------------------------- |
| **HIGH**   | 4     | Wrong import name, Missing dependency, Field mismatch (2) |
| **MEDIUM** | 3     | Missing property, Missing export, Type annotations        |
| **LOW**    | 2     | Script errors, Type inference                             |

---

## Required Fixes

### Priority 1: HIGH (Must Fix to Compile)

1. **Fix import name** (mapping-suggestion.service.ts:10):

   ```typescript
   - type ICanonicalSchemaField,
   + type ICanonicalField,
   ```

2. **Install missing dependency**:

   ```bash
   cd apps/search-ai && pnpm add @anthropic-ai/sdk
   ```

3. **Fix field mapping access** (canonical-mapper.service.ts:258):
   ```typescript
   - transformType: mapping.transformType || 'direct',
   - transformConfig: mapping.transformConfig || {},
   + transformType: mapping.transform.type || 'direct',
   + transformConfig: mapping.transform || {},
   ```

### Priority 2: MEDIUM (Should Fix)

4. **Fix enabled check** (mapping-suggestion.service.ts:174):

   ```typescript
   - if (!llmConfig.enabled || !llmConfig.apiKey) {
   + if (!llmConfig.apiKey) {
   ```

5. **Export BaseSchemaDiscoveryService** (schema-discovery/index.ts):

   ```typescript
   + export { BaseSchemaDiscoveryService } from './base-discovery.service.js';
   export { getDiscoveryService };
   ```

6. **Add type annotations** (schemas.ts:156-177):
   ```typescript
   const oldFieldMap = new Map(oldSchema.fields.map((f: IConnectorSchemaField) => [f.path, f]));
   ```

### Priority 3: LOW (Optional)

7. **Fix type inference** (mappings.ts:415):

   ```typescript
   const connectorIds = [
     ...new Set(updatedMappings.map((m: any) => m.connectorId as string)),
   ] as string[];
   ```

8. **Skip or fix migration script** (backfill-connector-id.ts) - Not blocking

---

## Root Cause Analysis

**These errors were NOT introduced by the merge with develop.** They existed in the Phase 2/3 implementation but were masked by:

1. Using `--no-verify` on previous commits
2. Not running `pnpm build` before committing
3. TypeScript errors not caught in local testing

**The merge with develop exposed these because:**

- The pre-push hook runs `turbo test:fast` which includes build
- Develop has stricter CI checks enabled
- The merge triggered a full rebuild

---

## Recommendation

**Fix Priority 1 issues (HIGH) immediately** - these block compilation:

- Wrong import name
- Missing dependency
- Field mapping structure mismatch

**Fix Priority 2 issues (MEDIUM) before merging** - these affect type safety:

- Missing property check
- Missing export
- Type annotations

**Priority 3 can be deferred** to post-merge cleanup.

---

**Estimated Time:** 20-30 minutes to fix all HIGH + MEDIUM issues.
