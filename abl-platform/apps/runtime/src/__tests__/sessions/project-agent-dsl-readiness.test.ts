import { describe, expect, test } from 'vitest';
import {
  evaluateProjectAgentDslReadiness,
  evaluateProjectExecutionReadiness,
} from '../../services/session/project-agent-dsl-readiness.js';

describe('evaluateProjectAgentDslReadiness', () => {
  test('fails closed for non-empty drafts without trusted validation metadata', () => {
    const readiness = evaluateProjectAgentDslReadiness([
      {
        name: 'legacy_agent',
        dslContent: 'AGENT: legacy_agent\nGOAL: "Help"',
        dslValidationStatus: null,
      },
      {
        name: 'valid_agent',
        dslContent: 'AGENT: valid_agent\nGOAL: "Help"',
        dslValidationStatus: 'valid',
      },
    ]);

    expect(readiness.hasBlockingErrors).toBe(true);
    expect(readiness.executableAgents).toEqual([]);
    expect(readiness.blockedAgents).toEqual([
      {
        name: 'legacy_agent',
        diagnosticCount: 1,
      },
    ]);
  });

  test('blocks executable working copies when persisted runtime config is invalid', async () => {
    const readiness = await evaluateProjectExecutionReadiness({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runtimeConfig: {
        extraction: {
          nlu_provider: 'advanced',
        },
      },
      agents: [
        {
          name: 'valid_agent',
          dslContent: 'AGENT: valid_agent\nGOAL: "Help"',
          dslValidationStatus: 'valid',
        },
      ],
    });

    expect(readiness.hasBlockingErrors).toBe(true);
    expect(readiness.executableAgents).toEqual([]);
    expect(readiness.blockedAgents).toEqual([]);
    expect(readiness.issues).toEqual([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'advanced_sidecar_url is required when nlu_provider is advanced',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
  });
});
