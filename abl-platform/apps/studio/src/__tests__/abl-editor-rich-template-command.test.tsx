import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCompileABL,
  mockEditor,
  mockInsertSnippetIntelligently,
  mockModel,
  mockMonaco,
  mockParseLive,
  mockSaveABL,
  mockTemplatePickerProps,
} = vi.hoisted(() => {
  const mockParseLive = vi.fn();
  const mockCompileABL = vi.fn();
  const mockSaveABL = vi.fn();
  const modelValue = {
    current: 'AGENT: Rich_Template_Test\nGOAL: "Test"\nPERSONA: "Test"\n',
  };

  const mockModel = {
    getLineContent: vi.fn(() => '/rich-template'),
    getLineCount: vi.fn(() => modelValue.current.split('\n').length),
    getLineMaxColumn: vi.fn(() => 16),
    getValue: vi.fn(() => modelValue.current),
    isDisposed: vi.fn(() => false),
  };

  const mockEditor = {
    addCommand: vi.fn(),
    executeEdits: vi.fn(),
    focus: vi.fn(),
    getModel: vi.fn(() => mockModel),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 15 })),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn(),
  };

  const mockMonaco = {
    KeyCode: { KeyE: 1, KeyS: 2 },
    KeyMod: { CtrlCmd: 1 << 11 },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      defineTheme: vi.fn(),
      setModelMarkers: vi.fn(),
      setTheme: vi.fn(),
    },
    languages: {
      CompletionItemKind: {
        Class: 1,
        Field: 2,
        Function: 3,
        Keyword: 4,
        Module: 5,
        Text: 6,
        Value: 7,
      },
      register: vi.fn(),
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
      setMonarchTokensProvider: vi.fn(),
    },
  };

  const mockInsertSnippetIntelligently = vi.fn(() => ({
    success: true,
    insertedAtLine: 1,
    message: 'Inserted at cursor (no target section defined)',
  }));
  const mockTemplatePickerProps = {
    current: null as null | {
      open: boolean;
      initialTab?: string;
      onInsert: (snippet: string) => void;
    },
  };

  return {
    mockCompileABL,
    mockEditor,
    mockInsertSnippetIntelligently,
    mockModel,
    mockMonaco,
    mockParseLive,
    mockSaveABL,
    mockTemplatePickerProps,
  };
});

vi.mock('@monaco-editor/react', () => {
  const ReactModule = require('react') as typeof import('react');

  return {
    default: ({
      onMount,
    }: {
      onMount?: (editor: typeof mockEditor, monaco: typeof mockMonaco) => void;
    }) => {
      ReactModule.useEffect(() => {
        onMount?.(mockEditor, mockMonaco);
      }, [onMount]);

      return ReactModule.createElement('div', { 'data-testid': 'mock-monaco-editor' });
    },
  };
});

vi.mock('@abl/language-service', () => ({
  getCompletions: vi.fn(() => []),
  getDocumentSymbols: vi.fn(() => []),
  getHoverInfo: vi.fn(() => null),
}));

vi.mock('@/hooks/useABLParsing', () => ({
  useABLParsing: () => ({
    parseLive: mockParseLive,
    compileABL: mockCompileABL,
    saveABL: mockSaveABL,
  }),
}));

