import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverAgent } from '../application/discover-agent.js';
import type { DiscoverAgentDeps, DiscoverAgentParams } from '../application/discover-agent.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import type { AgentCard } from '@a2a-js/sdk';

describe('DiscoverAgentUseCase', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;
  let mockClient: { getAgentCard: ReturnType<typeof vi.fn> };
  let deps: DiscoverAgentDeps;

  const ENDPOINT = 'https://remote-agent.example.com';
  const TENANT_ID = 'tenant-1';

  const sampleAgentCard: AgentCard = {
    name: 'Test Agent',
    description: 'A test remote agent',
    url: 'https://remote-agent.example.com/a2a',
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
      },
    ],
  } as AgentCard;

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    validator = {
      validate: vi.fn(),
    };
    mockClient = {
      getAgentCard: vi.fn(),
    };
    deps = {
      tracing,
      validator,
      createClient: vi.fn().mockReturnValue(mockClient),
    };
  });

  it('validates endpoint before discovering', async () => {
    mockClient.getAgentCard.mockResolvedValue(sampleAgentCard);

    await discoverAgent({ endpoint: ENDPOINT, tenantId: TENANT_ID }, deps);

    expect(validator.validate).toHaveBeenCalledWith(ENDPOINT, undefined);
  });

  it('returns the agent card from the SDK client', async () => {
    mockClient.getAgentCard.mockResolvedValue(sampleAgentCard);

    const card = await discoverAgent({ endpoint: ENDPOINT, tenantId: TENANT_ID }, deps);

    expect(deps.createClient).toHaveBeenCalledWith(ENDPOINT);
    expect(mockClient.getAgentCard).toHaveBeenCalledWith(ENDPOINT, undefined);
    expect(card).toEqual(sampleAgentCard);
  });

  it('traces successful discovery calls', async () => {
    mockClient.getAgentCard.mockResolvedValue(sampleAgentCard);

    await discoverAgent({ endpoint: ENDPOINT, tenantId: TENANT_ID }, deps);

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: ENDPOINT,
        taskId: `discovery:${ENDPOINT}`,
        tenantId: TENANT_ID,
        status: 'success',
      }),
    );
    const call = (tracing.traceOutbound as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.durationMs).toBe('number');
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('traces failed discovery calls and re-throws', async () => {
    const fetchError = new Error('Agent card not found');
    mockClient.getAgentCard.mockRejectedValue(fetchError);

    await expect(discoverAgent({ endpoint: ENDPOINT, tenantId: TENANT_ID }, deps)).rejects.toThrow(
      'Agent card not found',
    );

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: ENDPOINT,
        taskId: `discovery:${ENDPOINT}`,
        tenantId: TENANT_ID,
        status: 'error',
        error: 'Agent card not found',
      }),
    );
  });

  it('throws immediately on SSRF-blocked endpoint', async () => {
    (validator.validate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('SSRF blocked: 10.0.0.1 is a private/reserved address');
    });

    await expect(
      discoverAgent({ endpoint: 'http://10.0.0.1/a2a', tenantId: TENANT_ID }, deps),
    ).rejects.toThrow('SSRF blocked');

    expect(deps.createClient).not.toHaveBeenCalled();
    expect(mockClient.getAgentCard).not.toHaveBeenCalled();
  });

  it('passes custom agentCardPath to SDK client', async () => {
    mockClient.getAgentCard.mockResolvedValue(sampleAgentCard);

    await discoverAgent(
      { endpoint: ENDPOINT, tenantId: TENANT_ID, agentCardPath: 'custom/card.json' },
      deps,
    );

    expect(mockClient.getAgentCard).toHaveBeenCalledWith(ENDPOINT, 'custom/card.json');
  });

  it('passes allowPrivate flag to endpoint validator', async () => {
    mockClient.getAgentCard.mockResolvedValue(sampleAgentCard);

    await discoverAgent({ endpoint: ENDPOINT, tenantId: TENANT_ID, allowPrivate: true }, deps);

    expect(validator.validate).toHaveBeenCalledWith(ENDPOINT, true);
  });
});
