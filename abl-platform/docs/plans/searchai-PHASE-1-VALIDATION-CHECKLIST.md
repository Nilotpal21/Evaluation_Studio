# Phase 1 Validation Checklist

Comprehensive validation checklist for Phase 1: connectorId + LRU cache + Redis pub/sub

## Pre-Deployment Checklist

### Code Review

- [ ] All code follows SearchAI anti-patterns guidelines
- [ ] No `console.log/error` - all logging uses `createLogger`
- [ ] No `.lean()` on encrypted fields
- [ ] All database queries include `{ tenantId }` filter
- [ ] Queue `.close()` called in finally blocks
- [ ] Prettier run on all changed files

### Database Changes

- [ ] SearchDocument model has `connectorId` field
- [ ] Compound index `{ connectorId: 1, tenantId: 1 }` created
- [ ] Backfill script tested in dry-run mode
- [ ] Migration plan documented

### Dependencies

- [ ] `lru-cache` added to `@agent-platform/search-ai`
- [ ] No version conflicts in pnpm-lock.yaml
- [ ] All dependencies audit-clean

### Tests

- [ ] CanonicalMapperService tests passing (cache metrics, tenant isolation)
- [ ] Canonical-mapper-worker tests passing (service integration, error handling)
- [ ] All existing tests still passing
- [ ] Test coverage ≥80% for new code

### Documentation

- [ ] Implementation plan reviewed and approved
- [ ] Architecture review comments addressed
- [ ] README.md updated for backfill script
- [ ] SERVICES-INVENTORY.md updated if needed

## Deployment Steps

### Step 1: Pre-Deployment Tasks

1. **Run full test suite**

   ```bash
   pnpm --filter @agent-platform/search-ai test
   ```

2. **Build and verify no TypeScript errors**

   ```bash
   pnpm --filter @agent-platform/search-ai build
   ```

3. **Tag release branch**
   ```bash
   git tag -a canonical-mapping-phase1-v1.0.0 -m "Phase 1: connectorId + cache + pub/sub"
   git push origin canonical-mapping-phase1-v1.0.0
   ```

### Step 2: Staging Deployment

1. **Deploy to staging environment**
   - Deploy updated Search-AI service
   - Verify pod startup (check logs for Redis pub/sub initialization)
   - Verify health endpoints responding

2. **Run database migration**

   ```bash
   # Connect to staging MongoDB
   # Verify connectorId field exists (should be created automatically by Mongoose)
   db.search_documents.findOne({}, { connectorId: 1 })
   ```

3. **Run backfill script (dry-run first)**

   ```bash
   # Dry run
   pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --dry-run

   # Apply (with smaller batch size for staging)
   pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --batch-size=500
   ```

4. **Verify backfill results**

   ```bash
   # Check statistics
   db.search_documents.aggregate([
     { $group: {
       _id: "$connectorId",
       count: { $sum: 1 }
     }},
     { $sort: { count: -1 }}
   ])

   # Should show counts for each connectorId + null for direct uploads
   ```

### Step 3: Functional Validation

1. **Test canonical mapping service**

   ```bash
   # Upload test document via connector
   curl -X POST https://staging-search-ai.example.com/api/upload \
     -H "Authorization: Bearer $STAGING_TOKEN" \
     -F "file=@test-document.pdf" \
     -F "indexId=test-index-123"

   # Wait for ingestion pipeline to complete
   # Verify document has connectorId populated
   ```

2. **Test cache metrics endpoint**

   ```bash
   curl https://staging-search-ai.example.com/api/health/cache-metrics \
     -H "Authorization: Bearer $STAGING_TOKEN"

   # Expected response:
   # {
   #   "service": "canonical-mapper",
   #   "cache": {
   #     "size": 0,
   #     "maxSize": 500,
   #     "hits": 0,
   #     "misses": 0,
   #     "evictions": 0,
   #     "hitRate": 0
   #   }
   # }
   ```

3. **Test cache invalidation**

   ```bash
   # Confirm a field mapping
   curl -X POST https://staging-search-ai.example.com/api/mappings/mapping-123/confirm \
     -H "Authorization: Bearer $STAGING_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"reviewedBy": "admin@example.com"}'

   # Check logs for cache invalidation event
   # Expected log: "Cache invalidated and broadcasted"
   ```

