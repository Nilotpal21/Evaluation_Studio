/**
 * SimulatePersona — Restate activity for generating persona messages.
 *
 * Given a persona configuration, conversation history, and scenario context,
 * generates the next message a simulated user would send to the agent.
 * Supports configurable LLM model per eval set and adversarial personas.
 *
 * Config:
 *   persona:            PersonaConfig object
 *   scenario:           ScenarioConfig object
 *   conversation:       ConversationTurn[] — current conversation history
 *   personaModel:       string — LLM model override (optional)
 *   temperature:        number — LLM temperature (default: 0.7)
 *   maxTokens:          number — max output tokens (default: 512)
 *   tenantId:           string — for LLM client resolution
 *   projectId:          string — for LLM client resolution
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { resolvePipelineLLM } from '../llm-client-factory.js';
import { pipelineGenerateText } from '../pipeline-llm-call.js';
import { withCircuitBreaker } from './eval-circuit-breakers.js';
import { checkLLMRateLimit } from './eval-rate-limiter.js';
import { evalMetrics } from './eval-metrics.js';
import type { PipelineStepContext, StepOutput } from '../../types.js';
import type { PersonaConfig, ScenarioConfig, ConversationTurn } from './eval-types.js';
import { PERSONA_END_SIGNAL } from './eval-types.js';
import {
  buildPersonaSystemPrompt,
  getAdversarialInstructions,
  buildConversationContext,
} from '../../prompts/index.js';

const log = createLogger('eval-persona-sim');

// ── Service Definition ──────────────────────────────────────────────

export const simulatePersonaService = restate.service({
  name: 'SimulatePersona',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const {
        persona,
        scenario,
        conversation = [],
        tenantId: configTenantId,
        projectId: configProjectId,
        personaModel,
        temperature = 0.7,
        maxTokens = 512,
      } = input.config as {
        persona: PersonaConfig;
        scenario: ScenarioConfig;
        conversation: ConversationTurn[];
        tenantId?: string;
        projectId?: string;
        personaModel?: string;
        temperature?: number;
        maxTokens?: number;
      };

      const tenantId = configTenantId ?? input.tenantId;
      const projectId = configProjectId ?? input.projectId ?? '';
      const attrs = { tenant_id: tenantId, project_id: projectId };

      if (!persona || !scenario) {
        return {
          status: 'fail',
          data: { error: 'SimulatePersona requires persona and scenario in config' },
          durationMs: Date.now() - startTime,
        };
      }

      evalMetrics.personaCallsStarted.add(1, attrs);

      try {
        // Rate limit check
        if (!checkLLMRateLimit(tenantId)) {
          return {
            status: 'fail',
            data: { error: 'LLM rate limit exceeded for tenant' },
            durationMs: Date.now() - startTime,
          };
        }

        const result = await ctx.run('generate-persona-message', async () => {
          const resolved = await resolvePipelineLLM(tenantId, projectId, personaModel);

          const systemPrompt = buildPersonaSystemPrompt(persona, scenario);
          const conversationContext = buildConversationContext(conversation);

          const userContent =
            conversation.length === 0
              ? `Generate the first message this persona would send to start the conversation.\n\n${conversationContext}`
              : `Generate the next message this persona would send in response to the agent.\n\n${conversationContext}`;

          return withCircuitBreaker('eval-persona-llm', async () => {
            return pipelineGenerateText(
              resolved,
              {
                system: systemPrompt,
                messages: [{ role: 'user' as const, content: userContent }],
                maxOutputTokens: maxTokens,
                temperature,
              },
              { service: 'eval-simulate-persona', tenantId },
            );
          });
        });

        const message = result.content.trim();
        const isEnd = message === PERSONA_END_SIGNAL;
        const durationMs = Date.now() - startTime;

        evalMetrics.personaCallsCompleted.add(1, attrs);
        evalMetrics.personaDuration.record(durationMs, attrs);

        log.debug('Persona message generated', {
          sessionId: input.sessionId,
          personaId: persona._id,
          scenarioId: scenario._id,
          turnNumber: Math.floor(conversation.length / 2) + 1,
          isEnd,
          durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        return {
          status: 'success',
          data: {
            message: isEnd ? PERSONA_END_SIGNAL : message,
            isEnd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            model: result.model,
          },
          durationMs,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        evalMetrics.personaCallsFailed.add(1, attrs);
        log.error('Persona simulation failed', {
          sessionId: input.sessionId,
          personaId: persona._id,
          scenarioId: scenario._id,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type SimulatePersonaService = typeof simulatePersonaService;
