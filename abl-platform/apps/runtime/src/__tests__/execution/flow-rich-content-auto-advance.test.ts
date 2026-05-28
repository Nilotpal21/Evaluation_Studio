import { beforeEach, describe, expect, test } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { SessionService } from '../../services/session/session-service.js';

const AUTO_ADVANCE_RICH_CONTENT_DSL = `
AGENT: Rich_Content_Auto_Advance
GOAL: "Preserve rich content across auto-advance"
PERSONA: "Test"

FLOW:
  welcome:
    REASONING: false
    RESPOND: "Account summary"
      FORMATS:
        MARKDOWN: |
          | Account | Balance |
          | --- | --- |
          | Savings | $120 |
          | Checking | $80 |
    THEN: collect_name
  collect_name:
    REASONING: false
    GATHER:
      - name: required
    THEN: done
  done:
    REASONING: false
    RESPOND: "Thanks {{name}}"
    THEN: COMPLETE
`;

describe('flow rich content auto-advance', () => {
  let executor: RuntimeExecutor;
  let sessionService: SessionService;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    sessionService = new SessionService(new MemorySessionStore());
    executor.setSessionService(sessionService);
  });

  test('keeps rich content from an auto-advanced step when the chain stops on a gather prompt', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AUTO_ADVANCE_RICH_CONTENT_DSL], 'Rich_Content_Auto_Advance'),
    );

    const chunks: string[] = [];
    const result = await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

    expect(chunks.join('')).toContain('Account summary');
    expect(chunks.join('')).toContain('name');
    expect(result?.action?.type).toBe('collect');
    expect(result?.richContent?.markdown).toContain('| Account | Balance |');
    expect(result?.richContent?.markdown).toContain('| Savings | $120 |');
    expect(session.pendingRichContent?.markdown).toContain('| Checking | $80 |');
  });

  test('rehydrates pending rich content after the prompt is persisted', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AUTO_ADVANCE_RICH_CONTENT_DSL], 'Rich_Content_Auto_Advance'),
    );

    await executor.initializeSession(session.id);
    await executor.saveSessionSnapshot(session);

    const rehydratedExecutor = new RuntimeExecutor();
    rehydratedExecutor.setSessionService(sessionService);

    const rehydrated = await rehydratedExecutor.rehydrateSession(session.id);

    expect(rehydrated).not.toBeNull();
    expect(rehydrated?.waitingForInput).toEqual(['name']);
    expect(rehydrated?.pendingRichContent?.markdown).toContain('| Account | Balance |');
    expect(rehydrated?.pendingRichContent?.markdown).toContain('| Savings | $120 |');
  });
});
