/**
 * PermissionManifest — Connector-agnostic security documentation interface.
 *
 * Each connector exports a manifest describing the permissions it requests,
 * data handling practices, retention policies, and compliance alignment.
 * This is the SINGLE SOURCE OF TRUTH consumed by:
 *   - Admin email generator (connector.service.ts)
 *   - Security export (connector-security.service.ts)
 *   - Studio UI (ScopesSection, ITAdminGuide, SecurityReviewDocument)
 */

// ─── Scope Justification ────────────────────────────────────────────────

export interface ScopeJustification {
  /** OAuth scope name (e.g., "Sites.Read.All") */
  scope: string;
  /** Application or Delegated */
  type: 'Application' | 'Delegated';
  /** Microsoft/provider generic description */
  description: string;
  /** Why the platform needs this scope */
  why: string;
  /** Features that depend on this scope */
  usedFor: string;
  /** What this scope CANNOT do (trust signal) */
  cannotDo: string;
  /**
   * When this scope is required. Undefined = always required.
   * Example: "Permission-aware search is enabled"
   */
  requiredWhen?: string;
}

/** A permission the connector deliberately does NOT request. */
export interface NotRequestedScope {
  scope: string;
  reason: string;
}

// ─── Data Handling ──────────────────────────────────────────────────────

export interface DataHandlingInfo {
  whatIsDownloaded: string;
  originalFilesStored: boolean;
  originalFilesNote: string;
  encryptionAtRest: string;
  encryptionInTransit: string;
  thirdPartySharing: string;
  tenantIsolation: string;
}

// ─── Data Retention ─────────────────────────────────────────────────────

export interface RetentionEntry {
  dataType: string;
  retention: string;
  cleanup: string;
}

// ─── Compliance Alignment ───────────────────────────────────────────────

export interface ComplianceMapping {
  practice: string;
  soc2: string;
  iso27001: string;
  gdpr: string;
}

// ─── Revocation ─────────────────────────────────────────────────────────

export interface RevocationInfo {
  methods: string[];
  consequences: string[];
  fullRemoval: string;
}

// ─── Known Limitation ───────────────────────────────────────────────────

export interface KnownLimitation {
  description: string;
  impact: string;
}

// ─── Blast Radius Tier ──────────────────────────────────────────────────

export interface BlastRadiusTier {
  scopeLevel: string;
  risk: string;
  description: string;
}

// ─── Permission Manifest (top-level) ────────────────────────────────────

export interface PermissionManifest {
  /** Connector type identifier (e.g., "sharepoint") */
  connectorType: string;
  /** Human-readable display name (e.g., "SharePoint Online") */
  displayName: string;
  /** Platform version at time of manifest creation */
  version: string;

  /** Scopes always requested regardless of configuration */
  requiredScopes: ScopeJustification[];
  /** Scopes requested only when specific features are enabled */
  conditionalScopes: ScopeJustification[];
  /** Scopes deliberately NOT requested (trust signal) */
  notRequestedScopes: NotRequestedScope[];

  dataHandling: DataHandlingInfo;
  dataRetention: RetentionEntry[];
  complianceAlignment: ComplianceMapping[];
  revocation: RevocationInfo;
  knownLimitations: KnownLimitation[];
  blastRadiusTiers: BlastRadiusTier[];
}

/**
 * Resolve the effective scopes for a given connector configuration.
 * Returns required + conditional scopes that match the configuration.
 */
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
