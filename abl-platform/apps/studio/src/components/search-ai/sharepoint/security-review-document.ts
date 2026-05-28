/**
 * Security Review Document Generator
 *
 * Generates a comprehensive security review document from a PermissionManifest.
 * This is a static, pre-connection document — no API call or connectorId needed.
 * The document is the SINGLE shareable artifact for IT admin / security team review.
 *
 * Structure (4 sections per PM review):
 *   1. Executive Summary
 *   2. Permissions Detail
 *   3. Security & Compliance
 *   4. Appendix
 */

import type {
  PermissionManifest,
  ScopeJustification,
  NotRequestedScope,
} from './sharepoint-permission-manifest';
import { resolveEffectiveScopes } from './sharepoint-permission-manifest';

export interface SecurityReviewDocumentOptions {
  /** Organization / tenant display name */
  organizationName?: string;
  /** Whether permission-aware search is enabled */
  permissionAwareEnabled: boolean;
  /** Name of the project/knowledge base */
  projectName?: string;
}

/**
 * Generate a comprehensive security review markdown document.
 * This is a static document — it can be generated pre-connection.
 */
export function generateSecurityReviewDocument(
  manifest: PermissionManifest,
  options: SecurityReviewDocumentOptions,
): string {
  const { requested, notRequested } = resolveEffectiveScopes(manifest, {
    permissionAwareEnabled: options.permissionAwareEnabled,
  });

  const timestamp = new Date().toISOString().split('T')[0];
  const org = options.organizationName ?? 'Your Organization';
  const scope = 'Pre-connection estimate';

  const sections = [
    generateHeader(manifest, timestamp, org, scope),
    generateExecutiveSummary(manifest, requested, notRequested),
    generatePermissionsDetail(requested, notRequested),
    generateSecurityCompliance(manifest),
    generateAppendix(manifest),
  ];

  return sections.join('\n\n---\n\n');
}

// ─── Section Generators ─────────────────────────────────────────────────

function generateHeader(
  manifest: PermissionManifest,
  timestamp: string,
  org: string,
  scope: string,
): string {
  return [
    `# ${manifest.displayName} Connector — Security Review`,
    '',
    `**Organization:** ${org}`,
    `**Generated:** ${timestamp}`,
    `**Scope:** ${scope}`,
    `**Connector Version:** ${manifest.version}`,
    '',
    '> Valid as of the generation date. Re-download for the current version.',
  ].join('\n');
}

function generateExecutiveSummary(
  manifest: PermissionManifest,
  requested: ScopeJustification[],
  notRequested: NotRequestedScope[],
): string {
  const allReadOnly = requested.every(
    (s) => s.scope.includes('Read') || s.scope === 'offline_access' || s.scope === 'User.Read',
  );

  return [
    '## 1. Executive Summary',
    '',
    `The ABL Platform ${manifest.displayName} connector indexes enterprise content`,
    'into a search index for AI-powered enterprise search. It requires read-only',
    'access to your content via OAuth 2.0 application permissions.',
    '',
    '### Risk Assessment',
    '',
    `| Aspect | Value |`,
    `|--------|-------|`,
    `| Permissions requested | ${requested.length} |`,
    `| Permissions NOT requested | ${notRequested.length} |`,
    `| Access type | ${allReadOnly ? '**Read-only** — no write access to your data' : 'Mixed (review details below)'} |`,
    `| Data stored | Extracted text and vector embeddings only — original files are never retained |`,
    `| Third-party sharing | None — all processing is internal |`,
    `| Instant revocation | Yes — one-click from platform or Azure AD portal |`,
    '',
    '### At a Glance',
    '',
    '**We request:**',
    ...requested.map((s) => `- ✓ \`${s.scope}\` (${s.type}) — ${s.why}`),
    '',
    '**We do NOT request:**',
    ...notRequested.slice(0, 5).map((s) => `- ✗ \`${s.scope}\` — ${s.reason}`),
    ...(notRequested.length > 5
      ? [`- ✗ ...and ${notRequested.length - 5} more (see Section 2)`]
      : []),
  ].join('\n');
}

