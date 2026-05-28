/**
 * Editor Store
 *
 * Manages ABL editor state including content, parse errors, and compiled IR.
 */

import { create } from 'zustand';
import type { Diagnostic, DocumentSymbol } from '@abl/language-service';

export interface ParseError {
  line: number;
  column: number;
  message: string;
}

export interface EditorState {
  // Content
  dslContent: string;
  originalContent: string;
  isDirty: boolean;

  // Parse state
  parseErrors: ParseError[];
  parseWarnings: ParseError[];
  isParsingLive: boolean;

  // Compile state
  compiledIR: unknown | null;
  compileErrors: string[];
  isCompiling: boolean;

  // Language service state
  diagnostics: Diagnostic[];
  symbols: DocumentSymbol[];
  showSymbolTree: boolean;
  showDiagnostics: boolean;

  // File state
  currentFilePath: string | null;
  isSaving: boolean;
  saveError: string | null;

  // View mode
  viewMode: 'view' | 'edit';

  // Command palette state
  commandPaletteOpen: boolean;
  commandPalettePosition: { top: number; left: number } | null;
  commandPaletteSection: string | null;

  // Actions
  setDslContent: (content: string) => void;
  setOriginalContent: (content: string) => void;
  setParseErrors: (errors: ParseError[]) => void;
  setParseWarnings: (warnings: ParseError[]) => void;
  setIsParsingLive: (parsing: boolean) => void;
  setCompiledIR: (ir: unknown | null) => void;
  setCompileErrors: (errors: string[]) => void;
  setIsCompiling: (compiling: boolean) => void;
  setDiagnostics: (diagnostics: Diagnostic[]) => void;
  setSymbols: (symbols: DocumentSymbol[]) => void;
  toggleSymbolTree: () => void;
  toggleDiagnostics: () => void;
  setCurrentFilePath: (path: string | null) => void;
  setIsSaving: (saving: boolean) => void;
  setSaveError: (error: string | null) => void;
  setViewMode: (mode: 'view' | 'edit') => void;
  resetToOriginal: () => void;
  markSaved: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setCommandPalettePosition: (pos: { top: number; left: number } | null) => void;
  setCommandPaletteSection: (section: string | null) => void;
}

export const useEditorStore = create<EditorState>((set, _get) => ({
  // Initial state
  dslContent: '',
  originalContent: '',
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

  // Actions
  setDslContent: (content) =>
    set((state) => ({
      dslContent: content,
      isDirty: content !== state.originalContent,
      saveError: null, // Clear save error when content changes
      compileErrors: [], // Clear compile errors when content changes
    })),

  setOriginalContent: (content) =>
    set({
      originalContent: content,
      dslContent: content,
      isDirty: false,
      parseErrors: [],
      parseWarnings: [],
      compileErrors: [],
      compiledIR: null,
      saveError: null, // Clear save error when loading fresh content
    }),

  setParseErrors: (errors) => set({ parseErrors: errors }),
  setParseWarnings: (warnings) => set({ parseWarnings: warnings }),
  setIsParsingLive: (parsing) => set({ isParsingLive: parsing }),
  setCompiledIR: (ir) => set({ compiledIR: ir }),
  setCompileErrors: (errors) => set({ compileErrors: errors }),
  setIsCompiling: (compiling) => set({ isCompiling: compiling }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setSymbols: (symbols) => set({ symbols }),
  toggleSymbolTree: () => set((s) => ({ showSymbolTree: !s.showSymbolTree })),
  toggleDiagnostics: () => set((s) => ({ showDiagnostics: !s.showDiagnostics })),
  setCurrentFilePath: (path) => set({ currentFilePath: path }),
  setIsSaving: (saving) => set({ isSaving: saving }),
  setSaveError: (error) => set({ saveError: error }),
  setViewMode: (mode) => set({ viewMode: mode }),

  resetToOriginal: () =>
    set((state) => ({
      dslContent: state.originalContent,
      isDirty: false,
      parseErrors: [],
      parseWarnings: [],
    })),

  markSaved: () =>
    set((state) => ({
      originalContent: state.dslContent,
      isDirty: false,
      saveError: null,
    })),

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setCommandPalettePosition: (pos) => set({ commandPalettePosition: pos }),
  setCommandPaletteSection: (section) => set({ commandPaletteSection: section }),
}));
