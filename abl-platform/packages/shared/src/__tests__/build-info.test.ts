import { describe, expect, it } from 'vitest';
import {
  extractServiceBuildInfo,
  getServiceBuildInfo,
  normalizeBuildEnvironment,
  parseServiceBuildInfo,
} from '../build-info.js';

describe('build-info', () => {
  it('prefers GIT_SHA when both commit and package version are present', () => {
    expect(
      getServiceBuildInfo({
        GIT_SHA: 'abc123def456',
        DEPLOY_ID: 'deploy-runtime-1',
        DEPLOYMENT_ENVIRONMENT: 'production',
        npm_package_version: '1.2.3',
      }),
    ).toEqual({
      environment: 'production',
      deployId: 'deploy-runtime-1',
      codeVersion: 'abc123def456',
      commitSha: 'abc123def456',
      packageVersion: '1.2.3',
      versionSource: 'git_sha',
    });
  });

  it('falls back to package version and normalizes common environment aliases', () => {
    expect(
      getServiceBuildInfo({
        NODE_ENV: 'development',
        DEPLOY_ID: 'deploy-studio-1',
        npm_package_version: '9.9.9',
      }),
    ).toEqual({
      environment: 'dev',
      deployId: 'deploy-studio-1',
      codeVersion: '9.9.9',
      commitSha: null,
      packageVersion: '9.9.9',
      versionSource: 'package_version',
    });

    expect(normalizeBuildEnvironment('test')).toBe('dev');
    expect(normalizeBuildEnvironment('prod')).toBe('production');
    expect(normalizeBuildEnvironment('QA')).toBe('qa');
    expect(normalizeBuildEnvironment('preview')).toBe('preview');
  });

  it('parses build objects from health payloads', () => {
    expect(
      parseServiceBuildInfo({
        environment: 'staging',
        deployId: 'deploy-search-2',
        codeVersion: 'fedcba9876543210',
        commitSha: 'fedcba9876543210',
        packageVersion: '1.0.0',
        versionSource: 'git_sha',
      }),
    ).toEqual({
      environment: 'staging',
      deployId: 'deploy-search-2',
      codeVersion: 'fedcba9876543210',
      commitSha: 'fedcba9876543210',
      packageVersion: '1.0.0',
      versionSource: 'git_sha',
    });

    expect(
      extractServiceBuildInfo({
        status: 'ok',
        build: {
          environment: 'prod',
          deployId: 'deploy-admin-3',
          codeVersion: '1.0.5',
          packageVersion: '1.0.5',
          versionSource: 'package_version',
        },
      }),
    ).toEqual({
      environment: 'production',
      deployId: 'deploy-admin-3',
      codeVersion: '1.0.5',
      commitSha: null,
      packageVersion: '1.0.5',
      versionSource: 'package_version',
    });
  });

  it('returns null when the build payload has no code version', () => {
    expect(parseServiceBuildInfo({ deployId: 'deploy-1' })).toBeNull();
    expect(extractServiceBuildInfo({ status: 'ok' })).toBeNull();
  });

  it('preserves deploy environments that are not part of the legacy alias set', () => {
    expect(
      getServiceBuildInfo({
        DEPLOYMENT_ENVIRONMENT: 'qa',
        GIT_SHA: '1234567890ab',
      }),
    ).toEqual({
      environment: 'qa',
      deployId: 'local',
      codeVersion: '1234567890ab',
      commitSha: '1234567890ab',
      packageVersion: null,
      versionSource: 'git_sha',
    });

    expect(
      parseServiceBuildInfo({
        environment: 'preview',
        deployId: 'deploy-preview-1',
        codeVersion: '2.0.0',
        versionSource: 'package_version',
      }),
    ).toEqual({
      environment: 'preview',
      deployId: 'deploy-preview-1',
      codeVersion: '2.0.0',
      commitSha: null,
      packageVersion: null,
      versionSource: 'package_version',
    });
  });
});