vi.mock('@/components/abl/commands/useMonacoCommands', () => ({
  useMonacoCommands: () => ({
    setup: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('@/components/abl/commands/IntelligentInsertion', () => ({
  insertSnippetIntelligently: mockInsertSnippetIntelligently,
}));

vi.mock('@/components/abl/ToolPickerDialog', () => ({
  ToolPickerDialog: () => null,
}));

vi.mock('@/components/abl/ABLSymbolTree', () => ({
  ABLSymbolTree: () => null,
}));

vi.mock('@/components/abl/ABLDiagnosticsPanel', () => ({
  ABLDiagnosticsPanel: () => null,
}));

vi.mock('@/components/abl/pickers/ToolPickerModal', () => ({
  ToolPickerModal: () => null,
}));

vi.mock('@/components/abl/pickers/GuardrailPickerModal', () => ({
  GuardrailPickerModal: () => null,
}));

vi.mock('@/components/abl/pickers/TemplatePickerModal', () => {
  const ReactModule = require('react') as typeof import('react');

  return {
    TemplatePickerModal: (props: {
      open: boolean;
      initialTab?: string;
      onInsert: (snippet: string) => void;
    }) => {
      mockTemplatePickerProps.current = props;
      if (!props.open) return null;

      return ReactModule.createElement(
        'div',
        { 'data-testid': 'template-picker-modal' },
        ReactModule.createElement('span', {}, props.initialTab),
        ReactModule.createElement(
          'button',
          {
            type: 'button',
            onClick: () => props.onInsert('mock_template:\n  DEFAULT: |\n    Hello from template'),
          },
          'Insert mocked template',
        ),
      );
    },
  };
});

vi.mock('@/components/abl/pickers/SimpleConstructModal', () => ({
  SimpleConstructModal: () => null,
}));

vi.mock('@/components/abl/MarkdownEditorModal', () => ({
  MarkdownEditorModal: () => null,
}));

import { ABLEditor } from '@/components/abl/ABLEditor';
import { useEditorStore } from '@/store/editor-store';

describe('ABLEditor /rich-template command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockCompileABL.mockReset();
    mockEditor.addCommand.mockReset();
    mockEditor.executeEdits.mockReset();
    mockEditor.focus.mockReset();
    mockEditor.getPosition.mockReturnValue({ lineNumber: 1, column: 15 });
    mockEditor.onDidChangeCursorPosition.mockReturnValue({ dispose: vi.fn() });
    mockEditor.revealLineInCenter.mockReset();
    mockEditor.setPosition.mockReset();
    mockInsertSnippetIntelligently.mockClear();
    mockTemplatePickerProps.current = null;
    mockModel.getLineContent.mockReturnValue('/rich-template');
    mockModel.getValue.mockReturnValue(
      'AGENT: Rich_Template_Test\nGOAL: "Test"\nPERSONA: "Test"\n',
    );
    mockParseLive.mockReset();
    mockSaveABL.mockReset();

    useEditorStore.setState({
      dslContent: 'AGENT: Rich_Template_Test\nGOAL: "Test"\nPERSONA: "Test"\n',
      originalContent: 'AGENT: Rich_Template_Test\nGOAL: "Test"\nPERSONA: "Test"\n',
      isDirty: false,
      parseErrors: [],
      parseWarnings: [],
      isParsingLive: false,
      compiledIR: null,
      compileErrors: [],
      isCompiling: false,
      diagnostics: [],
      symbols: [],
      showSymbolTree: false,
      showDiagnostics: false,
      currentFilePath: null,
      isSaving: false,
      saveError: null,
      viewMode: 'view',
      commandPaletteOpen: false,
      commandPalettePosition: null,
      commandPaletteSection: null,
    });
  });

  it('opens the insert panel from the command palette and routes supported inserts through intelligent insertion', async () => {
    render(<ABLEditor />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();
    });

    act(() => {
      const state = useEditorStore.getState();
      state.setCommandPaletteSection('root');
      state.setCommandPalettePosition({ top: 64, left: 32 });
      state.setCommandPaletteOpen(true);
    });

    fireEvent.click(screen.getByText('/rich-template'));

    await waitFor(() => {
      expect(screen.getByText('Insert Rich Template')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select Markdown' }));

    await waitFor(() => {
      expect(mockInsertSnippetIntelligently).toHaveBeenCalledWith(
        mockEditor,
        expect.stringContaining('FORMATS:'),
        'rich-template',
        'root',
      );
    });
  });

  it('opens /multiformat in the template picker and preserves the command id for insertion', async () => {
    render(<ABLEditor />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();
    });

    act(() => {
      const state = useEditorStore.getState();
      state.setCommandPaletteSection('root');
      state.setCommandPalettePosition({ top: 64, left: 32 });
      state.setCommandPaletteOpen(true);
    });

    fireEvent.click(screen.getByText('/multiformat'));

    await waitFor(() => {
      expect(screen.getByTestId('template-picker-modal')).toHaveTextContent('multiformat');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert mocked template' }));

    await waitFor(() => {
      expect(mockInsertSnippetIntelligently).toHaveBeenCalledWith(
        mockEditor,
        expect.stringContaining('mock_template:'),
        'multiformat',
        'root',
      );
    });
  });

  it('opens /voice-template on the voice tab', async () => {
    render(<ABLEditor />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();
    });

    act(() => {
      const state = useEditorStore.getState();
      state.setCommandPaletteSection('root');
      state.setCommandPalettePosition({ top: 64, left: 32 });
      state.setCommandPaletteOpen(true);
    });

    fireEvent.click(screen.getByText('/voice-template'));

    await waitFor(() => {
      expect(screen.getByTestId('template-picker-modal')).toHaveTextContent('voice');
    });
  });
});
