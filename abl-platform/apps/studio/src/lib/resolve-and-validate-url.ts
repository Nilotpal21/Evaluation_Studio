/**
 * Resolve {{env.X}} / {{secrets.X}} / {{config.X}} template placeholders in a URL,
 * then validate the resolved URL for SSRF safety.
 *
 * Resolution uses DB-backed environment/config variables for the project.
 * If a placeholder cannot be resolved (var doesn't exist), the request
 * is rejected — the env var must be created before it can be used in a URL.
 */

import { validateUrlForSSRF } from '@agent-platform/shared';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const PLACEHOLDER_RE = /\{\{(env|secrets|config)\.(\w+)\}\}/g;

type PlaceholderType = 'env' | 'secrets' | 'config';

export interface UrlPlaceholderValidationOptions {
  allowUnresolvedEnvPlaceholders?: boolean;
  variableNamespaceIds?: readonly string[];
  useDefaultNamespaceFallback?: boolean;
}

function normalizeNamespaceIds(namespaceIds?: readonly string[]): string[] {
  return [...new Set((namespaceIds ?? []).filter((namespaceId) => namespaceId.length > 0))];
}

async function resolveNamespaceScope(
  tenantId: string,
  projectId: string,
  options?: UrlPlaceholderValidationOptions,
): Promise<string[] | null> {
  if (!options) {
    return null;
  }

  const explicitNamespaceIds = normalizeNamespaceIds(options.variableNamespaceIds);
  if (explicitNamespaceIds.length > 0 || options.useDefaultNamespaceFallback === false) {
    return explicitNamespaceIds;
  }

  if (options.useDefaultNamespaceFallback) {
    const { VariableNamespace } = await import('@agent-platform/database/models');
    const defaultNamespace = await VariableNamespace.findOne({
      tenantId,
      projectId,
      isDefault: true,
    })
      .select('_id')
      .lean();

    return defaultNamespace?._id ? [String(defaultNamespace._id)] : [];
  }

  return explicitNamespaceIds;
}

async function isInNamespaceScope(params: {
  tenantId: string;
  projectId: string;
  variableId: unknown;
  variableType: 'env' | 'config';
  namespaceIds: string[] | null;
}): Promise<boolean> {
  if (params.namespaceIds === null) {
    return true;
  }

  if (params.namespaceIds.length === 0 || !params.variableId) {
    return false;
  }

  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  const membership = await VariableNamespaceMembership.findOne({
    tenantId: params.tenantId,
    projectId: params.projectId,
    variableId: params.variableId,
    variableType: params.variableType,
    namespaceId: { $in: params.namespaceIds },
  })
    .select('_id')
    .lean();

  return Boolean(membership);
}

/**
 * Try to resolve template placeholders in a URL by looking up env vars.
 * Returns { resolved, unresolvedKeys } where `resolved` is the best-effort
 * URL and `unresolvedKeys` lists any env var keys that couldn't be found.
 */
