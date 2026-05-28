'use client';

/**
 * usePreloadOrchestrator — shared animation timeline for resuming an Arch session.
 *
 * Cloned for v4 so the preload timeline drives the v4 artifact store instead of
 * the current/root arch store.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { ArchSession } from '@agent-platform/arch-ai';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { buildBlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';
import {
  getBlueprintStage,
  getDraftTopology,
  getLockedTopology,
} from '@/lib/arch-ai/blueprint-flow';

type BackendPhase = 'INTERVIEW' | 'BLUEPRINT' | 'BUILD' | 'CREATE';

export type PreloadState =
  | { status: 'idle' }
  | { status: 'running'; revealedPhases: BackendPhase[]; visibleMessageCount: number }
  | { status: 'complete' };

export function usePreloadOrchestrator(session: ArchSession | null): {
  preloadState: PreloadState;
  startPreload: (messageCount: number) => void;
} {
  const [preloadState, setPreloadState] = useState<PreloadState>({ status: 'idle' });
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  const cancelTimers = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];
  }, []);

  const startPreload = useCallback(
    (messageCount: number) => {
      if (!session) return;

      cancelTimers();
      setPreloadState({ status: 'running', revealedPhases: [], visibleMessageCount: 0 });

      const meta = session.metadata as unknown as Record<string, unknown>;
      const phase = meta.phase as BackendPhase | undefined;
      const files = (meta.files ?? {}) as Record<string, { content: string }>;
      const mockServer = meta.mockServer as {
        files: Array<{ path: string; content: string }>;
      } | null;
      const lockedTopology = getLockedTopology(session);
      const draftTopology = getDraftTopology(session);
      const preloadTopology = (lockedTopology ??
        draftTopology ??
        (meta.topology && typeof meta.topology === 'object'
          ? (meta.topology as Record<string, unknown>)
          : null)) as Record<string, unknown> | null;

      const fileEntries = Object.entries(files);
      const fileCount = fileEntries.length;
      const isBlueprint = phase === 'BLUEPRINT' || phase === 'BUILD' || phase === 'CREATE';
      const isBuild = phase === 'BUILD' || phase === 'CREATE';

      useArchAIStore.getState().resetProjectState();

      const schedule = (delay: number, fn: () => void) => {
        const id = setTimeout(fn, delay);
        timerRefs.current.push(id);
      };

      const revealPhase = (nextPhase: BackendPhase) => {
        setPreloadState((prev) => {
          if (prev.status !== 'running') return prev;
          if (prev.revealedPhases.includes(nextPhase)) return prev;
          return { ...prev, revealedPhases: [...prev.revealedPhases, nextPhase] };
        });
      };

      const revealMessages = (count: number) => {
        setPreloadState((prev) => {
          if (prev.status !== 'running') return prev;
          return { ...prev, visibleMessageCount: count };
        });
      };

      const phaseCount = isBuild ? 3 : isBlueprint ? 2 : 1;
      const batch = (n: number) => Math.round((messageCount * n) / phaseCount);

      schedule(600, () => {
        revealPhase('INTERVIEW');
        revealMessages(batch(1));
      });
      schedule(800, () => {
        const store = useArchAIStore.getState();
        store.addTab({
          type: 'spec-document',
          label: 'Spec',
          data: meta.specification,
          toolCallId: `spec-${session.id}`,
        });
        store.addTab({
          type: 'journal',
          label: 'Journal',
          data: {},
          toolCallId: `journal-${session.id}`,
        });
        const specTab = useArchAIStore
          .getState()
          .artifactTabs.find((tab) => tab.type === 'spec-document');
        if (specTab) {
          useArchAIStore.getState().setActiveTab(specTab.id);
        }
      });

      if (isBlueprint) {
        schedule(2000, () => {
          revealPhase('BLUEPRINT');
          revealMessages(batch(isBuild ? 2 : phaseCount));
        });
        if (preloadTopology) {
          schedule(2200, () => {
            const store = useArchAIStore.getState();
            store.addTab({
              type: 'topology',
              label: 'Topology',
              data: {
                ...preloadTopology,
                approved: meta.topologyApproved,
                locked: Boolean(lockedTopology),
              },
              toolCallId: `topology-${session.id}`,
            });
            const blueprintTabId = store.addTab({
              type: 'blueprint-document',
              label: 'Blueprint',
              data: buildBlueprintDocumentArtifact({
                metadata: meta,
                topology: preloadTopology,
                stage: getBlueprintStage(session),
                approved: meta.topologyApproved === true,
                locked: Boolean(lockedTopology) || meta.topologyApproved === true,
              }),
              toolCallId: `blueprint-${session.id}`,
            });
            store.setActiveTab(blueprintTabId);
          });
        }
      }

      if (isBuild) {
        schedule(3600, () => {
          revealPhase('BUILD');
          revealMessages(messageCount);
        });
        schedule(3800, () => useArchAIStore.getState().showFilePanel());

        fileEntries.slice(0, 4).forEach(([name, file], idx) => {
          schedule(3900 + idx * 200, () => {
            const store = useArchAIStore.getState();
            store.addFile(name, file.content);
            store.addTab({
              type: 'agent_code',
              label: name,
              data: { name, content: file.content },
              toolCallId: `file-${name}`,
            });
          });
        });

        if (mockServer?.files?.length) {
          const baseOffset = Math.min(fileEntries.length, 4);
          mockServer.files.slice(0, 2).forEach((file, idx) => {
            schedule(3900 + (baseOffset + idx) * 200, () => {
              const store = useArchAIStore.getState();
              const mockKey = `mock:${file.path}`;
              store.addFile(mockKey, file.content, {
                fileType: 'mock',
                displayName: file.path,
              });
              store.addTab({
                type: 'agent_code',
                label: file.path,
                data: { name: file.path, content: file.content, isMock: true },
                toolCallId: `file-${mockKey}`,
              });
            });
          });
        }
      }

      const totalDuration = !isBlueprint ? 3000 : !isBuild ? 5000 : fileCount <= 3 ? 7000 : 8000;
      schedule(totalDuration, () => setPreloadState({ status: 'complete' }));
    },
    [session, cancelTimers],
  );

  useEffect(() => () => cancelTimers(), [cancelTimers]);

  return { preloadState, startPreload };
}
