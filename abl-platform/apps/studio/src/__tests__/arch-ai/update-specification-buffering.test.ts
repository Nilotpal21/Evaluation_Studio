import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWrite } from '@agent-platform/arch-ai/engine';
import { ArchSpecDocument } from '@agent-platform/database/models';
import { buildOnboardingToolRegistry } from '@/lib/arch-ai/engine-factory';
import {
  journalService,
  sessionService,
  specDocumentService,
} from '@/lib/arch-ai/message-services';

class FakeTurnBuffer {
  private sessionPatch: Record<string, unknown> = {};
  private pendingProjectWrites: ProjectWrite[] = [];

  patchSession(patch: Record<string, unknown>): void {
    Object.assign(this.sessionPatch, patch);
  }

  enqueueProjectWrite(write: ProjectWrite): void {
    this.pendingProjectWrites.push(write);
  }

  get sessionPatchSnapshot(): Readonly<Record<string, unknown>> {
    return { ...this.sessionPatch };
  }

  get pendingProjectWritesSnapshot(): ReadonlyArray<ProjectWrite> {
    return [...this.pendingProjectWrites];
  }
}

describe('buildOnboardingToolRegistry update_specification buffering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('patches the turn buffer and queues a spec doc write instead of mutating session state directly', async () => {
    vi.spyOn(journalService, 'append').mockResolvedValue({
      id: 'journal-1',
      sessionId: 'sess-1',
      type: 'mutation',
      content: { type: 'mutation', what: 'updated' },
      specialist: 'onboarding',
      phase: 'INTERVIEW',
      timestamp: new Date().toISOString(),
      status: 'active',
      sequence: 1,
    });
    const sessionUpdateSpy = vi.spyOn(sessionService, 'updateSpecification');
    const specLookupSpy = vi.spyOn(specDocumentService, 'getBySession');
    const specWriteSpy = vi.spyOn(ArchSpecDocument, 'findOneAndUpdate').mockResolvedValue(null);

    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('update_specification');
    expect(tool?.kind).toBe('internal');
    expect(tool?.execute).toBeTypeOf('function');

    const buffer = new FakeTurnBuffer();

    const result = await tool!.execute!(
      {
        field: 'description',
        value: 'Qualify inbound leads against ICP rules.',
      },
      {
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        signal: new AbortController().signal,
        emit: () => {},
        buffer,
      },
    );

    expect(result).toBe('Updated description');
    expect(buffer.sessionPatchSnapshot['metadata.specification.description']).toBe(
      'Qualify inbound leads against ICP rules.',
    );
    expect(buffer.pendingProjectWritesSnapshot).toHaveLength(1);
    expect(sessionUpdateSpy).not.toHaveBeenCalled();
    expect(specLookupSpy).not.toHaveBeenCalled();

    await buffer.pendingProjectWritesSnapshot[0]?.execute({
      id: 'txn-1',
    });

    expect(specWriteSpy).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'sess-1',
      },
      {
        $set: { 'business.objective': 'Qualify inbound leads against ICP rules.' },
        $inc: { version: 1 },
      },
      expect.objectContaining({
        returnDocument: 'after',
        session: expect.objectContaining({ id: 'txn-1' }),
      }),
    );
  });
});
