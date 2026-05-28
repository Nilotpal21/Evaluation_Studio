'use client';

import type { ReactNode } from 'react';

export type LayoutMode = 'centered-chat' | 'split-panel' | 'ide' | 'centered-card';

interface ArchShellProps {
  chatPanel: ReactNode;
  artifactPanel?: ReactNode;
  progressBar?: ReactNode;
  phase?: string | null;
}

/**
 * ArchShell — responsive layout shell.
 *
 * chat (38%) + artifact (62%), always side by side.
 * Agent files appear in the artifact panel sidebar nav during BUILD.
 */
export function ArchShell({ chatPanel, artifactPanel, progressBar }: ArchShellProps) {
  return (
    <div className="flex h-full flex-col">
      {progressBar && <div className="flex-shrink-0">{progressBar}</div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Chat — always 38% on the far left */}
        <div
          className="flex-shrink-0 overflow-hidden border-r border-border/40 bg-background transition-[width] duration-300 ease-in-out"
          style={{ width: '38%' }}
        >
          <div className="h-full mx-auto max-w-[720px] bg-background">{chatPanel}</div>
        </div>

        {/* Artifact panel — always 62% */}
        {artifactPanel && (
          <div
            className="flex-shrink-0 overflow-hidden bg-background transition-[width] duration-300 ease-in-out lg:flex lg:flex-col"
            style={{ width: '62%' }}
          >
            {artifactPanel}
          </div>
        )}
      </div>
    </div>
  );
}
