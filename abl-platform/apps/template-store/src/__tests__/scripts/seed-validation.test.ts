/**
 * Seed Template Validation — Regression Tests
 *
 * Validates that seed template ABL content is import-pipeline-compatible.
 * These tests prevent regressions of Bug 2 (ABL syntax format) by running
 * seed content through the same validation the import pipeline uses.
 *
 * TC-TS-134: Seed ABL files pass validateAgentSyntax
 * TC-TS-135: Seed bundles pass full validateImport (syntax + dependency graph)
 * TC-TS-139: Invalid ABL syntax (missing colon) produces blocking syntax error
 */

import { describe, it, expect } from 'vitest';
import { validateAgentSyntax, validateImport } from '@agent-platform/project-io/import';
import { buildSeedTemplates } from '../../scripts/seed-templates.js';

// ─── TC-TS-134: All seed agent ABL files pass validateAgentSyntax ─────────

describe('TC-TS-134: Seed ABL files pass import-validator syntax validation', () => {
  const seedTemplates = buildSeedTemplates();

  it('buildSeedTemplates returns at least one template', () => {
    expect(seedTemplates.length).toBeGreaterThan(0);
  });

  it('every seed template has at least one agent ABL file', () => {
    for (const template of seedTemplates) {
      const ablFiles = Object.keys(template.files).filter((path) =>
        path.match(/^agents\/.*\.agent\.abl$/),
      );
      expect(ablFiles.length, `${template.slug} should have agent ABL files`).toBeGreaterThan(0);
    }
  });

  it('all seed agent ABL files pass validateAgentSyntax with zero errors', () => {
    for (const template of seedTemplates) {
      for (const [filePath, content] of Object.entries(template.files)) {
        if (!filePath.match(/^agents\/.*\.agent\.abl$/)) continue;

        const errors = validateAgentSyntax(filePath, content);
        expect(
          errors,
          `${template.slug} / ${filePath} should have zero syntax errors but got: ${JSON.stringify(errors)}`,
        ).toHaveLength(0);
      }
    }
  });
});

// ─── TC-TS-135: Seed bundles pass full validateImport (syntax + deps) ──────

describe('TC-TS-135: Seed bundles pass full import validation', () => {
  const seedTemplates = buildSeedTemplates();

  it('all seed template bundles pass validateImport with zero syntax errors and valid dependencies', () => {
    for (const template of seedTemplates) {
      // Separate agent files and tool files from the bundle
      const agentFiles = new Map<string, string>();
      const toolFiles = new Map<string, string>();

      for (const [filePath, content] of Object.entries(template.files)) {
        if (filePath.match(/^agents\/.*\.agent\.abl$/)) {
          agentFiles.set(filePath, content);
        } else if (filePath.match(/^tools\/.*\.tools\.abl$/)) {
          toolFiles.set(filePath, content);
        }
      }

      const result = validateImport(agentFiles, toolFiles);

      expect(
        result.syntaxErrors,
        `${template.slug} should have zero syntax errors but got: ${JSON.stringify(result.syntaxErrors)}`,
      ).toHaveLength(0);

      expect(result.valid, `${template.slug} validateImport should return valid=true`).toBe(true);
    }
  });

  it('each seed template has a valid project.json manifest', () => {
    for (const template of seedTemplates) {
      const manifestContent = template.files['project.json'];
      expect(manifestContent, `${template.slug} should have a project.json file`).toBeDefined();

      // Verify it is valid JSON
      let manifest: Record<string, unknown>;
      expect(() => {
        manifest = JSON.parse(manifestContent);
      }, `${template.slug}/project.json should be valid JSON`).not.toThrow();

      manifest = JSON.parse(manifestContent);

      // Verify required manifest fields
      expect(manifest).toHaveProperty('format_version');
      expect(manifest).toHaveProperty('name');
      expect(manifest).toHaveProperty('entry_agent');
      expect(manifest).toHaveProperty('agents');

      // Verify every agent referenced in manifest has a corresponding ABL file
      const agents = manifest.agents as Record<string, { path: string }>;
      for (const [agentName, agentMeta] of Object.entries(agents)) {
        expect(
          template.files[agentMeta.path],
          `${template.slug}: agent "${agentName}" references path "${agentMeta.path}" which should exist in files`,
        ).toBeDefined();
      }
    }
  });
});

// ─── TC-TS-139: Invalid ABL syntax produces blocking syntax error ──────────

describe('TC-TS-139: Invalid ABL syntax detection', () => {
  it('ABL file with missing colon (old format "AGENT supervisor") produces syntax error', () => {
    // This is the exact bug we hit: seed used "AGENT supervisor" instead of "AGENT: supervisor"
    const badContent = 'AGENT supervisor\n  MODEL gpt-4o\n  GOAL\n    Handle requests';
    const errors = validateAgentSyntax('agents/bad.agent.abl', badContent);

    expect(errors.length).toBeGreaterThan(0);
    // The error message should indicate the expected format
    const errorMessages = errors.map((e) => e.message).join(' ');
    expect(errorMessages).toMatch(/AGENT:|SUPERVISOR:|agent:|supervisor:/i);
  });

  it('ABL file with correct colon format "AGENT: supervisor" passes validation', () => {
    const goodContent = 'AGENT: supervisor\n  MODEL gpt-4o\n  GOAL\n    Handle requests';
    const errors = validateAgentSyntax('agents/good.agent.abl', goodContent);

    expect(errors).toHaveLength(0);
  });

  it('empty ABL file produces syntax error', () => {
    const errors = validateAgentSyntax('agents/empty.agent.abl', '');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/empty/i);
  });

  it('ABL file with only comments (no AGENT header) produces syntax error', () => {
    const content = '# This is a comment\n// Another comment\n/* block comment */';
    const errors = validateAgentSyntax('agents/comments-only.agent.abl', content);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/AGENT:|SUPERVISOR:|agent:|supervisor:/i);
  });

  it('SUPERVISOR: format also passes validation', () => {
    const content = 'SUPERVISOR: main_supervisor\n  MODEL gpt-4o\n  GOAL\n    Route requests';
    const errors = validateAgentSyntax('agents/supervisor.agent.abl', content);

    expect(errors).toHaveLength(0);
  });
});
