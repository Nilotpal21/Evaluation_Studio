import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DOCKERFILE_PATH = resolve(process.cwd(), 'Dockerfile');
const ORIGINAL_GIT_SHA = process.env.GIT_SHA;
const ORIGINAL_DEPLOY_ID = process.env.DEPLOY_ID;
const ORIGINAL_DEPLOYMENT_ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT;
const ORIGINAL_PACKAGE_VERSION = process.env.npm_package_version;

describe('GET /api/health', () => {
  it('points the container healthcheck at the liveness probe', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');

    expect(dockerfile).toContain("fetch('http://localhost:5173/health/live')");
    expect(dockerfile).not.toContain("fetch('http://localhost:5173/health')");
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_GIT_SHA === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = ORIGINAL_GIT_SHA;
    }

    if (ORIGINAL_DEPLOY_ID === undefined) {
      delete process.env.DEPLOY_ID;
    } else {
      process.env.DEPLOY_ID = ORIGINAL_DEPLOY_ID;
    }

    if (ORIGINAL_DEPLOYMENT_ENVIRONMENT === undefined) {
      delete process.env.DEPLOYMENT_ENVIRONMENT;
    } else {
      process.env.DEPLOYMENT_ENVIRONMENT = ORIGINAL_DEPLOYMENT_ENVIRONMENT;
    }

    if (ORIGINAL_PACKAGE_VERSION === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = ORIGINAL_PACKAGE_VERSION;
    }
  });

  it('returns build metadata with a no-store cache policy', async () => {
    process.env.GIT_SHA = 'studiosha123456';
    process.env.DEPLOY_ID = 'deploy-studio-1';
    process.env.DEPLOYMENT_ENVIRONMENT = 'production';
    delete process.env.npm_package_version;

    const { GET } = await import('@/app/api/health/route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'studio',
      build: {
        environment: 'production',
        deployId: 'deploy-studio-1',
        codeVersion: 'studiosha123456',
        commitSha: 'studiosha123456',
        packageVersion: null,
        versionSource: 'git_sha',
      },
    });
  });
});
