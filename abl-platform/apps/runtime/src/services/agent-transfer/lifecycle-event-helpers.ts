/**
 * Pure field-extraction helpers for agent transfer lifecycle events.
 * Extracted from index.ts to make the logic unit-testable without singletons.
 */

/** Fields selectively extracted from SmartAssist event data for agent_disconnected. */
export interface AgentDisconnectedSelectiveFields {
  originalType?: string;
  syntheticDisconnect?: true;
  isACWEnabled?: true;
  acwStartTime?: string;
}

/** Parsed fields from an ACW data message (agent:message with isACWEnabled=true). */
export interface AcwMessageFields {
  dispositionCode: string | undefined;
  wrapUpNotes: string | undefined;
  acwTimedOut: boolean;
  acwCloseReason: 'timeout' | 'agent_closed';
  acwEventTimestamp: string | undefined;
}

/**
 * Extracts selective SmartAssist fields from agent:disconnected event data.
 * Only truthy/string values are included — absent or wrong-typed fields are omitted.
 */
export function extractAgentDisconnectedFields(
  eventData: Record<string, unknown> | undefined,
): AgentDisconnectedSelectiveFields {
  return {
    originalType: typeof eventData?.originalType === 'string' ? eventData.originalType : undefined,
    syntheticDisconnect: eventData?.syntheticDisconnect === true ? true : undefined,
    isACWEnabled: eventData?.isACWEnabled === true ? true : undefined,
    acwStartTime: typeof eventData?.acwStartTime === 'string' ? eventData.acwStartTime : undefined,
  };
}

/**
 * Parses an ACW data message payload into typed fields for the acw_completed event.
 * Called when agent:message arrives with isACWEnabled=true in post_agent state.
 */
export function parseAcwMessageFields(msgData: Record<string, unknown>): AcwMessageFields {
  const dispositionCode = typeof msgData.closeStatus === 'string' ? msgData.closeStatus : undefined;
  const wrapUpNotes = typeof msgData.closeRemarks === 'string' ? msgData.closeRemarks : undefined;
  const acwTimedOut = msgData.acwTimedOut === true;
  const acwCloseReason: 'timeout' | 'agent_closed' = acwTimedOut ? 'timeout' : 'agent_closed';
  const acwEventTimestamp = typeof msgData.timestamp === 'string' ? msgData.timestamp : undefined;

  return { dispositionCode, wrapUpNotes, acwTimedOut, acwCloseReason, acwEventTimestamp };
}
