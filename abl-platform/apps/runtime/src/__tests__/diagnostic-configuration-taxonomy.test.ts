import { describe, expect, it } from 'vitest';
import {
  classifyCanonicalConfigurationFinding,
  classifyCanonicalSessionHealthEntry,
} from '../services/diagnostics/configuration-taxonomy.js';

describe('configuration diagnostic taxonomy', () => {
  it('maps model-resolution missing credential findings to the canonical credential-missing code', () => {
    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'model-resolution',
        code: 'NO_CREDENTIAL',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_CREDENTIAL_MISSING',
    });
  });

  it('maps credential-chain provider incompatibility findings to a single canonical code', () => {
    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'credential-chain',
        code: 'PROVIDER_NOT_ALLOWED',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_PROVIDER_CONFIGURATION_INVALID',
    });
  });

  it('maps provider-specific missing credential findings to the canonical credential-missing code', () => {
    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'credential-chain',
        code: 'PROVIDER_CREDENTIAL_MISSING',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_CREDENTIAL_MISSING',
    });
  });

  it('maps encryption and database analyzer findings onto the canonical config taxonomy', () => {
    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'encryption-availability',
        code: 'ENCRYPTION_UNAVAILABLE',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'encryption',
      code: 'ENCRYPTION_UNAVAILABLE',
    });

    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'encryption-availability',
        code: 'DB_UNAVAILABLE',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'database',
      code: 'DB_RESOLUTION_UNAVAILABLE',
    });
  });

  it('maps session health entries onto the same canonical codes', () => {
    expect(
      classifyCanonicalSessionHealthEntry({
        category: 'llm',
        code: 'LLM_WIRING_FAILED',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_WIRING_FAILED',
    });
  });

  it('maps provider-configuration session health entries onto the canonical config taxonomy', () => {
    expect(
      classifyCanonicalSessionHealthEntry({
        category: 'llm',
        code: 'LLM_PROVIDER_CONFIGURATION_INVALID',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_PROVIDER_CONFIGURATION_INVALID',
    });
  });

  it('maps tool configuration session health entries onto the canonical config taxonomy', () => {
    expect(
      classifyCanonicalSessionHealthEntry({
        category: 'tool',
        code: 'TOOL_CODE_EXECUTION_DISABLED',
      }),
    ).toEqual({
      domain: 'configuration',
      category: 'tool',
      code: 'TOOL_CODE_EXECUTION_DISABLED',
    });
  });

  it('returns undefined for non-configuration diagnostics', () => {
    expect(
      classifyCanonicalConfigurationFinding({
        analyzer: 'tool-binding',
        code: 'UNBOUND_TOOL',
      }),
    ).toBeUndefined();

    expect(
      classifyCanonicalSessionHealthEntry({
        category: 'tool',
        code: 'TOOL_BINDING_FAILED',
      }),
    ).toBeUndefined();
  });
});
