/**
 * Studio External Agents API Route — Proxy Verification Tests
 *
 * Verifies that the Studio Next.js API routes for external agents are correctly
 * wired to proxy requests to the Runtime API at the expected paths.
 *
 * These are source-level structural tests that verify:
 * - Route files exist and export the expected HTTP method handlers
 * - Proxy paths contain the correct Runtime API path templates
 * - All CRUD operations (GET list, POST create, GET single, PATCH update, DELETE)
 *   and test-connection are covered
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StudioPermission } from '../lib/permissions';

const STUDIO_API_BASE = path.resolve(__dirname, '../app/api/projects/[id]/external-agents');

describe('Studio external-agents API route structure', () => {
  // ─── Collection routes: /api/projects/[id]/external-agents ──────────────

  describe('collection route (GET list, POST create)', () => {
    const routePath = path.join(STUDIO_API_BASE, 'route.ts');

    it('route file exists', () => {
      expect(fs.existsSync(routePath)).toBe(true);
    });

    it('exports GET handler for listing external agents', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const GET');
    });

    it('exports POST handler for creating external agents', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const POST');
    });

    it('proxies to correct Runtime path pattern', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      // GET should proxy to /api/projects/${params.id}/external-agents
      expect(source).toContain('`/api/projects/${params.id}/external-agents${search}`');
      // POST should proxy to /api/projects/${params.id}/external-agents
      expect(source).toContain('`/api/projects/${params.id}/external-agents`');
    });

    it('requires project context (requireProject: true)', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('requireProject: true');
    });

    it('uses proxyToRuntime for proxying', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('proxyToRuntime');
    });
  });

  // ─── Single-item routes: /api/projects/[id]/external-agents/[agentId] ──

  describe('single-item route (GET, PATCH, DELETE)', () => {
    const routePath = path.join(STUDIO_API_BASE, '[agentId]/route.ts');

    it('route file exists', () => {
      expect(fs.existsSync(routePath)).toBe(true);
    });

    it('exports GET handler for fetching a single external agent', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const GET');
    });

    it('exports PATCH handler for updating an external agent', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const PATCH');
    });

    it('exports DELETE handler for deleting an external agent', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const DELETE');
    });

    it('proxies to correct Runtime path pattern with agentId', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('`/api/projects/${params.id}/external-agents/${params.agentId}`');
    });

    it('requires project context (requireProject: true)', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('requireProject: true');
    });
  });

  // ─── Test-connection route ─────────────────────────────────────────────

  describe('test-connection route (POST)', () => {
    const routePath = path.join(STUDIO_API_BASE, '[agentId]/test-connection/route.ts');

    it('route file exists', () => {
      expect(fs.existsSync(routePath)).toBe(true);
    });

    it('exports POST handler for testing connection', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('export const POST');
    });

    it('proxies to correct Runtime test-connection path pattern', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain(
        '`/api/projects/${params.id}/external-agents/${params.agentId}/test-connection`',
      );
    });

    it('requires project context and update permission', () => {
      const source = fs.readFileSync(routePath, 'utf-8');
      expect(source).toContain('requireProject: true');
      expect(source).toContain('StudioPermission.EXTERNAL_AGENT_UPDATE');
    });
  });

  // ─── Permission coverage ───────────────────────────────────────────────

  describe('permission assignments use typed StudioPermission constants', () => {
    it('collection GET uses StudioPermission.EXTERNAL_AGENT_READ', () => {
      const source = fs.readFileSync(path.join(STUDIO_API_BASE, 'route.ts'), 'utf-8');
      const getSection = source.split('export const GET')[1]?.split('export const')[0] ?? '';
      expect(getSection).toContain('StudioPermission.EXTERNAL_AGENT_READ');
    });

    it('collection POST uses StudioPermission.EXTERNAL_AGENT_CREATE', () => {
      const source = fs.readFileSync(path.join(STUDIO_API_BASE, 'route.ts'), 'utf-8');
      const postSection = source.split('export const POST')[1] ?? '';
      expect(postSection).toContain('StudioPermission.EXTERNAL_AGENT_CREATE');
    });

    it('single-item PATCH uses StudioPermission.EXTERNAL_AGENT_UPDATE', () => {
      const source = fs.readFileSync(path.join(STUDIO_API_BASE, '[agentId]/route.ts'), 'utf-8');
      const patchSection = source.split('export const PATCH')[1]?.split('export const')[0] ?? '';
      expect(patchSection).toContain('StudioPermission.EXTERNAL_AGENT_UPDATE');
    });

    it('single-item DELETE uses StudioPermission.EXTERNAL_AGENT_DELETE', () => {
      const source = fs.readFileSync(path.join(STUDIO_API_BASE, '[agentId]/route.ts'), 'utf-8');
      const deleteSection = source.split('export const DELETE')[1] ?? '';
      expect(deleteSection).toContain('StudioPermission.EXTERNAL_AGENT_DELETE');
    });

    it('StudioPermission constants resolve to the wire-format permission strings', () => {
      // Tenant + project + user RBAC checks compare the resolved string against
      // the platform permission registry — drift here would silently bypass auth.
      expect(StudioPermission.EXTERNAL_AGENT_READ).toBe('external_agent:read');
      expect(StudioPermission.EXTERNAL_AGENT_CREATE).toBe('external_agent:create');
      expect(StudioPermission.EXTERNAL_AGENT_UPDATE).toBe('external_agent:update');
      expect(StudioPermission.EXTERNAL_AGENT_DELETE).toBe('external_agent:delete');
    });
  });

  // ─── No untyped permission casts ───────────────────────────────────────

  describe('no `as any` permission casts in route files', () => {
    const routeFiles = [
      path.join(STUDIO_API_BASE, 'route.ts'),
      path.join(STUDIO_API_BASE, '[agentId]/route.ts'),
      path.join(STUDIO_API_BASE, '[agentId]/test-connection/route.ts'),
    ];

    for (const routeFile of routeFiles) {
      it(`${path.relative(STUDIO_API_BASE, routeFile)} has zero \`as any\` casts`, () => {
        const source = fs.readFileSync(routeFile, 'utf-8');
        // Match `as any` whether trailing the permission literal, the value, or anywhere else.
        // The route file should rely on typed StudioPermission constants exclusively.
        expect(source).not.toMatch(/\bas\s+any\b/);
      });
    }
  });
});
