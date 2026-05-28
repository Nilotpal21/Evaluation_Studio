# MongoDB: audit

### Collection: `audit_logs`

```javascript
{
  _id: String,
  userId: String | null,
  tenantId: String | null,
  action: String,
  ip: String | null,
  userAgent: String | null,
  metadata: Object | null,            // native object
  createdAt: Date
}

// Indexes
{ tenantId: 1, createdAt: -1 }
{ userId: 1 }
{ action: 1 }
{ createdAt: -1 }
```

## Notes

- `metadata` stored as native MongoDB object
- High-volume audit events (trace-level) go to ClickHouse `audit_events` table instead; this collection is for control-plane audit (login, config changes, RBAC updates)
- Capped collection or TTL index on `createdAt` recommended for retention management
