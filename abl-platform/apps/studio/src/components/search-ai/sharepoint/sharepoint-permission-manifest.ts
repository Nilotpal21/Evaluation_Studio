/**
 * SharePoint Permission Manifest — Studio-side copy
 *
 * This is the client-side source of truth for permission justification
 * data used by ITAdminGuide, SecurityReviewDocument, and ScopesSection.
 *
 * The canonical PermissionManifest interface and SharePoint implementation
 * live in packages/connectors/base/ and packages/connectors/sharepoint/.
 * This Studio copy avoids adding a server-package dependency to the frontend.
 *
 * Keep in sync with:
 *   - packages/connectors/base/src/security/permission-manifest.ts (interface)
 *   - packages/connectors/sharepoint/src/security/permission-manifest.ts (data)
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface ScopeJustification {
  scope: string;
  type: 'Application' | 'Delegated';
  description: string;
  why: string;
  usedFor: string;
  cannotDo: string;
  requiredWhen?: string;
}

export interface NotRequestedScope {
  scope: string;
  reason: string;
}

export interface DataHandlingInfo {
  whatIsDownloaded: string;
  originalFilesStored: boolean;
  originalFilesNote: string;
  encryptionAtRest: string;
  encryptionInTransit: string;
  thirdPartySharing: string;
  tenantIsolation: string;
}

export interface RetentionEntry {
  dataType: string;
  retention: string;
  cleanup: string;
}

export interface ComplianceMapping {
  practice: string;
  soc2: string;
  iso27001: string;
  gdpr: string;
}

export interface RevocationInfo {
  methods: string[];
  consequences: string[];
  fullRemoval: string;
}

export interface KnownLimitation {
  description: string;
  impact: string;
}

export interface BlastRadiusTier {
  scopeLevel: string;
  risk: string;
  description: string;
}

export interface PermissionManifest {
  connectorType: string;
  displayName: string;
  version: string;
  requiredScopes: ScopeJustification[];
  conditionalScopes: ScopeJustification[];
  notRequestedScopes: NotRequestedScope[];
  dataHandling: DataHandlingInfo;
  dataRetention: RetentionEntry[];
  complianceAlignment: ComplianceMapping[];
  revocation: RevocationInfo;
  knownLimitations: KnownLimitation[];
  blastRadiusTiers: BlastRadiusTier[];
}

// ─── Resolve Helper ─────────────────────────────────────────────────────

export function resolveEffectiveScopes(
  manifest: PermissionManifest,
  options: { permissionAwareEnabled: boolean },
): {
  requested: ScopeJustification[];
  notRequested: NotRequestedScope[];
} {
  const requested = [...manifest.requiredScopes];
  const notRequested = [...manifest.notRequestedScopes];

  for (const scope of manifest.conditionalScopes) {
    if (options.permissionAwareEnabled) {
      requested.push(scope);
    } else {
      notRequested.push({
        scope: scope.scope,
        reason: `Not needed — ${scope.requiredWhen ?? 'optional feature'} is disabled`,
      });
    }
  }

  return { requested, notRequested };
}

// ─── SharePoint Manifest Data ───────────────────────────────────────────

export const SHAREPOINT_PERMISSION_MANIFEST: PermissionManifest = {
  connectorType: 'sharepoint',
  displayName: 'SharePoint Online',
  version: '1.0.0',

  requiredScopes: [
    {
      scope: 'Sites.Read.All',
      type: 'Application',
      description: 'Read items in all site collections',
      why: 'Discover and read site structure, document libraries, and metadata for search indexing',
      usedFor: 'Site discovery, document enumeration, delta sync, permission reading',
      cannotDo: 'Create, modify, or delete any sites or content',
    },
    {
      scope: 'Files.Read.All',
      type: 'Application',
      description: 'Read all files that user can access',
      why: 'Read document content (Word, PDF, Excel, PowerPoint, HTML) for text extraction and indexing',
      usedFor: 'Content indexing, webhook-based real-time sync',
      cannotDo: 'Upload, modify, or delete any files',
    },
    {
      scope: 'offline_access',
      type: 'Delegated',
      description: 'Maintain access to data you have given it access to',
      why: 'Background sync runs on schedule (hourly/daily) and requires token refresh without re-authentication',
      usedFor: 'Scheduled sync, token refresh for unattended operations',
      cannotDo: 'Escalate access or bypass admin consent',
    },
  ],

  conditionalScopes: [
    {
      scope: 'GroupMember.Read.All',
      type: 'Application',
      description: 'Read all group memberships',
      why: 'Resolve Active Directory group memberships so search results respect the same access controls that exist in SharePoint',
      usedFor:
        'Permission-aware search — if a user cannot see a document in SharePoint, they will not see it in search results',
      cannotDo: 'Modify group memberships or read anything beyond group member lists',
      requiredWhen: 'Permission-aware search is enabled',
    },
  ],

  notRequestedScopes: [
    { scope: 'Sites.ReadWrite.All', reason: 'We never write to SharePoint' },
    { scope: 'Sites.FullControl.All', reason: 'We never need admin-level access' },
    { scope: 'Files.ReadWrite.All', reason: 'We never modify or delete files' },
    { scope: 'User.ReadWrite.All', reason: 'We never modify user profiles' },
    { scope: 'Mail.Read', reason: 'We never access email or Exchange' },
    { scope: 'Mail.ReadWrite', reason: 'We never access email or Exchange' },
    { scope: 'Calendars.Read', reason: 'We never access calendar data' },
    { scope: 'Chat.Read', reason: 'We never access Teams chat messages' },
  ],

  dataHandling: {
    whatIsDownloaded:
      'Document text content only (Word, PDF, Excel, PowerPoint, HTML). Metadata such as author, modified date, and file size.',
    originalFilesStored: false,
    originalFilesNote:
      'Only extracted text and vector embeddings are stored — original files are never retained',
    encryptionAtRest: 'AES-256-GCM with tenant-specific data encryption keys',
    encryptionInTransit: 'TLS 1.2+ for all connections',
    thirdPartySharing: 'None — all processing is internal to the platform',
    tenantIsolation:
      'All data is scoped to your tenant. Cross-tenant access is architecturally impossible and returns 404.',
  },

  dataRetention: [
    {
      dataType: 'Synced documents (text + metadata)',
      retention: 'Until connector is deleted',
      cleanup: 'Cascading delete removes all documents, chunks, and embeddings',
    },
    {
      dataType: 'Vector embeddings',
      retention: 'Until connector is deleted',
      cleanup: 'Queued for cleanup within 15 minutes of deletion',
    },
    {
      dataType: 'Discovery cache (site list)',
      retention: '7-day TTL',
      cleanup: 'Auto-purged after expiry',
    },
    {
      dataType: 'OAuth tokens (access + refresh)',
      retention: 'Until revoked or expired',
      cleanup: 'Revocable instantly via platform UI or Azure AD portal',
    },
    {
      dataType: 'Sync job data',
      retention: '24-hour retention',
      cleanup: 'Auto-purged by job queue',
    },
    { dataType: 'Audit logs', retention: '90 days (configurable)', cleanup: 'Automatic rotation' },
  ],

  complianceAlignment: [
    {
      practice: 'Encryption at rest (AES-256-GCM)',
      soc2: 'CC6.1 — Logical and physical access controls',
      iso27001: 'A.10.1.1 — Cryptographic controls policy',
      gdpr: 'Art. 32(1)(a) — Encryption of personal data',
    },
    {
      practice: 'Encryption in transit (TLS 1.2+)',
      soc2: 'CC6.7 — Transmission security',
      iso27001: 'A.13.1.1 — Network controls',
      gdpr: 'Art. 32(1)(a) — Encryption of personal data',
    },
    {
      practice: 'Tenant data isolation',
      soc2: 'CC6.3 — Authorized access only',
      iso27001: 'A.9.4.1 — Information access restriction',
      gdpr: 'Art. 25 — Data protection by design',
    },
    {
      practice: 'Read-only permissions (no write access)',
      soc2: 'CC6.1 — Principle of least privilege',
      iso27001: 'A.9.1.2 — Access to networks and services',
      gdpr: 'Art. 5(1)(c) — Data minimization',
    },
    {
      practice: 'Instant token revocation',
      soc2: 'CC6.2 — Access revocation',
      iso27001: 'A.9.2.6 — Removal of access rights',
      gdpr: 'Art. 17 — Right to erasure',
    },
    {
      practice: 'Immutable audit logging',
      soc2: 'CC7.2 — Monitoring activities',
      iso27001: 'A.12.4.1 — Event logging',
      gdpr: 'Art. 30 — Records of processing activities',
    },
    {
      practice: 'Data retention with TTLs',
      soc2: 'CC6.5 — Data disposal',
      iso27001: 'A.8.3.2 — Disposal of media',
      gdpr: 'Art. 5(1)(e) — Storage limitation',
    },
  ],

  revocation: {
    methods: [
      'One-click emergency revoke from the platform Security tab',
      'Remove the app registration from Azure AD portal',
      'Revoke admin consent from Azure AD > Enterprise Applications',
    ],
    consequences: [
      'All active and scheduled syncs stop immediately',
      'OAuth tokens (access + refresh) are invalidated',
      'Existing indexed data remains searchable until connector is deleted',
      'Vector embedding cleanup queued within 15 minutes',
    ],
    fullRemoval:
      'Delete the connector to permanently remove all indexed documents, vector embeddings, metadata, and audit entries.',
  },

  knownLimitations: [
    {
      description: 'Webhooks require a publicly accessible HTTPS endpoint',
      impact: 'Without webhooks, delta sync runs on schedule (hourly/daily) as a fallback',
    },
    {
      description: 'Vector embedding cleanup is queued, not instant',
      impact: 'Up to 15 minutes between document deletion and embedding removal',
    },
    {
      description: 'Without GroupMember.Read.All, search accuracy is reduced',
      impact: '~70-85% accuracy vs ~95%+ with permission-aware search enabled',
    },
    {
      description: 'Sharing links with "Anyone with the link" have limited resolution',
      impact: 'Specific recipients of sharing links may not be individually resolvable',
    },
  ],

  blastRadiusTiers: [
    {
      scopeLevel: 'Sites.Selected',
      risk: 'Minimal',
      description:
        'Only admin-approved sites are accessible. Attacker with stolen token can only read explicitly granted sites.',
    },
    {
      scopeLevel: 'Sites.Read.All',
      risk: 'Moderate',
      description:
        'All sites in tenant are readable (read-only). Attacker with stolen token could read any site but cannot modify, delete, or exfiltrate data outside the platform.',
    },
  ],
};
