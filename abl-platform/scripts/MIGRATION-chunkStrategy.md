# Migration: chunkStrategy → tokenChunkStrategy

**Date:** 2026-02-24  
**Issue:** ABLP-2 (Feature branch merge)  
**Script:** `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`

---

## Purpose

Rename the `SearchIndex.chunkStrategy` field to `SearchIndex.tokenChunkStrategy` to clarify its purpose and support the new page-based chunking default.

## Context

### Before (Develop Branch)

```typescript
// All indices had chunkStrategy (required)
{
  chunkStrategy: {
    method: 'fixed',      // Token-based chunking
    chunkSize: 1024,
    chunkOverlap: 128
  }
}
```

- **Default behavior**: Token-based chunking (LlamaIndex)
- **Field**: Required with default values

### After (Feature Branch)

```typescript
// Indices have tokenChunkStrategy (optional)
{
  tokenChunkStrategy: {
    method: 'fixed',      // Explicit: token-based
    chunkSize: 1024,
    chunkOverlap: 128
  }
}

// OR null for page-based (default)
{
  tokenChunkStrategy: null  // Page-based (Docling)
}
```

- **Default behavior**: Page-based chunking (Docling) when `tokenChunkStrategy = null`
- **Field**: Optional (null = page-based, set = token-based)

## What This Migration Does

1. **Renames field**: `chunkStrategy` → `tokenChunkStrategy`
2. **Preserves values**: All existing configuration is kept intact
3. **Idempotent**: Safe to run multiple times
4. **Non-destructive**: Only renames, no data loss

## When to Run

**Run this migration when:**

- Merging the feature branch into develop
- Deploying to environments with existing indices from develop
- Migrating development/staging databases

**DO NOT run if:**

- Your database only has indices created from the feature branch (already use `tokenChunkStrategy`)
- You haven't merged the feature branch code yet (code expects old field name)

## How to Run

### Step 1: Dry Run (Recommended)

Test the migration without making changes:

```bash
# From repository root
npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts --dry-run
```

**Expected output:**

```
========================================
Migration: chunkStrategy → tokenChunkStrategy
========================================
Mode: DRY RUN (no changes)
Batch size: 100

✓ Found 42 total indices
✓ Found 42 indices needing migration
✓ Found 0 indices already migrated

Starting migration of 42 indices...
...
✓ DRY RUN COMPLETE - No changes made
  Run without --dry-run flag to apply changes
```

### Step 2: Review Results

Check the output to ensure:

- Number of indices matches expectations
- No unexpected errors
- All indices needing migration are identified

### Step 3: Run Migration

Apply the changes:

```bash
npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts
```

**Expected output:**

```
========================================
Migration: chunkStrategy → tokenChunkStrategy
========================================
Mode: LIVE (will modify data)
Batch size: 100

✓ Found 42 total indices
✓ Found 42 indices needing migration
✓ Found 0 indices already migrated

Starting migration of 42 indices...
Processing batch 1/1 (42 indices)...
  ✓ Batch 1/1 complete

✅ Verification passed: All indices migrated successfully

========================================
Migration Summary
========================================
Total indices:        42
Needed migration:     42
Already migrated:     0
Migrated this run:    42
Errors:               0

✅ MIGRATION COMPLETE
```

### Step 4: Verify

Check a few indices in MongoDB to confirm:

```bash
# Connect to MongoDB
mongosh

# Check before state (should be empty)
db.search_indexes.find({ chunkStrategy: { $exists: true } }).count()
// Expected: 0

# Check after state (should have migrated records)
db.search_indexes.find({ tokenChunkStrategy: { $exists: true } }).count()
// Expected: 42 (or your total count)

# Inspect a migrated index
db.search_indexes.findOne({ tokenChunkStrategy: { $exists: true } })
// Should show tokenChunkStrategy field with preserved values
```

## Troubleshooting

### "Database connection not established"

**Cause:** MongoDB connection string not configured

**Fix:**

```bash
export MONGODB_URI="mongodb://localhost:27017/agent-platform"
npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts
```

### "Warning: X indices still have chunkStrategy"

**Cause:** Migration didn't complete for some indices (errors)

**Fix:**

1. Check error logs for specific indices
2. Fix issues (permissions, connection, etc.)
3. Re-run migration (idempotent)

### Migration runs but no indices found

**Cause:** Either:

- Database already migrated
- Wrong database connected
- No indices exist

**Fix:**

```bash
# Verify you're connected to the right database
mongosh $MONGODB_URI
db.search_indexes.countDocuments()

# Check for old field
db.search_indexes.find({ chunkStrategy: { $exists: true } }).count()

# Check for new field
db.search_indexes.find({ tokenChunkStrategy: { $exists: true } }).count()
```

## Rollback

If you need to undo the migration:

```bash
mongosh $MONGODB_URI

# Rename back
db.search_indexes.updateMany(
  { tokenChunkStrategy: { $exists: true } },
  { $rename: { tokenChunkStrategy: 'chunkStrategy' } }
)
```

**⚠️ Warning:** Only rollback if you're reverting the code changes too. The new code expects `tokenChunkStrategy`.

## Options

- `--dry-run`: Test migration without making changes
- `--verbose`: Show detailed progress for each index

## Safety Features

✅ **Idempotent**: Safe to run multiple times  
✅ **Batch processing**: Handles large datasets  
✅ **Verification**: Post-migration checks  
✅ **Error handling**: Continues on individual failures  
✅ **Non-destructive**: Only renames, preserves data

## Questions?

Contact the platform team or check:

- Database model: `packages/database/src/models/search-index.model.ts`
- Feature branch: `feat/atlas-kg-merged-with-develop-2026-02-24`
- Related commit: `ac9ab874` (original chunkStrategy removal)
