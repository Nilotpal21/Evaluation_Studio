import { execSync } from 'child_process';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GENERATOR_PATH = path.resolve(__dirname, '..', 'manifest-generator.ts');

interface RouteEntry {
  path: string;
  methods: string[];
  auth: string;
  pathParams: string[];
  queryParams?: string[];
  category: string;
  dependencies: string[];
  source: string;
}

interface RouteManifest {
  generatedAt: string;
  studioRoutes: RouteEntry[];
  runtimeRoutes: RouteEntry[];
}

const VALID_AUTH_LEVELS = ['tenant', 'project', 'admin', 'public', 'unknown'];
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const CRITICAL_RUNTIME_ROUTES = [
  {
    path: '/api/auth/dev-login',
    methods: ['POST'],
    auth: 'public',
    category: 'auth',
    source: 'apps/runtime/src/routes/auth.ts',
  },
  {
    path: '/api/projects/[projectId]',
    methods: ['GET'],
    auth: 'project',
    category: 'projects',
    source: 'apps/runtime/src/routes/projects.ts',
  },
  {
    path: '/api/projects/[projectId]/sessions',
    methods: ['GET', 'POST'],
    auth: 'project',
    category: 'sessions',
    source: 'apps/runtime/src/routes/sessions.ts',
  },
  {
    path: '/api/projects/[projectId]/workflows',
    methods: ['GET', 'POST'],
    auth: 'project',
    category: 'workflows',
    source: 'apps/runtime/src/routes/workflows.ts',
  },
  {
    path: '/api/v1/chat/stream',
    methods: ['POST'],
    auth: 'project',
    category: 'chat',
    source: 'apps/runtime/src/routes/chat.ts',
  },
  {
    path: '/api/platform/admin/usage-summary',
    methods: ['GET'],
    auth: 'admin',
    category: 'platform-admin',
    source: 'apps/runtime/src/routes/platform-admin-usage.ts',
  },
] as const;

let manifest: RouteManifest;

beforeAll(() => {
  let output: string;
  try {
    output = execSync(`npx tsx "${GENERATOR_PATH}"`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `manifest-generator failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    manifest = JSON.parse(output);
  } catch {
    throw new Error(
      `manifest-generator output is not valid JSON (first 200 chars): ${output.slice(0, 200)}`,
    );
  }
}, 60_000);

describe('manifest-generator', () => {
  describe('manifest structure', () => {
    it('produces valid JSON with studioRoutes and runtimeRoutes arrays', () => {
      expect(manifest).toBeDefined();
      expect(manifest.generatedAt).toBeDefined();
      expect(typeof manifest.generatedAt).toBe('string');
      expect(Array.isArray(manifest.studioRoutes)).toBe(true);
      expect(Array.isArray(manifest.runtimeRoutes)).toBe(true);
    });
  });

  describe('required fields on every route', () => {
    const requiredFields: (keyof RouteEntry)[] = [
      'path',
      'methods',
      'auth',
      'pathParams',
      'category',
      'source',
    ];

    it('every studio route has all required fields', () => {
      for (const route of manifest.studioRoutes) {
        for (const field of requiredFields) {
          expect(route[field], `studio route ${route.path} missing "${field}"`).toBeDefined();
        }
      }
    });

    it('every runtime route has all required fields', () => {
      for (const route of manifest.runtimeRoutes) {
        for (const field of requiredFields) {
          expect(route[field], `runtime route ${route.path} missing "${field}"`).toBeDefined();
        }
      }
    });
  });

  describe('auth values are valid', () => {
    it('every studio route has a valid auth level', () => {
      for (const route of manifest.studioRoutes) {
        expect(
          VALID_AUTH_LEVELS,
          `studio route ${route.path} has invalid auth "${route.auth}"`,
        ).toContain(route.auth);
      }
    });

    it('every runtime route has a valid auth level', () => {
      for (const route of manifest.runtimeRoutes) {
        expect(
          VALID_AUTH_LEVELS,
          `runtime route ${route.path} has invalid auth "${route.auth}"`,
        ).toContain(route.auth);
      }
    });
  });

  describe('HTTP methods are valid', () => {
    it('every studio route has only valid HTTP methods', () => {
      for (const route of manifest.studioRoutes) {
        expect(route.methods.length, `studio route ${route.path} has no methods`).toBeGreaterThan(
          0,
        );
        for (const method of route.methods) {
          expect(
            VALID_HTTP_METHODS,
            `studio route ${route.path} has invalid method "${method}"`,
          ).toContain(method);
        }
      }
    });

    it('every runtime route has only valid HTTP methods', () => {
      for (const route of manifest.runtimeRoutes) {
        expect(route.methods.length, `runtime route ${route.path} has no methods`).toBeGreaterThan(
          0,
        );
        for (const method of route.methods) {
          expect(
            VALID_HTTP_METHODS,
            `runtime route ${route.path} has invalid method "${method}"`,
          ).toContain(method);
        }
      }
    });
  });

  describe('path params match [paramName] patterns', () => {
    it('studio route pathParams correspond to bracket segments in the path', () => {
      for (const route of manifest.studioRoutes) {
        const bracketed = route.path.match(/\[([^\]]+)\]/g) ?? [];
        const expectedParams = bracketed.map((b) => b.slice(1, -1));
        expect(route.pathParams).toEqual(expectedParams);
      }
    });

    it('runtime route pathParams correspond to bracket segments in the path', () => {
      for (const route of manifest.runtimeRoutes) {
        const bracketed = route.path.match(/\[([^\]]+)\]/g) ?? [];
        const expectedParams = bracketed.map((b) => b.slice(1, -1));
        expect(route.pathParams).toEqual(expectedParams);
      }
    });
  });

  describe('no duplicate routes', () => {
    it('no duplicate studio routes (same path + same methods)', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const route of manifest.studioRoutes) {
        const key = `${route.path}|${[...route.methods].sort().join(',')}`;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      expect(duplicates, `duplicate studio routes: ${duplicates.join(', ')}`).toEqual([]);
    });

    it('no duplicate runtime routes (same path + same methods)', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const route of manifest.runtimeRoutes) {
        const key = `${route.path}|${[...route.methods].sort().join(',')}`;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      expect(duplicates, `duplicate runtime routes: ${duplicates.join(', ')}`).toEqual([]);
    });
  });

  describe('route count sanity checks', () => {
    it('has at least 100 studio routes', () => {
      expect(manifest.studioRoutes.length).toBeGreaterThanOrEqual(100);
    });

    it('has at least 300 runtime routes', () => {
      expect(manifest.runtimeRoutes.length).toBeGreaterThanOrEqual(300);
    });
  });

  describe('runtime regression guardrails', () => {
    it('keeps critical runtime routes discoverable with stable auth and source metadata', () => {
      for (const expected of CRITICAL_RUNTIME_ROUTES) {
        const actual = manifest.runtimeRoutes.find((route) => route.path === expected.path);
        expect(actual, `missing runtime route ${expected.path}`).toBeDefined();
        expect(actual?.methods).toEqual(expected.methods);
        expect(actual?.auth).toBe(expected.auth);
        expect(actual?.category).toBe(expected.category);
        expect(actual?.source).toBe(expected.source);
      }
    });

    it('covers primary runtime categories used by the planned migration slices', () => {
      const categories = new Set(manifest.runtimeRoutes.map((route) => route.category));
      expect([...categories]).toEqual(
        expect.arrayContaining([
          'auth',
          'projects',
          'sessions',
          'workflows',
          'chat',
          'platform-admin',
          'analytics',
          'voice',
        ]),
      );
    });
  });
});
