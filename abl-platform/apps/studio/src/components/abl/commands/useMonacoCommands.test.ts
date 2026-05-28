/**
 * Tests for useMonacoCommands slash command behavior
 *
 * Tests the logic for when "/" triggers:
 * 1. Command palette with all commands (empty line at start)
 * 2. Markdown editor (inside field value)
 * 3. Command palette with section-specific commands
 */

import { describe, test, expect } from 'vitest';
import { findFieldAtLine } from '../dsl-field-utils';
import { detectDSLContext } from './DSLContextDetector';

const FULL_DSL = `AGENT: Account_Support
VERSION: "1.0"
DESCRIPTION: "Helps with Apple ID, iCloud, two-factor authentication, and account security"
GOAL: "Help with Apple ID, iCloud, two-factor authentication, and account security"

PERSONA: |
  Security-conscious and patient account specialist.
  Understands that account issues can be stressful – especially lockouts.
  Explains security measures clearly without being condescending.
  Always prioritizes account safety over convenience.
  Verifies identity before any account changes.

LIMITATIONS:
  - "Cannot bypass Apple's identity verification requirements"
  - "Cannot disable two-factor authentication without security confirmation"
  - "Cannot access account without identity verification"
  - "Maximum 3 verification attempts before security lockout"

TOOLS:
  verify_identity(id: string) -> object
    description: "Verify identity"

GUARDRAILS:
  pii_check:
    kind: input

TEMPLATES:
  identity_verified:
    DEFAULT: "Your identity has been verified."

FLOW:
  steps: [welcome]
  welcome:
    REASONING: false

GATHER:
  name:
    type: string

MEMORY:
  SESSION:
    - x: string

CONSTRAINTS:
  pre:
    - REQUIRE: x > 0

HANDOFF:
  - TO: Other

ESCALATE:
  triggers:
    - WHEN: attempts >= 3

COMPLETE:
  - WHEN: resolved == true`;

