# MongoDB: billing

### Collection: `subscriptions`

```javascript
{
  _id: String,
  organizationId: String | null,
  tenantId: String,
  planTier: String,
  billingCycle: String,
  billingStartDate: Date,
  billingEndDate: Date | null,
  status: String,
  trialEndsAt: Date | null,
  canceledAt: Date | null,
  externalBillingId: String | null,
  externalCustomerId: String | null,
  orgLimits: Object,               // native object
  entitlements: [String],          // native array
  createdAt: Date,
  updatedAt: Date,

  // Embedded: quotas (1:few per subscription)
  tenantQuotas: [{
    id: String,
    tenantId: String,
    allocatedLimits: Object,       // native object
    burstAllowed: Boolean,
    createdAt: Date,
    updatedAt: Date,
    projectQuotas: [{
      id: String,
      projectId: String,
      allocatedLimits: Object,     // native object
      overageBehavior: String,
      createdAt: Date,
      updatedAt: Date
    }]
  }]
}

// Indexes
{ organizationId: 1 }
{ tenantId: 1 }
{ status: 1 }
{ planTier: 1 }
```

### Collection: `usage_periods`

```javascript
{
  _id: String,
  subscriptionId: String,
  periodStart: Date,
  periodEnd: Date,
  periodLabel: String,
  totalSessions: Number,
  totalMessages: Number,
  totalTokens: Number,
  totalToolCalls: Number,
  totalEstimatedCost: Number,
  peakConcurrentSessions: Number,
  tenantBreakdown: Object,         // native object
  invoiced: Boolean,
  invoiceId: String | null,
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ subscriptionId: 1, periodLabel: 1 }   // unique
{ subscriptionId: 1 }
{ periodLabel: 1 }
{ invoiced: 1 }
```

## Notes

- TenantQuota and ProjectQuota are embedded in Subscription (hierarchical, always accessed together)
- JSON string fields → native MongoDB objects/arrays
