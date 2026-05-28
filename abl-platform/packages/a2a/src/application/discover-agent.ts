// packages/a2a/src/application/discover-agent.ts

import type { AgentCard } from '@a2a-js/sdk';
import type { A2AClient } from '@a2a-js/sdk/client';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

export interface DiscoverAgentParams {
  /** Remote agent base URL (e.g. https://agent.example.com) */
  endpoint: string;
  /** Tenant issuing the discovery request */
  tenantId: string;
  /** Allow private/internal endpoints (dev only) */
  allowPrivate?: boolean;
  /** Custom agent card path (defaults to .well-known/agent-card.json) */
  agentCardPath?: string;
}

export interface DiscoverAgentDeps {
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  /** Factory to create A2AClient — enables testing without real HTTP */
  createClient: (baseUrl: string) => A2AClient;
}

/**
 * DiscoverAgentUseCase wraps the A2A SDK's agent card resolution
 * with platform concerns:
 *  - SSRF endpoint validation
 *  - Outbound discovery call tracing (duration, success/error)
 *
 * Uses the SDK's A2AClient.getAgentCard() to fetch the remote
 * agent's card from its well-known URI.
 */
export async function discoverAgent(
  params: DiscoverAgentParams,
  deps: DiscoverAgentDeps,
): Promise<AgentCard> {
  // 1. Validate endpoint (throws on SSRF) and set up tracing
  const interceptor = new TracedCallInterceptor({
    endpoint: params.endpoint,
    tenantId: params.tenantId,
    tracing: deps.tracing,
    validator: deps.validator,
    allowPrivate: params.allowPrivate,
  });

  // 2. Create SDK client
  const client = deps.createClient(interceptor.endpoint);

  // 3. Fetch agent card and trace
  const start = Date.now();
  const DISCOVERY_TASK_ID = `discovery:${params.endpoint}`;
  try {
    const card = await client.getAgentCard(params.endpoint, params.agentCardPath);
    const durationMs = Date.now() - start;
    interceptor.traceCall(DISCOVERY_TASK_ID, durationMs, 'success');
    return card;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    interceptor.traceCall(DISCOVERY_TASK_ID, durationMs, 'error', errorMessage);
    throw error;
  }
}
