// apps/runtime/src/__tests__/helpers/execution-diagnostics.ts
import type { RuntimeSession, AgentThread } from '../../services/execution/types.js';

/**
 * Format a RuntimeSession's full state for debugging failed assertions.
 * Call this in catch blocks or custom assertions to dump execution context.
 */
export function formatSessionDiagnostics(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
): string {
  const lines: string[] = [];
  const hr = '─'.repeat(60);

  lines.push('');
  lines.push(`${hr}`);
  lines.push('SESSION DIAGNOSTICS');
  lines.push(`${hr}`);

  // 1. Session identity
  lines.push(`Session ID:      ${session.id}`);
  lines.push(`Agent Name:      ${session.agentName}`);
  lines.push(`Is Complete:     ${session.isComplete}`);
  lines.push(`Is Escalated:    ${session.isEscalated}`);
  lines.push(`Initialized:     ${session.initialized}`);
  lines.push(`Conv Phase:      ${session.state?.conversationPhase ?? 'n/a'}`);

  // 2. Compilation
  if (session.compilationOutput) {
    const co = session.compilationOutput;
    lines.push('');
    lines.push('COMPILATION:');
    lines.push(`  Success:       ${co.success !== false}`);
    if (co.errors && co.errors.length > 0) {
      lines.push(
        `  Errors:        ${co.errors.map((e: any) => e.message ?? String(e)).join('; ')}`,
      );
    }
    if (co.warnings && co.warnings.length > 0) {
      lines.push(
        `  Warnings:      ${co.warnings.map((w: any) => w.message ?? String(w)).join('; ')}`,
      );
    }
  } else if (!session.agentIR) {
    lines.push('');
    lines.push('COMPILATION:     No IR compiled (agentIR is null)');
  }

  // 3. Flow state
  lines.push('');
  lines.push('FLOW STATE:');
  lines.push(`  Current Step:  ${session.currentFlowStep ?? 'none'}`);
  lines.push(`  Waiting For:   ${session.waitingForInput?.join(', ') || 'nothing'}`);
  lines.push(
    `  Pending Resp:  ${session.pendingResponse ? session.pendingResponse.substring(0, 80) + '...' : 'none'}`,
  );

  // 4. Data values
  lines.push('');
  lines.push('DATA VALUES:');
  if (session.data?.values) {
    const entries = Object.entries(session.data.values);
    if (entries.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const [k, v] of entries) {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(`  ${k}: ${val.substring(0, 100)}`);
      }
    }
  }

  // 5. Gathered keys
  if (session.data?.gatheredKeys?.size > 0) {
    lines.push(`  Gathered Keys: [${[...session.data.gatheredKeys].join(', ')}]`);
  }

  // 6. Gather progress from state
  if (session.state?.gatherProgress) {
    lines.push('');
    lines.push('GATHER PROGRESS:');
    const gp = session.state.gatherProgress;
    for (const [field, info] of Object.entries(gp)) {
      lines.push(`  ${field}: ${JSON.stringify(info)}`);
    }
  }

  // 7. Thread stack
  lines.push('');
  lines.push(
    `THREADS: (${session.threads.length} total, active index: ${session.activeThreadIndex})`,
  );
  for (let i = 0; i < session.threads.length; i++) {
    const t = session.threads[i];
    const marker = i === session.activeThreadIndex ? ' [ACTIVE]' : '';
    lines.push(
      `  [${i}]${marker} agent=${t.agentName} status=${t.status} step=${t.currentFlowStep ?? 'none'} history=${t.conversationHistory.length}msgs`,
    );
    if (t.handoffFrom) {
      lines.push(`       handoffFrom=${t.handoffFrom} return=${t.returnExpected}`);
    }
    if (t.waitingForInput?.length) {
      lines.push(`       waitingFor=[${t.waitingForInput.join(', ')}]`);
    }
  }

  // 8. Handoff/delegate stacks
  if (session.handoffStack.length > 0) {
    lines.push(`\nHANDOFF STACK: [${session.handoffStack.join(' -> ')}]`);
  }
  if (session.delegateStack.length > 0) {
    lines.push(`DELEGATE STACK: [${session.delegateStack.join(' -> ')}]`);
  }

  // 9. Conversation history (last 6 messages)
  lines.push('');
  lines.push(
    `CONVERSATION HISTORY: (${session.conversationHistory.length} messages, showing last 6)`,
  );
  const lastMsgs = session.conversationHistory.slice(-6);
  for (const msg of lastMsgs) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    lines.push(`  ${msg.role}: ${content.substring(0, 120)}`);
  }

  // 10. LLM calls (from mock client)
  if (mockClient?.calls?.length) {
    lines.push('');
    lines.push(`LLM CALLS: (${mockClient.calls.length} total)`);
    for (let i = 0; i < mockClient.calls.length; i++) {
      const call = mockClient.calls[i];
      const toolNames = (call.tools as any[])?.map((t: any) => t.name).join(', ') || 'none';
      lines.push(`  [${i}] msgs=${call.messages.length} tools=[${toolNames}]`);
    }
  }

  // 11. Trace events (last 20)
  if (traces?.length) {
    lines.push('');
    lines.push(`TRACE EVENTS: (${traces.length} total, showing last 20)`);
    const lastTraces = traces.slice(-20);
    for (const t of lastTraces) {
      const summary = Object.entries(t.data)
        .filter(([k]) => !['sessionId', 'timestamp'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
        .substring(0, 100);
      lines.push(`  ${t.type}: ${summary}`);
    }
  }

  // 12. Agent IR summary
  if (session.agentIR) {
    lines.push('');
    lines.push('AGENT IR SUMMARY:');
    const ir = session.agentIR;
    lines.push(`  Name:          ${ir.name}`);
    lines.push(`  Mode:          ${ir.executionMode ?? 'unknown'}`);
    if (ir.gather?.fields?.length) {
      const fieldNames = ir.gather.fields.map((f: any) => `${f.name}${f.required ? '*' : ''}`);
      lines.push(`  Gather Fields: [${fieldNames.join(', ')}]`);
    }
    if (ir.handoff?.length) {
      lines.push(
        `  Handoffs:      [${ir.handoff.map((h: any) => `${h.to}(when: ${h.when ?? 'always'})`).join(', ')}]`,
      );
    }
    if (ir.flow?.steps) {
      const stepNames = Object.keys(ir.flow.steps);
      lines.push(`  Flow Steps:    [${stepNames.join(' -> ')}]`);
    }
  }

  lines.push(`${hr}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Wrap an assertion block so that on failure, session diagnostics are dumped.
 *
 * Usage:
 *   await withDiagnostics(session, mockClient, traces, () => {
 *     expect(session.agentName).toBe('Child_Agent');
 *   });
 */
export function withDiagnostics(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
  fn?: () => void,
): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.error(formatSessionDiagnostics(session, mockClient, traces));
    throw e;
  }
}

/**
 * Async version of withDiagnostics for assertions after await calls.
 */
export async function withDiagnosticsAsync(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
  fn?: () => Promise<void>,
): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (e) {
    console.error(formatSessionDiagnostics(session, mockClient, traces));
    throw e;
  }
}
