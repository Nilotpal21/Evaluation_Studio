# MongoDB: tenants

### Collection: `tenants`

```javascript
{
  _id: String,                    // CUID
  name: String,
  slug: String,                   // unique
  organizationId: String | null,
  ownerId: String,
  retentionDays: Number,          // default: 7
  settings: Object,               // native object (was JSON string)
  status: String,                 // active, suspended, archived, transferring
  createdAt: Date,
  updatedAt: Date,

  // Embedded: LLM policy (1:1 with tenant)
  llmPolicy: {
    allowedProviders: [String],   // native array (was JSON string)
    credentialPolicy: String,
    monthlyTokenBudget: Number,
    dailyTokenBudget: Number,
    defaultModel: String | null,
    defaultFastModel: String | null,
    maxRequestsPerMinute: Number,
    allowProjectCredentials: Boolean,
    platformDemoEnabled: Boolean,
    updatedAt: Date
  } | null
}

// Indexes
{ slug: 1 }                       // unique
{ organizationId: 1 }
{ ownerId: 1 }
{ status: 1 }
```

### Collection: `tenant_members`

```javascript
{
  _id: String,
  tenantId: String,
  userId: String,
  role: String,
  customRoleId: String | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, userId: 1 }        // unique compound
{ userId: 1 }
{ customRoleId: 1 }
```

### Collection: `workspace_invitations`

```javascript
{
  _id: String,
  tenantId: String,
  email: String,
  role: String,
  invitedBy: String | null,
  token: String,                   // unique
  status: String,                  // pending, accepted, expired, revoked
  expiresAt: Date,
  acceptedAt: Date | null,
  acceptedBy: String | null,
  createdAt: Date
}

// Indexes
{ token: 1 }                      // unique
{ tenantId: 1, email: 1 }         // unique compound
{ email: 1 }
{ expiresAt: 1 }                  // TTL index for auto-cleanup
```

## Notes

- TenantLLMPolicy is embedded in `tenants` (1:1, always accessed together)
- JSON string fields become native MongoDB objects/arrays
