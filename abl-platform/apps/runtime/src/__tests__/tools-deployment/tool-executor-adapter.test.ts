/**
 * Tool Executor Adapter Tests
 *
 * Verifies MockToolExecutor behavior:
 * - Tool execution with default mock responses
 * - Custom tool response registration and priority
 * - Parallel tool execution
 * - Error handling for unknown tools
 * - onToolCall callback invocation
 * - Tool listing (available tools)
 * - getDefaultMockResponses utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockToolExecutor, getDefaultMockResponses } from '../fixtures/mock-tool-executor.js';

describe('MockToolExecutor', () => {
  let executor: MockToolExecutor;

  beforeEach(() => {
    vi.restoreAllMocks();
    executor = new MockToolExecutor();
  });

  // ===========================================================================
  // SINGLE TOOL EXECUTION — DEFAULT MOCKS
  // ===========================================================================

  describe('execute — default mock responses', () => {
    it('should return greeting from greet_user tool', async () => {
      const result = await executor.execute('greet_user', { name: 'Alice' }, 5000);
      expect(result).toHaveProperty('greeting', 'Hello, Alice! Nice to meet you!');
      expect(result).toHaveProperty('timestamp');
    });

    it('should return default greeting when name is not provided', async () => {
      const result = (await executor.execute('greet_user', {}, 5000)) as any;
      expect(result.greeting).toBe('Hello, there! Nice to meet you!');
    });

    it('should return hotel search results', async () => {
      const result = (await executor.execute(
        'search_hotels',
        {
          destination: 'Paris',
          checkin: '2026-03-01',
          checkout: '2026-03-05',
        },
        5000,
      )) as any;

      expect(result.hotels).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.destination).toBe('Paris');
      expect(result.checkin).toBe('2026-03-01');
    });

    it('should return flight search results with correct parameters', async () => {
      const result = (await executor.execute(
        'search_flights',
        {
          origin: 'NYC',
          destination: 'LAX',
        },
        5000,
      )) as any;

      expect(result.flights).toHaveLength(3);
      expect(result.origin).toBe('NYC');
      expect(result.destination).toBe('LAX');
    });

    it('should return hotel booking confirmation', async () => {
      const result = (await executor.execute(
        'book_hotel',
        {
          hotel: 'Grand Hotel',
          checkin: '2026-03-01',
          checkout: '2026-03-05',
        },
        5000,
      )) as any;

      expect(result.status).toBe('confirmed');
      expect(result.confirmation).toMatch(/^HTL-/);
      expect(result.hotel).toBe('Grand Hotel');
    });

    it('should return weather data for get_weather tool', async () => {
      const result = (await executor.execute('get_weather', { location: 'Tokyo' }, 5000)) as any;

      expect(result.location).toBe('Tokyo');
      expect(result.temperature).toBe(72);
      expect(result.condition).toBe('Sunny');
    });

    it('should return warning for unknown tools', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = (await executor.execute('nonexistent_tool', {}, 5000)) as any;

      expect(result._warning).toContain('No mock implementation for tool: nonexistent_tool');
      expect(warnSpy).toHaveBeenCalledWith('[MockToolExecutor] No mock for tool: nonexistent_tool');
    });
  });

  // ===========================================================================
  // CUSTOM TOOL RESPONSES
  // ===========================================================================

  describe('execute — custom responses', () => {
    it('should use custom response over default mock', async () => {
      const customExecutor = new MockToolExecutor({
        greet_user: (params) => ({ greeting: `Custom hello, ${params.name}!` }),
      });

      const result = (await customExecutor.execute('greet_user', { name: 'Bob' }, 5000)) as any;
      expect(result.greeting).toBe('Custom hello, Bob!');
    });

    it('should support registering custom tool via registerMock', async () => {
      executor.registerMock('my_custom_tool', (params) => ({
        custom: true,
        input: params.data,
      }));

      const result = (await executor.execute('my_custom_tool', { data: 'test' }, 5000)) as any;
      expect(result.custom).toBe(true);
      expect(result.input).toBe('test');
    });

    it('should override existing mock with registerMock', async () => {
      executor.registerMock('get_weather', () => ({
        location: 'Override',
        temperature: 100,
      }));

      const result = (await executor.execute('get_weather', { location: 'NYC' }, 5000)) as any;
      expect(result.temperature).toBe(100);
      expect(result.location).toBe('Override');
    });

    it('should prioritize custom responses passed in constructor over default mocks', async () => {
      const customExecutor = new MockToolExecutor({
        search_hotels: () => ({ hotels: [], total: 0 }),
      });

      const result = (await customExecutor.execute('search_hotels', {}, 5000)) as any;
      expect(result.hotels).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ===========================================================================
  // CALLBACK (onToolCall)
  // ===========================================================================

  describe('onToolCall callback', () => {
    it('should invoke callback for default mock tools', async () => {
      const onToolCall = vi.fn();
      const callbackExecutor = new MockToolExecutor({}, onToolCall);

      await callbackExecutor.execute('get_weather', { location: 'Berlin' }, 5000);

      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolCall).toHaveBeenCalledWith(
        'get_weather',
        { location: 'Berlin' },
        expect.objectContaining({ location: 'Berlin', temperature: 72 }),
      );
    });

    it('should invoke callback for custom tools', async () => {
      const onToolCall = vi.fn();
      const callbackExecutor = new MockToolExecutor(
        { custom_tool: () => ({ ok: true }) },
        onToolCall,
      );

      await callbackExecutor.execute('custom_tool', { x: 1 }, 5000);

      expect(onToolCall).toHaveBeenCalledWith('custom_tool', { x: 1 }, { ok: true });
    });

    it('should invoke callback for unknown tools', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onToolCall = vi.fn();
      const callbackExecutor = new MockToolExecutor({}, onToolCall);

      await callbackExecutor.execute('missing_tool', { a: 'b' }, 5000);

      expect(onToolCall).toHaveBeenCalledWith(
        'missing_tool',
        { a: 'b' },
        expect.objectContaining({ _warning: expect.stringContaining('missing_tool') }),
      );
    });

    it('should not throw when onToolCall is not provided', async () => {
      const noCallbackExecutor = new MockToolExecutor();
      await expect(noCallbackExecutor.execute('greet_user', {}, 5000)).resolves.toBeDefined();
    });
  });

  // ===========================================================================
  // PARALLEL EXECUTION
  // ===========================================================================

  describe('executeParallel', () => {
    it('should execute multiple tools in parallel and return all results', async () => {
      const results = await executor.executeParallel(
        [
          { name: 'get_weather', params: { location: 'NYC' } },
          { name: 'greet_user', params: { name: 'Alice' } },
          { name: 'get_deals', params: {} },
        ],
        5000,
      );

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('get_weather');
      expect(results[0].result).toHaveProperty('temperature', 72);
      expect(results[0].error).toBeUndefined();

      expect(results[1].name).toBe('greet_user');
      expect(results[1].result).toHaveProperty('greeting');

      expect(results[2].name).toBe('get_deals');
      expect((results[2].result as any).deals).toHaveLength(3);
    });

    it('should handle errors in parallel execution gracefully', async () => {
      const errorExecutor = new MockToolExecutor({
        failing_tool: () => {
          throw new Error('Tool exploded');
        },
      });

      const results = await errorExecutor.executeParallel(
        [
          { name: 'greet_user', params: { name: 'Test' } },
          { name: 'failing_tool', params: {} },
        ],
        5000,
      );

      expect(results).toHaveLength(2);
      expect(results[0].result).toHaveProperty('greeting');
      expect(results[0].error).toBeUndefined();

      expect(results[1].error).toBe('Tool exploded');
      expect(results[1].result).toBeUndefined();
    });

    it('should handle non-Error throws in parallel execution', async () => {
      const errorExecutor = new MockToolExecutor({
        string_throw: () => {
          throw 'some string error';
        },
      });

      const results = await errorExecutor.executeParallel(
        [{ name: 'string_throw', params: {} }],
        5000,
      );

      expect(results).toHaveLength(1);
      expect(results[0].error).toBe('Unknown error');
    });

    it('should return empty array for empty calls list', async () => {
      const results = await executor.executeParallel([], 5000);
      expect(results).toEqual([]);
    });
  });

  // ===========================================================================
  // AVAILABLE TOOLS LISTING
  // ===========================================================================

  describe('getAvailableTools', () => {
    it('should list all default mock tools', () => {
      const tools = executor.getAvailableTools();
      expect(tools).toContain('greet_user');
      expect(tools).toContain('search_hotels');
      expect(tools).toContain('get_weather');
      expect(tools).toContain('book_hotel');
      expect(tools).toContain('get_noc_dashboard');
    });

    it('should include custom tools in the listing', () => {
      executor.registerMock('my_special_tool', () => ({ done: true }));
      const tools = executor.getAvailableTools();
      expect(tools).toContain('my_special_tool');
    });

    it('should include both constructor custom and registerMock tools', () => {
      const customExecutor = new MockToolExecutor({
        ctor_tool: () => ({}),
      });
      customExecutor.registerMock('registered_tool', () => ({}));

      const tools = customExecutor.getAvailableTools();
      expect(tools).toContain('ctor_tool');
      expect(tools).toContain('registered_tool');
    });
  });

  // ===========================================================================
  // getDefaultMockResponses
  // ===========================================================================

  describe('getDefaultMockResponses', () => {
    it('should return a copy of the default mock responses', () => {
      const mocks = getDefaultMockResponses();
      expect(typeof mocks.greet_user).toBe('function');
      expect(typeof mocks.search_hotels).toBe('function');
      expect(typeof mocks.get_weather).toBe('function');
    });

    it('should return independent copies (modifying one does not affect another)', () => {
      const mocks1 = getDefaultMockResponses();
      const mocks2 = getDefaultMockResponses();

      // Delete a key from mocks1
      delete mocks1.greet_user;

      // mocks2 should still have it
      expect(mocks2.greet_user).toBeDefined();
    });

    it('should produce callable mock functions', () => {
      const mocks = getDefaultMockResponses();
      const result = mocks.greet_user({ name: 'Test' }) as any;
      expect(result.greeting).toBe('Hello, Test! Nice to meet you!');
    });
  });

  // ===========================================================================
  // DOMAIN-SPECIFIC MOCK TOOLS
  // ===========================================================================

  describe('domain-specific mock tools', () => {
    it('should handle healthcare check_symptoms tool', async () => {
      const result = (await executor.execute(
        'check_symptoms',
        {
          symptoms: ['headache', 'fever'],
        },
        5000,
      )) as any;

      expect(result.possibleConditions).toContain('Common Cold');
      expect(result.urgency).toBe('low');
    });

    it('should handle telco get_active_alarms tool', async () => {
      const result = (await executor.execute(
        'get_active_alarms',
        {
          severity: 'critical',
        },
        5000,
      )) as any;

      expect(result.alarms).toBeDefined();
      expect(result.alarms.length).toBeGreaterThan(0);
      expect(result.total).toBe(5);
    });

    it('should handle traveldesk verify_code with valid code', async () => {
      const result = (await executor.execute('verify_code', { code: '123456' }, 5000)) as any;
      expect(result.valid).toBe(true);
      expect(result.user_id).toMatch(/^USR-/);
      expect(result.token).toMatch(/^tok-/);
    });

    it('should handle traveldesk verify_code with invalid code', async () => {
      const result = (await executor.execute('verify_code', { code: '999999' }, 5000)) as any;
      expect(result.valid).toBe(false);
    });

    it('should handle booking cancellation with refund info', async () => {
      const result = (await executor.execute(
        'cancel_booking',
        {
          booking_id: 'BK-12345',
          reason: 'changed plans',
        },
        5000,
      )) as any;

      expect(result.success).toBe(true);
      expect(result.refund_amount).toBe(245);
      expect(result.processing_days).toBe(5);
    });

    it('should handle check_change_eligibility with fee calculation', async () => {
      const result = (await executor.execute(
        'check_change_eligibility',
        {
          booking_id: 'BK-12345',
          change_type: 'date',
        },
        5000,
      )) as any;

      expect(result.eligible).toBe(true);
      expect(result.fee).toBe(50);
    });

    it('should handle NOC dashboard with network health', async () => {
      const result = (await executor.execute('get_noc_dashboard', {}, 5000)) as any;

      expect(result.network_health_score).toBe(94);
      expect(result.active_alarms.critical).toBe(2);
      expect(result.regions).toHaveLength(5);
    });
  });
});
