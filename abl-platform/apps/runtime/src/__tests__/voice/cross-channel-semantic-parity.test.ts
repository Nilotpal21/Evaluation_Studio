import { describe, expect, test } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
} from '../../services/runtime-executor.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import { executeLiveVoiceSemanticTurn } from '../../services/voice/live-voice-runtime-bridge.js';
import { executeVoiceTurn } from '../../services/voice/voice-turn-coordinator.js';
import { loadOrchestrationFixture } from '../helpers/orchestration-harness.js';

const PARITY_SCOPE = {
  userId: 'user-voice-parity',
} as const;

const TURN_TIMEOUT_MS = 30_000;

const GATHER_PROGRESSIVE_DSL = `
AGENT: Gather_Progressive_Test

GOAL: "Test progressive single-field GATHER"

FLOW:
  entry_point: get_destination
  steps:
    - get_destination
    - get_name
    - confirm

get_destination:
  GATHER: destination
  PROMPT: "Where are you going?"
  THEN: get_name

get_name:
  GATHER: name
  PROMPT: "What is your name?"
  THEN: confirm

confirm:
  RESPOND: "Booking for {{name}} to {{destination}}."
  THEN: COMPLETE
`;

const STEP_DIGRESSION_RESUME_DSL = `
AGENT: Digression_Resume_Parity

GOAL: "Resume the active gather step after a help digression"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request
    - confirm

collect_request:
  REASONING: false
  GATHER:
    - request: required
  DIGRESSIONS:
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "I can help with booking, cancellation, and status."
      RESUME: true
  THEN: confirm

confirm:
  REASONING: false
  RESPOND: "Captured request: {{request}}."
  THEN: COMPLETE
`;

const AUTH_GATED_SUPERVISOR_DSL = `
AGENT: Auth_Gated_Supervisor

GOAL: "Authenticate account balance requests before sharing the balance"

MEMORY:
  session:
    - route
    - account_verified
    - account_balance

FLOW:
  entry_point: classify
  steps:
    - classify
    - serve_balance

classify:
  REASONING: false
  GATHER:
    - request: required
  ON_INPUT:
    - IF: account_verified == true OR account_verified == "true"
      THEN: serve_balance
    - IF: input contains "balance"
      SET: route = "auth"
      THEN: COMPLETE
    - ELSE:
      RESPOND: "Tell me if you need your account balance."
      THEN: COMPLETE

serve_balance:
  REASONING: false
  RESPOND: "Your account balance is {{account_balance}}."
  THEN: COMPLETE

RETURN_HANDLERS:
  auth_follow_up:
    RESUME_INTENT: true

HANDOFF:
  - TO: Auth_Verification_Agent
    WHEN: route == "auth"
    CONTEXT:
      pass: [route, request]
      summary: "Verify the caller before sharing balance details."
    RETURN: true
    ON_RETURN:
      handler: auth_follow_up
      map:
        route: route
        account_verified: account_verified
        account_balance: account_balance
`;

const AUTH_VERIFICATION_CHILD_DSL = `
AGENT: Auth_Verification_Agent

GOAL: "Verify the caller with a passcode"

MEMORY:
  session:
    - route
    - account_verified
    - account_balance

EXECUTION:
  inline_gather: true

FLOW:
  entry_point: collect_passcode
  steps:
    - collect_passcode
    - auth_complete

collect_passcode:
  REASONING: false
  GATHER:
    - passcode: required
      prompt: "Please share your passcode."
      type: string
      sensitive: true
  THEN: auth_complete

auth_complete:
  REASONING: false
  SET: account_verified = true
  SET: account_balance = "$5,000"
  SET: route = "balance_ready"
  RESPOND: "Thanks, you are verified."
  THEN: complete

COMPLETE:
  - WHEN: account_verified == true OR account_verified == "true"
    RESPOND: "Thanks, you are verified."
`;

