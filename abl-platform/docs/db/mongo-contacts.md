# MongoDB: contacts

### Collection: `contacts`

```javascript
{
  _id: String,                    // CUID
  tenantId: String,

  // Identity
  type: String,                   // 'employee' | 'customer' | 'anonymous'
  identity: String | null,
  identityType: String | null,    // 'email' | 'phone' | 'external'
  displayName: String | null,

  // Employee-specific
  department: String | null,
  employeeId: String | null,

  // Customer-specific
  company: String | null,
  accountRef: String | null,

  // Common
  channel: String | null,
  metadata: Object | null,        // native object (was JSON string)
  tags: [String],                 // native array (was JSON string)
  firstSeenAt: Date,
  lastSeenAt: Date,
  deletedAt: Date | null          // soft delete marker
}

// Indexes
{ tenantId: 1, identityType: 1, identity: 1 }   // lookup
{ tenantId: 1, type: 1 }                          // filter by type
{ tenantId: 1, lastSeenAt: -1 }                   // recent contacts
{ tenantId: 1, deletedAt: 1 }                     // soft-deleted filter
```

## Notes

- No unique constraint on identity (phone numbers can be shared, anonymous callers have none)
- Soft delete clears PII fields and sets `deletedAt`
