import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_ROOT = path.resolve(__dirname, '../../');

function readStudioFile(relativePath: string): string {
  return fs.readFileSync(path.join(STUDIO_ROOT, relativePath), 'utf8');
}

describe('Studio proxy production wiring', () => {
  it('keeps runtime session attachment proxying project scoped and tenant header sanitized', () => {
    const route = readStudioFile('app/api/runtime/sessions/[id]/attachments/route.ts');

    expect(route).toContain('requireProjectAccess');
    expect(route).toContain("headers['X-Tenant-Id'] = user.tenantId");
    expect(route).toContain('/api/projects/${encodeURIComponent(projectId)}');
    expect(route).toContain('/sessions/${encodeURIComponent(id)}/attachments');
  });

  it('keeps SDK channel proxy resolution tenant and project scoped before runtime forwarding', () => {
    const proxy = readStudioFile('lib/sdk-runtime-channel-proxy.ts');

    expect(proxy).toContain('findSdkChannelByIdForTenant');
    expect(proxy).toContain('requireSdkProjectAccess');
    expect(proxy).toContain('projectId: channel.projectId');
    expect(proxy).toContain("message: 'SDK channel not found'");
  });

  it('keeps shared route helpers and safe proxy parsing reachable for Studio API routes', () => {
    const routeHandler = readStudioFile('lib/route-handler.ts');
    const runtimeProxy = readStudioFile('lib/runtime-proxy.ts');
    const safeProxy = readStudioFile('lib/safe-proxy.ts');

    expect(routeHandler).toContain('withRouteHandler');
    expect(routeHandler).toContain('requireProjectAccess');
    expect(routeHandler).toContain('canProjectPermissionContextPerform');
    expect(runtimeProxy).toContain('buildRuntimeProxyHeaders');
    expect(runtimeProxy).toContain("headers['X-Tenant-Id'] = tenantId");
    expect(safeProxy).toContain('safeJsonParse');
  });

  it('no longer rewrites Academy API traffic to the separate Academy service', () => {
    const proxy = readStudioFile('proxy.ts');

    expect(proxy).not.toContain('ACADEMY_URL');
    expect(proxy).not.toContain('/api/v1/academy/');
  });
});
