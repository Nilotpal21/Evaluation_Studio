# MongoDB: workflows

### Collection: `workflows`

```javascript
{
  _id: String,                    // CUID
  tenantId: String,
  projectId: String,

  name: String,
  type: String,                   // 'cx_automation' | 'ex_automation' | 'internal'
  description: String | null,

  // Definition
  entryAgent: String,
  steps: [Object] | null,         // native array (was JSON string)
  triggers: [Object] | null,      // native array (was JSON string)

  // SLA & Escalation
  slaMinutes: Number | null,
  escalationRules: [Object] | null, // native array (was JSON string)

  status: String,                 // 'active' | 'paused' | 'archived'
  metadata: Object | null,        // native object (was JSON string)
  createdAt: Date,
  archivedAt: Date | null,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, projectId: 1, name: 1 }   // unique
{ tenantId: 1, type: 1, status: 1 }
{ tenantId: 1, projectId: 1 }
```

## Notes

- All JSON string fields → native MongoDB objects/arrays