function generatePermissionsDetail(
  requested: ScopeJustification[],
  notRequested: NotRequestedScope[],
): string {
  const requestedTable = [
    '| Permission | Type | Why We Need It | What It Cannot Do |',
    '|------------|------|----------------|-------------------|',
    ...requested.map((s) => `| \`${s.scope}\` | ${s.type} | ${s.why} | ${s.cannotDo} |`),
  ];

  const notRequestedTable = [
    '| Permission | Why We Do NOT Request It |',
    '|------------|-------------------------|',
    ...notRequested.map((s) => `| \`${s.scope}\` | ${s.reason} |`),
  ];

  return [
    '## 2. Permissions Detail',
    '',
    '### Requested Permissions',
    '',
    ...requestedTable,
    '',
    '**Usage detail per scope:**',
    '',
    ...requested
      .map((s) => [
        `#### \`${s.scope}\` (${s.type})`,
        '',
        `- **Why:** ${s.why}`,
        `- **Used for:** ${s.usedFor}`,
        `- **Cannot:** ${s.cannotDo}`,
        ...(s.requiredWhen ? [`- **Required when:** ${s.requiredWhen}`] : []),
        '',
      ])
      .flat(),
    '### Permissions NOT Requested',
    '',
    'The following permissions are deliberately excluded. This demonstrates',
    'adherence to the principle of least privilege.',
    '',
    ...notRequestedTable,
  ].join('\n');
}

function generateSecurityCompliance(manifest: PermissionManifest): string {
  const dh = manifest.dataHandling;

  const dataTable = [
    '| Aspect | Detail |',
    '|--------|--------|',
    `| What is downloaded | ${dh.whatIsDownloaded} |`,
    `| Original files stored? | ${dh.originalFilesStored ? 'Yes' : 'No'} — ${dh.originalFilesNote} |`,
    `| Encryption at rest | ${dh.encryptionAtRest} |`,
    `| Encryption in transit | ${dh.encryptionInTransit} |`,
    `| Third-party data sharing | ${dh.thirdPartySharing} |`,
    `| Tenant isolation | ${dh.tenantIsolation} |`,
  ];

  const complianceTable = [
    '| Practice | SOC 2 | ISO 27001 | GDPR |',
    '|----------|-------|-----------|------|',
    ...manifest.complianceAlignment.map(
      (c) => `| ${c.practice} | ${c.soc2} | ${c.iso27001} | ${c.gdpr} |`,
    ),
  ];

  return [
    '## 3. Security & Compliance',
    '',
    '### Data Handling',
    '',
    ...dataTable,
    '',
    '### Compliance Alignment',
    '',
    "The following table maps the connector's security practices to major",
    'compliance frameworks. This is not a certification claim — it demonstrates',
    'alignment with control objectives.',
    '',
    ...complianceTable,
  ].join('\n');
}

function generateAppendix(manifest: PermissionManifest): string {
  const retentionTable = [
    '| Data Type | Retention | Cleanup |',
    '|-----------|-----------|---------|',
    ...manifest.dataRetention.map((r) => `| ${r.dataType} | ${r.retention} | ${r.cleanup} |`),
  ];

  const blastTable = [
    '| Scope Level | Risk | Description |',
    '|-------------|------|-------------|',
    ...manifest.blastRadiusTiers.map(
      (b) => `| \`${b.scopeLevel}\` | ${b.risk} | ${b.description} |`,
    ),
  ];

  return [
    '## 4. Appendix',
    '',
    '### Data Retention',
    '',
    ...retentionTable,
    '',
    '### Revocation Procedures',
    '',
    '**How to revoke access:**',
    ...manifest.revocation.methods.map((m) => `1. ${m}`),
    '',
    '**What happens on revocation:**',
    ...manifest.revocation.consequences.map((c) => `- ${c}`),
    '',
    `**Full removal:** ${manifest.revocation.fullRemoval}`,
    '',
    '### Blast Radius Analysis',
    '',
    ...blastTable,
    '',
    '**Recommendation:** Use `Sites.Selected` if your organization requires',
    'explicit per-site approval to minimize blast radius.',
    '',
    '### Known Limitations',
    '',
    ...manifest.knownLimitations.map((l, i) => `${i + 1}. **${l.description}** — ${l.impact}`),
  ].join('\n');
}

/**
 * Generate the clipboard text for "Copy Request to Share".
 * Shorter than the full document — meant for pasting into Slack/Teams/ServiceNow.
 */
