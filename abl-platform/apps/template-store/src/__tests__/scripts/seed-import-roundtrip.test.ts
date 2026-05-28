/**
 * Seed Template Import Round-Trip — Integration Tests
 *
 * Validates that seed template bundles survive the full import pipeline at the
 * layer that matters most: the folder reader + validators from project-io.
 *
 * These tests prevent regressions of:
 * - Bug 2 (ABL syntax format): validateAgentSyntax catches "AGENT name" vs "AGENT: name"
 * - Bug 3/4 (acknowledgement): validateCrossLayerDeps and readFolderV2 detect structural issues
 *
 * TC-TS-136 (simplified): Seed bundles pass readFolderV2 folder structure validation
 * TC-TS-137: Seed bundles have valid ProjectManifestV2 manifests
 * TC-TS-138: Seed bundles pass both syntax validation AND folder structure validation
 */

import { describe, it, expect } from 'vitest';
import {
  readFolderV2,
  validateAgentSyntax,
  validateImport,
  validateCrossLayerDeps,
  type FolderReadResultV2,
} from '@agent-platform/project-io/import';
import { buildSeedTemplates, type Phase2SeedTemplate } from '../../scripts/seed-templates.js';

// ─── Shared Test Data ─────────────────────────────────────────────────────────

let seedTemplates: Phase2SeedTemplate[];

// Build seed templates once — they are pure functions, no DB required.
seedTemplates = buildSeedTemplates();

// ─── TC-TS-136 (simplified): Seed bundles pass readFolderV2 ──────────────────

describe('TC-TS-136: Seed bundles pass folder reader validation (readFolderV2)', () => {
  it('buildSeedTemplates returns at least one template', () => {
    expect(seedTemplates.length).toBeGreaterThan(0);
  });

  it('all seed template file bundles pass readFolderV2 without critical errors', () => {
    for (const seed of seedTemplates) {
      const fileMap = new Map(Object.entries(seed.files));
      const result: FolderReadResultV2 = readFolderV2(fileMap);

      // Should detect the v2 manifest format
      expect(
        result.formatVersion,
        `${seed.slug}: expected format_version 2.0 but got ${result.formatVersion}`,
      ).toBe('2.0');

      // Should parse the manifest successfully
      expect(
        result.manifestV2,
        `${seed.slug}: manifestV2 should be parsed (not null)`,
      ).not.toBeNull();

      // Should detect agent files
      expect(
        result.agentFiles.size,
        `${seed.slug}: should have at least one agent file`,
      ).toBeGreaterThan(0);

      // Should have no critical errors
      expect(
        result.errors,
        `${seed.slug}: readFolderV2 should produce zero errors but got: ${JSON.stringify(result.errors)}`,
      ).toHaveLength(0);

      // Success flag should be true (no critical errors)
      expect(result.success, `${seed.slug}: readFolderV2 success should be true`).toBe(true);
    }
  });

  it('multi-agent project bundles detect all agent files', () => {
    // Filter for project templates that have multiple agents
    const multiAgentTemplates = seedTemplates.filter(
      (seed) => Object.keys(seed.manifest.agents as Record<string, unknown>).length > 1,
    );
    expect(multiAgentTemplates.length).toBeGreaterThan(0);

    for (const seed of multiAgentTemplates) {
      const fileMap = new Map(Object.entries(seed.files));
      const result = readFolderV2(fileMap);

      const expectedAgentCount = Object.keys(
        seed.manifest.agents as Record<string, unknown>,
      ).length;
      expect(
        result.agentFiles.size,
        `${seed.slug}: expected ${expectedAgentCount} agent files but found ${result.agentFiles.size}`,
      ).toBe(expectedAgentCount);
    }
  });

  it('seed bundles with environment files are categorized correctly', () => {
    for (const seed of seedTemplates) {
      const hasEnvFile = Object.keys(seed.files).some((path) => path.startsWith('environment/'));
      if (!hasEnvFile) continue;

      const fileMap = new Map(Object.entries(seed.files));
      const result = readFolderV2(fileMap);

      expect(
        result.environmentFiles.size,
        `${seed.slug}: should detect environment files`,
      ).toBeGreaterThan(0);
    }
  });
});

