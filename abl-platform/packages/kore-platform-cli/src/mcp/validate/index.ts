/**
 * ABL Validation
 *
 * Validates .agent.abl files using the @abl/core parser.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';

// =============================================================================
// TYPES
// =============================================================================

export interface ValidationError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface ValidationWarning {
  file: string;
  line: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  fileCount: number;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate a single ABL file content string.
 * Uses a lightweight check since @abl/core may not be available at runtime.
 */
export function validateABLContent(
  content: string,
  filename: string,
): {
  errors: ValidationError[];
  warnings: ValidationWarning[];
} {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const lines = content.split('\n');

  let hasAgentOrSupervisor = false;
  let hasGoal = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      trimmed.startsWith('AGENT:') ||
      trimmed.startsWith('agent:') ||
      trimmed.startsWith('SUPERVISOR:') ||
      trimmed.startsWith('supervisor:')
    ) {
      hasAgentOrSupervisor = true;
      const name = trimmed.split(':')[1]?.trim();
      if (!name) {
        errors.push({
          file: filename,
          line: i + 1,
          column: trimmed.indexOf(':') + 2,
          message: 'AGENT/SUPERVISOR declaration must have a name',
        });
      }
    }

    if (trimmed.startsWith('GOAL:') || trimmed.startsWith('goal:')) {
      hasGoal = true;
    }

    if (trimmed.startsWith('MODE:') || trimmed.startsWith('mode:')) {
      const mode = trimmed.substring(5).trim().toLowerCase();
      if (mode !== 'reasoning' && mode !== 'scripted') {
        errors.push({
          file: filename,
          line: i + 1,
          column: 6,
          message: `Invalid MODE: "${mode}". Must be "reasoning" or "scripted"`,
        });
      }
    }

    // Check for common syntax issues
    if (
      (trimmed.startsWith('HANDOFF:') || trimmed.startsWith('handoff:')) &&
      trimmed !== 'HANDOFF:' &&
      trimmed !== 'handoff:'
    ) {
      warnings.push({
        file: filename,
        line: i + 1,
        message: 'HANDOFF: section header should be on its own line',
      });
    }

    // Validate TOOLS syntax: name(params) -> return
    if (trimmed.match(/^\w+\(/) && !trimmed.includes('->')) {
      // Check if we're in a TOOLS section (look back for TOOLS:)
      let inToolsSection = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (prev === 'TOOLS:' || prev === 'tools:') {
          inToolsSection = true;
          break;
        }
        if (prev.match(/^[A-Za-z_]+:$/) && prev !== 'TOOLS:' && prev !== 'tools:') break;
      }
      if (inToolsSection) {
        errors.push({
          file: filename,
          line: i + 1,
          column: 0,
          message: `Tool definition missing return type: "${trimmed}". Expected: name(params) -> return_type`,
        });
      }
    }
  }

  if (!hasAgentOrSupervisor) {
    errors.push({
      file: filename,
      line: 1,
      column: 0,
      message: 'Missing required AGENT: or SUPERVISOR: declaration',
    });
  }

  if (!hasGoal) {
    warnings.push({
      file: filename,
      line: 1,
      message: 'Missing GOAL: section (recommended)',
    });
  }

  return { errors, warnings };
}

/**
 * Validate ABL files in a directory
 */
export function validateABLFiles(dir: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let fileCount = 0;

  // Find all .agent.abl files
  const files = findABLFiles(dir);

  for (const file of files) {
    fileCount++;
    try {
      const content = readFileSync(file, 'utf-8');
      const result = validateABLContent(content, file);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    } catch (err) {
      errors.push({
        file,
        line: 0,
        column: 0,
        message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    fileCount,
    errors,
    warnings,
  };
}

/**
 * Find all .agent.abl files recursively in a directory
 */
function findABLFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir) as string[];

    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...findABLFiles(fullPath));
      } else if (entry.endsWith('.agent.abl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return files;
}
