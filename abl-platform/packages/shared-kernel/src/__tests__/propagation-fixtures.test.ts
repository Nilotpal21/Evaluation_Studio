import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_OUTPUT_GOLDEN_FIXTURE,
  PROPAGATION_CONTRACT_VERSIONS,
  PROPAGATION_FIXTURE_MANIFEST,
  PROPAGATION_GOLDEN_FIXTURES,
  type PropagationFixtureFamily,
} from '../propagation-fixtures.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '../../');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../');

const REQUIRED_FAMILIES: readonly PropagationFixtureFamily[] = [
  'assistant-output',
  'guardrail-output',
  'channel-capability',
  'tool-contract',
  'attachment-media',
  'locale-auth-memory',
];

const REQUIRED_CONSUMER_PACKAGES = [
  '@agent-platform/runtime',
  '@agent-platform/studio',
  '@agent-platform/project-io',
  '@agent-platform/web-sdk',
] as const;

describe('propagation golden fixtures', () => {
  it('keeps a manifest for every future-ready propagation fixture family', () => {
    const families = new Set(PROPAGATION_FIXTURE_MANIFEST.map((entry) => entry.family));

    for (const family of REQUIRED_FAMILIES) {
      expect(families.has(family), `Missing propagation fixture family: ${family}`).toBe(true);
    }

    for (const entry of PROPAGATION_FIXTURE_MANIFEST) {
      expect(entry.ownerPackage).toBe('@agent-platform/shared-kernel');
      expect(entry.fixtureExports.length, `${entry.family} needs fixture exports`).toBeGreaterThan(
        0,
      );
      expect(
        entry.compatibilityShapeVersions.length,
        `${entry.family} needs compatibility shape versions`,
      ).toBeGreaterThan(0);
      for (const version of entry.compatibilityShapeVersions) {
        expect(version, `${entry.family} uses an unversioned contract`).toMatch(/\/v\d+$/);
      }
    }
  });

  it('declares consumers for runtime, Studio, project-io, and Web SDK paths', () => {
    const manifestText = JSON.stringify(PROPAGATION_FIXTURE_MANIFEST);

    for (const packageName of REQUIRED_CONSUMER_PACKAGES) {
      expect(manifestText, `Missing consumer package: ${packageName}`).toContain(packageName);
    }
  });

  it('locks text-plus-structured and structured-only assistant output examples', () => {
    const { textPlusStructured, structuredOnly } = ASSISTANT_OUTPUT_GOLDEN_FIXTURE;

    expect(textPlusStructured.response).not.toBe('');
    expect(textPlusStructured.richContent).toBeDefined();
    expect(textPlusStructured.voiceConfig).toBeDefined();
    expect(textPlusStructured.actions.length).toBeGreaterThan(0);
    expect(textPlusStructured.contentEnvelope.version).toBe(
      PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope,
    );
    expect(textPlusStructured.contentEnvelope.localization).toEqual(
      textPlusStructured.localization,
    );

    expect(structuredOnly.response).toBe('');
    expect(structuredOnly.richContent).toBeDefined();
    expect(structuredOnly.voiceConfig).toBeDefined();
    expect(structuredOnly.actions.length).toBeGreaterThan(0);
    expect(structuredOnly.contentEnvelope.text).toBe('');
    expect(structuredOnly.contentEnvelope.metadata.structuredOnly).toBe(true);
  });

  it('exposes the fixture corpus through the package barrel and subpath export', () => {
    const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.['./propagation-fixtures']).toBeDefined();
    expect(PROPAGATION_GOLDEN_FIXTURES.assistantOutput).toBe(ASSISTANT_OUTPUT_GOLDEN_FIXTURE);
  });

  it('keeps declared consumer package directories present', () => {
    const packageDirs = new Map([
      ['@agent-platform/runtime', 'apps/runtime'],
      ['@agent-platform/studio', 'apps/studio'],
      ['@agent-platform/project-io', 'packages/project-io'],
      ['@agent-platform/web-sdk', 'packages/web-sdk'],
    ]);

    for (const entry of PROPAGATION_FIXTURE_MANIFEST) {
      for (const packageName of entry.consumerPackages) {
        const packageDir = packageDirs.get(packageName);
        if (!packageDir) {
          continue;
        }
        expect(
          fs.existsSync(path.join(REPO_ROOT, packageDir)),
          `${entry.family} declares missing consumer package ${packageName}`,
        ).toBe(true);
      }
    }
  });
});