4. **Test audit logging**

   ```bash
   # Search logs for audit events
   # Expected: Field mapping audit event with operation=confirm
   ```

5. **Test Redis pub/sub across multiple pods**
   - Scale Search-AI to 2 pods
   - Confirm mapping via pod 1
   - Verify cache invalidation logged on pod 2
   - Scale back to 1 pod

### Step 4: Performance Validation

1. **Monitor cache hit rate**
   - Let system run for 1 hour with normal traffic
   - Check cache metrics
   - Expected hit rate: >70% after warm-up

2. **Monitor memory usage**
   - LRU cache should cap at ~5MB (500 entries × ~10KB each)
   - No memory leaks over 24 hours

3. **Monitor Redis connections**
   - Verify subscriber and publisher connections are stable
   - No connection leak warnings

### Step 5: Error Scenario Testing

1. **Test with missing connectorId**
   - Upload document directly (no connector)
   - Verify canonical mapping skips gracefully
   - Document should still process successfully

2. **Test with invalid field mapping**
   - Create mapping with invalid transform
   - Verify errors logged but processing continues
   - No documents stuck in ERROR status

3. **Test Redis unavailability**
   - Temporarily disable Redis pub/sub (network partition)
   - Verify local cache still works
   - Verify no crashes or deadlocks
   - Restore Redis and verify reconnection

## Post-Deployment Validation

### Monitoring

- [ ] Cache hit rate >70% after 1 hour
- [ ] Memory usage stable (<100MB for cache)
- [ ] No error spikes in logs
- [ ] Redis connection count stable
- [ ] Document processing throughput unchanged

### Metrics to Track

1. **Cache Performance**
   - Hit rate (target: >80%)
   - Miss rate (target: <20%)
   - Eviction rate (should be low)
   - Average lookup time (target: <5ms)

2. **Worker Performance**
   - Canonical-mapper queue throughput (documents/minute)
   - Average job duration (should be <500ms per document)
   - Error rate (target: <1%)

3. **Database Performance**
   - Query time for `{ connectorId, tenantId }` index (target: <10ms)
   - Backfill completion time (logged by script)

4. **Redis Performance**
   - Pub/sub message count
   - Message latency (target: <100ms)
   - Connection count (2 per pod: subscriber + publisher)

## Rollback Plan

### If Critical Issues Found

1. **Stop deployment**

   ```bash
   # Tag current state
   git tag -a canonical-mapping-phase1-rollback -m "Rollback point"
   ```

2. **Revert to previous version**
   - Deploy previous Search-AI image
   - Verify pods healthy
   - MongoDB schema is backward compatible (connectorId nullable)

3. **Document rollback reason**
   - Add to deployment log
   - Create post-mortem ticket

### Data Rollback (if needed)

Backfill script is idempotent and safe. If connectorId data is incorrect:

```bash
# Reset connectorId to null for specific tenant
db.search_documents.updateMany(
  { tenantId: "tenant_xxx" },
  { $set: { connectorId: null }}
)

# Re-run backfill
pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --tenant-id=tenant_xxx
```

## Success Criteria

Phase 1 deployment is successful when:

- [ ] All documents have correct connectorId (or null for direct uploads)
- [ ] Cache hit rate >70% after 1 hour
- [ ] No error rate increase (baseline: <1%)
- [ ] No memory leaks over 24 hours
- [ ] Redis pub/sub working across multiple pods
- [ ] Audit logs capturing all mapping operations
- [ ] All smoke tests passing
- [ ] Performance baseline maintained or improved

## Sign-Off

- [ ] **Tech Lead**: Code review approved
- [ ] **QA**: All validation tests passing
- [ ] **DevOps**: Staging deployment successful, monitoring configured
- [ ] **Product**: Feature works as expected

**Approved for production deployment**: [ ] Yes [ ] No

**Notes:**

---

**Last Updated**: 2026-03-03
**Phase**: 1 - connectorId + LRU cache + Redis pub/sub
**Next Phase**: 2 - Transform engine implementation
