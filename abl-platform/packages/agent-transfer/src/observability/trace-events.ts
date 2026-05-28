export interface TraceEventEmitter {
  emit(event: {
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
  }): void | Promise<void>;
}

interface BaseTransferTrace {
  tenantId: string;
  projectId: string;
  contactId: string;
  provider: string;
  channel: string;
  timestamp: number;
}

export interface TransferInitiatedTrace extends BaseTransferTrace {
  kind: 'transfer_initiated';
  queue?: string;
  skills?: string[];
}

export interface TransferCompletedTrace extends BaseTransferTrace {
  kind: 'transfer_completed';
  status: string;
  durationMs: number;
}

export interface TransferFailedTrace extends BaseTransferTrace {
  kind: 'transfer_failed';
  errorCode: string;
  errorMessage: string;
}

export interface AgentConnectedTrace extends BaseTransferTrace {
  kind: 'agent_connected';
  agentName?: string;
  waitTimeMs?: number;
}

export interface AgentDisconnectedTrace extends BaseTransferTrace {
  kind: 'agent_disconnected';
  reason?: string;
  durationMs?: number;
}

export interface CsatCompletedTrace extends BaseTransferTrace {
  kind: 'csat_completed';
  score?: number;
  feedback?: string;
}

export type TransferTraceEvent =
  | TransferInitiatedTrace
  | TransferCompletedTrace
  | TransferFailedTrace
  | AgentConnectedTrace
  | AgentDisconnectedTrace
  | CsatCompletedTrace;

export function emitTransferTraceEvent(
  emitter: TraceEventEmitter,
  event: TransferTraceEvent,
): void | Promise<void> {
  const { kind, ...data } = event;
  return emitter.emit({
    type: `agent_transfer.${kind}`,
    timestamp: event.timestamp,
    data: data as Record<string, unknown>,
  });
}
