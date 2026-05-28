/**
 * Escalation Bridge
 *
 * EventBus subscriber that listens for `session.escalation` events
 * and creates corresponding HumanTask records in the unified inbox.
 *
 * This bridges the agent runtime's escalation system with the HITL
 * workflow, ensuring escalated sessions appear in the unified inbox
 * for human agents to handle.
 */

import { createLogger } from '@abl/compiler/platform';
import { HumanTask } from '@agent-platform/database/models';
import type { EventBus, AnyPlatformEvent, SessionEscalationPayload } from './event-bus/types.js';

const log = createLogger('runtime:escalation-bridge');

const DEFAULT_ESCALATION_DUE_HOURS = 24;

/**
 * Initialize the escalation bridge by subscribing to the EventBus.
 * Creates HumanTask records for agent escalation events.
 */
export function initEscalationBridge(bus: EventBus): void {
  const handler = async (event: AnyPlatformEvent): Promise<void> => {
    if (event.type !== 'session.escalation') return;

    const payload = event.payload as SessionEscalationPayload;

    try {
      // Idempotency: check if an active task already exists for this session
      const existing = await HumanTask.findOne({
        tenantId: event.tenantId,
        'source.type': 'agent_escalation',
        'source.sessionId': event.sessionId,
        status: { $in: ['pending', 'assigned', 'in_progress'] },
      }).lean();

      if (existing) {
        log.info('Escalation task already exists for session', {
          sessionId: event.sessionId,
          taskId: existing._id,
        });
        return;
      }

      const dueAt = new Date(Date.now() + DEFAULT_ESCALATION_DUE_HOURS * 60 * 60 * 1000);

      await HumanTask.create({
        tenantId: event.tenantId,
        projectId: event.projectId,
        type: 'escalation',
        mailbox: 'agent',
        status: 'pending',
        priority: payload.priority ?? 'high',
        title: `Agent escalation: ${payload.reason}`,
        description: `Session ${event.sessionId} escalated by agent ${payload.agent}. Reason: ${payload.reason}`,
        source: {
          type: 'agent_escalation',
          sessionId: event.sessionId,
          agentName: payload.agent,
        },
        assignedToTeam: payload.targetTeam,
        fields: [],
        context: {
          sessionId: event.sessionId,
          agentName: payload.agent,
          channel: event.channel,
          escalationReason: payload.reason,
        },
        dueAt,
        escalationChain: payload.targetTeam ? [payload.targetTeam] : [],
        currentEscalationLevel: 0,
      });

      log.info('Created escalation human task', {
        sessionId: event.sessionId,
        agentName: payload.agent,
        priority: payload.priority,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to create escalation human task', {
        sessionId: event.sessionId,
        error: msg,
      });
    }
  };

  bus.subscribe(handler);
  log.info('Escalation bridge initialized');
}
