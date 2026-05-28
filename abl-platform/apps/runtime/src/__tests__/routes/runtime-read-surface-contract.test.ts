import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime read-surface route contract', () => {
  it('routes inline REST chat trace events through the read-surface renderer', () => {
    const source = readFileSync(resolve(__dirname, '../../routes/chat.ts'), 'utf-8');

    expect(source).toContain('renderInlineTraceEventsForResponse');
    expect(source).toContain('toPublicInlineTraceEvent');
    expect(source).not.toContain('traceEvents: traceEvents.length > 0 ? traceEvents : undefined');
  });

  it('forwards canonical runtime trace events to inline REST chat callbacks', () => {
    const source = readFileSync(resolve(__dirname, '../../services/runtime-executor.ts'), 'utf-8');

    expect(source).toContain('originalOnTraceEvent(traceEvent)');
    expect(source).not.toContain('originalOnTraceEvent(event)');
  });

  it('routes internal chat and transcript exports through the shared read-surface renderer', () => {
    const internalChatSource = readFileSync(
      resolve(__dirname, '../../routes/internal-chat.ts'),
      'utf-8',
    );
    const transcriptsSource = readFileSync(
      resolve(__dirname, '../../routes/transcripts.ts'),
      'utf-8',
    );

    expect(internalChatSource).toContain('renderRuntimeTraceEventsForReadSurface');
    expect(transcriptsSource).toContain('renderRuntimeMessagesForReadSurface');
    expect(transcriptsSource).toContain('renderRuntimeTraceEventsForReadSurface');
  });

  it('uses durable trace counts when listing historical sessions', () => {
    const source = readFileSync(resolve(__dirname, '../../routes/sessions.ts'), 'utf-8');

    expect(source).toContain('countClickHousePlatformEventsBySession');
    expect(source).toContain('durableTraceCounts.get(s.id)');
    expect(source).toContain('Math.max(');
  });

  it('merges live and durable traces for session detail reads', () => {
    const source = readFileSync(resolve(__dirname, '../../routes/sessions.ts'), 'utf-8');

    expect(source).toContain('const liveTraceEvents = await loadBufferedTraceEventsForCandidates');
    expect(source).toContain(
      'mergeTraceEventSources(liveTraceEvents as TraceStoreEvent[], chEvents)',
    );
    expect(source).not.toContain('if (traceEvents.length === 0) {');
  });
});
