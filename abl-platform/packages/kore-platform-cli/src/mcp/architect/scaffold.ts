/**
 * Project Scaffolding
 *
 * Creates the complete project directory structure with ABL files and documentation.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import type { ArchitectureSpec, GenerateResult, GapReport } from './types.js';
import { generateABL } from './generate.js';
import {
  generateReadme,
  generateArchitectureDoc,
  generateBestPracticesDoc,
  generateLimitationsDoc,
  generateDeploymentDoc,
} from './templates.js';

// =============================================================================
// SCAFFOLD PROJECT
// =============================================================================

/**
 * Create a complete project directory with ABL files and documentation.
 */
export function scaffoldProject(spec: ArchitectureSpec, outputDir: string): GenerateResult {
  const projectDir = join(outputDir, spec.projectName);
  const filesCreated: string[] = [];

  // Create directories
  mkdirSync(join(projectDir, 'docs'), { recursive: true });

  if (spec.topology !== 'single-agent') {
    mkdirSync(join(projectDir, 'agents'), { recursive: true });
  }

  // Generate ABL files
  const ablFiles = generateABL(spec);
  for (const [relativePath, content] of ablFiles) {
    const fullPath = join(projectDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    filesCreated.push(relativePath);
  }

  // Generate documentation
  const docs = generateDocs(spec);
  for (const [relativePath, content] of docs) {
    const fullPath = join(projectDir, relativePath);
    writeFileSync(fullPath, content, 'utf-8');
    filesCreated.push(relativePath);
  }

  const agentCount = ablFiles.size;
  const summary = `Created ${spec.topology} project "${spec.projectName}" with ${agentCount} agent file(s) and ${docs.size} doc file(s)`;

  return {
    projectDir,
    filesCreated,
    summary,
  };
}

// =============================================================================
// SCAFFOLD DOCS ONLY
// =============================================================================

/**
 * Generate only documentation files for an architecture spec.
 */
export function scaffoldDocs(spec: ArchitectureSpec, outputDir: string): GenerateResult {
  const projectDir = join(outputDir, spec.projectName);
  const filesCreated: string[] = [];

  mkdirSync(join(projectDir, 'docs'), { recursive: true });

  const docs = generateDocs(spec);
  for (const [relativePath, content] of docs) {
    const fullPath = join(projectDir, relativePath);
    writeFileSync(fullPath, content, 'utf-8');
    filesCreated.push(relativePath);
  }

  return {
    projectDir,
    filesCreated,
    summary: `Generated ${docs.size} documentation file(s) for "${spec.projectName}"`,
  };
}

// =============================================================================
// INTERNAL
// =============================================================================

function generateDocs(spec: ArchitectureSpec): Map<string, string> {
  const docs = new Map<string, string>();

  docs.set('README.md', generateReadme(spec));
  docs.set('docs/architecture.md', generateArchitectureDoc(spec));
  docs.set('docs/best-practices.md', generateBestPracticesDoc());
  docs.set('docs/limitations.md', generateLimitationsDoc(spec.gapReport));
  docs.set('docs/deployment.md', generateDeploymentDoc(spec));

  return docs;
}
