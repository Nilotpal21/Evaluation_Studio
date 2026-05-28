/**
 * Manifest Validator — validates project.json schema and references
 */

import type { ProjectManifest } from '../types.js';

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a project manifest for required fields and internal consistency.
 */
export function validateManifest(
  manifest: ProjectManifest,
  availableAgentFiles: Set<string>,
  availableToolFiles: Set<string>,
): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!manifest.name) errors.push('manifest.name is required');
  if (!manifest.slug) errors.push('manifest.slug is required');
  if (!manifest.abl_version) errors.push('manifest.abl_version is required');

  // Validate agent entries reference actual files
  if (manifest.agents) {
    for (const [name, agent] of Object.entries(manifest.agents)) {
      if (!agent.path) {
        errors.push(`Agent "${name}": missing path`);
        continue;
      }
      if (!availableAgentFiles.has(agent.path)) {
        errors.push(`Agent "${name}": referenced file "${agent.path}" not found`);
      }
    }
  }

  // Validate tool entries reference actual files
  if (manifest.tools) {
    for (const [name, tool] of Object.entries(manifest.tools)) {
      if (!tool.path) {
        errors.push(`Tool "${name}": missing path`);
        continue;
      }
      if (!availableToolFiles.has(tool.path)) {
        errors.push(`Tool "${name}": referenced file "${tool.path}" not found`);
      }
    }
  }

  // Validate entry_agent exists
  if (manifest.entry_agent && manifest.agents) {
    if (!manifest.agents[manifest.entry_agent]) {
      warnings.push(`Entry agent "${manifest.entry_agent}" not found in agents`);
    }
  }

  // Validate dependency references
  if (manifest.dependencies?.agent_references && manifest.agents) {
    const agentNames = new Set(Object.keys(manifest.agents));
    for (const ref of manifest.dependencies.agent_references) {
      if (!agentNames.has(ref.from)) {
        warnings.push(`Dependency from unknown agent "${ref.from}"`);
      }
      if (!agentNames.has(ref.to)) {
        warnings.push(`Dependency to unknown agent "${ref.to}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
