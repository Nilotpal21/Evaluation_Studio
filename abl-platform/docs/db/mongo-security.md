# MongoDB: security

### Collection: `tool_secrets`

```javascript
{
  _id: String,
  tenantId: String,
  projectId: String,
  toolName: String,
  secretKey: String,
  encryptedValue: String,
  environment: String,
  version: Number,
  expiresAt: Date | null,
  rotatedAt: Date | null,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, projectId: 1, toolName: 1, secretKey: 1, environment: 1 }  // unique
{ tenantId: 1, projectId: 1 }
```

### Collection: `end_user_oauth_tokens`

```javascript
{
  _id: String,
  tenantId: String,
  userId: String,
  provider: String,
  providerUserId: String,
  encryptedAccessToken: String,
  encryptedRefreshToken: String | null,
  scope: String,
  expiresAt: Date | null,
  refreshedAt: Date | null,
  consentedAt: Date,
  revokedAt: Date | null,
  lastUsedAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, userId: 1, provider: 1 }   // unique
{ tenantId: 1 }
```

### Collection: `org_proxy_configs`

```javascript
{
  _id: String,
  tenantId: String,
  name: String,
  proxyUrl: String,
  proxyAuthType: String,
  encryptedProxyUsername: String | null,
  encryptedProxyPassword: String | null,
  encryptedProxyToken: String | null,
  encryptedCaCertificate: String | null,
  encryptedClientCert: String | null,
  encryptedClientKey: String | null,
  urlPatterns: String,
  bypassPatterns: String | null,
  environment: String,
  priority: Number,
  enabled: Boolean,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, name: 1, environment: 1 }  // unique
{ tenantId: 1, environment: 1 }
```

### Collection: `key_versions`

```javascript
{
  _id: String,
  tenantId: String,
  version: Number,
  status: String,                 // active, decrypt_only, destroyed
  algorithm: String,
  createdAt: Date,
  rotatedAt: Date | null,
  destroyedAt: Date | null
}

// Indexes
{ tenantId: 1, version: 1 }   // unique
{ tenantId: 1 }
{ status: 1 }
```
