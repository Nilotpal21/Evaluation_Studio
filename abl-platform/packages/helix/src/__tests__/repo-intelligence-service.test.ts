import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RepoIntelligenceService } from '../intelligence/repo-intelligence-service.js';

describe('repo-intelligence-service', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('finds exported symbols with signatures inside a scoped package', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.findSymbol('requireProjectPermission', {
      scope: ['apps/demo'],
    });

    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      expect.objectContaining({
        symbol: 'requireProjectPermission',
        path: 'apps/demo/src/shared.ts',
        exported: true,
        matchType: 'exact',
        signature: expect.stringContaining('function requireProjectPermission'),
      }),
    ]);
    expect(result.matches[0]?.line).toBeGreaterThan(0);
  });

  it('finds references within the default package scope for a symbol declaration', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.findReferences(
      'apps/demo/src/shared.ts',
      'requireProjectPermission',
    );

    expect(result.scope).toEqual(['apps/demo']);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'apps/demo/src/consumer.ts',
          excerpt: expect.stringContaining('requireProjectPermission'),
        }),
        expect.objectContaining({
          path: 'apps/demo/src/secondary.ts',
          excerpt: expect.stringContaining('requireProjectPermission'),
        }),
      ]),
    );
    expect(result.references.some((reference) => reference.isDefinition)).toBe(false);
  });

  it('surfaces route middleware chains and auth signals for Express routers', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.getRouteInfo({
      filePath: 'apps/demo/src/routes/query.ts',
      method: 'post',
      pathContains: '/:projectId/query',
    });

    expect(result.routes).toEqual([
      expect.objectContaining({
        filePath: 'apps/demo/src/routes/query.ts',
        kind: 'route',
        method: 'post',
        path: '/:projectId/query',
        inheritedMiddleware: expect.arrayContaining(['authMiddleware', 'verifyProjectOwnership']),
        middleware: expect.arrayContaining(['requireProjectPermission()']),
        handler: 'handleQuery',
        authSignals: expect.arrayContaining([
          'authMiddleware',
          'verifyProjectOwnership',
          'requireProjectPermission()',
        ]),
      }),
    ]);
  });

  it('understands createOpenAPIRouter routes and applies basePath plus inherited middleware', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.getRouteInfo({
      filePath: 'apps/demo/src/routes/projects.ts',
      method: 'get',
    });

    expect(result.routes).toEqual([
      expect.objectContaining({
        filePath: 'apps/demo/src/routes/projects.ts',
        kind: 'route',
        method: 'get',
        path: '/api/projects/:projectId',
        inheritedMiddleware: expect.arrayContaining(['authMiddleware', 'requireProjectScope()']),
        middleware: expect.arrayContaining(['requireProjectPermission()']),
        handler: 'handleProject',
        authSignals: expect.arrayContaining([
          'authMiddleware',
          'requireProjectScope()',
          'requireProjectPermission()',
        ]),
        schema: 'projectDetailResponseSchema',
      }),
    ]);
  });

  it('summarizes exported zod schemas with field-level defaults and enums', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.getSchemaInfo({
      filePath: 'apps/demo/src/schemas/auth.ts',
      symbol: 'AuthConfigSchema',
    });

    expect(result.schemas).toEqual([
      expect.objectContaining({
        filePath: 'apps/demo/src/schemas/auth.ts',
        symbol: 'AuthConfigSchema',
        schemaKind: 'zod-object',
        summary: expect.stringContaining('Zod object'),
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'password',
            type: 'string',
            required: true,
          }),
          expect.objectContaining({
            name: 'strategy',
            enumValues: ['local', 'sso'],
            defaultValue: '"local"',
            required: false,
          }),
          expect.objectContaining({
            name: 'retries',
            type: 'number',
            defaultValue: '3',
            required: false,
          }),
        ]),
      }),
    ]);
  });

  it('summarizes mongoose schemas with required flags and nested object fields', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.getSchemaInfo({
      filePath: 'packages/demo/src/models/search-index.model.ts',
      symbol: 'SearchIndexSchema',
    });

    expect(result.schemas).toEqual([
      expect.objectContaining({
        filePath: 'packages/demo/src/models/search-index.model.ts',
        symbol: 'SearchIndexSchema',
        schemaKind: 'mongoose-schema',
        summary: expect.stringContaining('Mongoose schema'),
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'tenantId',
            type: 'string',
            required: true,
          }),
          expect.objectContaining({
            name: 'status',
            type: 'string',
            enumValues: ['draft', 'ready'],
            defaultValue: '"draft"',
          }),
          expect.objectContaining({
            name: 'metadata',
            type: 'object',
            defaultValue: 'null',
          }),
        ]),
      }),
    ]);
  });

  it('infers impacted tests from direct imports, sibling regressions, and dependent seams', async () => {
    workDir = await createWorkspace();
    const service = new RepoIntelligenceService({ workDir });

    const result = await service.getImpactedTests({
      paths: ['apps/demo/src/shared.ts'],
    });

    expect(result.scope).toEqual(['apps/demo']);
    expect(result.truncated).toBe(false);
    expect(result.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'apps/demo/src/shared.test.ts',
          reasons: expect.arrayContaining([
            expect.stringContaining('Imports changed file apps/demo/src/shared.ts.'),
          ]),
        }),
        expect.objectContaining({
          path: 'apps/demo/src/shared.regression.test.ts',
          reasons: expect.arrayContaining([
            expect.stringContaining('shared.regression.test.ts matches apps/demo/src/shared.ts'),
          ]),
        }),
        expect.objectContaining({
          path: 'apps/demo/src/consumer.test.ts',
          reasons: expect.arrayContaining([
            expect.stringContaining('Touches dependent seam apps/demo/src/consumer.ts'),
          ]),
        }),
      ]),
    );
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'helix-repo-intelligence-'));
  await mkdir(join(root, 'apps', 'demo', 'src'), { recursive: true });
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'shared.ts'),
    [
      'export function requireProjectPermission(permission: string): string {',
      '  return permission;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'consumer.ts'),
    [
      "import { requireProjectPermission } from './shared';",
      '',
      'export function usePermission(): string {',
      "  return requireProjectPermission('project:read');",
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'secondary.ts'),
    [
      "import { requireProjectPermission } from './shared';",
      '',
      'export const allow = (): string => {',
      "  return requireProjectPermission('project:write');",
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'shared.test.ts'),
    [
      "import { requireProjectPermission } from './shared';",
      '',
      "describe('requireProjectPermission', () => {",
      "  it('returns the requested permission', () => {",
      "    expect(requireProjectPermission('project:read')).toBe('project:read');",
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'shared.regression.test.ts'),
    [
      "describe('shared regression', () => {",
      '  it("keeps the auth seam stable", () => {',
      '    expect(true).toBe(true);',
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'consumer.test.ts'),
    [
      "import { usePermission } from './consumer';",
      '',
      "describe('usePermission', () => {",
      "  it('covers the dependent seam', () => {",
      "    expect(usePermission()).toBe('project:read');",
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  await mkdir(join(root, 'apps', 'demo', 'src', 'routes'), { recursive: true });
  await mkdir(join(root, 'apps', 'demo', 'src', 'schemas'), { recursive: true });
  await mkdir(join(root, 'packages', 'demo', 'src', 'models'), { recursive: true });
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'routes', 'query.ts'),
    [
      "import { Router } from 'express';",
      "import { authMiddleware } from '../middleware/auth';",
      "import { verifyProjectOwnership } from '../middleware/ownership';",
      "import { requireProjectPermission } from '../middleware/rbac';",
      '',
      'const router = Router();',
      'router.use(authMiddleware);',
      "router.use('/:projectId', verifyProjectOwnership);",
      "router.get('/health', handleHealth);",
      "router.post('/:projectId/query', requireProjectPermission('search:read'), handleQuery);",
      '',
      'function handleHealth(): string {',
      "  return 'ok';",
      '}',
      '',
      'function handleQuery(): string {',
      "  return 'query';",
      '}',
      '',
      'export default router;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'routes', 'projects.ts'),
    [
      "import { createOpenAPIRouter } from '@agent-platform/openapi/express';",
      "import { authMiddleware } from '../middleware/auth';",
      "import { requireProjectScope } from '../middleware/scope';",
      "import { requireProjectPermission } from '../middleware/rbac';",
      '',
      'const openapi = createOpenAPIRouter(runtimeRegistry, {',
      "  basePath: '/api/projects/:projectId',",
      '});',
      'const router = openapi.router;',
      'const projectDetailResponseSchema = responseSchema;',
      '',
      'router.use(authMiddleware);',
      "router.use(requireProjectScope('projectId'));",
      '',
      'openapi.route(',
      "  'get',",
      "  '/',",
      '  projectDetailResponseSchema,',
      "  requireProjectPermission('project:read'),",
      '  handleProject,',
      ');',
      '',
      'async function handleProject(req, res) {',
      '    res.json({ success: true });',
      '}',
      '',
      'export default router;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'src', 'schemas', 'auth.ts'),
    [
      "import { z } from 'zod';",
      '',
      'export const AuthConfigSchema = z.object({',
      '  password: z.string().min(8),',
      "  strategy: z.enum(['local', 'sso']).default('local'),",
      '  retries: z.coerce.number().int().default(3),',
      '  metadata: z.object({ issuer: z.string().optional() }).optional(),',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(root, 'packages', 'demo', 'src', 'models', 'search-index.model.ts'),
    [
      "import { Schema } from 'mongoose';",
      '',
      'export const SearchIndexSchema = new Schema({',
      '  tenantId: { type: String, required: true },',
      '  projectId: { type: String, required: true },',
      "  status: { type: String, enum: ['draft', 'ready'], default: 'draft' },",
      '  metadata: {',
      '    type: new Schema({ provider: { type: String, required: true } }),',
      '    default: null,',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );

  return root;
}
