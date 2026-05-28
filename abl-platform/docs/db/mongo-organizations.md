# MongoDB: organizations

### Collection: `organizations`

```javascript
{
  _id: String,                    // CUID
  name: String,
  slug: String,                   // unique
  ownerId: String,                // references users._id
  billingEmail: String | null,
  billingConfig: Object,          // native object (was JSON string)
  compliance: [String],           // native array (was JSON string)
  settings: Object,               // native object (was JSON string)
  createdAt: Date,
  updatedAt: Date,

  // Embedded: SSO configs (1:few per org)
  ssoConfigs: [{
    id: String,
    protocol: String,             // 'saml' | 'oidc'
    encryptedConfig: String,
    forceSso: Boolean,
    allowGoogleFallback: Boolean,
    isActive: Boolean,
    createdAt: Date,
    updatedAt: Date
  }],

  // Embedded: Domain mappings (1:few per org)
  domainMappings: [{
    id: String,
    domain: String,
    verified: Boolean,
    verificationToken: String,
    verifiedAt: Date | null,
    createdAt: Date
  }]
}

// Indexes
{ slug: 1 }                       // unique
{ ownerId: 1 }
{ "domainMappings.domain": 1 }    // unique, sparse
```

### Collection: `org_members`

```javascript
{
  _id: String,
  organizationId: String,
  userId: String,
  role: String,                   // ORG_OWNER, ORG_ADMIN, ORG_MEMBER, ORG_BILLING
  createdAt: Date,
  updatedAt: Date
}

// Indexes
{ organizationId: 1, userId: 1 }  // unique compound
{ userId: 1 }
```

### Collection: `tenant_transfers`

```javascript
{
  _id: String,
  tenantId: String,
  sourceOrgId: String,
  targetOrgId: String,
  status: String,
  initiatedBy: String,
  sourceApprovedBy: String | null,
  sourceApprovedAt: Date | null,
  targetApprovedBy: String | null,
  targetApprovedAt: Date | null,
  rejectedBy: String | null,
  rejectedAt: Date | null,
  rejectionReason: String | null,
  cancelledBy: String | null,
  cancelledAt: Date | null,
  assetInventory: Object,         // native object
  transferOptions: Object,        // native object
  executionStartedAt: Date | null,
  executionCompletedAt: Date | null,
  executionError: String | null,
  expiresAt: Date,
  createdAt: Date,
  updatedAt: Date,

  // Embedded: transfer logs (append-only, bounded)
  logs: [{
    id: String,
    action: String,
    performedBy: String,
    details: Object,
    createdAt: Date
  }]
}

// Indexes
{ tenantId: 1 }
{ sourceOrgId: 1 }
{ targetOrgId: 1 }
{ status: 1 }
```

## Notes

- SSOConfig and DomainMapping are embedded in Organization (1:few, always accessed together)
- TenantTransferLog is embedded in TenantTransfer (append-only audit trail, bounded per transfer)
- JSON string fields (`billingConfig`, `compliance`, `settings`, `assetInventory`, `transferOptions`) become native MongoDB objects/arrays
