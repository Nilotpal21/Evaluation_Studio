# MongoDB: conversations

### Collection: `conversations`

```javascript
{
  _id: String,                    // CUID
  tenantId: String,
  projectId: String,

  // Who
  contactId: String | null,
  callerNumber: String | null,
  initiatedById: String | null,
  customerId: String | null,      // legacy external customer ID
  anonymousId: String | null,

  // What
  currentAgent: String,
  agentVersion: String | null,
  environment: String,            // 'development' | 'staging' | 'production'
  entryAgentName: String | null,

  // Workflow
  workflowId: String | null,
  workflowStepId: String | null,
  parentId: String | null,

  // Channel
  channel: String,                // 'web' | 'voice' | 'sms' | 'whatsapp' | 'email' | 'api'
  channelHistory: [String],       // native array (was JSON string)

  // State
  status: String,                 // 'active' | 'idle' | 'completed' | 'escalated' | 'abandoned' | 'archived'
  disposition: String | null,
  dispositionCode: String | null,
  context: Object | null,         // native object
  metadata: Object | null,        // native object

  // Deployment
  deploymentId: String | null,
  projectSlug: String | null,
  region: String | null,

  // Voice-specific
  callDuration: Number | null,

  // Counters (denormalized)
  messageCount: Number,           // default: 0
  tokenCount: Number,             // default: 0
  estimatedCost: Number,          // default: 0
  errorCount: Number,             // default: 0
  handoffCount: Number,           // default: 0

  // Billing
  billingPeriod: String | null,   // 'YYYY-MM'
  isTest: Boolean,                // default: false

  // Tags
  tags: [String],                 // native array (was JSON string)

  // Timestamps
  startedAt: Date,
  lastActivityAt: Date,
  endedAt: Date | null,
  archivedAt: Date | null
}

// Indexes
{ tenantId: 1, status: 1, lastActivityAt: -1 }     // retention sweep
{ tenantId: 1, contactId: 1 }                        // contact history
{ tenantId: 1, callerNumber: 1 }                     // voice lookup
{ tenantId: 1, workflowId: 1 }                       // workflow sessions
{ tenantId: 1, projectId: 1, environment: 1 }        // project filter
{ tenantId: 1, initiatedById: 1 }                    // user sessions
{ tenantId: 1, billingPeriod: 1, isTest: 1 }         // billing queries
{ tenantId: 1, projectSlug: 1, status: 1 }           // project dashboard
{ tenantId: 1, entryAgentName: 1, startedAt: -1 }   // agent analytics
{ tenantId: 1, environment: 1, status: 1 }           // env filtering
{ deploymentId: 1, status: 1 }                              // deployment health
{ customerId: 1 }
{ anonymousId: 1 }
{ parentId: 1 }
```

## Notes

- All JSON string fields → native MongoDB types
- This is the highest-volume MongoDB collection (~1M writes/day)