const CONFIRMATION_COMPLETION_DSL = `
AGENT: Confirmation_Completion_Parity

GOAL: "Finalize a prepared booking after user confirmation"

FLOW:
  entry_point: confirm_booking
  steps:
    - confirm_booking
    - finalize

confirm_booking:
  REASONING: false
  GATHER: confirmation
  PROMPT: "Say confirm to finalize your booking."
  ON_INPUT:
    - IF: input contains "confirm" AND destination IS SET AND checkin IS SET AND checkout IS SET
      THEN: finalize
    - ELSE:
      RESPOND: "Say confirm to finalize your booking."
      THEN: confirm_booking

finalize:
  REASONING: false
  RESPOND: "Booking locked for {{destination}} from {{checkin}} to {{checkout}}."
  THEN: COMPLETE
`;

type ParityChannelType = 'web_chat' | 'korevg' | 'voice_realtime';

interface ChannelHarness {
  channelType: ParityChannelType;
  executor: RuntimeExecutor;
  session: RuntimeSession;
}

interface ChannelHarnesses {
  chat: ChannelHarness;
  korevg: ChannelHarness;
  realtime: ChannelHarness;
}

interface TurnOutcome {
  responseText: string;
  actionType?: string;
  traceTypes: string[];
}

function createHarness(
  dsls: string[],
  entryAgentName: string,
  channelType: ParityChannelType,
): ChannelHarness {
  const executor = new RuntimeExecutor();
  const session = executor.createSessionFromResolved(compileToResolvedAgent(dsls, entryAgentName), {
    ...PARITY_SCOPE,
    channelType,
  });

  return { channelType, executor, session };
}

function createHarnesses(dsls: string[], entryAgentName: string): ChannelHarnesses {
  return {
    chat: createHarness(dsls, entryAgentName, 'web_chat'),
    korevg: createHarness(dsls, entryAgentName, 'korevg'),
    realtime: createHarness(dsls, entryAgentName, 'voice_realtime'),
  };
}

async function runAcrossChannels<T>(
  harnesses: ChannelHarnesses,
  callback: (harness: ChannelHarness) => Promise<T>,
): Promise<{ chat: T; korevg: T; realtime: T }> {
  // Keep channel executions isolated so parity checks don't depend on
  // cross-channel singleton contention inside the runtime harness.
  const chat = await callback(harnesses.chat);
  const korevg = await callback(harnesses.korevg);
  const realtime = await callback(harnesses.realtime);

  return { chat, korevg, realtime };
}

function expectChannelParity<T>(snapshots: { chat: T; korevg: T; realtime: T }) {
  expect(snapshots.korevg).toEqual(snapshots.chat);
  expect(snapshots.realtime).toEqual(snapshots.chat);
}

