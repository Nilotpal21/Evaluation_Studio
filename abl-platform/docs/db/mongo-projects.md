# MongoDB: projects

### Collection: `projects`

```javascript
{
  _id: String,                    // CUID
  name: String,
  slug: String,                   // unique
  description: String | null,
  ownerId: String,
  tenantId: String | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ slug: 1 }                       // unique
{ ownerId: 1 }
{ tenantId: 1 }
```

### Collection: `project_agents`

```javascript
{
  _id: String,
  projectId: String,
  name: String,
  agentPath: String,
  description: String | null,
  domain: String,                 // default: "default"
  dslContent: String | null,
  activeVersions: Object,         // native object (was JSON string)
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1, name: 1 }         // unique compound
{ projectId: 1 }
{ domain: 1 }
```

### Collection: `agent_versions`

```javascript
{
  _id: String,
  agentId: String,
  version: String,
  status: String,                 // draft, testing, staged, active, deprecated
  dslContent: String,
  irContent: String,              // compiled IR JSON
  sourceHash: String,
  changelog: String | null,
  createdBy: String,
  createdAt: Date,
  promotedAt: Date | null,
  promotedBy: String | null,
  testResults: Object | null      // native object (was JSON string)
}

// Indexes
{ agentId: 1, version: 1 }        // unique compound
{ agentId: 1 }
{ status: 1 }
```

### Collection: `project_members`

```javascript
{
  _id: String,
  projectId: String,
  userId: String,
  role: String,
  customRoleId: String | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1, userId: 1 }       // unique compound
{ userId: 1 }
```

### Collection: `model_configs`

```javascript
{
  _id: String,
  projectId: String,
  name: String,
  modelId: String,
  provider: String,
  credentialId: String | null,
  tenantModelId: String | null,
  temperature: Number,
  maxTokens: Number,
  topP: Number,
  frequencyPenalty: Number,
  presencePenalty: Number,
  inputCostPer1k: Number | null,
  outputCostPer1k: Number | null,
  supportsTools: Boolean,
  supportsVision: Boolean,
  supportsStreaming: Boolean,
  contextWindow: Number,
  tier: String,
  isDefault: Boolean,
  priority: Number,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1, name: 1 }         // unique compound
{ projectId: 1 }
{ tier: 1 }
```

### Collection: `agent_model_configs`

```javascript
{
  _id: String,
  projectId: String,
  agentName: String,
  defaultModel: String | null,
  operationModels: Object,         // native object (was JSON string)
  temperature: Number | null,
  maxTokens: Number | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1, agentName: 1 }    // unique compound
{ projectId: 1 }
```

### Collection: `service_nodes`

```javascript
{
  _id: String,
  projectId: String,
  name: String,
  displayName: String,
  description: String | null,
  endpoint: String,
  method: String,
  authType: String,
  authConfig: Object | null,       // native object (was JSON string)
  encryptedSecrets: String | null,
  inputSchema: Object,             // native object (was JSON string)
  outputSchema: Object | null,     // native object (was JSON string)
  timeoutMs: Number,
  retryCount: Number,
  retryDelayMs: Number,
  rateLimitPerMinute: Number | null,
  rateLimitPerHour: Number | null,
  circuitBreakerThreshold: Number,
  circuitBreakerResetMs: Number,
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ projectId: 1, name: 1 }         // unique compound
{ projectId: 1 }
```

## Notes

- All JSON string fields become native MongoDB objects
- AgentVersion.irContent stays as String (large compiled IR blob, not queried internally)
- ServiceNode.encryptedSecrets stays as String (encrypted, not queryable)