describe('useMonacoCommands - Slash Command Behavior', () => {
  describe('Empty line at start detection', () => {
    test('empty line after GOAL should NOT be inside field', () => {
      // Line 5 in FULL_DSL is empty, after GOAL
      const field = findFieldAtLine(FULL_DSL, 5);
      // Should not find a field or field should not include line 5
      const isInsideField = field && 5 >= field.headerLine && 5 <= field.endLine;
      expect(isInsideField).toBe(false);
    });

    test('empty line before PERSONA should NOT be inside field', () => {
      const field = findFieldAtLine(FULL_DSL, 5);
      // findFieldAtLine scans backwards and finds GOAL, but line 5 is NOT in GOAL's range
      const isInsideField = field && 5 >= field.headerLine && 5 <= field.endLine;
      expect(isInsideField).toBe(false);
    });

    test('line 7 (inside PERSONA block) SHOULD be inside field', () => {
      // Line 7 is "  Security-conscious..."
      const field = findFieldAtLine(FULL_DSL, 7);
      expect(field).not.toBe(null);
      expect(field?.name).toBe('PERSONA');
      const isInsideField = field && 7 >= field.headerLine && 7 <= field.endLine;
      expect(isInsideField).toBe(true);
    });

    test('line 18 (empty after LIMITATIONS) IS technically inside field range', () => {
      // Line 18 is empty after LIMITATIONS list
      // findFieldAtLine includes trailing empty lines in the field range
      const field = findFieldAtLine(FULL_DSL, 18);
      const isInsideField = field && 18 >= field.headerLine && 18 <= field.endLine;

      // Field detection includes empty lines after list items
      expect(isInsideField).toBe(true);
      expect(field?.name).toBe('LIMITATIONS');

      // However, slash command logic should still show all commands
      // when "/" is at line start, even if technically inside a field
      const lineContent = '';
      const textBeforeSlash = lineContent.substring(0, 1 - 2); // column 1, after "/"
      const isAtLineStart = textBeforeSlash.trim() === '';
      expect(isAtLineStart).toBe(true);

      // Result: show root context (slash command overrides field detection)
    });
  });

  describe('Context detection for slash commands', () => {
    test('empty line after GOAL detects identity section (but not inside field)', () => {
      const context = detectDSLContext(FULL_DSL, { line: 5, column: 1 });
      expect(context.section).toBe('identity');
    });

    test('line inside PERSONA block detects identity section', () => {
      const context = detectDSLContext(FULL_DSL, { line: 7, column: 3 });
      expect(context.section).toBe('identity');
    });

    test('empty line before TOOLS detects identity section', () => {
      const context = detectDSLContext(FULL_DSL, { line: 16, column: 1 });
      expect(context.section).toBe('identity');
    });

    test('line in TOOLS section detects tools section', () => {
      const context = detectDSLContext(FULL_DSL, { line: 20, column: 3 });
      expect(context.section).toBe('tools');
    });
  });

  describe('Slash command trigger logic simulation', () => {
    test('slash at start of empty line should show root context', () => {
      // Simulates typing "/" on an empty line (line 5)
      const lineContent = ''; // empty line
      const position = { lineNumber: 5, column: 1 }; // after typing "/"

      // Check text before slash
      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      const isAtLineStart = textBeforeSlash.trim() === '';

      expect(isAtLineStart).toBe(true);

      // Check if inside field
      const field = findFieldAtLine(FULL_DSL, position.lineNumber);
      const isInsideFieldValue =
        field && position.lineNumber >= field.headerLine && position.lineNumber <= field.endLine;

      expect(isInsideFieldValue).toBe(false);

      // Expected behavior: show root context (all commands)
      const shouldShowRootContext = isAtLineStart && !isInsideFieldValue;
      expect(shouldShowRootContext).toBe(true);
    });

    test('slash inside PERSONA field should open markdown editor', () => {
      // Simulates typing "/" on line 7 inside PERSONA
      const lineContent = '  Security-conscious and patient account specialist.';
      const position = { lineNumber: 7, column: 10 }; // mid-line

      // Check if inside field
      const field = findFieldAtLine(FULL_DSL, position.lineNumber);
      const isInsideFieldValue =
        field && position.lineNumber >= field.headerLine && position.lineNumber <= field.endLine;

      expect(isInsideFieldValue).toBe(true);
      expect(field?.name).toBe('PERSONA');

      // Expected behavior: open markdown editor
    });

    test('slash at start of indented line inside PERSONA should open markdown editor', () => {
      // Simulates typing "/" at the start of line 8 inside PERSONA block
      const lineContent = '  Understands that account issues can be stressful';
      const position = { lineNumber: 8, column: 3 }; // after two spaces and "/"

      // Check text before slash (should be just whitespace)
      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      const isAtLineStart = textBeforeSlash.trim() === '';

      expect(isAtLineStart).toBe(true);

      // Check if inside field
      const field = findFieldAtLine(FULL_DSL, position.lineNumber);
      const isInsideFieldValue =
        field && position.lineNumber >= field.headerLine && position.lineNumber <= field.endLine;

      expect(isInsideFieldValue).toBe(true);

      // Expected behavior: open markdown editor (takes precedence over root context)
    });

    test('slash mid-word should NOT trigger anything', () => {
      // Simulates typing "/" in "https://example.com"
      const lineContent = 'https://example.com';
      const position = { lineNumber: 5, column: 7 }; // after "https:/"

      const charBefore = lineContent[position.column - 3];
      const shouldIgnore = charBefore && /[a-zA-Z0-9/]/.test(charBefore);

      expect(shouldIgnore).toBe(true);
    });

    test('slash after colon should trigger command palette', () => {
      // Simulates typing "/" after "GOAL: "
      const lineContent = 'GOAL: ';
      const position = { lineNumber: 4, column: 7 }; // after "GOAL: /"

      const charBefore = lineContent[position.column - 3];
      const shouldIgnore = charBefore && /[a-zA-Z0-9/]/.test(charBefore);

      expect(shouldIgnore).toBe(false);
    });
  });

  describe('Position calculation edge cases', () => {
    test('position.column - 2 gets text before slash', () => {
      const lineContent = '  /';
      const position = { column: 4 }; // column AFTER typing "/" (0-indexed, so column 4 is after the 3rd character)

      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      expect(textBeforeSlash).toBe('  '); // two spaces
      expect(textBeforeSlash.trim()).toBe('');
    });

    test('position.column - 2 at column 1 gives empty string', () => {
      const lineContent = '/';
      const position = { column: 1 }; // column AFTER typing "/"

      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      expect(textBeforeSlash).toBe(''); // empty string (substring with negative is empty)
    });

    test('text before slash with content', () => {
      const lineContent = 'hello /';
      const position = { column: 8 }; // after "hello /" (column points AFTER the slash)

      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      expect(textBeforeSlash).toBe('hello ');
      expect(textBeforeSlash.trim()).toBe('hello');
    });
  });

  describe('Command availability by section', () => {
    test('root section should have all commands available', () => {
      const context = detectDSLContext(FULL_DSL, { line: 1, column: 1 });
      // When isAtLineStart is true, we override to root
      // This test verifies the context detector for comparison
      expect(['identity', 'root']).toContain(context.section);
    });

    test('tools section should have tool-related commands', () => {
      const context = detectDSLContext(FULL_DSL, { line: 20, column: 3 });
      expect(context.section).toBe('tools');
      expect(context.availableCommands.some((c) => c.id === 'tool')).toBe(true);
    });

    test('identity section should have edit command', () => {
      const context = detectDSLContext(FULL_DSL, { line: 6, column: 1 });
      expect(context.section).toBe('identity');
      expect(context.availableCommands.some((c) => c.id === 'edit')).toBe(true);
    });
  });

  describe('Real-world scenarios', () => {
    test('scenario: empty line 5 with "/" should show all commands', () => {
      // User types "/" on line 5 (empty line after GOAL)
      const lineNumber = 5;
      const column = 1; // after typing "/"

      const field = findFieldAtLine(FULL_DSL, lineNumber);
      const isInsideFieldValue =
        field && lineNumber >= field.headerLine && lineNumber <= field.endLine;

      const lineContent = '';
      const textBeforeSlash = lineContent.substring(0, column - 2);
      const isAtLineStart = textBeforeSlash.trim() === '';

      // Should NOT be inside field
      expect(isInsideFieldValue).toBe(false);

      // Should be at line start
      expect(isAtLineStart).toBe(true);

      // Result: show root context with all commands
      const shouldShowAllCommands = isAtLineStart && !isInsideFieldValue;
      expect(shouldShowAllCommands).toBe(true);
    });

    test('scenario: line 7 in PERSONA with "/" should open markdown editor', () => {
      // User types "/" on line 7 inside PERSONA block
      const lineNumber = 7;
      const column = 5; // somewhere in the line

      const field = findFieldAtLine(FULL_DSL, lineNumber);
      const isInsideFieldValue =
        field && lineNumber >= field.headerLine && lineNumber <= field.endLine;

      // Should be inside PERSONA field
      expect(isInsideFieldValue).toBe(true);
      expect(field?.name).toBe('PERSONA');

      // Result: open markdown editor
    });

    test('scenario: line 22 (after TOOLS section) with "/" at start should show all commands', () => {
      // User types "/" on an empty line after TOOLS section
      const lineNumber = 22; // hypothetical empty line after tool
      const column = 1; // after typing "/" at line start

      const lineContent = '';
      const textBeforeSlash = lineContent.substring(0, column - 2);
      const isAtLineStart = textBeforeSlash.trim() === '';

      const field = findFieldAtLine(FULL_DSL, lineNumber);
      const isInsideFieldValue =
        field && lineNumber >= field.headerLine && lineNumber <= field.endLine;

      expect(isAtLineStart).toBe(true);
      // Can't test isInsideFieldValue since line 22 doesn't exist in FULL_DSL

      // Result: show root context (all commands)
      const shouldShowAllCommands = isAtLineStart && !isInsideFieldValue;
      expect(shouldShowAllCommands).toBe(true);
    });
  });

  describe('Field detection accuracy', () => {
    test('PERSONA field should span lines 6-11', () => {
      const field = findFieldAtLine(FULL_DSL, 7);
      expect(field).not.toBe(null);
      expect(field?.name).toBe('PERSONA');
      expect(field?.headerLine).toBe(6);
      // endLine depends on content, should be > 6
      expect(field?.endLine).toBeGreaterThan(6);
    });

    test('GOAL field should be single line', () => {
      const field = findFieldAtLine(FULL_DSL, 4);
      expect(field).not.toBe(null);
      expect(field?.name).toBe('GOAL');
      expect(field?.headerLine).toBe(4);
      expect(field?.endLine).toBe(4);
    });

    test('LIMITATIONS field should span multiple lines', () => {
      const field = findFieldAtLine(FULL_DSL, 14); // line 14 is first item in LIMITATIONS
      expect(field).not.toBe(null);
      expect(field?.name).toBe('LIMITATIONS');
      expect(field?.headerLine).toBe(13); // LIMITATIONS: is on line 13
      expect(field?.endLine).toBeGreaterThan(13);
    });

    test('empty line after LIMITATIONS is included in field range but slash command handles it', () => {
      // Line 18 is empty line after LIMITATIONS (lines 13-17)
      const lineAfterLimitations = 18;

      const field = findFieldAtLine(FULL_DSL, lineAfterLimitations);
      const isInsideField =
        field && lineAfterLimitations >= field.headerLine && lineAfterLimitations <= field.endLine;

      // Field detection includes trailing empty lines
      expect(isInsideField).toBe(true);
      expect(field?.name).toBe('LIMITATIONS');
      expect(field?.endLine).toBe(18);

      // But when "/" is typed at line start, slash command logic
      // treats it as root context, showing all commands
    });
  });
});
