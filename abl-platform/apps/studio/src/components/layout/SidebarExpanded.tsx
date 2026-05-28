'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import { useNavigationStore } from '@/store/navigation-store';
import { ArchIcon } from '@/components/arch-shared/ArchIcon';
import { ChevronLeft } from 'lucide-react';
import { SidebarProjectList } from './SidebarProjectList';

interface SidebarExpandedProps {
  onCollapse: () => void;
}

export function SidebarExpanded({ onCollapse }: SidebarExpandedProps) {
  const { navigate } = useNavigationStore();

  return (
    <div className="flex h-full w-60 flex-col border-r border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <Tooltip content="New Chat" side="right">
          <button
            aria-label="New Chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-purple hover:bg-purple/10 transition-colors"
            onClick={() => navigate('/')}
          >
            <ArchIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip content="Collapse sidebar" side="right">
          <button
            aria-label="Collapse sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/10 hover:text-foreground transition-colors"
            onClick={onCollapse}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Projects section */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Projects
        </div>
        <SidebarProjectList />
      </div>
    </div>
  );
}
