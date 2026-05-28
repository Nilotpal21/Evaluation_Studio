/**
 * Unit tests for AuditLogEmitter
 * UT-1: Constructor and defaults
 * UT-2: emit() adds to buffer
 * UT-3: Timer-based flush
 * UT-4: Buffer cap (max 100)
 *
 * Uses DI — injects a model spy, no vi.mock of platform components.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditLogEmitter } from '../audit/audit-log-emitter.js';
import type { ArchAuditLogWriter } from '../audit/audit-log-emitter.js';
import type { AuditLogEntry } from '../audit/types.js';

// ─── Model Spy ──────────────────────────────────────────────────────────

function createModelSpy() {
  const insertMany = vi.fn().mockResolvedValue([]);
  return { insertMany } as unknown as ArchAuditLogWriter;
}

function createWriterSpy() {
  const insertMany = vi.fn().mockResolvedValue([]);
  const emitPayload = vi.fn();
  return { insertMany, emitPayload } as unknown as ArchAuditLogWriter;
}

function makeEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    category: 'llm_call',
    severity: 'info',
    summary: 'test entry',
    detail: { model: 'claude-sonnet-4' },
    ...overrides,
  };
}

const CTX = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

describe('AuditLogEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure enabled
    delete process.env.ARCH_AUDIT_LOG_ENABLED;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ARCH_AUDIT_LOG_ENABLED;
  });

  // UT-1: Constructor and defaults
  test('creates with empty buffer and no active timer', () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model);
    expect(emitter.bufferSize).toBe(0);
    emitter.destroy();
  });

  // UT-2: emit() adds to buffer with context fields
  test('emit() adds entry to buffer with context fields', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 100 });

    emitter.emit(makeEntry());

    expect(emitter.bufferSize).toBe(1);

    // Flush to verify stored fields
    await emitter.flush();

    expect(model.insertMany).toHaveBeenCalledOnce();
    const batch = (model.insertMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      category: 'llm_call',
      severity: 'info',
      summary: 'test entry',
    });
    expect(batch[0].timestamp).toBeInstanceOf(Date);

    emitter.destroy();
  });

  // UT-2b: flush on threshold
  test('auto-flushes when buffer reaches threshold', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 3 });

    emitter.emit(makeEntry());
    emitter.emit(makeEntry());
    expect(model.insertMany).not.toHaveBeenCalled();

    emitter.emit(makeEntry()); // hits threshold of 3

    // doFlush is async — let microtasks complete
    await vi.advanceTimersByTimeAsync(0);

    expect(model.insertMany).toHaveBeenCalledOnce();
    const batch = (model.insertMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(batch).toHaveLength(3);
    expect(emitter.bufferSize).toBe(0);

    emitter.destroy();
  });

  // UT-2c: manual flush() drains remaining buffer
  test('flush() drains remaining buffer', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 100 });

    emitter.emit(makeEntry());
    emitter.emit(makeEntry());
    expect(emitter.bufferSize).toBe(2);

    await emitter.flush();

    expect(emitter.bufferSize).toBe(0);
    expect(model.insertMany).toHaveBeenCalledOnce();
    const batch = (model.insertMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(batch).toHaveLength(2);

    emitter.destroy();
  });

  // UT-2d: double flush is safe
  test('double flush() is idempotent', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 100 });

    emitter.emit(makeEntry());
    await emitter.flush();
    await emitter.flush(); // second flush — empty buffer

    expect(model.insertMany).toHaveBeenCalledOnce();
    emitter.destroy();
  });

  // UT-3: Timer-based flush
  test('schedules timer flush after emit (below threshold)', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, {
      bufferThreshold: 100,
      flushIntervalMs: 500,
    });

    emitter.emit(makeEntry());
    emitter.emit(makeEntry());

    expect(model.insertMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(model.insertMany).toHaveBeenCalledOnce();
    const batch = (model.insertMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(batch).toHaveLength(2);

    emitter.destroy();
  });

  // UT-4: Buffer cap (max 100)
  test('hard cap at 100 entries triggers immediate flush', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 200 }); // threshold higher than cap

    for (let i = 0; i < 100; i++) {
      emitter.emit(makeEntry({ summary: `entry-${i}` }));
    }

    // Buffer hit MAX_BUFFER_SIZE=100, should auto-flush
    await vi.advanceTimersByTimeAsync(0);

    expect(model.insertMany).toHaveBeenCalled();
    expect(emitter.bufferSize).toBe(0);

    emitter.destroy();
  });

  // UT-5: Fire-and-forget — swallows write errors
  test('swallows insertMany errors without propagating', async () => {
    const model = createModelSpy();
    (model.insertMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('MongoDB connection refused'),
    );

    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 2 });

    emitter.emit(makeEntry());
    emitter.emit(makeEntry()); // triggers flush

    // Should not throw
    await vi.advanceTimersByTimeAsync(0);

    // Buffer cleared even on failure (no re-queue)
    expect(emitter.bufferSize).toBe(0);

    emitter.destroy();
  });

  // ARCH_AUDIT_LOG_ENABLED=false → no-op
  test('emit and flush are no-ops when disabled', async () => {
    process.env.ARCH_AUDIT_LOG_ENABLED = 'false';

    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model);

    emitter.emit(makeEntry());
    emitter.emit(makeEntry());
    expect(emitter.bufferSize).toBe(0);

    await emitter.flush();
    expect(model.insertMany).not.toHaveBeenCalled();

    emitter.destroy();
  });

  // ordered: false passed to insertMany
  test('passes ordered: false to insertMany', async () => {
    const model = createModelSpy();
    const emitter = new AuditLogEmitter(CTX, model, { bufferThreshold: 100 });

    emitter.emit(makeEntry());
    await emitter.flush();

    expect(model.insertMany).toHaveBeenCalledWith(expect.any(Array), { ordered: false });

    emitter.destroy();
  });

  test('redacts payload content before delegating to the writer', async () => {
    const writer = createWriterSpy();
    const emitter = new AuditLogEmitter(CTX, writer);

    emitter.emitPayload({
      eventId: 'evt-1',
      payloadType: 'prompt',
      content: 'email me at user@example.com with api_key=sk-testsecret123456',
    });
    expect(emitter.payloadBufferSize).toBe(1);

    await emitter.flush();

    expect(writer.emitPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'email me at [REDACTED] with api_key=[REDACTED]',
      }),
    );

    emitter.destroy();
  });

  test('redacts non-allowlisted tool input payloads', async () => {
    const writer = createWriterSpy();
    const emitter = new AuditLogEmitter(CTX, writer);

    emitter.emitPayload({
      eventId: 'evt-2',
      payloadType: 'tool_input',
      toolName: 'collect_secret',
      content: JSON.stringify({ token: 'secret-token', label: 'OpenAI key' }),
    });

    await emitter.flush();

    expect(writer.emitPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        content: JSON.stringify({
          _redacted: true,
          reason: 'tool_input_not_allowlisted',
          toolName: 'collect_secret',
          inputKeys: ['token', 'label'],
        }),
      }),
    );

    emitter.destroy();
  });
});
