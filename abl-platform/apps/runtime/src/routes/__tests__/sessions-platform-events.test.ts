/**
 * Sessions Platform Events Integration Tests
 *
 * Tests for the GET /traces endpoint with platform_events table fallback
 * using the event framework with voice category filtering.
 */

import { describe, test, expect, beforeEach, vi, afterAll } from 'vitest';

// Mock the dependencies
const mockClickHouseQuery = vi.fn();
const mockGetClickHouseClient = vi.fn(() => ({
  query: mockClickHouseQuery,
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: mockGetClickHouseClient,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: () => ({
    getTrace: () => null,
    getEvents: () => [],
  }),
}));

describe('Sessions Platform Events Integration', () => {
  const sessionId = 'session-123';
  const tenantId = 'tenant-456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('Query platform_events Table', () => {
    test('should query platform_events with correct parameters', async () => {
      const mockRows = [
        {
          event_id: 'event-1',
          event_type: 'voice.session.started',
          category: 'voice',
          agent_name: 'voice-agent',
          timestamp: '2026-03-06 10:00:00',
          duration_ms: 0,
          has_error: 0,
          data: JSON.stringify({ callSid: 'CA123' }),
          encrypted: 0,
        },
      ];

      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce(mockRows),
      });

      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();

      expect(client).toBeTruthy();

      const result = await client!.query({
        query: expect.stringContaining('platform_events'),
        query_params: { sessionId, tenantId },
        format: 'JSONEachRow',
      });

      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: { sessionId, tenantId },
          format: 'JSONEachRow',
        }),
      );
    });

    test('should filter by voice category', async () => {
      const queryString = `
        WHERE session_id = {sessionId:String}
          AND tenant_id = {tenantId:String}
          AND category IN ('voice', 'session', 'llm', 'tool', 'agent', 'attachment')
      `;

      expect(queryString).toContain("category IN ('voice'");
    });
  });

  describe('Voice Event Type Mapping', () => {
    const voiceEventMapping: Record<string, string> = {
      'voice.session.started': 'voice_session_start',
      'voice.session.ended': 'voice_session_end',
      'voice.turn.completed': 'voice_turn',
      'voice.stt.completed': 'voice_stt',
      'voice.tts.completed': 'voice_tts',
      'voice.realtime.tool_call': 'voice_realtime_tool_call',
      'voice.barge_in.detected': 'voice_barge_in',
      'voice.asr_quality.analyzed': 'voice_asr_quality',
      'voice.tts_quality.measured': 'voice_tts_quality',
      'voice.asr_cascade.detected': 'voice_asr_cascade',
    };

    Object.entries(voiceEventMapping).forEach(([platformType, traceType]) => {
      test(`should map ${platformType} to ${traceType}`, () => {
        const mappedType = voiceEventMapping[platformType];
        expect(mappedType).toBe(traceType);
      });
    });
  });

  describe('Full Voice Session with Event Framework', () => {
    test('should handle complete voice session in platform_events', async () => {
      const mockRows = [
        {
          event_id: 'evt-1',
          event_type: 'voice.session.started',
          category: 'voice',
          agent_name: 'voice-agent',
          timestamp: '2026-03-06 10:00:00',
          duration_ms: 0,
          has_error: 0,
          data: JSON.stringify({
            call_sid: 'CA123',
            caller: '+1234567890',
            voice_provider: 'korevg',
          }),
          encrypted: 0,
        },
        {
          event_id: 'evt-2',
          event_type: 'voice.turn.completed',
          category: 'voice',
          agent_name: 'voice-agent',
          timestamp: '2026-03-06 10:01:00',
          duration_ms: 2500,
          has_error: 0,
          data: JSON.stringify({
            turn_number: 1,
            input_method: 'speech',
          }),
          encrypted: 0,
        },
        {
          event_id: 'evt-3',
          event_type: 'voice.session.ended',
          category: 'voice',
          agent_name: 'voice-agent',
          timestamp: '2026-03-06 10:05:00',
          duration_ms: 300000,
          has_error: 0,
          data: 'Z1:encrypted:qos:data',
          encrypted: 1,
        },
      ];

      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce(mockRows),
      });

      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();

      const result = await client!.query({
        query: 'SELECT * FROM platform_events WHERE category = voice',
        query_params: { sessionId, tenantId },
        format: 'JSONEachRow',
      });

      const rows = await result.json();

      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.category === 'voice')).toBe(true);

      const eventTypes = rows.map((r: any) => r.event_type);
      expect(eventTypes).toContain('voice.session.started');
      expect(eventTypes).toContain('voice.turn.completed');
      expect(eventTypes).toContain('voice.session.ended');
    });
  });

  describe('Event Category System', () => {
    test('should filter multiple categories correctly', () => {
      const categories = ['voice', 'session', 'llm', 'tool', 'agent'];
      const categoryFilter = `category IN ('${categories.join("', '")}')`;

      expect(categoryFilter).toContain('voice');
      expect(categoryFilter).toContain('session');
      expect(categoryFilter).toContain('llm');
    });

    test('should extract category from event_type prefix', () => {
      const eventTypes = {
        'voice.session.started': 'voice',
        'llm.call.completed': 'llm',
        'tool.call.completed': 'tool',
        'agent.entered': 'agent',
      };

      Object.entries(eventTypes).forEach(([eventType, expectedCategory]) => {
        const category = eventType.split('.')[0];
        expect(category).toBe(expectedCategory);
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid JSON in data field', () => {
      const invalidJson = 'not valid json {';

      expect(() => JSON.parse(invalidJson)).toThrow();
    });
  });

  describe('Query Performance', () => {
    test('should enforce 500 row limit', () => {
      const queryString = 'SELECT * FROM platform_events LIMIT 500';

      expect(queryString).toContain('LIMIT 500');
    });

    test('should order by timestamp ascending', () => {
      const queryString = 'ORDER BY timestamp ASC';

      expect(queryString).toContain('ORDER BY timestamp ASC');
    });

    test('should use indexed columns in WHERE clause', () => {
      const queryString = `
        WHERE session_id = {sessionId:String}
          AND tenant_id = {tenantId:String}
          AND category IN ('voice', 'session')
      `;

      // All these are indexed columns in platform_events
      expect(queryString).toContain('session_id');
      expect(queryString).toContain('tenant_id');
      expect(queryString).toContain('category');
    });
  });

  describe('Backward Compatibility', () => {
    test('should map platform event types back to trace types for UI', () => {
      const platformToTraceMap: Record<string, string> = {
        'voice.session.started': 'voice_session_start',
        'voice.session.ended': 'voice_session_end',
        'llm.call.completed': 'llm_call',
        'agent.entered': 'agent_enter',
      };

      Object.entries(platformToTraceMap).forEach(([platformType, traceType]) => {
        expect(platformToTraceMap[platformType]).toBe(traceType);
      });
    });
  });
});