// ─── TC-TS-137: Seed bundles have valid ProjectManifestV2 manifests ──────────

describe('TC-TS-137: Seed bundles have valid ProjectManifestV2 format', () => {
  it('all seed template manifests have required v2 fields', () => {
    for (const seed of seedTemplates) {
      const manifestJson = seed.files['project.json'];
      expect(manifestJson, `${seed.slug}: should have a project.json file`).toBeDefined();

      const manifest = JSON.parse(manifestJson);

      // v2 required fields
      expect(manifest.format_version, `${seed.slug}: format_version should be 2.0`).toBe('2.0');
      expect(manifest.entry_agent, `${seed.slug}: entry_agent should be truthy`).toBeTruthy();
      expect(manifest.agents, `${seed.slug}: agents should be defined`).toBeDefined();
      expect(
        Object.keys(manifest.agents).length,
        `${seed.slug}: should have at least one agent in manifest`,
      ).toBeGreaterThan(0);
      expect(manifest.name, `${seed.slug}: manifest name should be truthy`).toBeTruthy();
    }
  });

  it('all agent files referenced in manifest exist in the bundle', () => {
    for (const seed of seedTemplates) {
      const manifest = JSON.parse(seed.files['project.json']);
      const agents = manifest.agents as Record<string, { path: string }>;

      for (const [agentName, agentMeta] of Object.entries(agents)) {
        expect(
          seed.files[agentMeta.path],
          `${seed.slug}: agent "${agentName}" references path "${agentMeta.path}" which should exist in files`,
        ).toBeDefined();
      }
    }
  });

  it('entry_agent is one of the declared agents', () => {
    for (const seed of seedTemplates) {
      const manifest = JSON.parse(seed.files['project.json']);
      const agentNames = Object.keys(manifest.agents);

      expect(
        agentNames,
        `${seed.slug}: entry_agent "${manifest.entry_agent}" should be declared in agents`,
      ).toContain(manifest.entry_agent);
    }
  });

  it('manifest metadata contains entity counts matching actual agents', () => {
    for (const seed of seedTemplates) {
      const manifest = JSON.parse(seed.files['project.json']);
      const declaredCount = Object.keys(manifest.agents).length;
      const metadataCount = manifest.metadata?.entity_counts?.agents;

      if (metadataCount !== undefined) {
        expect(
          metadataCount,
          `${seed.slug}: metadata.entity_counts.agents should match actual agent count`,
        ).toBe(declaredCount);
      }
    }
  });
});

// ─── TC-TS-138: Full round-trip — syntax + folder + cross-layer ──────────────

