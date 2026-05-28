/**
 * Module Publish Safety Validator
 *
 * Two-tier validation that prevents credential leaks and flags non-portable
 * bindings before a module release is published.
 *
 * Tier 1 — Structural validation (blocking):
 *   HTTP tools must use auth_profile_ref or {{env.*}}/{{config.*}} templating.
 *   Reject non-templated literal auth values.
 *
 * Tier 2 — Pattern-based validation (supplementary):
 *   Scan all string values for Base64 secrets, URL-embedded keys, PEM keys,
 *   and common secret prefixes.
 *
 * Also emits non-portable warnings for SearchAI/Workflow tool bindings that
 * reference project-scoped resource IDs.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('module-publish-safety');

// ─── Result Types ────────────────────────────────────────────────────────

export type PublishSafetySeverity = 'blocking' | 'warning';

export interface PublishSafetyIssue {
  severity: PublishSafetySeverity;
  code: string;
  source: string;
  message: string;
}

export interface PublishSafetyResult {
  safe: boolean;
  issues: PublishSafetyIssue[];
}

// ─── Input Types ─────────────────────────────────────────────────────────

export interface SafetyAgentInput {
  name: string;
  dslContent: string;
}

export interface SafetyToolInput {
  name: string;
  toolType: string;
  dslContent: string;
}

export interface SafetyProfileInput {
  name: string;
  dslContent: string;
}

// ─── Pattern constants ───────────────────────────────────────────────────

/** Base64 strings > 20 chars that look like encoded secrets */
const BASE64_RE = /[A-Za-z0-9+/=]{20,}/g;

/** URL-embedded API keys in query parameters */
const URL_KEY_RE = /[?&](api_key|apikey|key|token|secret|access_token|auth)=([^&\s]{8,})/gi;

/** PEM-encoded private keys */
const PEM_PRIVATE_KEY_RE = /-----BEGIN\s+[\w\s]*PRIVATE\s+KEY-----/i;

/** Common secret prefixes */
const SECRET_PREFIX_RE =
  /\b(Bearer\s+[A-Za-z0-9._\-]{10,}|Basic\s+[A-Za-z0-9+/=]{10,}|sk-[A-Za-z0-9]{20,}|pk_[A-Za-z0-9]{20,})/g;

/** Template patterns that are safe ({{env.*}}, {{config.*}}, {{secrets.*}}) */
const SAFE_TEMPLATE_RE = /\{\{(?:env|config|secrets)\.\w+\}\}/;

/** Auth-related DSL directives */
const AUTH_CONFIG_RE = /^\s*AUTH(?:_CONFIG)?:\s*(.+)$/gim;

/** auth_profile_ref pattern */
const AUTH_PROFILE_REF_RE = /auth_profile_ref/i;

const AUTH_TYPE_KEYWORDS = new Set([
  'api_key',
  'bearer',
  'oauth2_client',
  'oauth2_user',
  'custom',
  'none',
]);

