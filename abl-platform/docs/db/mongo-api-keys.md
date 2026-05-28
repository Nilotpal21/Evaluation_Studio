# MongoDB: api-keys

### Collection: `api_keys`

```javascript
{
  _id: String,
  tenantId: String,
  name: String,
  clientId: String,
  keyHash: String,                // unique
  prefix: String,
  scopes: [String],               // native array
  projectIds: [String],           // native array
  environments: [String],         // native array
  expiresAt: Date | null,
  lastUsedAt: Date | null,
  createdBy: String,
  createdAt: Date,
  revokedAt: Date | null
}

// Indexes
{ keyHash: 1 }                    // unique
{ tenantId: 1, clientId: 1 } // unique compound
{ tenantId: 1 }
{ prefix: 1 }
```

### Collection: `public_api_keys`

```javascript
{
  _id: String,
  projectId: String,
  keyPrefix: String,
  keyHash: String,                // unique
  name: String,
  allowedOrigins: [String] | null, // native array (was JSON string)
  permissions: Object,             // native object
  lastUsedAt: Date | null,
  createdAt: Date,
  expiresAt: Date | null,
  isActive: Boolean
}

// Indexes
{ keyHash: 1 }                    // unique
{ projectId: 1 }
```

### Collection: `sdk_channels`

```javascript
{
  _id: String,
  tenantId: String,
  projectId: String,
  deploymentId: String | null,
  name: String,
  channelType: String,
  publicApiKeyId: String,
  config: Object,                  // native object
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, projectId: 1, name: 1 }  // unique
{ tenantId: 1, projectId: 1 }
{ publicApiKeyId: 1 }
```