describe('TC-TS-138: Seed bundles pass both syntax and folder structure validation', () => {
  it('all seed agent ABL files pass validateAgentSyntax (round-trip inclusion)', () => {
    for (const seed of seedTemplates) {
      for (const [path, content] of Object.entries(seed.files)) {
        if (!path.endsWith('.agent.abl')) continue;

        const errors = validateAgentSyntax(path, content);
        expect(
          errors,
          `${seed.slug} / ${path} should have zero syntax errors but got: ${JSON.stringify(errors)}`,
        ).toHaveLength(0);
      }
    }
  });

  it('all seed bundles pass validateImport with zero syntax errors and valid dependencies', () => {
    for (const seed of seedTemplates) {
      const agentFiles = new Map<string, string>();
      const toolFiles = new Map<string, string>();

      for (const [filePath, content] of Object.entries(seed.files)) {
        if (filePath.match(/^agents\/.*\.agent\.abl$/)) {
          agentFiles.set(filePath, content);
        } else if (filePath.match(/^tools\/.*\.tools\.abl$/)) {
          toolFiles.set(filePath, content);
        }
      }

      const result = validateImport(agentFiles, toolFiles);

      expect(
        result.syntaxErrors,
        `${seed.slug}: validateImport should have zero syntax errors but got: ${JSON.stringify(result.syntaxErrors)}`,
      ).toHaveLength(0);

      expect(result.valid, `${seed.slug}: validateImport should return valid=true`).toBe(true);
    }
  });

  it('manifest-to-files integrity: every agent in manifest has a file', () => {
    for (const seed of seedTemplates) {
      const manifest = JSON.parse(seed.files['project.json']);
      for (const [name, agent] of Object.entries(
        manifest.agents as Record<string, { path: string }>,
      )) {
        expect(
          seed.files,
          `${seed.slug}: agent "${name}" path "${agent.path}" should exist in files`,
        ).toHaveProperty(agent.path);
      }
    }
  });

  it('files-to-manifest integrity: every agent ABL file has a corresponding manifest entry', () => {
    for (const seed of seedTemplates) {
      const manifest = JSON.parse(seed.files['project.json']);
      for (const path of Object.keys(seed.files)) {
        if (!path.startsWith('agents/') || !path.endsWith('.agent.abl')) continue;

        const agentName = path.replace('agents/', '').replace('.agent.abl', '');
        expect(
          manifest.agents,
          `${seed.slug}: agent file "${path}" (name: "${agentName}") should have a manifest entry`,
        ).toHaveProperty(agentName);
      }
    }
  });

  it('cross-layer dependency validation passes for all seed bundles', () => {
    for (const seed of seedTemplates) {
      const fileMap = new Map(Object.entries(seed.files));
      const folderResult = readFolderV2(fileMap);

      const crossLayerResult = validateCrossLayerDeps(folderResult);

      expect(
        crossLayerResult.valid,
        `${seed.slug}: cross-layer validation should be valid but found missing deps: ${JSON.stringify(crossLayerResult.missingDependencies)}`,
      ).toBe(true);

      expect(
        crossLayerResult.missingDependencies,
        `${seed.slug}: should have zero missing cross-layer dependencies`,
      ).toHaveLength(0);
    }
  });
});

// ─── Additional: Bundle consistency checks ───────────────────────────────────

describe('Seed bundle consistency checks', () => {
  it('all seed bundles contain valid JSON in project.json', () => {
    for (const seed of seedTemplates) {
      expect(() => JSON.parse(seed.files['project.json'])).not.toThrow();
    }
  });

  it('all seed bundles contain valid JSON in environment files', () => {
    for (const seed of seedTemplates) {
      for (const [path, content] of Object.entries(seed.files)) {
        if (!path.startsWith('environment/') || !path.endsWith('.json')) continue;
        expect(
          () => JSON.parse(content),
          `${seed.slug} / ${path}: should be valid JSON`,
        ).not.toThrow();
      }
    }
  });

  it('agent names in ABL DSL match their file names', () => {
    for (const seed of seedTemplates) {
      for (const [path, content] of Object.entries(seed.files)) {
        if (!path.startsWith('agents/') || !path.endsWith('.agent.abl')) continue;

        const fileBaseName = path.replace('agents/', '').replace('.agent.abl', '');

        // Extract the agent name from the AGENT: header
        const headerMatch = content.match(/^(?:AGENT|SUPERVISOR):\s+(\S+)/m);
        expect(
          headerMatch,
          `${seed.slug} / ${path}: should have an AGENT: or SUPERVISOR: header`,
        ).not.toBeNull();

        if (headerMatch) {
          expect(
            headerMatch[1],
            `${seed.slug} / ${path}: agent DSL name "${headerMatch[1]}" should match file base name "${fileBaseName}"`,
          ).toBe(fileBaseName);
        }
      }
    }
  });

  it('seed template count is 5 (Phase 2 seeds)', () => {
    // Phase 2 defines exactly 5 seed templates
    expect(seedTemplates.length).toBe(5);
  });

  it('seed templates cover both agent and project types', () => {
    const types = new Set(seedTemplates.map((s) => s.type));
    expect(types.has('agent')).toBe(true);
    expect(types.has('project')).toBe(true);
  });

  it('project-type seeds have multiple agents', () => {
    const projectSeeds = seedTemplates.filter((s) => s.type === 'project');
    for (const seed of projectSeeds) {
      const agentFiles = Object.keys(seed.files).filter(
        (path) => path.startsWith('agents/') && path.endsWith('.agent.abl'),
      );
      expect(
        agentFiles.length,
        `${seed.slug}: project template should have multiple agents but found ${agentFiles.length}`,
      ).toBeGreaterThan(1);
    }
  });
});