export function generateClipboardRequest(
  manifest: PermissionManifest,
  options: SecurityReviewDocumentOptions & {
    requestingUserName?: string;
    requestingUserEmail?: string;
    platformUrl?: string;
  },
): string {
  const { requested, notRequested } = resolveEffectiveScopes(manifest, {
    permissionAwareEnabled: options.permissionAwareEnabled,
  });

  const userName = options.requestingUserName ?? 'A team member';
  const userEmail = options.requestingUserEmail ?? '';
  const project = options.projectName ?? 'our enterprise search';
  const platform = options.platformUrl ?? '';

  const lines = [
    `SHAREPOINT CONNECTOR — PERMISSION REQUEST`,
    '',
    `Requested by: ${userName}${userEmail ? ` (${userEmail})` : ''}`,
    `Project: ${project}`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
    '',
    '── PERMISSIONS REQUESTED (all read-only) ──',
    '',
    ...requested.map((s) =>
      [
        `✓ ${s.scope} (${s.type})`,
        `  WHY: ${s.why}`,
        `  USED FOR: ${s.usedFor}`,
        `  CANNOT: ${s.cannotDo}`,
        '',
      ].join('\n'),
    ),
    '── PERMISSIONS NOT REQUESTED ──',
    '',
    ...notRequested.map((s) => `✗ ${s.scope} — ${s.reason}`),
    '',
    '── DATA HANDLING ──',
    '',
    `• Encryption: ${manifest.dataHandling.encryptionAtRest} at rest, ${manifest.dataHandling.encryptionInTransit}`,
    `• Original files stored: ${manifest.dataHandling.originalFilesStored ? 'Yes' : 'No'} — ${manifest.dataHandling.originalFilesNote}`,
    `• Third-party sharing: ${manifest.dataHandling.thirdPartySharing}`,
    `• Tenant isolation: ${manifest.dataHandling.tenantIsolation}`,
    '',
    '── SETUP STEPS ──',
    '',
    '1. Azure Portal > Azure Active Directory > App registrations > New registration',
    '2. Name: "ABL Platform SharePoint Connector"',
    '3. Supported account types: "Accounts in this organizational directory only"',
    ...(platform
      ? [`4. Redirect URI (Web): ${platform}/api/connectors/auth/callback`]
      : ['4. Redirect URI (Web): (ask your team for the platform callback URL)']),
    '5. API permissions > Add the Microsoft Graph permissions listed above',
    '6. Certificates & secrets > Create a new client secret',
    '7. Grant admin consent for all permissions',
    '',
    '⚠️  IMPORTANT: Do NOT reply with credentials via email.',
    `Enter the Client ID, Tenant ID, and Client Secret directly in the platform.`,
    ...(platform ? [`Platform URL: ${platform}`] : []),
    '',
    'For the full Security Review Document with compliance alignment,',
    'data retention, and revocation procedures, ask the requester to',
    'download it from the connector setup page.',
  ];

  return lines.join('\n');
}

/**
 * Generate a short email body for mailto: (under 1500 chars).
 * Points to the Security Review Document for full details.
 */
export function generateShortEmailBody(
  manifest: PermissionManifest,
  options: SecurityReviewDocumentOptions & {
    requestingUserName?: string;
    requestingUserEmail?: string;
    redirectUri?: string;
  },
): { subject: string; body: string; mailto: string } {
  const { requested } = resolveEffectiveScopes(manifest, {
    permissionAwareEnabled: options.permissionAwareEnabled,
  });

  const userName = options.requestingUserName ?? 'A team member';
  const project = options.projectName ?? 'enterprise search';

  const subject = `Azure App Registration Request — ABL Platform ${manifest.displayName} Connector`;

  const body = [
    `Hi,`,
    '',
    `${userName} is setting up a ${manifest.displayName} connector for ${project}.`,
    `We need an Azure AD App Registration with the following read-only permissions:`,
    '',
    ...requested.map((s) => `• ${s.scope} (${s.type}) — ${s.why}`),
    '',
    'All permissions are READ-ONLY. No data is modified or deleted.',
    '',
    'Setup steps:',
    '1. Azure Portal > App registrations > New registration',
    '2. Name: "ABL Platform SharePoint Connector"',
    '3. Account type: "Accounts in this organizational directory only"',
    ...(options.redirectUri ? [`4. Redirect URI (Web): ${options.redirectUri}`] : []),
    '5. Add the Graph permissions listed above',
    '6. Create a client secret',
    '7. Grant admin consent',
    '',
    '⚠️ Do NOT reply with credentials via email.',
    'Enter them directly in the platform.',
    '',
    'For the full Security Review Document (compliance alignment, data',
    'handling, retention, and revocation), ask the requester to download',
    'it from the connector setup page.',
    '',
    'Thank you!',
  ].join('\n');

  const encodedSubject = encodeURIComponent(subject);
  const encodedBody = encodeURIComponent(body);
  const mailto = `mailto:?subject=${encodedSubject}&body=${encodedBody}`;

  return { subject, body, mailto };
}