/** SearchAI project-scoped identity binding in structured metadata or DSL-native snake_case */
const SEARCHAI_IDENTITY_RE =
  /\b(?:indexId|index_id|tenantId|tenant_id)\s*:\s*['"]?([A-Za-z0-9_{}.-]+)['"]?/gi;

/** Workflow project-scoped identity binding in structured metadata or DSL-native snake_case */
const WORKFLOW_IDENTITY_RE =
  /\b(?:workflowId|workflow_id|triggerId|trigger_id|workflowVersionId|workflow_version_id)\s*:\s*['"]?([A-Za-z0-9_{}.-]+)['"]?/gi;

/** Config placeholders are not executable in persisted SearchAI/workflow identity fields. */
const CONFIG_PLACEHOLDER_VALUE_RE = /^\{\{config\.\w+\}\}$/;

/** variable namespace IDs — source-project-only identifiers to strip */
const VARIABLE_NAMESPACE_RE =
  /(?:variableNamespaceId[s]?|variable_namespace_id[s]?)\s*[:=]\s*['"]?[^'"\s,}\]]+/gi;

/** Raw MongoDB ObjectId or UUIDv7 _id references */
const RAW_ID_RE = /_id\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/gi;

/** projectId references pointing to source project */
const PROJECT_ID_RE = /projectId\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/gi;

/** tenantId references that would leak tenant identity into published artifacts */
const TENANT_ID_RE = /tenantId\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/gi;

// ─── Main validator ──────────────────────────────────────────────────────

/**
 * Validate module agents and tools for publish safety.
 *
 * Returns blocking issues that prevent publication and warnings that
 * inform the publisher about non-portable bindings.
 */
export function validatePublishSafety(
  agents: SafetyAgentInput[],
  tools: SafetyToolInput[],
  profiles: SafetyProfileInput[] = [],
): PublishSafetyResult {
  const issues: PublishSafetyIssue[] = [];

  // ── Structural validation (HTTP tools) ─────────────────────────────
  for (const tool of tools) {
    if (tool.toolType === 'http') {
      validateHttpToolAuth(tool, issues);
    }
  }

  // ── Pattern-based validation (all content) ─────────────────────────
  for (const agent of agents) {
    scanForSecretPatterns(`agent:${agent.name}`, agent.dslContent, issues);
  }
  for (const tool of tools) {
    scanForSecretPatterns(`tool:${tool.name}`, tool.dslContent, issues);
  }
  for (const profile of profiles) {
    scanForSecretPatterns(`profile:${profile.name}`, profile.dslContent, issues);
  }

  // ── Non-portable warnings ──────────────────────────────────────────
  for (const tool of tools) {
    if (tool.toolType === 'searchai') {
      checkSearchAiBinding(tool, issues);
    }
    checkWorkflowBinding(tool, issues);
  }

  // ── Source-project-only identifiers ────────────────────────────────
  for (const agent of agents) {
    checkSourceOnlyIdentifiers(`agent:${agent.name}`, agent.dslContent, issues);
  }
  for (const tool of tools) {
    checkSourceOnlyIdentifiers(`tool:${tool.name}`, tool.dslContent, issues);
  }
  for (const profile of profiles) {
    checkSourceOnlyIdentifiers(`profile:${profile.name}`, profile.dslContent, issues);
  }

  const hasBlocking = issues.some((i) => i.severity === 'blocking');

  if (issues.length > 0) {
    log.info('Publish safety validation completed', {
      issueCount: issues.length,
      blocking: issues.filter((i) => i.severity === 'blocking').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
    });
  }

  return {
    safe: !hasBlocking,
    issues,
  };
}

// ─── Structural validation ───────────────────────────────────────────────

/**
 * Validate that HTTP tool auth config uses auth_profile_ref or templating.
 * Rejects non-templated literal auth values.
 */
function validateHttpToolAuth(tool: SafetyToolInput, issues: PublishSafetyIssue[]): void {
  const re = new RegExp(AUTH_CONFIG_RE.source, AUTH_CONFIG_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(tool.dslContent)) !== null) {
    const authValue = match[1].trim();

    // auth_profile_ref is safe
    if (AUTH_PROFILE_REF_RE.test(authValue)) continue;

    // Template references are safe
    if (SAFE_TEMPLATE_RE.test(authValue)) continue;

    // DSL auth type keywords (e.g. "auth: api_key") are type names, not secrets
    if (AUTH_TYPE_KEYWORDS.has(authValue)) continue;

    // Non-templated literal — blocking
    issues.push({
      severity: 'blocking',
      code: 'LITERAL_AUTH_VALUE',
      source: `tool:${tool.name}`,
      message:
        `HTTP tool "${tool.name}" has a non-templated auth value. ` +
        `Use auth_profile_ref or {{env.*}}/{{config.*}} templating instead.`,
    });
  }

  // Also check custom_headers, query_params, body_template for auth-sensitive literals
  checkAuthSensitiveFields(tool, issues);
}

/** Check custom_headers and query_params for non-templated auth-sensitive values */
function checkAuthSensitiveFields(tool: SafetyToolInput, issues: PublishSafetyIssue[]): void {
  // Match header assignments like Authorization: <literal>
  const headerRe =
    /(?:Authorization|X-Api-Key|X-Auth-Token|Api-Key)\s*[:=]\s*['"]?(?!.*\{\{(?:env|config|secrets)\.)([^'"}\n]{8,})/gi;

  let match: RegExpExecArray | null;
  const re = new RegExp(headerRe.source, headerRe.flags);
  while ((match = re.exec(tool.dslContent)) !== null) {
    const value = match[1].trim();
    // Skip if it contains template syntax
    if (SAFE_TEMPLATE_RE.test(value)) continue;

    issues.push({
      severity: 'blocking',
      code: 'LITERAL_AUTH_HEADER',
      source: `tool:${tool.name}`,
      message:
        `HTTP tool "${tool.name}" has a non-templated auth header value. ` +
        `Use {{env.*}} or {{config.*}} templating for sensitive headers.`,
    });
  }
}

// ─── Pattern-based validation ────────────────────────────────────────────

/** Scan content for potential secret patterns */
function scanForSecretPatterns(
  source: string,
  content: string,
  issues: PublishSafetyIssue[],
): void {
  // PEM private keys
  if (PEM_PRIVATE_KEY_RE.test(content)) {
    issues.push({
      severity: 'blocking',
      code: 'PEM_PRIVATE_KEY',
      source,
      message: `${source} contains a PEM-encoded private key.`,
    });
  }

  // URL-embedded API keys
  const urlRe = new RegExp(URL_KEY_RE.source, URL_KEY_RE.flags);
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(content)) !== null) {
    const value = urlMatch[2];
    if (SAFE_TEMPLATE_RE.test(value)) continue;
    issues.push({
      severity: 'blocking',
      code: 'URL_EMBEDDED_KEY',
      source,
      message: `${source} contains a URL-embedded API key in parameter "${urlMatch[1]}".`,
    });
  }

  // Common secret prefixes (Bearer, Basic, sk-, pk_)
  const prefixRe = new RegExp(SECRET_PREFIX_RE.source, SECRET_PREFIX_RE.flags);
  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = prefixRe.exec(content)) !== null) {
    const matched = prefixMatch[0];
    // Skip if it's inside a template
    const contextStart = Math.max(0, prefixMatch.index - 5);
    const context = content.slice(contextStart, prefixMatch.index + matched.length + 5);
    if (SAFE_TEMPLATE_RE.test(context)) continue;

    issues.push({
      severity: 'blocking',
      code: 'SECRET_PREFIX',
      source,
      message: `${source} contains a potential secret value starting with "${matched.slice(0, 10)}...".`,
    });
  }

  // Base64 strings > 20 chars
  const b64Re = new RegExp(BASE64_RE.source, BASE64_RE.flags);
  let b64Match: RegExpExecArray | null;
  while ((b64Match = b64Re.exec(content)) !== null) {
    const value = b64Match[0];
    // Only flag if it decodes to printable ASCII (likely a real secret)
    if (!looksLikeEncodedSecret(value)) continue;
    // Skip if inside a template
    const ctxStart = Math.max(0, b64Match.index - 5);
    const ctx = content.slice(ctxStart, b64Match.index + value.length + 5);
    if (SAFE_TEMPLATE_RE.test(ctx)) continue;

    issues.push({
      severity: 'warning',
      code: 'BASE64_SECRET',
      source,
      message: `${source} contains a Base64-encoded string that may be a secret (${value.length} chars).`,
    });
  }
}

