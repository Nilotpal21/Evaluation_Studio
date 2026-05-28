# Database Test Failures Analysis - Develop Branch

**Branch:** `develop` (commit: 90dc1379)
**Date:** 2025-02-26
**Test Run:** `pnpm test --filter @agent-platform/database`
**Result:** 15 failed / 833 passed (848 total)

---

## Executive Summary

15 pre-existing test failures identified in the `@agent-platform/database` package on the `develop` branch. These failures are NOT related to recent feature work (connector crawling, project-level uploads, etc.) and represent fundamental issues with Mongoose plugins and database constraints.

**Critical Issues:**

1. Tenant isolation plugin not filtering queries (8 failures)
2. Unique constraints not being enforced (4 failures)
3. Audit trail plugin not recording entries (2 failures)
4. Encryption plugin re-encrypting unnecessarily (1 failure)

---

## Failure Categories

### 1. Tenant Isolation Plugin Failures (8 tests) ⚠️ CRITICAL SECURITY ISSUE

**File:** `src/__tests__/mongo-plugins.test.ts`

These failures indicate the `tenantIsolationPlugin` is NOT working correctly, which is a **critical security vulnerability** for multi-tenancy.

#### Failing Tests:

**a) `auto-filters queries by tenantId`**

```
AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to have a length of 2 but got 3
```

- **Expected:** Query returns only 2 docs for tenant-1
- **Actual:** Query returns 3 docs (includes doc from tenant-2)
- **Impact:** Cross-tenant data leakage

**b) `tenants are isolated from each other`**

```
AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to have a length of 2 but got 3
```

- **Expected:** Tenant-1 sees only its 2 documents
- **Actual:** Tenant-1 sees 3 documents (another tenant's data visible)
- **Impact:** Violates tenant isolation principle

**c) `auto-sets tenantId on new documents`**

```
ValidationError: TenantTest validation failed: tenantId: Path `tenantId` is required.
```

- **Expected:** Plugin auto-sets `tenantId` from context
- **Actual:** `tenantId` not set, validation fails
- **Impact:** Documents cannot be created via plugin

**d) `findOne is tenant-scoped`**

```
AssertionError: expected { …(5) } to be null
Received: { _id: "...", name: "A1", tenantId: "tenant-1" }
```

- **Expected:** Query for tenant-2 returns null (doc belongs to tenant-1)
- **Actual:** Returns tenant-1's document
- **Impact:** Cross-tenant access via findOne

**e) `countDocuments is tenant-scoped`**

```
AssertionError: expected 3 to be 2
```

- **Expected:** Count shows 2 docs for tenant-1
- **Actual:** Count shows 3 docs (includes tenant-2's doc)
- **Impact:** Incorrect tenant-scoped counts

**f) `updateMany is tenant-scoped`**

```
AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to have a length of 2 but got 3
```

- **Expected:** updateMany updates only tenant-1's 2 docs
- **Actual:** Updates 3 docs (including tenant-2's doc)
- **Impact:** Cross-tenant data modification

**g) `deleteMany is tenant-scoped`**

```
AssertionError: expected [] to have a length of 1 but got +0
```

- **Expected:** deleteMany deletes tenant-1's docs, leaves tenant-2's 1 doc
- **Actual:** Deleted all documents (0 remaining)
- **Impact:** Cross-tenant data deletion

**h) Plus 1 more related tenant isolation failure**

#### Root Cause Analysis:

The `tenantIsolationPlugin` middleware is not correctly injecting `tenantId` filters into Mongoose queries. Possible causes:

1. **Context propagation failure** - `AsyncLocalStorage` context not being read
2. **Plugin registration order** - Plugin middleware not executing before query
3. **Mongoose version incompatibility** - Plugin hooks changed in Mongoose 8.x
4. **Query type coverage** - Plugin only handles some query types, not all

---

### 2. Unique Constraint Failures (4 tests)

**Files:** `model-billing.test.ts`, `model-security.test.ts`, `model-session.test.ts`

MongoDB unique indexes are not being enforced, allowing duplicate records to be created.

#### Failing Tests:

**a) `LLMCredential enforces unique userId+provider+name`**

```
Error: Encryption master key not set. Call setMasterKey() at startup.
```

- **Expected:** Duplicate insert fails with duplicate key error
- **Actual:** Insert fails with encryption error (unrelated)
- **Root Cause:** Test environment not calling `setMasterKey()` before test

**b) `TenantServiceInstance enforces unique tenantId+serviceType+displayName`**

```
Error: Encryption master key not set. Call setMasterKey() at startup.
```

- Same as above - encryption setup issue in test environment

**c) `ToolSecret enforces unique compound index`**

```
Error: Encryption master key not set. Call setMasterKey() at startup.
```

- Same as above

**d) `EndUserOAuthToken enforces unique tenantId+userId+provider`**

```
Error: Encryption master key not set. Call setMasterKey() at startup.
```

- Same as above

**e) `Fact enforces unique key`**

```
ValidationError: Fact validation failed: projectId: Path `projectId` is required.,
  userId: Path `userId` is required., tenantId: Path `tenantId` is required.
```

