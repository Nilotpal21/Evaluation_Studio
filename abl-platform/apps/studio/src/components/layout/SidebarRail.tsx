'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import { useNavigationStore } from '@/store/navigation-store';
import { ArchIcon } from '@/components/arch-shared/ArchIcon';
import { FolderOpen, ChevronRight } from 'lucide-react';

interface SidebarRailProps {
  onExpand: () => void;
  onProjectsClick?: () => void;
}

export function SidebarRail({ onExpand, onProjectsClick }: SidebarRailProps) {
  const { navigate } = useNavigationStore();

  return (
    <div className="flex h-full w-12 flex-col items-center border-r border-border bg-background py-3">
      {/* Arch logo — home / new chat */}
      <Tooltip content="New Chat" side="right">
        <button
          aria-label="New Chat"
          className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg text-purple hover:bg-purple/10 transition-colors"
          onClick={() => navigate('/')}
        >
          <ArchIcon size={20} />
        </button>
      </Tooltip>

      {/* Projects */}
      <Tooltip content="Projects" side="right">
        <button
          aria-label="Projects"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/10 hover:text-foreground transition-colors"
          onClick={onProjectsClick ?? onExpand}
        >
          <FolderOpen className="h-5 w-5" />
        </button>
      </Tooltip>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Expand toggle */}
      <Tooltip content="Expand sidebar" side="right">
        <button
          aria-label="Expand sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/10 hover:text-foreground transition-colors"
          onClick={onExpand}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
