# MongoDB: llm-config

### Collection: `llm_credentials`

```javascript
{
  _id: String,
  userId: String,
  tenantId: String | null,
  provider: String,
  name: String,
  encryptedApiKey: String,
  encryptedEndpoint: String | null,
  authType: String,
  authConfig: Object | null,       // native object
  isActive: Boolean,
  isDefault: Boolean,
  createdAt: Date,
  updatedAt: Date,
  lastUsedAt: Date | null,
  lastValidatedAt: Date | null
}

// Indexes
{ userId: 1, provider: 1, name: 1 }   // unique
{ userId: 1 }
{ provider: 1 }
{ tenantId: 1 }
```

### Collection: `tenant_models`

```javascript
{
  _id: String,
  tenantId: String,
  displayName: String,
  integrationType: String,         // "easy" | "api"

  // Easy integration
  modelId: String | null,
  provider: String | null,

  // API integration
  endpointUrl: String | null,
  providerStructure: String | null,
  requestTemplate: Object | null,   // native object (was JSON string)
  responseMapping: Object | null,   // native object
  customHeaders: Object | null,     // native object
  customEndpoint: String | null,
  gatewayConfig: Object | null,     // native object

  // Parameters
  temperature: Number,
  maxTokens: Number,

  // Capabilities
  supportsTools: Boolean,
  supportsStreaming: Boolean,
  supportsVision: Boolean,
  supportsStructured: Boolean,

  // Classification
  tier: String,
  isDefault: Boolean,
  isActive: Boolean,
  inferenceEnabled: Boolean,

  createdBy: String,
  createdAt: Date,
  updatedAt: Date,

  // Embedded: connections (1:few per model)
  connections: [{
    id: String,
    connectionName: String,
    credentialId: String | null,
    encryptedApiKey: String | null,
    authType: String,
    authConfig: Object | null,
    isActive: Boolean,
    isPrimary: Boolean,
    createdBy: String,
    createdAt: Date,
    updatedAt: Date
  }]
}

// Indexes
{ tenantId: 1, displayName: 1 }         // unique
{ tenantId: 1, tier: 1, isActive: 1 }
{ tenantId: 1, provider: 1, isActive: 1 }
```

### Collection: `tenant_service_instances`

```javascript
{
  _id: String,
  tenantId: String,
  displayName: String,
  serviceType: String,             // "deepgram", "elevenlabs", "twilio"
  encryptedApiKey: String,
  encryptedConfig: Object | null,  // native object (was JSON string)
  isDefault: Boolean,
  isActive: Boolean,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ tenantId: 1, serviceType: 1, displayName: 1 }   // unique
{ tenantId: 1, serviceType: 1, isActive: 1 }
```

## Notes

- TenantModelConnection is embedded in TenantModel (1:few, always accessed together)
- JSON string fields → native MongoDB objects
