# MongoDB: rbac

### Collection: `role_definitions`

```javascript
{
  _id: String,
  tenantId: String,
  name: String,
  description: String | null,
  isSystem: Boolean,
  permissions: [String],           // native array (was JSON string)
  parentRoleId: String | null,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, name: 1 }          // unique compound
{ tenantId: 1 }
```

### Collection: `resource_permissions`

```javascript
{
  _id: String,
  tenantId: String,
  userId: String,
  resourceType: String,
  resourceId: String,
  operations: [String],            // native array (was JSON string)
  grantedBy: String,
  expiresAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, userId: 1, resourceType: 1, resourceId: 1 }  // unique
{ tenantId: 1, userId: 1 }
{ tenantId: 1, resourceType: 1, resourceId: 1 }
{ userId: 1 }
```

### Collection: `resource_types`

```javascript
{
  _id: String,
  name: String,                    // unique
  displayName: String,
  description: String | null,
  isSystem: Boolean,
  createdAt: Date,
  updatedAt: Date,

  // Embedded: operations (1:few per type)
  operations: [{
    id: String,
    name: String,
    displayName: String,
    description: String | null,
    isSystem: Boolean,
    createdAt: Date
  }]
}

// Indexes
{ name: 1 }                       // unique
```

## Notes

- ResourceOperation is embedded in ResourceType (1:few, always accessed together, seeded on startup)
- JSON string arrays become native MongoDB arrays
