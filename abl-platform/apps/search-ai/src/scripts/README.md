# Search-AI Scripts

Maintenance and migration scripts for Search-AI.

## Backfill Scripts

### backfill-connector-id.ts

Populates the `connectorId` field in SearchDocument for documents that were ingested before the field existed.

**Usage:**

```bash
# Dry run (preview changes without applying)
pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --dry-run

# Apply changes
pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts

# Backfill for specific tenant only
pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --tenant-id=tenant_abc123

# Custom batch size (default: 1000)
pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts --batch-size=500
```

**Options:**

- `--dry-run` — Preview changes without updating database
- `--batch-size=N` — Process N documents per batch (default: 1000)
- `--tenant-id=X` — Only backfill for specific tenant (optional)

**When to run:**

Run this script once after deploying the canonical mapping changes to production. It populates `connectorId` for existing documents so canonical field mappings can be applied.

**Safety:**

- The script processes documents in batches to avoid memory issues
- It only updates documents where `connectorId` is null
- Use `--dry-run` first to preview changes
- The script is idempotent - safe to run multiple times
