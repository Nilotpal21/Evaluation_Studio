import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDiffEditor, mockHoverDisposable, mockModifiedModel, mockMonaco, mockOriginalModel } =
  vi.hoisted(() => {
    const mockOriginalModel = {
      isDisposed: vi.fn(() => false),
    };

    const mockModifiedModel = {
      getLineCount: vi.fn(() => 4),
      getLineMaxColumn: vi.fn(() => 24),
      isDisposed: vi.fn(() => false),
    };

    const mockDiffEditor = {
      getModel: vi.fn(() => ({
        original: mockOriginalModel,
        modified: mockModifiedModel,
      })),
      getModifiedEditor: vi.fn(() => ({
        getModel: vi.fn(() => mockModifiedModel),
      })),
      setModel: vi.fn(),
    };

    const mockHoverDisposable = {
      dispose: vi.fn(),
    };

    const mockMonaco = {
      MarkerSeverity: { Error: 8, Warning: 4 },
      editor: {
        defineTheme: vi.fn(),
        setModelMarkers: vi.fn(),
        setTheme: vi.fn(),
      },
      languages: {
        register: vi.fn(),
        registerHoverProvider: vi.fn(() => mockHoverDisposable),
        setMonarchTokensProvider: vi.fn(),
      },
    };

    return {
      mockDiffEditor,
      mockHoverDisposable,
      mockModifiedModel,
      mockMonaco,
      mockOriginalModel,
    };
  });

vi.mock('@monaco-editor/react', () => {
  const ReactModule = require('react') as typeof import('react');

  return {
    DiffEditor: ({
      onMount,
    }: {
      onMount?: (editor: typeof mockDiffEditor, monaco: typeof mockMonaco) => void;
    }) => {
      ReactModule.useEffect(() => {
        onMount?.(mockDiffEditor, mockMonaco);
      }, [onMount]);

      return ReactModule.createElement('div', { 'data-testid': 'mock-diff-editor' });
    },
  };
});

vi.mock('@abl/language-service', () => ({
  getHoverInfo: vi.fn(() => null),
}));

vi.mock('@/lib/abl-monarch', () => ({
  ablYamlTokenizer: {},
}));

import { ArchDiffEditor } from '@/lib/arch-ai/components/arch/panels/ArchDiffEditor';

describe('ArchDiffEditor cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockOriginalModel.isDisposed.mockReturnValue(false);
    mockModifiedModel.isDisposed.mockReturnValue(false);
    mockDiffEditor.getModel.mockReturnValue({
      original: mockOriginalModel,
      modified: mockModifiedModel,
    });
  });

  it('detaches the diff model before unmount disposal', () => {
    const { unmount } = render(
      <ArchDiffEditor original={'AGENT: Before'} modified={'AGENT: After'} fileName="LeadIntake" />,
    );

    unmount();

    expect(mockMonaco.editor.setModelMarkers).toHaveBeenCalledWith(
      mockOriginalModel,
      'arch-ai-validation',
      [],
    );
    expect(mockMonaco.editor.setModelMarkers).toHaveBeenCalledWith(
      mockModifiedModel,
      'arch-ai-validation',
      [],
    );
    expect(mockDiffEditor.setModel).toHaveBeenCalledWith(null);
    expect(mockHoverDisposable.dispose).toHaveBeenCalledTimes(1);
  });
});
