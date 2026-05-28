/**
 * ABL Expression Migration Tool
 *
 * Scans ABL DSL content and migrates all expression contexts
 * (REQUIRE conditions, WHEN conditions, SET expressions, IF conditions, CHECK expressions)
 * from legacy ABL syntax to CEL syntax.
 *
 * Supported expression contexts:
 * - REQUIRE: "expression"  (constraint conditions)
 * - WHEN: expression       (completion conditions, handoff/delegate conditions)
 * - SET: var = expression  (variable assignments in flow steps)
 * - CHECK: expression      (step-level constraint checks)
 * - IF: expression         (conditional branches in ON_INPUT)
 */

import {
  isLegacyExpression,
  migrateExpression,
} from '../platform/constructs/expression-migrator.js';

export interface MigrationChange {
  /** 1-based line number where the change occurs */
  line: number;
  /** Expression context description (e.g., "constraint condition", "completion condition") */
  context: string;
  /** Original legacy ABL expression */
  original: string;
  /** Migrated CEL expression */
  migrated: string;
}

export interface MigrationResult {
  /** The DSL content with all expressions migrated to CEL */
  migratedContent: string;
  /** List of individual changes made */
  changes: MigrationChange[];
  /** Any errors encountered during migration */
  errors: string[];
}

/**
 * Migrate all expressions in an ABL DSL file from legacy ABL syntax to CEL syntax.
 *
 * Scans for expression contexts in the DSL content and applies the expression
 * migrator to each one. Non-expression lines are preserved unchanged.
 */
export function migrateAgentExpressions(dslContent: string): MigrationResult {
  const lines = dslContent.split('\n');
  const changes: MigrationChange[] = [];
  const errors: string[] = [];
  const migratedLines = [...lines];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // -----------------------------------------------------------------------
    // 1. Constraint conditions: REQUIRE: "expr" or - REQUIRE: "expr"
    //    Also handles: REQUIRE "expr" (without colon) and REQUIRE expr (unquoted)
    // -----------------------------------------------------------------------
    const requireQuotedMatch = trimmed.match(/^-?\s*REQUIRE:\s*"(.+)"$/);
    if (requireQuotedMatch) {
      const expr = requireQuotedMatch[1];
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(`"${expr}"`, `"${migrated}"`);
          changes.push({ line: i + 1, context: 'constraint condition', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate constraint condition: ${String(e)}`);
        }
      }
      continue;
    }

    // REQUIRE without quotes (e.g., "- REQUIRE num_guests <= 10")
    const requireUnquotedMatch = trimmed.match(/^-?\s*REQUIRE\s+(.+)$/);
    if (requireUnquotedMatch) {
      const expr = requireUnquotedMatch[1].trim();
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(expr, migrated);
          changes.push({ line: i + 1, context: 'constraint condition', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate constraint condition: ${String(e)}`);
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // 2. Completion / handoff / delegate conditions: WHEN: expression
    // -----------------------------------------------------------------------
    const whenMatch = trimmed.match(/^-?\s*WHEN:\s*(.+)$/);
    if (whenMatch) {
      const expr = whenMatch[1].trim();
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(expr, migrated);
          changes.push({ line: i + 1, context: 'completion condition', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate completion condition: ${String(e)}`);
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // 3. SET assignments: SET: var = expression
    // -----------------------------------------------------------------------
    const setMatch = trimmed.match(/^SET:\s*(\w+)\s*=\s*(.+)$/);
    if (setMatch) {
      const expr = setMatch[2].trim();
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(expr, migrated);
          changes.push({ line: i + 1, context: 'set expression', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate set expression: ${String(e)}`);
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // 4. CHECK: expression (step-level constraint checks)
    // -----------------------------------------------------------------------
    const checkMatch = trimmed.match(/^CHECK:\s*(.+)$/);
    if (checkMatch) {
      const expr = checkMatch[1].trim();
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(expr, migrated);
          changes.push({ line: i + 1, context: 'check expression', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate check expression: ${String(e)}`);
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // 5. IF: expression (conditional branches in ON_INPUT)
    // -----------------------------------------------------------------------
    const ifMatch = trimmed.match(/^-?\s*IF:\s*(.+)$/);
    if (ifMatch) {
      const expr = ifMatch[1].trim();
      if (isLegacyExpression(expr)) {
        try {
          const migrated = migrateExpression(expr);
          migratedLines[i] = line.replace(expr, migrated);
          changes.push({ line: i + 1, context: 'if condition', original: expr, migrated });
        } catch (e) {
          errors.push(`Line ${i + 1}: Failed to migrate if condition: ${String(e)}`);
        }
      }
      continue;
    }
  }

  return {
    migratedContent: migratedLines.join('\n'),
    changes,
    errors,
  };
}
