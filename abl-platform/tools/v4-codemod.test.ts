import { describe, it, expect } from 'vitest';
import { transformImports, transformFileContent } from './v4-codemod.js';

describe('v4 codemod — transformImports', () => {
  it('rewrites studio hook imports', () => {
    const input = `import { useArchChat } from '@/hooks/useArchChat';`;
    const output = transformImports(input);
    expect(output).toBe(`import { useArchChat } from '@/lib/arch-ai/ui/hook';`);
  });

  it('rewrites store imports', () => {
    const input = `import { useArchAIStore } from '@/store/arch-ai-store';`;
    const output = transformImports(input);
    expect(output).toBe(`import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';`);
  });

  it('rewrites @agent-platform/arch-ai imports', () => {
    const input = `import { SessionService } from '@agent-platform/arch-ai';`;
    const output = transformImports(input);
    expect(output).toBe(`import { SessionService } from '@agent-platform/arch-ai';`);
  });

  it('rewrites @agent-platform/arch-ai subpath imports', () => {
    const input = `import type { ArchSession } from '@agent-platform/arch-ai/types';`;
    const output = transformImports(input);
    expect(output).toBe(`import type { ArchSession } from '@agent-platform/arch-ai/types';`);
  });

  it('rewrites /api/arch-ai/ fetch URLs', () => {
    const input = `fetch('/api/arch-ai/sessions/current')`;
    const output = transformImports(input);
    expect(output).toBe(`fetch('/api/arch-ai/sessions/current')`);
  });

  it('rewrites @/lib/arch-ai/ imports', () => {
    const input = `import { attachmentFileStoreService } from '@/lib/arch-ai/message-services';`;
    const output = transformImports(input);
    expect(output).toBe(
      `import { attachmentFileStoreService } from '@/lib/arch-ai/message-services';`,
    );
  });

  it('rewrites @/types/arch imports', () => {
    const input = `import type { ArchMessage } from '@/types/arch';`;
    const output = transformImports(input);
    expect(output).toBe(`import type { ArchMessage } from '@/lib/arch-ai/types/arch';`);
  });

  it('leaves platform package imports untouched', () => {
    const input = `import { Button } from '@agent-platform/design-tokens';`;
    const output = transformImports(input);
    expect(output).toBe(input);
  });

  it('leaves unrelated imports untouched', () => {
    const input = `import { z } from 'zod';\nimport mongoose from 'mongoose';`;
    const output = transformImports(input);
    expect(output).toBe(input);
  });
});

describe('v4 codemod — transformFileContent with model options', () => {
  it('renames ArchSession → ArchSessionV4 and adds collection override', () => {
    const input = `
import type { IArchSession } from './types.js';

export const ArchSession =
  mongoose.models.ArchSession ||
  mongoose.model<IArchSession>('ArchSession', archSessionSchema);
`.trim();

    const output = transformFileContent(input, {
      kind: 'model',
      modelName: 'ArchSession',
      collection: 'arch_sessions_v4',
    });

    expect(output).toContain('ArchSessionV4');
    expect(output).toContain('IArchSessionV4');
    expect(output).toContain("'arch_sessions_v4'");
    // Old names should be fully replaced:
    expect(output).not.toMatch(/\bArchSession\b(?!V4)/);
    expect(output).not.toMatch(/\bIArchSession\b(?!V4)/);
  });

  it('handles HMR-guarded registration with schema arg', () => {
    const input = `
export const ArchJournal =
  mongoose.models.ArchJournal ||
  mongoose.model<IArchJournal>('ArchJournal', archJournalSchema);
`.trim();

    const output = transformFileContent(input, {
      kind: 'model',
      modelName: 'ArchJournal',
      collection: 'arch_journals_v4',
    });

    expect(output).toContain('ArchJournalV4');
    expect(output).toContain("'arch_journals_v4'");
  });

  it('still applies import rewrites when model options given', () => {
    const input = `
import { someHelper } from '@agent-platform/arch-ai/helpers';
export const ArchSession = mongoose.models.ArchSession || mongoose.model<IArchSession>('ArchSession', s);
`.trim();

    const output = transformFileContent(input, {
      kind: 'model',
      modelName: 'ArchSession',
      collection: 'arch_sessions_v4',
    });

    expect(output).toContain('@agent-platform/arch-ai/helpers');
    expect(output).toContain('ArchSessionV4');
  });
});

describe('v4 codemod — transformFileContent without model options', () => {
  it('only applies import rewrites', () => {
    const input = `import { X } from '@agent-platform/arch-ai';`;
    const output = transformFileContent(input);
    expect(output).toBe(`import { X } from '@agent-platform/arch-ai';`);
  });
});
