import type { SessionHealthEntry } from '../execution/types.js';

export type CanonicalConfigurationCategory = 'llm' | 'tool' | 'encryption' | 'database';

export type CanonicalConfigurationCode =
  | 'LLM_CREDENTIAL_MISSING'
  | 'LLM_MODEL_NOT_CONFIGURED'
  | 'LLM_PROVIDER_CONFIGURATION_INVALID'
  | 'LLM_CREDENTIAL_STALE'
  | 'LLM_WIRING_FAILED'
  | 'TOOL_CODE_EXECUTION_DISABLED'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'DB_RESOLUTION_UNAVAILABLE';

export interface CanonicalConfigurationClassification {
  domain: 'configuration';
  category: CanonicalConfigurationCategory;
  code: CanonicalConfigurationCode;
}

interface DiagnosticFindingLike {
  analyzer: string;
  code: string;
}

const CONFIGURATION_CLASSIFICATION_DOMAIN = 'configuration' as const;

function buildCanonicalConfigurationClassification(
  category: CanonicalConfigurationCategory,
  code: CanonicalConfigurationCode,
): CanonicalConfigurationClassification {
  return {
    domain: CONFIGURATION_CLASSIFICATION_DOMAIN,
    category,
    code,
  };
}

/**
 * Normalize diagnostics-engine findings onto the canonical configuration error
 * taxonomy used by live runtime execution and Studio debug banners.
 *
 * This is intentionally additive: legacy analyzer codes remain stable so
 * existing API consumers do not break, while newer consumers can key off the
 * canonical classification instead of reverse-engineering overlapping codes.
 */
export function classifyCanonicalConfigurationFinding(
  finding: DiagnosticFindingLike,
): CanonicalConfigurationClassification | undefined {
  if (finding.analyzer === 'model-resolution') {
    switch (finding.code) {
      case 'NO_MODEL_RESOLVED':
        return buildCanonicalConfigurationClassification('llm', 'LLM_MODEL_NOT_CONFIGURED');
      case 'NO_CREDENTIAL':
        return buildCanonicalConfigurationClassification('llm', 'LLM_CREDENTIAL_MISSING');
      default:
        return undefined;
    }
  }

  if (finding.analyzer === 'credential-chain') {
    switch (finding.code) {
      case 'NO_ACTIVE_CREDENTIAL':
      case 'PROVIDER_CREDENTIAL_MISSING':
        return buildCanonicalConfigurationClassification('llm', 'LLM_CREDENTIAL_MISSING');
      case 'PROVIDER_NOT_ALLOWED':
        return buildCanonicalConfigurationClassification(
          'llm',
          'LLM_PROVIDER_CONFIGURATION_INVALID',
        );
      case 'CREDENTIAL_STALE':
        return buildCanonicalConfigurationClassification('llm', 'LLM_CREDENTIAL_STALE');
      default:
        return undefined;
    }
  }

  switch (finding.code) {
    case 'ENCRYPTION_UNAVAILABLE':
      return buildCanonicalConfigurationClassification('encryption', 'ENCRYPTION_UNAVAILABLE');
    case 'DB_UNAVAILABLE':
      return buildCanonicalConfigurationClassification('database', 'DB_RESOLUTION_UNAVAILABLE');
    default:
      return undefined;
  }
}

export function classifyCanonicalSessionHealthEntry(
  entry: Pick<SessionHealthEntry, 'category' | 'code'>,
): CanonicalConfigurationClassification | undefined {
  switch (entry.code) {
    case 'LLM_CREDENTIAL_MISSING':
      return buildCanonicalConfigurationClassification('llm', 'LLM_CREDENTIAL_MISSING');
    case 'LLM_MODEL_NOT_CONFIGURED':
      return buildCanonicalConfigurationClassification('llm', 'LLM_MODEL_NOT_CONFIGURED');
    case 'LLM_PROVIDER_CONFIGURATION_INVALID':
      return buildCanonicalConfigurationClassification('llm', 'LLM_PROVIDER_CONFIGURATION_INVALID');
    case 'LLM_WIRING_FAILED':
      return buildCanonicalConfigurationClassification('llm', 'LLM_WIRING_FAILED');
    case 'TOOL_CODE_EXECUTION_DISABLED':
      return buildCanonicalConfigurationClassification('tool', 'TOOL_CODE_EXECUTION_DISABLED');
    case 'ENCRYPTION_UNAVAILABLE':
      return buildCanonicalConfigurationClassification('encryption', 'ENCRYPTION_UNAVAILABLE');
    case 'DB_RESOLUTION_UNAVAILABLE':
      return buildCanonicalConfigurationClassification('database', 'DB_RESOLUTION_UNAVAILABLE');
    default:
      return undefined;
  }
}
