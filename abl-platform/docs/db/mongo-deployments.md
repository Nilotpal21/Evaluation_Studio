# MongoDB: deployments

### Collection: `deployments`

```javascript
{
  _id: String,
  projectId: String,
  tenantId: String,
  environment: String,               // 'dev', 'staging', 'prod', 'test'
  label: String | null,
  description: String | null,
  agentVersionManifest: Object,      // native object: { "booking_agent": "1.2.0" }
  entryAgentName: String,
  compilationHash: String | null,
  status: String,                    // 'active', 'draining', 'retired'
  endpointSlug: String,              // unique
  previousDeploymentId: String | null,
  createdBy: String,
  createdAt: Date,
  retiredAt: Date | null,
  drainingStartedAt: Date | null
}

// Indexes
{ endpointSlug: 1 }                              // unique
{ projectId: 1, environment: 1, createdAt: -1 }  // unique
{ projectId: 1, environment: 1, status: 1 }
{ tenantId: 1 }
{ status: 1 }
```

## Notes

- `agentVersionManifest` stored as native MongoDB object
- `endpointSlug` unique index for URL routing
- `previousDeploymentId` preserves rollback chain
