import type { Session, SessionState } from './types.js';

export const DEFAULT_WATCH_LINES = 20;
export const DEFAULT_WATCH_POLL_MS = 1000;
export const DEFAULT_WATCH_STALE_AFTER_MS = 60_000;

interface FormatSessionWatchSummaryOptions {
  nowMs?: number;
  staleAfterMs?: number;
}

export function isTerminalSessionState(state: SessionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'paused';
}

export function resolveCurrentStageLabel(session: Session): string {
  const pipelineStages = session.pipelineSnapshot?.stages;
  if (!pipelineStages || pipelineStages.length === 0) {
    return `Stage ${session.currentStageIndex + 1}`;
  }

  const currentStage = pipelineStages[session.currentStageIndex];
  if (currentStage) {
    return currentStage.name;
  }

  return isTerminalSessionState(session.state) ? 'Pipeline Complete' : 'Unknown Stage';
}

export function isSessionHeartbeatStale(
  session: Pick<Session, 'state' | 'heartbeat' | 'updatedAt'>,
  options: FormatSessionWatchSummaryOptions = {},
): boolean {
  if (isTerminalSessionState(session.state)) {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_WATCH_STALE_AFTER_MS;
  const referenceIso = session.heartbeat?.at ?? session.updatedAt;
  const referenceMs = Date.parse(referenceIso);

  if (!Number.isFinite(referenceMs)) {
    return false;
  }

  return nowMs - referenceMs > staleAfterMs;
}

export function buildSessionWatchSignature(session: Session): string {
  return JSON.stringify({
    state: session.state,
    currentStageIndex: session.currentStageIndex,
    findings: session.findings.length,
    decisions: session.decisions.length,
    updatedAt: session.updatedAt,
    heartbeatAt: session.heartbeat?.at,
    heartbeatStage: session.heartbeat?.stage,
    heartbeatMessage: session.heartbeat?.message,
  });
}

export function formatSessionWatchSummary(
  session: Session,
  options: FormatSessionWatchSummaryOptions = {},
): string {
  const totalStages = session.pipelineSnapshot?.stages.length;
  const stageLabel = resolveCurrentStageLabel(session);
  const stageCounter =
    totalStages && totalStages > 0
      ? `${Math.min(session.currentStageIndex + 1, totalStages)}/${totalStages}`
      : null;
  const heartbeatLabel = session.heartbeat
    ? `${shortTime(session.heartbeat.at)} ${session.heartbeat.stage ?? stageLabel}: ${truncate(session.heartbeat.message, 88)}`
    : `${shortTime(session.updatedAt)} session persisted`;

  const parts = [
    `[watch] ${shortTime(session.updatedAt)}`,
    `state=${session.state}`,
    stageCounter ? `stage=${stageLabel} (${stageCounter})` : `stage=${stageLabel}`,
    `findings=${session.findings.length}`,
    `decisions=${session.decisions.length}`,
    `heartbeat=${heartbeatLabel}`,
  ];

  if (isSessionHeartbeatStale(session, options)) {
    parts.push(
      `stale=${formatAgeMs((options.nowMs ?? Date.now()) - Date.parse(session.heartbeat?.at ?? session.updatedAt))}`,
    );
  }

  return parts.join(' | ');
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return iso;
  }
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatAgeMs(value: number): string {
  const seconds = Math.max(1, Math.round(value / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
