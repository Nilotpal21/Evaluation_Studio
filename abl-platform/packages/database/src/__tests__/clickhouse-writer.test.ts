/**
 * BufferedClickHouseWriter Tests
 *
 * Tests batching, flushing, error handling, and lifecycle
 * using a mock ClickHouse client.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { BufferedClickHouseWriter } from '../clickhouse';

// =============================================================================
// MOCK CLICKHOUSE CLIENT
// =============================================================================

function createMockClient() {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    command: vi.fn(),
    close: vi.fn(),
  };
}

interface TestRow {
  id: string;
  value: number;
}

function makeRow(id: string, value = 1): TestRow {
  return { id, value };
}

describe('BufferedClickHouseWriter', () => {
  let client: ReturnType<typeof createMockClient>;
  let writer: BufferedClickHouseWriter<TestRow>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
  });

  afterEach(async () => {
    if (writer) {
      // Prevent real flush in close since we're using fake timers
      client.insert.mockResolvedValue(undefined);
      await writer.close();
    }
    vi.useRealTimers();
  });

  function createWriter(opts?: { batchSize?: number; flushIntervalMs?: number }) {
    writer = new BufferedClickHouseWriter(client as any, {
      table: 'test_table',
      batchSize: opts?.batchSize ?? 5,
      flushIntervalMs: opts?.flushIntervalMs ?? 10000,
    });
    return writer;
  }

  // ===========================================================================
  // BASIC INSERT & PENDING COUNT
  // ===========================================================================

  describe('insert', () => {
    test('should buffer rows without flushing', () => {
      createWriter();
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      expect(writer.pending).toBe(2);
      expect(client.insert).not.toHaveBeenCalled();
    });

    test('should auto-flush when batch size reached', async () => {
      createWriter({ batchSize: 3 });

      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));
      writer.insert(makeRow('3')); // triggers flush

      // Let the async flush complete
      await vi.advanceTimersByTimeAsync(0);

      expect(client.insert).toHaveBeenCalledTimes(1);
      expect(client.insert).toHaveBeenCalledWith({
        table: 'test_table',
        values: [makeRow('1'), makeRow('2'), makeRow('3')],
        format: 'JSONEachRow',
      });
      expect(writer.pending).toBe(0);
    });
  });

  describe('insertMany', () => {
    test('should add multiple rows at once', () => {
      createWriter();
      writer.insertMany([makeRow('1'), makeRow('2'), makeRow('3')]);
      expect(writer.pending).toBe(3);
    });

    test('should auto-flush when batch size reached via insertMany', async () => {
      createWriter({ batchSize: 3 });
      writer.insertMany([makeRow('1'), makeRow('2'), makeRow('3')]);

      await vi.advanceTimersByTimeAsync(0);

      expect(client.insert).toHaveBeenCalledTimes(1);
      expect(writer.pending).toBe(0);
    });
  });

  // ===========================================================================
  // TIMER-BASED FLUSH
  // ===========================================================================

  describe('timer flush', () => {
    test('should flush on interval even below batch size', async () => {
      createWriter({ batchSize: 100, flushIntervalMs: 5000 });

      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      expect(client.insert).not.toHaveBeenCalled();

      // Advance past flush interval
      await vi.advanceTimersByTimeAsync(5000);

      expect(client.insert).toHaveBeenCalledTimes(1);
      expect(client.insert).toHaveBeenCalledWith({
        table: 'test_table',
        values: [makeRow('1'), makeRow('2')],
        format: 'JSONEachRow',
      });
      expect(writer.pending).toBe(0);
    });

    test('should not flush when buffer is empty', async () => {
      createWriter({ flushIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1000);

      expect(client.insert).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // MANUAL FLUSH
  // ===========================================================================

  describe('flush', () => {
    test('should flush buffered rows', async () => {
      createWriter();
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      await writer.flush();

      expect(client.insert).toHaveBeenCalledTimes(1);
      expect(writer.pending).toBe(0);
    });

    test('should be a no-op when buffer is empty', async () => {
      createWriter();
      await writer.flush();
      expect(client.insert).not.toHaveBeenCalled();
    });

    test('should re-add batch to buffer on failure', async () => {
      createWriter();
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      client.insert.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(writer.flush()).rejects.toThrow('Connection failed');
      expect(writer.pending).toBe(2); // rows re-added
    });

    test('should suppress console noise when configured', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      writer = new BufferedClickHouseWriter(client as any, {
        table: 'test_table',
        batchSize: 5,
        flushIntervalMs: 10000,
        suppressErrorLogs: true,
      });
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      client.insert.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(writer.flush()).rejects.toThrow('Connection failed');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    test('should only flush up to batchSize at a time', async () => {
      createWriter({ batchSize: 2 });

      // Add 5 rows manually (bypassing auto-flush by inserting one at a time below threshold)
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2')); // triggers auto-flush for first 2

      await vi.advanceTimersByTimeAsync(0); // let auto-flush complete

      writer.insert(makeRow('3'));
      writer.insert(makeRow('4')); // triggers auto-flush for next 2

      await vi.advanceTimersByTimeAsync(0);

      writer.insert(makeRow('5'));

      // Should have flushed twice so far (2 rows each)
      expect(client.insert).toHaveBeenCalledTimes(2);
      expect(writer.pending).toBe(1); // 1 remaining
    });
  });

  // ===========================================================================
  // CLOSE
  // ===========================================================================

  describe('close', () => {
    test('should flush remaining rows and stop timer', async () => {
      createWriter();
      writer.insert(makeRow('1'));
      writer.insert(makeRow('2'));

      await writer.close();

      expect(client.insert).toHaveBeenCalledTimes(1);
      expect(writer.pending).toBe(0);
    });

    test('should handle close with empty buffer', async () => {
      createWriter();
      await writer.close();
      expect(client.insert).not.toHaveBeenCalled();
    });
  });
});
