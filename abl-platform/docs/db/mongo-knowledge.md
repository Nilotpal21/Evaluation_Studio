# MongoDB: knowledge

### Collection: `knowledge_bases`

```javascript
{
  _id: String,
  tenantId: String,
  name: String,
  description: String | null,
  sourceType: String,
  sourceConfig: Object,            // native object
  indexStatus: String,
  documentCount: Number,
  lastIndexedAt: Date | null,
  indexError: String | null,
  embeddingModel: String,
  chunkSize: Number,
  chunkOverlap: Number,
  isPublic: Boolean,
  metadata: Object,                // native object
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, name: 1 }    // unique
{ tenantId: 1 }
{ indexStatus: 1 }
{ sourceType: 1 }
```

### Collection: `resource_groups`

```javascript
{
  _id: String,
  tenantId: String,
  name: String,
  description: String | null,
  icon: String | null,
  metadata: Object,                // native object
  createdAt: Date,
  updatedAt: Date,

  // Embedded: members (1:many but bounded)
  members: [{
    id: String,
    resourceType: String,
    resourceId: String,
    addedBy: String,
    createdAt: Date
  }]
}

// Indexes
{ tenantId: 1, name: 1 }    // unique
{ tenantId: 1 }
{ "members.resourceType": 1, "members.resourceId": 1 }
```

### Collection: `facts`

```javascript
{
  _id: String,
  key: String,                     // unique
  value: String,                   // JSON.stringify(value)
  createdAt: Date,
  updatedAt: Date,
  expiresAt: Date | null,
  sourceType: String,
  sourceAgentName: String | null,
  sourceSessionId: String | null,
  sourceTraceId: String | null,
  metadata: Object                 // native object
}

// Indexes
{ key: 1 }                        // unique
{ expiresAt: 1 }                  // TTL index
{ sourceType: 1 }
```

## Notes

- ResourceGroupMember embedded in ResourceGroup (bounded per group, always accessed together)
- Fact.expiresAt gets TTL index for automatic cleanup