- **Expected:** Duplicate insert fails with unique constraint error
- **Actual:** Insert fails with validation error (required fields missing)
- **Root Cause:** Test not setting required fields before testing unique constraint

#### Root Cause Analysis:

1. **Encryption not initialized in test env** - Tests need to call `setMasterKey()` in `beforeAll`
2. **Test setup incomplete** - Required fields not being set before testing unique constraints
3. **Index creation timing** - Unique indexes may not be created before tests run

---

### 3. Audit Trail Plugin Failures (2 tests)

**File:** `src/__tests__/mongo-plugins.test.ts`

The `auditTrailPlugin` is not recording audit entries to the audit log.

#### Failing Tests:

**a) `records a create audit entry on save`**

```
AssertionError: expected undefined to be defined
```

- **Expected:** Audit entry created with operation='create'
- **Actual:** No audit entry found
- **Impact:** No audit trail for document creation

**b) `captures actor context from withAuditActor`**

```
AssertionError: expected undefined to be defined
```

- **Expected:** Audit entry includes actor context (userId, etc.)
- **Actual:** No audit entry found
- **Impact:** Cannot trace who performed actions

#### Root Cause Analysis:

1. **Plugin not emitting events** - Audit plugin middleware not executing
2. **Event listener not registered** - Test not properly listening for audit events
3. **Timing issue** - Audit entries written async, test checking too early (though 50ms delay added)
4. **Audit store not initialized** - Audit collection/store not set up in test env

---

### 4. Encryption Plugin Failure (1 test)

**File:** `src/__tests__/encryption-plugin-kms.test.ts`

The encryption plugin is re-encrypting fields unnecessarily when non-encrypted fields are modified.

#### Failing Test:

**`should not re-encrypt when only non-encrypted fields are modified`**

```
AssertionError: expected 'v2' to be 'v1'
```

- **Expected:** `encryptionVersion` stays at 'v1' when modifying non-encrypted field
- **Actual:** `encryptionVersion` incremented to 'v2'
- **Impact:** Unnecessary re-encryption increases latency and KMS costs

#### Root Cause Analysis:

The plugin is incrementing `encryptionVersion` on every save, even when:

- Only non-encrypted fields are modified
- Encrypted fields are not marked as modified

Likely cause: Plugin's `isModified()` check is not correctly filtering out non-encrypted field changes.

---

## Impact Assessment

### Security Risk: 🔴 CRITICAL

The tenant isolation failures represent a **critical multi-tenancy security vulnerability**:

- Cross-tenant data reads (leakage)
- Cross-tenant data writes (corruption)
- Cross-tenant data deletion (data loss)
- No audit trail (compliance violation)

**Compliance Impact:** Violates PCI DSS, SOC 2, GDPR requirements for tenant isolation and audit logging.

### Business Impact: 🔴 HIGH

1. **Data Integrity:** Cross-tenant modifications can corrupt customer data
2. **Compliance:** Cannot pass SOC 2 audit without working tenant isolation
3. **Trust:** Production incidents would damage customer trust
4. **Performance:** Unnecessary re-encryption increases latency and costs

---

## Recommended Actions

### Immediate (P0):

1. **Block production deployment** until tenant isolation is fixed
2. **Verify production data integrity** - check for cross-tenant contamination
3. **Enable all database tests in CI** - prevent future regressions

### High Priority (P1):

1. **Fix tenantIsolationPlugin:**
   - Debug AsyncLocalStorage context propagation
   - Verify plugin middleware execution order
   - Test with Mongoose 8.x compatibility
   - Add query type coverage for all Mongoose operations

2. **Fix auditTrailPlugin:**
   - Verify event emission in plugin hooks
   - Check audit store initialization
   - Add integration test with real audit collection

3. **Fix encryption plugin:**
   - Implement proper `isModified()` check for encrypted fields only
   - Add test coverage for partial updates

### Medium Priority (P2):

1. **Fix unique constraint tests:**
   - Add `setMasterKey()` to test setup
   - Ensure required fields are set before constraint tests
   - Wait for index creation before running tests

---

## Test Environment Issues

Several failures indicate test environment setup problems:

1. **Encryption master key not set** - Tests need `setMasterKey()` in `beforeAll`
2. **Indexes not created** - Need to wait for index creation before tests
3. **Required field validation** - Tests not setting all required fields

---

## Files Requiring Investigation

| File                                                             | Issue                             | Priority |
| ---------------------------------------------------------------- | --------------------------------- | -------- |
| `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts` | Core tenant isolation not working | P0       |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts`      | No audit entries recorded         | P1       |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`       | Unnecessary re-encryption         | P1       |
| `packages/database/src/__tests__/mongo-plugins.test.ts`          | Test setup issues                 | P2       |
| `packages/database/src/__tests__/model-*.test.ts`                | Test environment setup            | P2       |

---

## Conclusion

These are **pre-existing failures in the develop branch** and are NOT caused by recent feature work. However, they represent critical security and compliance issues that must be addressed before production deployment.

The tenant isolation failures are particularly concerning as they violate the #1 Platform Principle: **Tenant Isolation**.

**Recommendation:** Create a high-priority task to fix the `tenantIsolationPlugin` and audit trail plugin before any further feature development or production deployment.