/** Check if a Base64 string decodes to printable ASCII (heuristic for real secrets) */
function looksLikeEncodedSecret(value: string): boolean {
  try {
    // Must be valid Base64
    if (value.length % 4 !== 0 && !value.endsWith('=')) return false;
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    // At least 50% printable ASCII
    let printable = 0;
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      if (code >= 32 && code <= 126) printable++;
    }
    return decoded.length > 0 && printable / decoded.length >= 0.5;
  } catch {
    return false;
  }
}

// ─── Non-portable warnings ───────────────────────────────────────────────

/** Warn about SearchAI tools with project-scoped indexId */
function checkSearchAiBinding(tool: SafetyToolInput, issues: PublishSafetyIssue[]): void {
  const re = new RegExp(SEARCHAI_IDENTITY_RE.source, SEARCHAI_IDENTITY_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(tool.dslContent)) !== null) {
    if (CONFIG_PLACEHOLDER_VALUE_RE.test(match[1])) {
      issues.push({
        severity: 'blocking',
        code: 'SEARCHAI_CONFIG_PLACEHOLDER_BINDING',
        source: `tool:${tool.name}`,
        message:
          `SearchAI tool "${tool.name}" uses config placeholder "${match[1]}" for a live identity binding. ` +
          `Materialize the SearchAI binding before publish/import or omit the tool from the module.`,
      });
      continue;
    }

    issues.push({
      severity: 'warning',
      code: 'SEARCHAI_INDEX_BINDING',
      source: `tool:${tool.name}`,
      message:
        `SearchAI tool "${tool.name}" references indexId "${match[1]}". ` +
        `This knowledge base ID is project-scoped and may not exist in consumer projects.`,
    });
  }
}

