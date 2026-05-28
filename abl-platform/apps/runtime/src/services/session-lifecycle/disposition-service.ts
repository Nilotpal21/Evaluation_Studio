import type {
  CanonicalSessionDisposition,
  CanonicalSessionStatus,
} from '@abl/compiler/platform/core/types';

const CANONICAL_DISPOSITION_BY_REASON: Record<string, CanonicalSessionDisposition> = {
  completed: 'completed',
  agent_completed: 'completed',
  conversation_complete: 'completed',
  abandoned: 'abandoned',
  agent_hangup: 'agent_hangup',
  transferred: 'transferred',
  failed: 'failed',
  timeout: 'timeout',
  unengaged: 'unengaged',
  error: 'failed',
  user_left: 'abandoned',
  user_exit: 'abandoned',
};

const STATUS_BY_DISPOSITION: Record<CanonicalSessionDisposition, CanonicalSessionStatus> = {
  completed: 'completed',
  abandoned: 'abandoned',
  agent_hangup: 'abandoned',
  transferred: 'escalated',
  failed: 'abandoned',
  timeout: 'abandoned',
  unengaged: 'abandoned',
};

export interface NormalizedSessionDisposition {
  disposition: CanonicalSessionDisposition;
  status: CanonicalSessionStatus;
}

export function normalizeSessionDisposition(
  reason: string | null | undefined,
): CanonicalSessionDisposition | undefined {
  if (!reason) {
    return undefined;
  }

  return CANONICAL_DISPOSITION_BY_REASON[reason];
}

export function deriveSessionStatus(
  disposition: CanonicalSessionDisposition,
): CanonicalSessionStatus {
  return STATUS_BY_DISPOSITION[disposition];
}

export function normalizeTerminalDisposition(
  reason: string | null | undefined,
): NormalizedSessionDisposition | undefined {
  const disposition = normalizeSessionDisposition(reason);
  if (!disposition) {
    return undefined;
  }

  return {
    disposition,
    status: deriveSessionStatus(disposition),
  };
}

export class SessionDispositionService {
  normalize(reason: string | null | undefined): NormalizedSessionDisposition | undefined {
    return normalizeTerminalDisposition(reason);
  }

  deriveStatus(disposition: CanonicalSessionDisposition): CanonicalSessionStatus {
    return deriveSessionStatus(disposition);
  }
}