function normalizeTransferBanner(text: string): string {
  // completeCustomerContinuityPhrase now rewrites the bare gerund opener
  // ("Transferring you to …") into the first-person form
  // ("I'm transferring you to …") for customer-facing delivery, so accept
  // either variant when stripping the bridge banner.
  return text.replace(/^(?:I'm transferring|Transferring) you to .*? One moment please\.?/, '');
}

function setHarnessValues(harnesses: ChannelHarnesses, values: Record<string, unknown>) {
  for (const harness of [harnesses.chat, harnesses.korevg, harnesses.realtime]) {
    Object.assign(harness.session.data.values, values);
  }
}

async function initializeHarness(harness: ChannelHarness): Promise<string> {
  const chunks: string[] = [];
  await harness.executor.initializeSession(harness.session.id, (chunk) => chunks.push(chunk));
  return chunks.join('');
}

async function executeSemanticTurn(
  harness: ChannelHarness,
  utterance: string,
): Promise<TurnOutcome> {
  const chunks: string[] = [];
  const traceTypes: string[] = [];

  if (harness.channelType === 'web_chat') {
    const result = await harness.executor.executeMessage(
      harness.session.id,
      utterance,
      (chunk) => chunks.push(chunk),
      (event) => traceTypes.push(event.type),
    );
    return {
      responseText: chunks.join('') || result.response,
      actionType: result.action?.type,
      traceTypes,
    };
  }

  if (harness.channelType === 'korevg') {
    const result = await executeVoiceTurn({
      channelType: harness.channelType,
      executor: harness.executor,
      sessionId: harness.session.id,
      utterance,
      timeoutMs: TURN_TIMEOUT_MS,
      promptProfile: 'pipeline',
      onChunk: (chunk) => chunks.push(chunk),
      onTraceEvent: (event) => traceTypes.push(event.type),
      executeOptions: {
        channelMetadata: {
          channel: harness.channelType,
          contentLength: utterance.length,
        },
      },
    });

    return {
      responseText: chunks.join('') || result.outcome.responseText,
      actionType: result.outcome.action?.type,
      traceTypes,
    };
  }

  const result = await executeLiveVoiceSemanticTurn({
    channelType: harness.channelType,
    runtimeExecutor: harness.executor,
    runtimeSession: harness.session,
    utterance,
    timeoutMs: TURN_TIMEOUT_MS,
    promptProfile: 'realtime',
    onChunk: (chunk) => chunks.push(chunk),
    onTraceEvent: (event) => traceTypes.push(event.type),
    channelMetadata: {
      channel: harness.channelType,
      contentLength: utterance.length,
    },
  });

  return {
    responseText: chunks.join('') || result.outcome.responseText,
    actionType: result.outcome.action?.type,
    traceTypes,
  };
}

function buildBaseSnapshot(
  session: RuntimeSession,
  outcome: TurnOutcome | { responseText: string },
) {
  const activeThread = getActiveThread(session);

  return {
    responseText: normalizeTransferBanner(outcome.responseText),
    actionType: 'actionType' in outcome ? outcome.actionType : undefined,
    activeAgentName: activeThread.agentName,
    activeThreadIndex: session.activeThreadIndex,
    currentFlowStep: session.currentFlowStep,
    isComplete: session.isComplete,
    threadCount: session.threads.length,
    threadStackDepth: session.threadStack.length,
  };
}

function buildFlowSnapshot(
  harness: ChannelHarness,
  outcome: TurnOutcome | { responseText: string },
  valueKeys: string[] = ['destination', 'name'],
) {
  return {
    ...buildBaseSnapshot(harness.session, outcome),
    waitingForInput: harness.session.waitingForInput ?? [],
    values: pickValues(harness.session.data.values, valueKeys),
  };
}

function buildThreadedSnapshot(
  harness: ChannelHarness,
  outcome: TurnOutcome,
  childAgentName: string,
  options?: {
    parentKeys?: string[];
    childKeys?: string[];
    includeWaitingForInput?: boolean;
  },
) {
  const parentThread = harness.session.threads[0];
  const childThread = harness.session.threads.find((thread) => thread.agentName === childAgentName);
  const snapshot = {
    ...buildBaseSnapshot(harness.session, outcome),
    threadSummary: harness.session.threads.map((thread) => ({
      agentName: thread.agentName,
      status: thread.status,
    })),
    parentValues: pickValues(
      parentThread?.data.values ?? {},
      options?.parentKeys ?? ['intent', 'request', 'booking_ref', 'price'],
    ),
    childValues: pickValues(
      childThread?.data.values ?? {},
      options?.childKeys ?? [
        'intent',
        'request',
        'destination',
        'date',
        'confirmation_id',
        'total_price',
      ],
    ),
  };

  if (!options?.includeWaitingForInput) {
    return snapshot;
  }

  return {
    ...snapshot,
    waitingForInput: harness.session.waitingForInput ?? [],
  };
}

function buildHandoffSnapshot(
  harness: ChannelHarness,
  outcome: TurnOutcome,
  childAgentName: string,
) {
  return buildThreadedSnapshot(harness, outcome, childAgentName);
}

function pickValues(values: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

describe('cross-channel semantic parity', () => {
  test('keeps progressive gather semantics aligned across chat, KoreVG, and realtime voice', async () => {
    const harnesses = createHarnesses([GATHER_PROGRESSIVE_DSL], 'Gather_Progressive_Test');

    const initResults = await runAcrossChannels(harnesses, initializeHarness);
    const initSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, { responseText: initResults.chat }),
      korevg: buildFlowSnapshot(harnesses.korevg, { responseText: initResults.korevg }),
      realtime: buildFlowSnapshot(harnesses.realtime, { responseText: initResults.realtime }),
    };

    expectChannelParity(initSnapshots);
    expect(initSnapshots.chat.responseText).toContain('destination');
    expect(initSnapshots.chat.currentFlowStep).toBe('get_destination');
    expect(initSnapshots.chat.waitingForInput).toContain('destination');

    const destinationTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'Paris'),
    );
    const destinationSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, destinationTurns.chat),
      korevg: buildFlowSnapshot(harnesses.korevg, destinationTurns.korevg),
      realtime: buildFlowSnapshot(harnesses.realtime, destinationTurns.realtime),
    };

    expectChannelParity(destinationSnapshots);
    expect(destinationSnapshots.chat.responseText).toContain('name');
    expect(destinationSnapshots.chat.currentFlowStep).toBe('get_name');
    expect(destinationSnapshots.chat.isComplete).toBe(false);
    expect(destinationSnapshots.chat.waitingForInput).toContain('name');
    expect(destinationSnapshots.chat.values.destination).toBe('Paris');

    const nameTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'Alice'),
    );
    const nameSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, nameTurns.chat),
      korevg: buildFlowSnapshot(harnesses.korevg, nameTurns.korevg),
      realtime: buildFlowSnapshot(harnesses.realtime, nameTurns.realtime),
    };

    expectChannelParity(nameSnapshots);
    expect(nameSnapshots.chat.responseText).toContain('Booking for Alice to Paris');
    expect(nameSnapshots.chat.isComplete).toBe(true);
    expect(nameSnapshots.chat.values).toEqual({
      destination: 'Paris',
      name: 'Alice',
    });
  });

  test('keeps deterministic handoff and return semantics aligned across chat, KoreVG, and realtime voice', async () => {
    const supervisorDsl = loadOrchestrationFixture('supervisor-router.abl');
    const bookingDsl = loadOrchestrationFixture('specialist-booking.abl');
    const supportDsl = loadOrchestrationFixture('specialist-support.abl');
    const harnesses = createHarnesses([supervisorDsl, bookingDsl, supportDsl], 'Supervisor_Router');

    await runAcrossChannels(harnesses, initializeHarness);

    const handoffTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'I want to book a trip'),
    );
    const handoffSnapshots = {
      chat: buildHandoffSnapshot(harnesses.chat, handoffTurns.chat, 'Specialist_Booking'),
      korevg: buildHandoffSnapshot(harnesses.korevg, handoffTurns.korevg, 'Specialist_Booking'),
      realtime: buildHandoffSnapshot(
        harnesses.realtime,
        handoffTurns.realtime,
        'Specialist_Booking',
      ),
    };

    expectChannelParity(handoffSnapshots);
    expect(handoffSnapshots.chat.activeAgentName).toBe('Specialist_Booking');
    expect(handoffSnapshots.chat.activeThreadIndex).toBe(1);
    expect(handoffSnapshots.chat.threadCount).toBe(2);
    expect(handoffSnapshots.chat.threadStackDepth).toBe(1);
    expect(handoffSnapshots.chat.threadSummary).toEqual([
      { agentName: 'Supervisor_Router', status: 'waiting' },
      { agentName: 'Specialist_Booking', status: 'active' },
    ]);
    expect(handoffSnapshots.chat.parentValues.intent).toBe('booking');
    expect(handoffSnapshots.chat.childValues.intent).toBe('booking');

    const returnTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'paris'),
    );
    const returnSnapshots = {
      chat: buildHandoffSnapshot(harnesses.chat, returnTurns.chat, 'Specialist_Booking'),
      korevg: buildHandoffSnapshot(harnesses.korevg, returnTurns.korevg, 'Specialist_Booking'),
      realtime: buildHandoffSnapshot(
        harnesses.realtime,
        returnTurns.realtime,
        'Specialist_Booking',
      ),
    };

    expectChannelParity(returnSnapshots);
    expect(returnSnapshots.chat.responseText).toContain('Booking confirmed for Paris');
    expect(returnSnapshots.chat.activeAgentName).toBe('Supervisor_Router');
    expect(returnSnapshots.chat.activeThreadIndex).toBe(0);
    expect(returnSnapshots.chat.threadStackDepth).toBe(0);
    expect(returnSnapshots.chat.threadSummary).toEqual([
      { agentName: 'Supervisor_Router', status: 'active' },
      { agentName: 'Specialist_Booking', status: 'completed' },
    ]);
    expect(returnSnapshots.chat.childValues).toMatchObject({
      destination: 'Paris',
      date: '2025-06-15',
      confirmation_id: 'BK-12345',
      total_price: '299.99',
    });
    expect(returnSnapshots.chat.parentValues).toMatchObject({
      intent: 'booking',
      booking_ref: 'BK-12345',
      price: '299.99',
    });
  });

  test('keeps digression resume semantics aligned across chat, KoreVG, and realtime voice', async () => {
    const harnesses = createHarnesses([STEP_DIGRESSION_RESUME_DSL], 'Digression_Resume_Parity');

    const initResults = await runAcrossChannels(harnesses, initializeHarness);
    const initSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, { responseText: initResults.chat }, ['request']),
      korevg: buildFlowSnapshot(harnesses.korevg, { responseText: initResults.korevg }, [
        'request',
      ]),
      realtime: buildFlowSnapshot(harnesses.realtime, { responseText: initResults.realtime }, [
        'request',
      ]),
    };

    expectChannelParity(initSnapshots);
    expect(initSnapshots.chat.currentFlowStep).toBe('collect_request');
    expect(initSnapshots.chat.waitingForInput).toContain('request');

    const digressionTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'help'),
    );
    const digressionSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, digressionTurns.chat, ['request']),
      korevg: buildFlowSnapshot(harnesses.korevg, digressionTurns.korevg, ['request']),
      realtime: buildFlowSnapshot(harnesses.realtime, digressionTurns.realtime, ['request']),
    };

    expectChannelParity(digressionSnapshots);
    expect(digressionSnapshots.chat.responseText).toContain(
      'I can help with booking, cancellation, and status.',
    );
    expect(digressionSnapshots.chat.currentFlowStep).toBe('collect_request');
    expect(digressionSnapshots.chat.isComplete).toBe(false);
    expect(digressionSnapshots.chat.waitingForInput).toContain('request');
    expect(digressionSnapshots.chat.values.request).toBeUndefined();

    const completionTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'Book a hotel'),
    );
    const completionSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, completionTurns.chat, ['request']),
      korevg: buildFlowSnapshot(harnesses.korevg, completionTurns.korevg, ['request']),
      realtime: buildFlowSnapshot(harnesses.realtime, completionTurns.realtime, ['request']),
    };

    expectChannelParity(completionSnapshots);
    expect(completionSnapshots.chat.responseText).toContain('Captured request: Book a hotel.');
    expect(completionSnapshots.chat.isComplete).toBe(true);
    expect(completionSnapshots.chat.values.request).toBe('Book a hotel');
  });

  test('keeps auth gate handoff and resume_intent semantics aligned across chat, KoreVG, and realtime voice', async () => {
    const harnesses = createHarnesses(
      [AUTH_GATED_SUPERVISOR_DSL, AUTH_VERIFICATION_CHILD_DSL],
      'Auth_Gated_Supervisor',
    );

    await runAcrossChannels(harnesses, initializeHarness);

    const gateTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'check my balance'),
    );
    const gateSnapshots = {
      chat: buildThreadedSnapshot(harnesses.chat, gateTurns.chat, 'Auth_Verification_Agent', {
        parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
        childKeys: ['request', 'route', 'account_verified', 'account_balance'],
        includeWaitingForInput: true,
      }),
      korevg: buildThreadedSnapshot(harnesses.korevg, gateTurns.korevg, 'Auth_Verification_Agent', {
        parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
        childKeys: ['request', 'route', 'account_verified', 'account_balance'],
        includeWaitingForInput: true,
      }),
      realtime: buildThreadedSnapshot(
        harnesses.realtime,
        gateTurns.realtime,
        'Auth_Verification_Agent',
        {
          parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
          childKeys: ['request', 'route', 'account_verified', 'account_balance'],
          includeWaitingForInput: true,
        },
      ),
    };

    expectChannelParity(gateSnapshots);
    expect(gateSnapshots.chat.responseText).toContain('passcode');
    expect(gateSnapshots.chat.activeAgentName).toBe('Auth_Verification_Agent');
    expect(gateSnapshots.chat.activeThreadIndex).toBe(1);
    expect(gateSnapshots.chat.threadStackDepth).toBe(1);
    expect(gateSnapshots.chat.waitingForInput).toContain('passcode');
    expect(gateSnapshots.chat.parentValues).toMatchObject({
      request: 'check my balance',
      route: 'auth',
    });
    expect(gateSnapshots.chat.childValues).toMatchObject({
      request: 'check my balance',
      route: 'auth',
    });

    const resumeTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, '4321'),
    );
    const resumeSnapshots = {
      chat: buildThreadedSnapshot(harnesses.chat, resumeTurns.chat, 'Auth_Verification_Agent', {
        parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
        childKeys: ['request', 'route', 'account_verified', 'account_balance'],
      }),
      korevg: buildThreadedSnapshot(
        harnesses.korevg,
        resumeTurns.korevg,
        'Auth_Verification_Agent',
        {
          parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
          childKeys: ['request', 'route', 'account_verified', 'account_balance'],
        },
      ),
      realtime: buildThreadedSnapshot(
        harnesses.realtime,
        resumeTurns.realtime,
        'Auth_Verification_Agent',
        {
          parentKeys: ['request', 'route', 'account_verified', 'account_balance'],
          childKeys: ['request', 'route', 'account_verified', 'account_balance'],
        },
      ),
    };

    expectChannelParity(resumeSnapshots);
    expect(resumeSnapshots.chat.responseText).toContain('Thanks, you are verified.');
    expect(resumeSnapshots.chat.activeAgentName).toBe('Auth_Gated_Supervisor');
    expect(resumeSnapshots.chat.activeThreadIndex).toBe(0);
    expect(resumeTurns.chat.traceTypes).toContain('resume_intent');
    expect(resumeTurns.korevg.traceTypes).toContain('resume_intent');
    expect(resumeTurns.realtime.traceTypes).toContain('resume_intent');
    expect(resumeSnapshots.chat.threadSummary).toEqual([
      { agentName: 'Auth_Gated_Supervisor', status: 'active' },
      { agentName: 'Auth_Verification_Agent', status: 'completed' },
    ]);
    expect(resumeSnapshots.chat.parentValues).toMatchObject({
      request: 'check my balance',
      route: 'balance_ready',
      account_verified: true,
      account_balance: '$5,000',
    });
    expect(resumeSnapshots.chat.childValues).toMatchObject({
      request: 'check my balance',
      route: 'balance_ready',
      account_verified: true,
      account_balance: '$5,000',
    });
  });

  test('keeps completion edge cases aligned across chat, KoreVG, and realtime voice', async () => {
    const harnesses = createHarnesses(
      [CONFIRMATION_COMPLETION_DSL],
      'Confirmation_Completion_Parity',
    );

    const initResults = await runAcrossChannels(harnesses, initializeHarness);
    const initSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, { responseText: initResults.chat }, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
      korevg: buildFlowSnapshot(harnesses.korevg, { responseText: initResults.korevg }, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
      realtime: buildFlowSnapshot(harnesses.realtime, { responseText: initResults.realtime }, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
    };

    expectChannelParity(initSnapshots);
    expect(initSnapshots.chat.waitingForInput).toContain('confirmation');

    setHarnessValues(harnesses, {
      destination: 'Rome',
      checkin: 'June 1',
      checkout: 'June 5',
    });

    const completionTurns = await runAcrossChannels(harnesses, (harness) =>
      executeSemanticTurn(harness, 'confirm'),
    );
    const completionSnapshots = {
      chat: buildFlowSnapshot(harnesses.chat, completionTurns.chat, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
      korevg: buildFlowSnapshot(harnesses.korevg, completionTurns.korevg, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
      realtime: buildFlowSnapshot(harnesses.realtime, completionTurns.realtime, [
        'confirmation',
        'destination',
        'checkin',
        'checkout',
      ]),
    };

    expectChannelParity(completionSnapshots);
    expect(completionSnapshots.chat.responseText).toContain(
      'Booking locked for Rome from June 1 to June 5.',
    );
    expect(completionSnapshots.chat.isComplete).toBe(true);
    expect(completionSnapshots.chat.values).toEqual({
      confirmation: 'confirm',
      destination: 'Rome',
      checkin: 'June 1',
      checkout: 'June 5',
    });
  });
});