/** Warn about tools with project-scoped workflowId */
function checkWorkflowBinding(tool: SafetyToolInput, issues: PublishSafetyIssue[]): void {
  const re = new RegExp(WORKFLOW_IDENTITY_RE.source, WORKFLOW_IDENTITY_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(tool.dslContent)) !== null) {
    if (CONFIG_PLACEHOLDER_VALUE_RE.test(match[1])) {
      issues.push({
        severity: 'blocking',
        code: 'WORKFLOW_CONFIG_PLACEHOLDER_BINDING',
        source: `tool:${tool.name}`,
        message:
          `Workflow tool "${tool.name}" uses config placeholder "${match[1]}" for a live identity binding. ` +
          `Materialize the workflow binding before publish/import or omit the tool from the module.`,
      });
      continue;
    }

    issues.push({
      severity: 'warning',
      code: 'WORKFLOW_ID_BINDING',
      source: `tool:${tool.name}`,
      message:
        `Tool "${tool.name}" references workflowId "${match[1]}". ` +
        `This workflow ID is project-scoped and may not exist in consumer projects.`,
    });
  }
}

// ─── Source-project-only identifiers ─────────────────────────────────────

/** Flag source-project-only identifiers that should be stripped */
function checkSourceOnlyIdentifiers(
  source: string,
  content: string,
  issues: PublishSafetyIssue[],
): void {
  // variableNamespaceIds
  const varNsRe = new RegExp(VARIABLE_NAMESPACE_RE.source, VARIABLE_NAMESPACE_RE.flags);
  if (varNsRe.test(content)) {
    issues.push({
      severity: 'blocking',
      code: 'VARIABLE_NAMESPACE_ID',
      source,
      message: `${source} contains variableNamespaceId references that must be stripped before publishing.`,
    });
  }

  // Raw _id references
  const idRe = new RegExp(RAW_ID_RE.source, RAW_ID_RE.flags);
  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRe.exec(content)) !== null) {
    issues.push({
      severity: 'warning',
      code: 'RAW_MONGODB_ID',
      source,
      message: `${source} contains a raw _id reference "${idMatch[1].slice(0, 12)}..." that may be source-project-specific.`,
    });
  }

  // projectId references
  const projIdRe = new RegExp(PROJECT_ID_RE.source, PROJECT_ID_RE.flags);
  let projMatch: RegExpExecArray | null;
  while ((projMatch = projIdRe.exec(content)) !== null) {
    issues.push({
      severity: 'warning',
      code: 'SOURCE_PROJECT_ID',
      source,
      message: `${source} contains a projectId reference "${projMatch[1].slice(0, 12)}..." pointing to the source project.`,
    });
  }

  // tenantId references — leaked tenant identity
  const tenantIdRe = new RegExp(TENANT_ID_RE.source, TENANT_ID_RE.flags);
  let tenantMatch: RegExpExecArray | null;
  while ((tenantMatch = tenantIdRe.exec(content)) !== null) {
    issues.push({
      severity: 'warning',
      code: 'SOURCE_TENANT_ID',
      source,
      message: `${source} contains a tenantId reference "${tenantMatch[1].slice(0, 12)}..." that would leak tenant identity.`,
    });
  }
}
