# MongoDB: sdk

### Collection: `widget_configs`

```javascript
{
  _id: String,
  projectId: String,               // unique
  mode: String,
  position: String,
  theme: Object,                   // native object
  welcomeMessage: String | null,
  placeholderText: String | null,
  voiceEnabled: Boolean,
  chatEnabled: Boolean,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1 }                   // unique
```

### Collection: `debug_tokens`

```javascript
{
  _id: String,
  token: String,                   // unique
  userId: String,
  sessionIds: [String],            // native array
  scopes: [String],                // native array
  expiresAt: Date,
  createdAt: Date,
  lastUsedAt: Date | null,
  revokedAt: Date | null
}

// Indexes
{ token: 1 }                      // unique
{ userId: 1 }
{ expiresAt: 1 }                  // TTL index
```

### Collection: `device_auth_requests`

```javascript
{
  _id: String,
  deviceCode: String,              // unique
  userCode: String,                // unique
  scopes: [String],                // native array
  expiresAt: Date,
  createdAt: Date,
  userId: String | null,
  authorizedAt: Date | null,
  consumedAt: Date | null
}

// Indexes
{ deviceCode: 1 }                 // unique
{ userCode: 1 }                   // unique
{ expiresAt: 1 }                  // TTL index
```