async function resolveUrlPlaceholders(
  url: string,
  tenantId: string,
  projectId: string,
  environment = 'dev',
  options?: UrlPlaceholderValidationOptions,
): Promise<{ resolved: string; unresolvedKeys: string[] }> {
  const matches = [...url.matchAll(PLACEHOLDER_RE)];
  if (matches.length === 0) return { resolved: url, unresolvedKeys: [] };

  const { EnvironmentVariable, ProjectConfigVariable } =
    await import('@agent-platform/database/models');
  const { decryptForTenantAuto } = await import('@agent-platform/shared/encryption');
  const namespaceIds = await resolveNamespaceScope(tenantId, projectId, options);

  let result = url;
  const unresolvedKeys: string[] = [];

  for (const match of matches) {
    const placeholder = match[0];
    const type = match[1] as PlaceholderType | undefined;
    const key = match[2];
    if (!type || !key) {
      continue;
    }

    if (type === 'config') {
      const configVar = await ProjectConfigVariable.findOne({
        tenantId,
        projectId,
        key,
      })
        .select('_id value')
        .lean();

      if (
        configVar &&
        (await isInNamespaceScope({
          tenantId,
          projectId,
          variableId: configVar._id,
          variableType: 'config',
          namespaceIds,
        }))
      ) {
        result = result.replace(placeholder, String(configVar.value ?? ''));
      } else {
        unresolvedKeys.push(`${type}.${key}`);
      }
      continue;
    }

    const envVar = await EnvironmentVariable.findOne({
      tenantId,
      projectId,
      key,
      environment,
    })
      .select('_id encryptedValue')
      .lean();

    if (
      !envVar?.encryptedValue ||
      !(await isInNamespaceScope({
        tenantId,
        projectId,
        variableId: envVar._id,
        variableType: 'env',
        namespaceIds,
      }))
    ) {
      unresolvedKeys.push(`${type}.${key}`);
      continue;
    }

    try {
      const value = await decryptForTenantAuto(envVar.encryptedValue, tenantId);
      result = result.replace(placeholder, value);
    } catch {
      unresolvedKeys.push(`${type}.${key}`);
    }
  }

  return { resolved: result, unresolvedKeys };
}

export interface UrlValidationResult {
  safe: boolean;
  reason?: string;
}

function isRuntimePlaceholderKey(key: string): boolean {
  return key.startsWith('env.') || key.startsWith('secrets.');
}

function validateLiteralUrlPrefixWithPlaceholders(url: string): UrlValidationResult {
  const match = PLACEHOLDER_RE.exec(url);
  PLACEHOLDER_RE.lastIndex = 0;
  const prefix = match ? url.slice(0, match.index) : url;

  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(prefix)) {
    return { safe: true };
  }

  const placeholderSafeUrl = url.replace(PLACEHOLDER_RE, 'placeholder');
  PLACEHOLDER_RE.lastIndex = 0;
  return validateUrlForSSRF(placeholderSafeUrl, getDevSSRFOptions());
}

/**
 * Validate a URL that may contain `{{env.X}}` / `{{secrets.X}}` / `{{config.X}}` placeholders.
 *
 * 1. If URL has no placeholders → standard SSRF validation.
 * 2. If URL has placeholders → resolve from DB, then validate the resolved URL.
 * 3. If some placeholders can't be resolved → reject with error listing missing vars.
 */
export async function validateUrlWithPlaceholders(
  url: string,
  tenantId: string,
  projectId: string,
  environment = 'dev',
  options?: UrlPlaceholderValidationOptions,
): Promise<UrlValidationResult> {
  const hasPlaceholders = PLACEHOLDER_RE.test(url);
  // Reset regex lastIndex since it's global
  PLACEHOLDER_RE.lastIndex = 0;

  if (!hasPlaceholders) {
    return validateUrlForSSRF(url, getDevSSRFOptions());
  }

  const { resolved, unresolvedKeys } = await resolveUrlPlaceholders(
    url,
    tenantId,
    projectId,
    environment,
    options,
  );

  // If any placeholders couldn't be resolved, reject — env var must exist
  if (unresolvedKeys.length > 0) {
    if (
      options?.allowUnresolvedEnvPlaceholders &&
      unresolvedKeys.every((key) => isRuntimePlaceholderKey(key))
    ) {
      return validateLiteralUrlPrefixWithPlaceholders(url);
    }

    const unresolvedConfigKeys = unresolvedKeys.filter((key) => key.startsWith('config.'));
    if (unresolvedConfigKeys.length === 0) {
      return {
        safe: false,
        reason: `Environment variable(s) not found: ${unresolvedKeys.join(', ')}. Create them before using in a URL.`,
      };
    }

    return {
      safe: false,
      reason: `Variable(s) not found or not linked to this tool: ${unresolvedKeys.join(', ')}. Create and link them before using in a URL.`,
    };
  }

  // All placeholders resolved — validate the final URL for SSRF
  return validateUrlForSSRF(resolved, getDevSSRFOptions());
}
