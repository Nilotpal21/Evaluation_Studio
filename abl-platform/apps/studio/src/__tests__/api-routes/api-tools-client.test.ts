/**
 * Tests for Tools API Client (apps/studio/src/api/tools.ts)
 *
 * Verifies that each exported function builds the correct URL, method, body,
 * and query params when calling the underlying apiFetch / handleResponse helpers.
 * Also verifies that error responses produce structured AppError throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectRejectedMessage } from '../helpers/expect-rejected-message';

// ---------------------------------------------------------------------------
// Mocks — api-client (apiFetch + handleResponse)
// ---------------------------------------------------------------------------

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are declared
// ---------------------------------------------------------------------------

import {
  fetchTools,
  fetchTool,
  createTool,
  updateTool,
  deleteTool,
  duplicateTool,
  testTool,
  exportTool,
  importTool,
} from '@/api/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-123';
const TOOL_ID = 'tool-456';
const FAKE_RESPONSE = {} as Response;

function lastApiFetchCall() {
  return {
    path: mockApiFetch.mock.calls.at(-1)?.[0] as string,
    init: mockApiFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue(FAKE_RESPONSE);
  mockHandleResponse.mockResolvedValue({ success: true });
});

// =============================================================================
// TOOLS CRUD
// =============================================================================

describe('Tools CRUD', () => {
  // ── fetchTools ──────────────────────────────────────────────────────────

  describe('fetchTools', () => {
    it('calls apiFetch with correct path (no params)', async () => {
      await fetchTools(PROJECT_ID);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools`);
      expect(init).toBeUndefined();
    });

    it('appends query params when provided', async () => {
      await fetchTools(PROJECT_ID, { page: 2, limit: 20, toolType: 'http', search: 'weather' });
      const { path } = lastApiFetchCall();
      expect(path).toContain('page=2');
      expect(path).toContain('limit=20');
      expect(path).toContain('toolType=http');
      expect(path).toContain('search=weather');
    });

    it('omits falsy query params', async () => {
      await fetchTools(PROJECT_ID, { page: 0, limit: 0 });
      const { path } = lastApiFetchCall();
      // page=0 and limit=0 are falsy so should not appear
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools`);
    });

    it('passes response to handleResponse', async () => {
      const data = {
        success: true,
        data: [],
        pagination: { page: 1, limit: 20, total: 0, hasMore: false },
      };
      mockHandleResponse.mockResolvedValueOnce(data);
      const result = await fetchTools(PROJECT_ID);
      expect(mockHandleResponse).toHaveBeenCalledWith(FAKE_RESPONSE);
      expect(result).toEqual(data);
    });
  });

  // ── fetchTool ──────────────────────────────────────────────────────────

  describe('fetchTool', () => {
    it('calls apiFetch with correct path', async () => {
      await fetchTool(PROJECT_ID, TOOL_ID);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}`);
      expect(init).toBeUndefined();
    });

    it('returns parsed tool detail', async () => {
      const detail = { success: true, tool: { _id: TOOL_ID, name: 'MyTool' } };
      mockHandleResponse.mockResolvedValueOnce(detail);
      const result = await fetchTool(PROJECT_ID, TOOL_ID);
      expect(result).toEqual(detail);
    });
  });

  // ── createTool ─────────────────────────────────────────────────────────

  describe('createTool', () => {
    it('sends POST with JSON body', async () => {
      const data = { name: 'WeatherTool', toolType: 'http' as const, description: 'Gets weather' };
      await createTool(PROJECT_ID, data);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init?.body as string)).toEqual(data);
    });
  });

  // ── updateTool ─────────────────────────────────────────────────────────

  describe('updateTool', () => {
    it('sends PUT with JSON body', async () => {
      const data = { description: 'Updated desc' };
      await updateTool(PROJECT_ID, TOOL_ID, data);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}`);
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init?.body as string)).toEqual(data);
    });
  });

  // ── deleteTool ─────────────────────────────────────────────────────────

  describe('deleteTool', () => {
    it('sends DELETE request', async () => {
      await deleteTool(PROJECT_ID, TOOL_ID);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}`);
      expect(init?.method).toBe('DELETE');
    });

    it('appends force=true when forced delete is requested', async () => {
      await deleteTool(PROJECT_ID, TOOL_ID, { force: true });
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}?force=true`);
      expect(init?.method).toBe('DELETE');
    });

    it('returns void (handleResponse result is discarded)', async () => {
      mockHandleResponse.mockResolvedValueOnce({ success: true });
      const result = await deleteTool(PROJECT_ID, TOOL_ID);
      expect(result).toBeUndefined();
    });
  });

  // ── duplicateTool ──────────────────────────────────────────────────────

  describe('duplicateTool', () => {
    it('sends POST with empty JSON body', async () => {
      await duplicateTool(PROJECT_ID, TOOL_ID);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}/duplicate`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init?.body).toBe('{}');
    });
  });
});

// =============================================================================
// TEST
// =============================================================================

describe('testTool', () => {
  it('sends POST with input payload', async () => {
    const input = { city: 'London' };
    await testTool(PROJECT_ID, TOOL_ID, input);
    const { path, init } = lastApiFetchCall();
    expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}/test`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.input).toEqual(input);
  });
});

// =============================================================================
// EXPORT / IMPORT
// =============================================================================

describe('Export / Import', () => {
  describe('exportTool', () => {
    it('calls apiFetch with GET (default method)', async () => {
      await exportTool(PROJECT_ID, TOOL_ID);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/${TOOL_ID}/export`);
      // No method specified means default GET
      expect(init).toBeUndefined();
    });
  });

  describe('importTool', () => {
    it('sends POST with tool payload', async () => {
      const payload = { tool: { name: 'Imported' } };
      await importTool(PROJECT_ID, payload);
      const { path, init } = lastApiFetchCall();
      expect(path).toBe(`/api/projects/${PROJECT_ID}/tools/import`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(payload);
    });

    it('accepts wrapped export payloads', async () => {
      const payload = {
        export: {
          tool: { name: 'Imported' },
          version: { inputSchema: '{}' },
        },
      };
      await importTool(PROJECT_ID, payload);
      const { init } = lastApiFetchCall();
      expect(JSON.parse(init?.body as string)).toEqual(payload);
    });
  });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

describe('Error handling', () => {
  it('propagates handleResponse errors to caller', async () => {
    const error = new Error('Not found');
    (error as any).code = 'TOOL_NOT_FOUND';
    (error as any).statusCode = 404;
    mockHandleResponse.mockRejectedValueOnce(error);

    await expectRejectedMessage(fetchTool(PROJECT_ID, TOOL_ID), 'Not found');
  });

  it('propagates apiFetch network errors', async () => {
    mockApiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expectRejectedMessage(fetchTools(PROJECT_ID), 'Failed to fetch');
  });

  it('propagates errors for write operations', async () => {
    const error = new Error('Validation failed');
    (error as any).code = 'VALIDATION_ERROR';
    (error as any).statusCode = 400;
    mockHandleResponse.mockRejectedValueOnce(error);

    await expectRejectedMessage(
      createTool(PROJECT_ID, { name: '', toolType: 'http' }),
      'Validation failed',
    );
  });

  it('propagates errors for delete operations', async () => {
    const error = new Error('Forbidden');
    (error as any).code = 'FORBIDDEN';
    (error as any).statusCode = 403;
    mockHandleResponse.mockRejectedValueOnce(error);

    await expectRejectedMessage(deleteTool(PROJECT_ID, TOOL_ID), 'Forbidden');
  });
});
