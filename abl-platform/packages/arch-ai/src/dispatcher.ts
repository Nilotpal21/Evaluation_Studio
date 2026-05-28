/**
 * One-shot Dispatcher — determines the next synthetic event
 * to feed into `processMessage` when driving the Arch pipeline
 * server-side for a synchronous one-shot generation.
 *
 * This is a pure function (aside from reading session state) and
 * is fully unit-testable without mocks.
 */

import type { ArchSession, MessageRequest } from '@agent-platform/arch-ai';

/** Sentinel indicating the pipeline is complete. */
export type DispatchResult = MessageRequest | { type: 'done' } | { type: 'error'; reason: string };

/**
 * Max iterations before aborting to prevent runaway loops.
 * Each iteration is one call to processMessage.
 */
export const MAX_DISPATCH_ITERATIONS = 30;

/**
 * Given the current session state after a processMessage call,
 * determine the next event to feed back into processMessage.
 *
 * Returns 'done' when the pipeline has completed (BUILD is done
 * and the session has moved past it), or 'error' if the session
 * is in an unexpected state.
 */
export function decideNextEvent(session: ArchSession, specText: string): DispatchResult {
  const { phase, pendingInteraction, topology, topologyApproved, buildProgress, files } =
    session.metadata;
  const state = session.state;
  const meta = session.metadata as unknown as Record<string, unknown>;

  // Pipeline is complete — session has reached terminal state
  if (state === 'COMPLETE' || state === 'ARCHIVED') {
    return { type: 'done' };
  }

  // INTERVIEW phase → skip directly (we already set the spec, just continue)
  if (phase === 'INTERVIEW' && (state === 'IDLE' || state === 'ACTIVE')) {
    return {
      sessionId: session.id,
      type: 'continue',
    };
  }

  // BLUEPRINT phase handling
  if (phase === 'BLUEPRINT') {
    // Topology approved, session idle → continue to BUILD
    if (topologyApproved && state === 'IDLE' && !pendingInteraction) {
      return {
        sessionId: session.id,
        type: 'continue',
      };
    }

    // Gate pending with topology_approval → auto-accept
    if (state === 'GATE_PENDING' && pendingInteraction?.kind === 'gate') {
      const gateType = (pendingInteraction.payload as Record<string, unknown>)?.gateType;
      if (gateType === 'topology_approval') {
        return {
          sessionId: session.id,
          type: 'gate_response',
          action: 'accept',
        };
      }
    }

    // Widget pending (ask_user) — answer it to keep the flow going
    if (state === 'IDLE' && pendingInteraction?.kind === 'widget') {
      const widgetPayload = pendingInteraction.payload as Record<string, unknown>;
      if (widgetPayload?.widgetType === 'TopologyApproval') {
        return {
          sessionId: session.id,
          type: 'tool_answer',
          toolCallId: pendingInteraction.id,
          answer: 'accept',
        };
      }
      if (widgetPayload?.widgetType === 'BlueprintConfirm') {
        return {
          sessionId: session.id,
          type: 'tool_answer',
          toolCallId: pendingInteraction.id,
          answer: 'generate_draft_topology',
        };
      }
      return {
        sessionId: session.id,
        type: 'tool_answer',
        toolCallId: pendingInteraction.id,
        answer: `Based on the spec, here is the answer: ${specText.slice(0, 200)}. Please proceed with the topology generation.`,
      };
    }

    // No topology yet, session idle → send spec as message to trigger LLM generation
    if (!topology && state === 'IDLE' && !pendingInteraction) {
      return {
        sessionId: session.id,
        type: 'message',
        text: `Design the complete agent topology for this project NOW. Do NOT call ask_user — you have all the information you need in the specification below. Make reasonable assumptions and call generate_topology directly with a multi-agent design that covers all the described workflows.\n\n${specText}`,
      };
    }

    // Topology exists but not approved yet, session idle → the LLM should have
    // raised a gate_request. If not, send a message to trigger the gate
    if (topology && !topologyApproved && state === 'IDLE' && !pendingInteraction) {
      return {
        sessionId: session.id,
        type: 'message',
        text: 'Please finalize the topology and present it for approval.',
      };
    }

    // ACTIVE state — wait for completion (processMessage is running)
    if (state === 'ACTIVE') {
      return { type: 'error', reason: 'Session unexpectedly still ACTIVE in BLUEPRINT' };
    }
  }

  // BUILD phase handling
  if (phase === 'BUILD') {
    // Widget pending (BuildComplete) — auto-answer with 'create'
    if (pendingInteraction?.kind === 'widget' && state === 'IDLE') {
      const widgetPayload = pendingInteraction.payload as Record<string, unknown>;
      if (widgetPayload?.widgetType === 'BuildComplete') {
        return {
          sessionId: session.id,
          type: 'tool_answer',
          toolCallId: pendingInteraction.id,
          answer: 'create',
        };
      }
      // Other widget types — answer generically
      return {
        sessionId: session.id,
        type: 'tool_answer',
        toolCallId: pendingInteraction.id,
        answer: 'proceed',
      };
    }

    // Build is complete, session idle → trigger CREATE
    if (buildProgress?.stage === 'complete' && state === 'IDLE') {
      return {
        sessionId: session.id,
        type: 'create',
      };
    }

    // Gate pending in BUILD (agent_review) — auto-accept
    if (state === 'GATE_PENDING' && pendingInteraction?.kind === 'gate') {
      return {
        sessionId: session.id,
        type: 'gate_response',
        action: 'accept',
      };
    }

    // No files yet, session idle, no pending → send message to trigger generation
    const existingFiles = files ?? {};
    const topoAgents = (meta.topology as { agents?: Array<{ name: string }> } | undefined)?.agents;
    const missingAgents = topoAgents
      ? topoAgents.filter((a) => !(a.name in (existingFiles as Record<string, unknown>)))
      : [];

    if (state === 'IDLE' && missingAgents.length > 0 && !pendingInteraction) {
      return {
        sessionId: session.id,
        type: 'message',
        text: 'Generate all agents for the approved topology.',
      };
    }

    // All files generated but stage not marked complete — send continue
    if (state === 'IDLE' && missingAgents.length === 0 && topoAgents && topoAgents.length > 0) {
      return {
        sessionId: session.id,
        type: 'continue',
      };
    }

    if (state === 'ACTIVE') {
      return { type: 'error', reason: 'Session unexpectedly still ACTIVE in BUILD' };
    }
  }

  // CREATE phase — project creation is pending
  if (phase === 'CREATE') {
    // If projectId is already set, we're done
    if (meta.projectId) {
      return { type: 'done' };
    }

    // Otherwise, trigger the actual project creation
    if (state === 'IDLE') {
      return {
        sessionId: session.id,
        type: 'create',
      };
    }
  }

  return { type: 'error', reason: `Unexpected state: phase=${phase}, state=${state}` };
}
