// apps/runtime/src/__tests__/helpers/domain-assertions.ts
import { expect } from 'vitest';
import type { RuntimeSession } from '../../services/execution/types.js';

/**
 * Assert that a handoff from one agent to another completed successfully.
 * Produces a rich failure message with handoff stack, active agent, and data context.
 */
export function assertHandoffCompleted(
  session: RuntimeSession,
  opts: { from: string; to: string },
): void {
  const activeAgent = session.agentName;
  const threads = session.threads;
  const targetThread = threads.find((t) => t.agentName === opts.to);

  if (activeAgent !== opts.to || !targetThread) {
    const threadSummary = threads
      .map(
        (t, i) => `  [${i}] ${t.agentName} (status=${t.status}, from=${t.handoffFrom ?? 'root'})`,
      )
      .join('\n');

    const handoffIR = session.agentIR?.handoff ?? [];
    const handoffSummary = (handoffIR as any[])
      .map((h: any) => `  TO: ${h.to} WHEN: ${h.when ?? 'always'}`)
      .join('\n');

    const dataStr = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Handoff from ${opts.from} to ${opts.to} did not complete.\n` +
        `  Active agent: ${activeAgent}\n` +
        `  Active thread index: ${session.activeThreadIndex}\n` +
        `  Flow step: ${session.currentFlowStep ?? 'none'}\n` +
        `\nThreads:\n${threadSummary}\n` +
        `\nHandoff rules (from IR):\n${handoffSummary || '  (none)'}\n` +
        `\ndata.values:\n${dataStr || '  (empty)'}`,
    );
  }

  // Also verify the thread's handoffFrom matches
  if (targetThread.handoffFrom && targetThread.handoffFrom !== opts.from) {
    throw new Error(
      `Handoff target thread exists but handoffFrom mismatch.\n` +
        `  Expected handoffFrom: ${opts.from}\n` +
        `  Actual handoffFrom: ${targetThread.handoffFrom}`,
    );
  }
}

/**
 * Assert gather progress: which fields are collected and which are pending.
 */
export function assertGatherProgress(
  session: RuntimeSession,
  opts: { collected?: string[]; pending?: string[] },
): void {
  const gatheredKeys = [...(session.data?.gatheredKeys ?? [])];
  const waitingFor = session.waitingForInput ?? [];

  const errors: string[] = [];

  if (opts.collected) {
    const missing = opts.collected.filter((k) => !gatheredKeys.includes(k));
    const extra = gatheredKeys.filter((k) => !opts.collected!.includes(k));
    if (missing.length > 0) {
      errors.push(`Expected collected but missing: [${missing.join(', ')}]`);
    }
    if (extra.length > 0) {
      errors.push(`Unexpectedly collected: [${extra.join(', ')}]`);
    }
  }

  if (opts.pending) {
    const missingPending = opts.pending.filter((k) => !waitingFor.includes(k));
    const extraPending = waitingFor.filter((k) => !opts.pending!.includes(k));
    if (missingPending.length > 0) {
      errors.push(`Expected pending but not waiting: [${missingPending.join(', ')}]`);
    }
    if (extraPending.length > 0) {
      errors.push(`Unexpectedly pending: [${extraPending.join(', ')}]`);
    }
  }

  if (errors.length > 0) {
    const gatherFields =
      session.agentIR?.gather?.fields?.map((f: any) => `${f.name}${f.required ? '*' : ''}`) ?? [];
    const dataStr = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Gather progress mismatch.\n` +
        errors.map((e) => `  ${e}`).join('\n') +
        `\n\nActual state:\n` +
        `  Gathered keys: [${gatheredKeys.join(', ')}]\n` +
        `  Waiting for: [${waitingFor.join(', ')}]\n` +
        `  IR gather fields: [${gatherFields.join(', ')}]\n` +
        `\ndata.values:\n${dataStr || '  (empty)'}`,
    );
  }
}

/**
 * Assert the session's flow reached a specific step.
 */
export function assertFlowReached(session: RuntimeSession, stepName: string): void {
  const currentStep = session.currentFlowStep;
  if (currentStep === stepName) return;

  const flowSteps = session.agentIR?.flow?.steps ? Object.keys(session.agentIR.flow.steps) : [];

  throw new Error(
    `Flow did not reach '${stepName}'.\n` +
      `  Current step: ${currentStep ?? 'none'}\n` +
      `  Available steps: [${flowSteps.join(', ')}]\n` +
      `  Agent: ${session.agentName}\n` +
      `  Phase: ${session.state?.conversationPhase ?? 'unknown'}`,
  );
}

/**
 * Assert an agent completed execution.
 */
export function assertAgentComplete(session: RuntimeSession, agentName?: string): void {
  if (agentName && session.agentName !== agentName) {
    throw new Error(
      `Expected active agent '${agentName}' but got '${session.agentName}'.\n` +
        `  Threads: [${session.threads.map((t) => t.agentName).join(', ')}]`,
    );
  }

  if (!session.isComplete) {
    const pendingFields = session.waitingForInput ?? [];
    const gatherFields =
      session.agentIR?.gather?.fields?.map((f: any) => `${f.name}${f.required ? '*' : ''}`) ?? [];

    throw new Error(
      `Agent ${agentName ?? session.agentName} not complete.\n` +
        `  isComplete: ${session.isComplete}\n` +
        `  conversationPhase: ${session.state?.conversationPhase ?? 'unknown'}\n` +
        `  currentFlowStep: ${session.currentFlowStep ?? 'none'}\n` +
        `  Pending fields: [${pendingFields.join(', ')}]\n` +
        `  IR gather fields: [${gatherFields.join(', ')}]\n` +
        `  History: ${session.conversationHistory.length} messages`,
    );
  }
}

/**
 * Assert a specific data value was collected.
 */
export function assertDataValue(session: RuntimeSession, key: string, expected: unknown): void {
  const actual = session.data?.values?.[key];
  try {
    expect(actual).toEqual(expected);
  } catch {
    const allValues = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Data value mismatch for '${key}'.\n` +
        `  Expected: ${JSON.stringify(expected)}\n` +
        `  Actual:   ${JSON.stringify(actual)}\n` +
        `\nAll data.values:\n${allValues || '  (empty)'}`,
    );
  }
}
