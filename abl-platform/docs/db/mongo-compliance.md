# MongoDB: compliance

### Collection: `deletion_requests`

```javascript
{
  _id: String,
  tenantId: String,
  requestedBy: String,
  subjectId: String,
  scope: String,
  status: String,                 // pending, in_progress, completed, failed
  slaDeadline: Date,
  escalatedAt: Date | null,
  retryCount: Number,
  completedAt: Date | null,
  createdAt: Date
}

// Indexes
{ tenantId: 1 }
{ status: 1 }
{ subjectId: 1 }
{ slaDeadline: 1 }
```

### Collection: `archive_manifests`

```javascript
{
  _id: String,
  tenantId: String,
  type: String,
  recordCount: Number,
  sizeBytes: Number,
  storageKey: String,
  storageBucket: String | null,
  region: String | null,
  checksum: String,
  format: String,
  dateRangeStart: Date,
  dateRangeEnd: Date,
  createdAt: Date
}

// Indexes
{ tenantId: 1 }
{ type: 1 }
{ createdAt: -1 }
```
