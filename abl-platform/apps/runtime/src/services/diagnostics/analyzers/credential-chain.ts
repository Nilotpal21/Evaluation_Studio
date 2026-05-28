/**
 * Credential Chain Analyzer
 *
 * Validates the LLM credential chain for a tenant:
 * 1. Checks that at least one active LLMCredential exists
 * 2. Checks TenantLLMPolicy provider allowlist
 * 3. Cross-references the credential provider against resolved model provider
 * 4. Warns on stale credentials (lastValidatedAt > 30 days or null)
 */

import { createLogger } from '@abl/compiler/platform';
import { areLlmProvidersPolicyEquivalent } from '@agent-platform/shared-kernel/llm-provider-identity';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';

const log = createLogger('diag-credential-chain');

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class CredentialChainAnalyzer implements Analyzer {
  name = 'credential-chain';
  category = 'infra' as const;

  async analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = [];
    const { tenantId } = context;

    try {
      // Step 1: Check for active credentials
      const credentials = await this.findActiveCredentials(tenantId);

      if (credentials.length === 0) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'NO_ACTIVE_CREDENTIAL',
          title: 'No active LLM credential found',
          detail:
            'No active LLM credential exists for this tenant. The runtime cannot make LLM API calls without a credential.',
          suggestion:
            'Add an LLM credential in Workspace Settings > Models & Credentials, or reactivate an existing credential.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Credential lookup',
              data: { tenantId, isActive: true, found: false },
            },
          ],
        });
        return findings;
      }

      const credentialProviders = uniqueStrings(
        credentials
          .map((credential) =>
            typeof credential.provider === 'string' ? credential.provider : undefined,
          )
          .filter((provider): provider is string => !!provider),
      );

      // Step 2: Cross-reference with resolved model provider
      const resolvedProvider = await this.findResolvedModelProvider(tenantId, context.projectId);
      const relevantCredentials = resolvedProvider
        ? credentials.filter(
            (credential) =>
              typeof credential.provider === 'string' &&
              areLlmProvidersPolicyEquivalent(credential.provider, resolvedProvider),
          )
        : credentials;
      const credential = selectCredentialForHealth(relevantCredentials);
      const credentialProvider =
        typeof credential?.provider === 'string'
          ? credential.provider
          : (resolvedProvider ?? credentialProviders[0] ?? '');

      if (resolvedProvider && relevantCredentials.length === 0) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'PROVIDER_CREDENTIAL_MISSING',
          title: 'No active credential for resolved model provider',
          detail: `The resolved model uses provider "${resolvedProvider}", but no active credential exists for that provider. Active credential providers: [${credentialProviders.join(', ')}].`,
          suggestion:
            'Add an active credential for the resolved model provider, or change the model configuration to use a provider with an active credential.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Provider credential lookup',
              data: {
                resolvedProvider,
                activeCredentialProviders: credentialProviders,
                tenantId,
              },
            },
          ],
        });
      }

      // Step 3: Check TenantLLMPolicy provider allowlist
      const policy = await this.findTenantPolicy(tenantId);

      if (policy) {
        const allowedProviders = Array.isArray(policy.allowedProviders)
          ? policy.allowedProviders
          : [];
        const providersToCheck = resolvedProvider ? [resolvedProvider] : credentialProviders;
        const disallowedProviders = providersToCheck.filter(
          (provider) =>
            !allowedProviders.some((allowed) => areLlmProvidersPolicyEquivalent(allowed, provider)),
        );

        if (allowedProviders.length > 0 && disallowedProviders.length > 0) {
          const providerList = disallowedProviders.join(', ');
          findings.push({
            analyzer: this.name,
            severity: 'error',
            code: 'PROVIDER_NOT_ALLOWED',
            title: resolvedProvider
              ? 'Resolved model provider not in tenant allowlist'
              : 'Credential provider not in tenant allowlist',
            detail: resolvedProvider
              ? `The resolved model uses provider "${resolvedProvider}", which is not in the tenant's allowed providers list: [${allowedProviders.join(', ')}].`
              : `The active credential provider(s) [${providerList}] are not in the tenant's allowed providers list: [${allowedProviders.join(', ')}].`,
            suggestion:
              'Either add the provider to the tenant allowlist in Workspace Settings > LLM Policy, or change the model configuration to use an allowed provider.',
            evidence: [
              {
                type: 'config' as const,
                label: 'Provider allowlist check',
                data: {
                  resolvedProvider,
                  credentialProvider,
                  disallowedProviders,
                  allowedProviders,
                  tenantId,
                },
              },
            ],
          });
        }
      }

      // Step 4: Check credential staleness
      const lastValidatedAt =
        credential?.lastValidatedAt instanceof Date
          ? credential.lastValidatedAt
          : credential?.lastValidatedAt
            ? new Date(credential.lastValidatedAt as string | number)
            : null;
      const isStale =
        relevantCredentials.length > 0 &&
        (!lastValidatedAt || Date.now() - new Date(lastValidatedAt).getTime() > STALE_THRESHOLD_MS);

      if (isStale) {
        findings.push({
          analyzer: this.name,
          severity: 'warning',
          code: 'CREDENTIAL_STALE',
          title: 'LLM credential has not been validated recently',
          detail: lastValidatedAt
            ? `The credential was last validated on ${new Date(lastValidatedAt).toISOString()}, which is over 30 days ago.`
            : 'The credential has never been validated.',
          suggestion:
            'Re-validate the credential in Workspace Settings > Models & Credentials to confirm the API key is still active.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Credential validation status',
              data: {
                tenantId,
                provider: credentialProvider,
                lastValidatedAt: lastValidatedAt ? new Date(lastValidatedAt).toISOString() : null,
                isStale: true,
              },
            },
          ],
        });
      }

      // If no errors or warnings, report healthy credential chain
      if (findings.length === 0) {
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'CREDENTIAL_CHAIN_OK',
          title: 'Credential chain is healthy',
          detail: `Active credential found for provider "${credentialProvider}". Last validated: ${lastValidatedAt ? new Date(lastValidatedAt).toISOString() : 'N/A'}.`,
          suggestion: 'No action needed.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Credential summary',
              data: {
                tenantId,
                provider: credentialProvider,
                resolvedProvider,
                activeCredentialProviders: credentialProviders,
                credentialScope: credential?.credentialScope,
                lastValidatedAt: lastValidatedAt ? new Date(lastValidatedAt).toISOString() : null,
              },
            },
          ],
        });
      }
    } catch (err) {
      log.error('Credential chain analysis failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'ANALYSIS_ERROR',
        title: 'Credential chain analysis encountered an error',
        detail: err instanceof Error ? err.message : String(err),
        suggestion: 'Check database connectivity and try again.',
        evidence: [],
      });
    }

    return findings;
  }

  private async findActiveCredentials(tenantId: string): Promise<Array<Record<string, unknown>>> {
    try {
      const { LLMCredential } = await import('@agent-platform/database/models');
      // No .lean(): LLMCredential encryption hooks decrypt credential fields after find.
      return (await LLMCredential.find({ tenantId, isActive: true })) as Array<
        Record<string, unknown>
      >;
    } catch (err) {
      log.warn('Failed to query LLMCredential', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async findTenantPolicy(tenantId: string): Promise<Record<string, unknown> | null> {
    try {
      const { TenantLLMPolicy } = await import('@agent-platform/database/models');
      return await TenantLLMPolicy.findOne({ tenantId }).lean();
    } catch (err) {
      log.warn('Failed to query TenantLLMPolicy', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async findResolvedModelProvider(
    tenantId: string,
    projectId: string,
  ): Promise<string | null> {
    try {
      // Project-level model configuration has higher precedence than tenant defaults.
      const { findAnyModelConfig } = await import('../../../repos/llm-resolution-repo.js');
      const projectConfig = await findAnyModelConfig(projectId, tenantId);

      if (projectConfig && typeof projectConfig.provider === 'string') {
        return projectConfig.provider;
      }

      const { TenantModel } = await import('@agent-platform/database/models');
      const tenantModel = await TenantModel.findOne({
        tenantId,
        isActive: true,
        inferenceEnabled: true,
      }).lean();

      if (tenantModel && typeof tenantModel.provider === 'string') {
        return tenantModel.provider;
      }

      return null;
    } catch (err) {
      log.warn('Failed to resolve model provider for credential cross-check', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function selectCredentialForHealth(
  credentials: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (credentials.length === 0) {
    return null;
  }

  return [...credentials].sort((left, right) => {
    const leftTime = toTime(left.lastValidatedAt);
    const rightTime = toTime(right.lastValidatedAt);
    return rightTime - leftTime;
  })[0]!;
}

function toTime(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}
