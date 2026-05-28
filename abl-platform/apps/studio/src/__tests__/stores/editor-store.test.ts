/**
 * Editor Store Tests
 *
 * Comprehensive tests for the Zustand editor store: DSL content editing,
 * dirty tracking, parse errors/warnings, compile state, file operations,
 * view mode, resetToOriginal, and markSaved.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../store/editor-store';
import type { ParseError } from '../../store/editor-store';

// =============================================================================
// HELPERS
// =============================================================================

function makeParseError(overrides: Partial<ParseError> = {}): ParseError {
  return {
    line: 1,
    column: 0,
    message: 'Unexpected token',
    ...overrides,
  };
}

function resetEditorStore() {
  useEditorStore.setState({
    dslContent: '',
    originalContent: '',
    isDirty: false,
    parseErrors: [],
    parseWarnings: [],
    isParsingLive: false,
    compiledIR: null,
    compileErrors: [],
    isCompiling: false,
    currentFilePath: null,
    isSaving: false,
    saveError: null,
    viewMode: 'view',
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Editor Store', () => {
  beforeEach(() => {
    resetEditorStore();
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useEditorStore.getState();

      expect(state.dslContent).toBe('');
      expect(state.originalContent).toBe('');
      expect(state.isDirty).toBe(false);
      expect(state.parseErrors).toEqual([]);
      expect(state.parseWarnings).toEqual([]);
      expect(state.isParsingLive).toBe(false);
      expect(state.compiledIR).toBeNull();
      expect(state.compileErrors).toEqual([]);
      expect(state.isCompiling).toBe(false);
      expect(state.currentFilePath).toBeNull();
      expect(state.isSaving).toBe(false);
      expect(state.saveError).toBeNull();
      expect(state.viewMode).toBe('view');
    });

    test('all action functions are defined', () => {
      const state = useEditorStore.getState();

      expect(typeof state.setDslContent).toBe('function');
      expect(typeof state.setOriginalContent).toBe('function');
      expect(typeof state.setParseErrors).toBe('function');
      expect(typeof state.setParseWarnings).toBe('function');
      expect(typeof state.setIsParsingLive).toBe('function');
      expect(typeof state.setCompiledIR).toBe('function');
      expect(typeof state.setCompileErrors).toBe('function');
      expect(typeof state.setIsCompiling).toBe('function');
      expect(typeof state.setCurrentFilePath).toBe('function');
      expect(typeof state.setIsSaving).toBe('function');
      expect(typeof state.setSaveError).toBe('function');
      expect(typeof state.setViewMode).toBe('function');
      expect(typeof state.resetToOriginal).toBe('function');
      expect(typeof state.markSaved).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setDslContent() — dirty tracking
  // ---------------------------------------------------------------------------
  describe('setDslContent()', () => {
    test('sets dslContent', () => {
      useEditorStore.getState().setDslContent('AGENT test');

      expect(useEditorStore.getState().dslContent).toBe('AGENT test');
    });

    test('marks isDirty when content differs from original', () => {
      useEditorStore.setState({ originalContent: 'AGENT original' });

      useEditorStore.getState().setDslContent('AGENT modified');

      expect(useEditorStore.getState().isDirty).toBe(true);
    });

    test('marks isDirty as false when content matches original', () => {
      useEditorStore.setState({
        originalContent: 'AGENT same',
        dslContent: 'AGENT different',
        isDirty: true,
      });

      useEditorStore.getState().setDslContent('AGENT same');

      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('handles empty content', () => {
      useEditorStore.setState({ originalContent: '' });

      useEditorStore.getState().setDslContent('');

      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('detects dirty state from empty original', () => {
      useEditorStore.setState({ originalContent: '' });

      useEditorStore.getState().setDslContent('new content');

      expect(useEditorStore.getState().isDirty).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. setOriginalContent()
  // ---------------------------------------------------------------------------
  describe('setOriginalContent()', () => {
    test('sets originalContent and dslContent', () => {
      useEditorStore.getState().setOriginalContent('AGENT booking\nDOMAIN travel');

      const state = useEditorStore.getState();
      expect(state.originalContent).toBe('AGENT booking\nDOMAIN travel');
      expect(state.dslContent).toBe('AGENT booking\nDOMAIN travel');
    });

    test('resets isDirty to false', () => {
      useEditorStore.setState({ isDirty: true });

      useEditorStore.getState().setOriginalContent('fresh content');

      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('clears parse errors and warnings', () => {
      useEditorStore.setState({
        parseErrors: [makeParseError()],
        parseWarnings: [makeParseError({ message: 'warning' })],
      });

      useEditorStore.getState().setOriginalContent('new content');

      expect(useEditorStore.getState().parseErrors).toEqual([]);
      expect(useEditorStore.getState().parseWarnings).toEqual([]);
    });

    test('clears compile errors and compiledIR', () => {
      useEditorStore.setState({
        compileErrors: ['compile error'],
        compiledIR: { some: 'ir' },
      });

      useEditorStore.getState().setOriginalContent('new content');

      expect(useEditorStore.getState().compileErrors).toEqual([]);
      expect(useEditorStore.getState().compiledIR).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Parse errors / warnings
  // ---------------------------------------------------------------------------
  describe('setParseErrors()', () => {
    test('sets parse errors', () => {
      const errors = [
        makeParseError({ line: 1, message: 'Missing keyword' }),
        makeParseError({ line: 5, column: 10, message: 'Unexpected end' }),
      ];

      useEditorStore.getState().setParseErrors(errors);

      expect(useEditorStore.getState().parseErrors).toEqual(errors);
    });

    test('replaces existing errors', () => {
      useEditorStore.getState().setParseErrors([makeParseError()]);
      useEditorStore.getState().setParseErrors([]);

      expect(useEditorStore.getState().parseErrors).toEqual([]);
    });
  });

  describe('setParseWarnings()', () => {
    test('sets parse warnings', () => {
      const warnings = [makeParseError({ message: 'Unused variable' })];

      useEditorStore.getState().setParseWarnings(warnings);

      expect(useEditorStore.getState().parseWarnings).toEqual(warnings);
    });
  });

  describe('setIsParsingLive()', () => {
    test('sets isParsingLive', () => {
      useEditorStore.getState().setIsParsingLive(true);
      expect(useEditorStore.getState().isParsingLive).toBe(true);

      useEditorStore.getState().setIsParsingLive(false);
      expect(useEditorStore.getState().isParsingLive).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Compile state
  // ---------------------------------------------------------------------------
  describe('setCompiledIR()', () => {
    test('sets compiled IR', () => {
      const ir = { agent: 'test', steps: [] };
      useEditorStore.getState().setCompiledIR(ir);

      expect(useEditorStore.getState().compiledIR).toEqual(ir);
    });

    test('clears compiled IR with null', () => {
      useEditorStore.getState().setCompiledIR({ data: true });
      useEditorStore.getState().setCompiledIR(null);

      expect(useEditorStore.getState().compiledIR).toBeNull();
    });
  });

  describe('setCompileErrors()', () => {
    test('sets compile errors', () => {
      useEditorStore.getState().setCompileErrors(['Error 1', 'Error 2']);

      expect(useEditorStore.getState().compileErrors).toEqual(['Error 1', 'Error 2']);
    });

    test('clears compile errors with empty array', () => {
      useEditorStore.getState().setCompileErrors(['error']);
      useEditorStore.getState().setCompileErrors([]);

      expect(useEditorStore.getState().compileErrors).toEqual([]);
    });
  });

  describe('setIsCompiling()', () => {
    test('sets isCompiling', () => {
      useEditorStore.getState().setIsCompiling(true);
      expect(useEditorStore.getState().isCompiling).toBe(true);

      useEditorStore.getState().setIsCompiling(false);
      expect(useEditorStore.getState().isCompiling).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. File state
  // ---------------------------------------------------------------------------
  describe('setCurrentFilePath()', () => {
    test('sets file path', () => {
      useEditorStore.getState().setCurrentFilePath('/agents/booking.abl');

      expect(useEditorStore.getState().currentFilePath).toBe('/agents/booking.abl');
    });

    test('clears file path with null', () => {
      useEditorStore.getState().setCurrentFilePath('/some/path');
      useEditorStore.getState().setCurrentFilePath(null);

      expect(useEditorStore.getState().currentFilePath).toBeNull();
    });
  });

  describe('setIsSaving()', () => {
    test('sets isSaving', () => {
      useEditorStore.getState().setIsSaving(true);
      expect(useEditorStore.getState().isSaving).toBe(true);

      useEditorStore.getState().setIsSaving(false);
      expect(useEditorStore.getState().isSaving).toBe(false);
    });
  });

  describe('setSaveError()', () => {
    test('sets save error', () => {
      useEditorStore.getState().setSaveError('Permission denied');
      expect(useEditorStore.getState().saveError).toBe('Permission denied');
    });

    test('clears save error with null', () => {
      useEditorStore.getState().setSaveError('error');
      useEditorStore.getState().setSaveError(null);
      expect(useEditorStore.getState().saveError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. View mode
  // ---------------------------------------------------------------------------
  describe('setViewMode()', () => {
    test('sets view mode to edit', () => {
      useEditorStore.getState().setViewMode('edit');
      expect(useEditorStore.getState().viewMode).toBe('edit');
    });

    test('sets view mode to view', () => {
      useEditorStore.getState().setViewMode('edit');
      useEditorStore.getState().setViewMode('view');
      expect(useEditorStore.getState().viewMode).toBe('view');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. resetToOriginal()
  // ---------------------------------------------------------------------------
  describe('resetToOriginal()', () => {
    test('restores dslContent to originalContent', () => {
      useEditorStore.setState({
        originalContent: 'AGENT original',
        dslContent: 'AGENT modified',
        isDirty: true,
      });

      useEditorStore.getState().resetToOriginal();

      expect(useEditorStore.getState().dslContent).toBe('AGENT original');
    });

    test('resets isDirty to false', () => {
      useEditorStore.setState({ isDirty: true, originalContent: 'x', dslContent: 'y' });

      useEditorStore.getState().resetToOriginal();

      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('clears parse errors and warnings', () => {
      useEditorStore.setState({
        originalContent: 'content',
        dslContent: 'changed',
        parseErrors: [makeParseError()],
        parseWarnings: [makeParseError({ message: 'warn' })],
      });

      useEditorStore.getState().resetToOriginal();

      expect(useEditorStore.getState().parseErrors).toEqual([]);
      expect(useEditorStore.getState().parseWarnings).toEqual([]);
    });

    test('does not clear compile errors', () => {
      useEditorStore.setState({
        originalContent: 'content',
        dslContent: 'changed',
        compileErrors: ['compile err'],
      });

      useEditorStore.getState().resetToOriginal();

      // resetToOriginal does not touch compileErrors
      expect(useEditorStore.getState().compileErrors).toEqual(['compile err']);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. markSaved()
  // ---------------------------------------------------------------------------
  describe('markSaved()', () => {
    test('sets originalContent to current dslContent', () => {
      useEditorStore.setState({
        dslContent: 'AGENT saved-version',
        originalContent: 'AGENT old-version',
        isDirty: true,
      });

      useEditorStore.getState().markSaved();

      expect(useEditorStore.getState().originalContent).toBe('AGENT saved-version');
    });

    test('resets isDirty to false', () => {
      useEditorStore.setState({ isDirty: true, dslContent: 'saved' });

      useEditorStore.getState().markSaved();

      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('clears saveError', () => {
      useEditorStore.setState({ saveError: 'previous error', dslContent: 'content' });

      useEditorStore.getState().markSaved();

      expect(useEditorStore.getState().saveError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Cross-cutting interactions
  // ---------------------------------------------------------------------------
  describe('cross-cutting interactions', () => {
    test('edit cycle: setOriginalContent -> setDslContent -> markSaved', () => {
      // Load original
      useEditorStore.getState().setOriginalContent('AGENT booking');
      expect(useEditorStore.getState().isDirty).toBe(false);

      // Edit
      useEditorStore.getState().setDslContent('AGENT booking-v2');
      expect(useEditorStore.getState().isDirty).toBe(true);

      // Save
      useEditorStore.getState().markSaved();
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(useEditorStore.getState().originalContent).toBe('AGENT booking-v2');

      // Further edit matches saved content
      useEditorStore.getState().setDslContent('AGENT booking-v2');
      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('edit then reset cycle: setOriginalContent -> edit -> resetToOriginal', () => {
      useEditorStore.getState().setOriginalContent('AGENT original');
      useEditorStore.getState().setDslContent('AGENT modified');
      expect(useEditorStore.getState().isDirty).toBe(true);

      useEditorStore.getState().resetToOriginal();
      expect(useEditorStore.getState().dslContent).toBe('AGENT original');
      expect(useEditorStore.getState().isDirty).toBe(false);
    });

    test('full workflow: load -> edit -> parse error -> fix -> compile -> save', () => {
      // Load file
      useEditorStore.getState().setOriginalContent('AGENT test');
      useEditorStore.getState().setCurrentFilePath('/test.abl');

      // Edit with errors
      useEditorStore.getState().setDslContent('AGENT test\nINVALID');
      useEditorStore
        .getState()
        .setParseErrors([makeParseError({ line: 2, message: 'Invalid keyword' })]);
      expect(useEditorStore.getState().isDirty).toBe(true);
      expect(useEditorStore.getState().parseErrors).toHaveLength(1);

      // Fix the error
      useEditorStore.getState().setDslContent('AGENT test\nDOMAIN travel');
      useEditorStore.getState().setParseErrors([]);

      // Compile
      useEditorStore.getState().setIsCompiling(true);
      useEditorStore.getState().setCompiledIR({ agent: 'test', domain: 'travel' });
      useEditorStore.getState().setIsCompiling(false);

      // Save
      useEditorStore.getState().setIsSaving(true);
      useEditorStore.getState().markSaved();
      useEditorStore.getState().setIsSaving(false);

      const state = useEditorStore.getState();
      expect(state.isDirty).toBe(false);
      expect(state.parseErrors).toEqual([]);
      expect(state.compiledIR).not.toBeNull();
      expect(state.isSaving).toBe(false);
      expect(state.saveError).toBeNull();
    });
  });
});
