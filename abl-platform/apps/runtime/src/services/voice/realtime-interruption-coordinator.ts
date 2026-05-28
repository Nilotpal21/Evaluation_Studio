import { randomUUID } from 'crypto';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('realtime-interruption-coordinator');

const MAX_REALTIME_INTERRUPTION_REGISTRATIONS = 10_000;
const REALTIME_INTERRUPTION_TTL_MS = 4 * 60 * 60 * 1000;

export type RealtimeInterruptionReason = 'barge_in' | 'typed_interrupt';

export interface RealtimeInterruptionRegistration {
  sessionIds: string[];
  tenantId?: string;
  provider: string;
  interrupt: (reason: RealtimeInterruptionReason) => void;
  acknowledge?: () => void;
}

export interface RealtimeInterruptionDispatchResult {
  interrupted: number;
  acknowledgements: number;
}

interface RegisteredRealtimeInterruptionTarget extends Omit<
  RealtimeInterruptionRegistration,
  'sessionIds'
> {
  registrationId: string;
  registeredAt: number;
  sessionIds: string[];
}

const registrationsById = new Map<string, RegisteredRealtimeInterruptionTarget>();
const registrationsBySessionId = new Map<
  string,
  Map<string, RegisteredRealtimeInterruptionTarget>
>();

export function registerRealtimeInterruptionTarget(
  registration: RealtimeInterruptionRegistration,
): string {
  const sessionIds = normalizeSessionIds(registration.sessionIds);
  if (sessionIds.length === 0) {
    throw new Error('Realtime interruption registration requires at least one sessionId');
  }

  evictStaleRegistrations();
  while (registrationsById.size >= MAX_REALTIME_INTERRUPTION_REGISTRATIONS) {
    if (!evictOldestRegistration()) {
      break;
    }
  }

  const target: RegisteredRealtimeInterruptionTarget = {
    ...registration,
    registrationId: randomUUID(),
    registeredAt: Date.now(),
    sessionIds,
  };

  registrationsById.set(target.registrationId, target);
  for (const sessionId of sessionIds) {
    let sessionRegistrations = registrationsBySessionId.get(sessionId);
    if (!sessionRegistrations) {
      sessionRegistrations = new Map();
      registrationsBySessionId.set(sessionId, sessionRegistrations);
    }
    sessionRegistrations.set(target.registrationId, target);
  }

  return target.registrationId;
}

export function unregisterRealtimeInterruptionTarget(registrationId: string | undefined): void {
  if (!registrationId) {
    return;
  }

  const target = registrationsById.get(registrationId);
  if (!target) {
    return;
  }

  registrationsById.delete(registrationId);
  for (const sessionId of target.sessionIds) {
    const sessionRegistrations = registrationsBySessionId.get(sessionId);
    if (!sessionRegistrations) {
      continue;
    }
    sessionRegistrations.delete(registrationId);
    if (sessionRegistrations.size === 0) {
      registrationsBySessionId.delete(sessionId);
    }
  }
}

export function interruptRealtimeVoiceSession(
  targetSessionId: string,
  options: {
    tenantId?: string;
    reason: RealtimeInterruptionReason;
  },
): RealtimeInterruptionDispatchResult {
  evictStaleRegistrations();

  const sessionRegistrations = registrationsBySessionId.get(targetSessionId);
  if (!sessionRegistrations || sessionRegistrations.size === 0) {
    return { interrupted: 0, acknowledgements: 0 };
  }

  let interrupted = 0;
  let acknowledgements = 0;

  for (const target of sessionRegistrations.values()) {
    if (options.tenantId && target.tenantId && target.tenantId !== options.tenantId) {
      continue;
    }

    try {
      target.interrupt(options.reason);
      interrupted++;
    } catch (err) {
      log.warn('Failed to interrupt realtime voice target', {
        error: err instanceof Error ? err.message : String(err),
        provider: target.provider,
        registrationId: target.registrationId,
        sessionId: targetSessionId,
        reason: options.reason,
      });
      continue;
    }

    if (target.acknowledge) {
      try {
        target.acknowledge();
        acknowledgements++;
      } catch (err) {
        log.warn('Failed to acknowledge realtime voice interruption', {
          error: err instanceof Error ? err.message : String(err),
          provider: target.provider,
          registrationId: target.registrationId,
          sessionId: targetSessionId,
          reason: options.reason,
        });
      }
    }
  }

  return { interrupted, acknowledgements };
}

export function resetRealtimeInterruptionCoordinatorForTests(): void {
  registrationsById.clear();
  registrationsBySessionId.clear();
}

function normalizeSessionIds(sessionIds: string[]): string[] {
  return [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
}

function evictStaleRegistrations(now = Date.now()): void {
  for (const [registrationId, target] of registrationsById) {
    if (now - target.registeredAt > REALTIME_INTERRUPTION_TTL_MS) {
      unregisterRealtimeInterruptionTarget(registrationId);
    }
  }
}

function evictOldestRegistration(): boolean {
  let oldestRegistrationId: string | undefined;
  let oldestRegisteredAt = Number.POSITIVE_INFINITY;

  for (const [registrationId, target] of registrationsById) {
    if (target.registeredAt < oldestRegisteredAt) {
      oldestRegisteredAt = target.registeredAt;
      oldestRegistrationId = registrationId;
    }
  }

  if (!oldestRegistrationId) {
    return false;
  }

  unregisterRealtimeInterruptionTarget(oldestRegistrationId);
  return true;
}
