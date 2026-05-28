/**
 * Build tools for the BLUEPRINT phase.
 * Used by the v4 message flow under apps/studio/src/app/api/arch-ai/message/route.ts.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { askUserSchema, collectFileSchema } from '@/lib/arch-ai/tool-schemas';
import {
  sessionService,
  journalService,
  specDocumentService,
} from '@/lib/arch-ai/message-services';
import { journalAppendAndEmit, specUpdateAndEmit } from '@/lib/arch-ai/helpers/stream-helpers';
import { validateTopologyRuntimeHints } from '@/lib/arch-ai/topology-runtime-validation';
import type { ArchSSEEvent, ArchSession } from '@agent-platform/arch-ai';

const log = createLogger('api:arch-ai:blueprint-tools');

/** Build tools for BLUEPRINT phase */
export function buildBlueprintTools(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  session: ArchSession,
  emit?: (event: ArchSSEEvent) => void,
  authToken?: string,
  options?: { includeCollectFile?: boolean },
) {
  const includeCollectFile = options?.includeCollectFile ?? true;

  return {
    ask_user: tool({
      description:
        'Ask a clarifying question with a widget only when the coordinator explicitly allows it. ' +
        'Do not self-manage blueprint approval or build transitions.',
      inputSchema: askUserSchema,
    }),
    ...(includeCollectFile
      ? {
          collect_file: tool({
            description: 'Request file upload (API specs, architecture diagrams).',
            inputSchema: collectFileSchema,
          }),
        }
      : {}),
    generate_topology: tool({
      description:
        'Generate or revise a complete multi-agent topology from the specification + blueprint context. ' +
        'Only call this when the coordinator has entered a draft-generation or draft-revision turn.',
      inputSchema: z.object({
        agents: z.array(
          z.object({
            name: z.string(),
            role: z.string(),
            executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
            description: z.string(),
            tools: z
              .array(z.string())
              .optional()
              .describe(
                'Snake_case callable tool names this agent needs, for example lookup_policy or book_appointment. Omit only when the agent truly needs no external lookup, action, or calculation.',
              ),
            gatherFields: z
              .array(z.string())
              .optional()
              .describe(
                'Snake_case fields this agent must ask the end user for directly before completion, for example policy_number or requested_date. Do not include values the supervisor, conversation context, tools, or memory can provide.',
              ),
            flowStepSeeds: z
              .array(z.string())
              .optional()
              .describe(
                'Ordered snake_case step names for scripted/hybrid agents, for example collect_context, run_eligibility_check, confirm_next_step.',
              ),
            suggestedConstructs: z
              .array(z.string())
              .optional()
              .describe(
                'ABL constructs the BUILD phase should consider, for example GATHER, TOOLS, FLOW, HANDOFF, ESCALATE, COMPLETE.',
              ),
          }),
        ),
        edges: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            type: z.enum(['delegate', 'escalate', 'transfer']),
            experienceMode: z
              .enum([
                'shared_voice_handoff',
                'visible_handoff',
                'silent_delegate',
                'human_escalation',
              ])
              .optional()
              .describe(
                'What the customer should perceive when this edge runs. Set on every edge: shared_voice_handoff for customer-facing support specialists, human_escalation for human/escalation targets, visible_handoff for announced transfers, silent_delegate only when DELEGATE agent-as-tool support is available.',
              ),
            condition: z.string(),
            allowCycle: z
              .boolean()
              .optional()
              .describe('Set to true on an edge to allow it to participate in a cycle.'),
            expectReturn: z
              .boolean()
              .optional()
              .describe(
                'true = source resumes after target completes (delegate). false = terminal transfer (escalate/transfer). Omit to infer from edge type.',
              ),
          }),
        ),
        entryPoint: z.string(),
      }),
      execute: async (input) => {
        // Step 1: Analyzing requirements

        // Step 2: Identifying agent roles

        // Validate: entryPoint must be in agents list
        const agentNames = input.agents.map((a) => a.name);
        if (!agentNames.includes(input.entryPoint)) {
          return `Error: entryPoint '${input.entryPoint}' is not in agents list [${agentNames.join(', ')}]`;
        }

        const runtimeHintError = validateTopologyRuntimeHints(input);
        if (runtimeHintError) {
          return runtimeHintError;
        }

        // Step 3: Designing handoffs

        // Validate: edges reference valid agents
        for (const edge of input.edges) {
          if (!agentNames.includes(edge.from)) {
            return `Error: edge from '${edge.from}' references unknown agent`;
          }
          if (!agentNames.includes(edge.to)) {
            return `Error: edge to '${edge.to}' references unknown agent`;
          }
        }

        // Validate: no cycles (unless explicitly allowed via allowCycle on edges).
        // Reuses computeBuildOrder which runs Kahn's topological sort and throws
        // on cycles. This catches designs that would deadlock the builder later.
        try {
          const { computeBuildOrder } = await import('@agent-platform/arch-ai');
          // Normalize input to the shape computeBuildOrder expects.
          // We only care about delegate/transfer edges for build ordering.
          const topologyForSort = {
            agents: input.agents.map((a) => ({
              name: a.name,
              role: a.role,
              executionMode: a.executionMode,
              description: a.description,
            })),
            edges: input.edges
              .filter((e) => !e.allowCycle)
              .map((e) => ({
                from: e.from,
                to: e.to,
                type: e.type,
                experienceMode: e.experienceMode,
                condition: e.condition,
              })),
            entryPoint: input.entryPoint,
          };
          computeBuildOrder(topologyForSort);
        } catch (cycleErr) {
          const msg = cycleErr instanceof Error ? cycleErr.message : String(cycleErr);
          return `Error: ${msg}. Break the cycle by changing edge direction, removing an edge, or setting allowCycle:true on one edge if the loop is intentional.`;
        }

        // Step 4: Creating topology structure

        // Store topology — use native driver but WITH tenant+user isolation
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (!db) {
          return 'Error: database not connected';
        }
        const result = await db
          .collection('arch_sessions')
          .updateOne(
            { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
              string,
              unknown
            >,
            {
              $set: {
                'metadata.blueprintStage': 'draft_ready',
                'metadata.topology': input,
                'metadata.draftTopology': input,
                'metadata.topologyApproved': false,
              },
            },
          );
        if (result.matchedCount === 0) {
          return 'Error: session not found';
        }

        // Step 5: Validating topology

        const topoSummary = `Topology generated: ${input.agents.length} agents, ${input.edges.length} edges, entry: ${input.entryPoint}`;
        await journalAppendAndEmit(
          journalService,
          ctx,
          {
            sessionId,
            type: 'mutation',
            content: {
              type: 'mutation',
              what: `Designed system: ${input.agents.length} agents`,
              to: agentNames.join(', '),
              reason: `${input.edges.length} connections, entry: ${input.entryPoint}`,
              specialist: 'multi-agent-architect',
              requestedBy: 'specialist' as const,
            },
            specialist: 'multi-agent-architect',
            phase: 'BLUEPRINT',
          },
          emit,
        );

        // Spec document parallel writes for topology (non-blocking)
        try {
          const specDocForTopo = await specDocumentService.getBySession(ctx, sessionId);
          if (specDocForTopo) {
            const specId = String(specDocForTopo._id);
            const agents = input.agents.map((a) => ({
              name: a.name,
              role: a.role || '',
              executionMode: a.executionMode || 'reasoning',
              model: null,
              description: a.description || '',
              compileStatus: null,
            }));
            await specUpdateAndEmit(
              specDocumentService,
              log,
              ctx,
              specId,
              'architecture.agents',
              agents,
              emit,
            );
            await specUpdateAndEmit(
              specDocumentService,
              log,
              ctx,
              specId,
              'architecture.edges',
              input.edges || [],
              emit,
            );
            await specUpdateAndEmit(
              specDocumentService,
              log,
              ctx,
              specId,
              'architecture.entryPoint',
              input.entryPoint,
              emit,
            );
            await specUpdateAndEmit(
              specDocumentService,
              log,
              ctx,
              specId,
              'architecture.agentCount',
              input.agents.length,
              emit,
            );
          }
        } catch {
          /* non-blocking — spec doc write failure does not affect main flow */
        }

        return topoSummary;
      },
    }),
    // TODO(v1.1): re-add governance tool when metadata.governance has downstream consumers
    proceed_to_next_phase: tool({
      description:
        'Advance from BLUEPRINT to BUILD phase when the user approves the topology ' +
        '(e.g., "looks good", "proceed", "build it"). Only call this AFTER ' +
        'generate_topology has been called and the topology exists. Do NOT call if ' +
        'the user is requesting changes — handle those first.',
      inputSchema: z.object({
        reason: z.string().describe('Brief explanation of why the user is ready to proceed'),
      }),
      execute: async () => {
        const { executePhaseTransition } = await import('@/lib/arch-ai/phase-transition');

        // Re-read session to get latest topology state
        const freshSession = await sessionService.getById(ctx, sessionId);
        if (!freshSession) {
          return { error: 'Session not found' };
        }

        const meta = freshSession.metadata as unknown as Record<string, unknown>;
        if (!meta.topology) {
          return {
            error:
              'No topology exists yet. Call generate_topology first to design the architecture.',
          };
        }

        const emitFn = emit ?? (() => {});
        const journalFn = async (summary: string, rationale: string, spec: string, ph: string) => {
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'decision',
              content: {
                type: 'decision',
                summary,
                rationale,
                specialist: spec,
                source: 'specialist_recommendation' as const,
              },
              specialist: spec,
              phase: ph,
            },
            emit,
          );
        };

        return executePhaseTransition(ctx, freshSession, sessionService, emitFn, journalFn);
      },
    }),
    platform_context: tool({
      description:
        'Query platform capabilities — list available LLM models. ' +
        'Use this to populate selection widgets with real data instead of asking users to type from memory. ' +
        'During onboarding (before project creation), only list_models is available.',
      inputSchema: z.object({
        action: z
          .enum([
            'get_summary',
            'list_agents',
            'list_models',
            'list_tools',
            'list_channels',
            'list_auth_profiles',
          ])
          .describe('Platform context action to perform'),
        agentName: z.string().optional().describe('Filter by agent name (for agent-specific data)'),
        toolType: z.string().optional().describe('Filter by tool type (for list_tools)'),
      }),
      execute: async (input) => {
        const projectScopedActions = [
          'get_summary',
          'list_agents',
          'list_tools',
          'list_channels',
          'list_auth_profiles',
        ];
        if (projectScopedActions.includes(input.action)) {
          return {
            success: false,
            error: {
              code: 'PROJECT_REQUIRED',
              message:
                'This action requires a project. It will be available after the project is created. ' +
                'During onboarding, use list_models to query available LLM models.',
            },
          };
        }
        const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
        return executePlatformContext(input, {
          projectId: '',
          user: {
            permissions: [],
            tenantId: ctx.tenantId,
            userId: ctx.userId,
          },
          authToken,
        });
      },
    }),
  };
}
