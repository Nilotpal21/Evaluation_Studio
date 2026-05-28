import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import type { RuntimeSession } from '../../services/execution/types.js';
import { renderSessionMessagesForUserSurface } from '../../services/pii/runtime-pii-boundary-service.js';

vi.mock('../../db/index.js', () => ({
  isDatabaseReady: vi.fn(() => true),
}));

describe('session pii context', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock('@agent-platform/database/models');
    vi.doUnmock('../../services/pii/pattern-loader.js');
  });

  it('refreshes active sessions from project runtime config and project patterns', async () => {
    const rawContractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';
    const findOne = vi.fn(() => ({
      lean: vi.fn().mockResolvedValue({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: true,
        },
      }),
    }));
    const loadProjectPIIPatterns = vi.fn(
      async (_tenantId: string, _projectId: string, registry: PIIRecognizerRegistry) => {
        registry.register(
          new RegexPIIRecognizer(
            'custom-contract-id',
            ['ContractID'],
            /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
            'ContractID',
            undefined,
            'custom',
          ),
        );
        return [
          {
            patternName: 'ContractID',
            defaultRenderMode: 'redacted' as const,
            consumerAccess: [],
          },
        ];
      },
    );

    vi.doMock('@agent-platform/database/models', () => ({
      ProjectRuntimeConfig: { findOne },
    }));
    vi.doMock('../../services/pii/pattern-loader.js', () => ({
      loadProjectPIIPatterns,
    }));

    const { refreshSessionPIIContext } = await import('../../services/pii/session-pii-context.js');
    const { filterOutputPII } = await import('../../services/execution/output-pii-filter.js');
    const session = {
      id: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      versionInfo: { environment: 'dev' },
      piiRedactionConfig: { enabled: false, redactInput: false, redactOutput: false },
    } as Partial<RuntimeSession> as RuntimeSession;

    await refreshSessionPIIContext(session);

    expect(session.piiRedactionConfig).toEqual({
      enabled: true,
      redactInput: true,
      redactOutput: true,
      // Foundation Stability Contract D-12 — defaults from mapProjectPIIRedactionConfig
      tier: 'basic',
      latencyBudgetMs: 200,
      confidenceThreshold: 0.5,
      enabledRecognizerPacks: ['core'],
    });
    expect(loadProjectPIIPatterns).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      session.piiRecognizerRegistry,
      { enabledRecognizerPacks: ['core'] },
    );

    const rendered = filterOutputPII(`Contract ID: ${rawContractId}`, session.piiRedactionConfig!, {
      vault: session.piiVault,
      patternConfigs: session.piiPatternConfigs,
      consumer: 'user',
    });
    expect(rendered.text).not.toContain(rawContractId);
    expect(rendered.text).toContain('REDACTED');
  });

  it('does not keep stale enabled policy when project PII runtime config is disabled', async () => {
    const findOne = vi.fn(() => ({
      lean: vi.fn().mockResolvedValue({
        pii_redaction: {
          enabled: false,
          redact_input: false,
          redact_output: false,
        },
      }),
    }));
    const loadProjectPIIPatterns = vi.fn();

    vi.doMock('@agent-platform/database/models', () => ({
      ProjectRuntimeConfig: { findOne },
    }));
    vi.doMock('../../services/pii/pattern-loader.js', () => ({
      loadProjectPIIPatterns,
    }));

    const { refreshSessionPIIContext } = await import('../../services/pii/session-pii-context.js');
    const session = {
      id: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      versionInfo: { environment: 'dev' },
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiPatternConfigs: [
        {
          patternName: 'ContractID',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
        },
      ],
    } as Partial<RuntimeSession> as RuntimeSession;

    await refreshSessionPIIContext(session);

    expect(session.piiRedactionConfig).toEqual({
      enabled: false,
      redactInput: false,
      redactOutput: false,
      tier: 'basic',
      latencyBudgetMs: 200,
      confidenceThreshold: 0.5,
      enabledRecognizerPacks: ['core'],
    });
    expect(session.piiPatternConfigs).toEqual([]);
    expect(session.piiRecognizerRegistry).toBeUndefined();
    expect(loadProjectPIIPatterns).not.toHaveBeenCalled();
  });

  it('rehydrates stored-session read-surface context with serialized vault data', async () => {
    const rawContractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';
    const findOne = vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(null),
    }));
    const loadProjectPIIPatterns = vi.fn(
      async (_tenantId: string, _projectId: string, registry: PIIRecognizerRegistry) => {
        registry.register(
          new RegexPIIRecognizer(
            'custom-contract-id',
            ['ContractID'],
            /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
            'ContractID',
            undefined,
            'custom',
          ),
        );
        return [
          {
            patternName: 'ContractID',
            defaultRenderMode: 'redacted' as const,
            consumerAccess: [],
          },
        ];
      },
    );

    vi.doMock('@agent-platform/database/models', () => ({
      ProjectRuntimeConfig: { findOne },
    }));
    vi.doMock('../../services/pii/pattern-loader.js', () => ({
      loadProjectPIIPatterns,
    }));

    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );
    const vault = new PIIVault({ recognizerRegistry: registry });
    const tokenized = vault.tokenize(`Contract ID: ${rawContractId}`);

    const { buildStoredPIIReadSurfaceContext } =
      await import('../../services/pii/session-pii-context.js');
    const context = await buildStoredPIIReadSurfaceContext({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      piiVaultData: vault.serialize(),
      fallbackPIIRedactionConfig: {
        enabled: true,
        redactInput: true,
        redactOutput: true,
      },
    });

    expect(context).toBeDefined();
    expect(loadProjectPIIPatterns).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      expect.anything(),
      expect.anything(),
    );

    const rendered = renderSessionMessagesForUserSurface(
      [
        {
          role: 'assistant',
          content: tokenized.text,
          contentEnvelope: {
            version: 2,
            format: 'abl.message.v2',
            text: tokenized.text,
            richContent: {
              markdown: tokenized.text,
            },
            voiceConfig: {
              plain_text: tokenized.text,
            },
            actions: {
              elements: [
                {
                  label: tokenized.text,
                  value: 'view-contract',
                },
              ],
            },
          },
        },
      ],
      context,
    );
    const serializedMessage = JSON.stringify(rendered[0]);
    expect(serializedMessage).not.toContain(rawContractId);
    expect(serializedMessage).toContain('REDACTED');
    expect(rendered[0].contentEnvelope).toMatchObject({
      text: expect.stringContaining('REDACTED'),
      richContent: {
        markdown: expect.stringContaining('REDACTED'),
      },
      voiceConfig: {
        plain_text: expect.stringContaining('REDACTED'),
      },
      actions: {
        elements: [
          {
            label: expect.stringContaining('REDACTED'),
            value: 'view-contract',
          },
        ],
      },
    });
  });
});
