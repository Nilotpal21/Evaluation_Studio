import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyRuntimeMcpServersChanged } from '../runtime-mcp-cache-invalidation';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

describe('notifyRuntimeMcpServersChanged', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockReset();
    process.env.JWT_SECRET = 'unit-test-jwt-secret-' + 'x'.repeat(48);
  });

  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  it('POSTs to the runtime internal cache-bust endpoint with a service-auth bearer token', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as unknown as Response);

    await notifyRuntimeMcpServersChanged('tenant1', 'project1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/internal/mcp/reset-project-init');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ tenantId: 'tenant1', projectId: 'project1' }));

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('logs but does not throw if runtime is unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(notifyRuntimeMcpServersChanged('tenant1', 'project1')).resolves.toBeUndefined();
  });

  it('skips the call (no fetch) when JWT_SECRET is not configured', async () => {
    delete process.env.JWT_SECRET;
    const fetchSpy = vi.spyOn(global, 'fetch');

    await notifyRuntimeMcpServersChanged('tenant1', 'project1');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
