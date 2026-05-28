'use client';

import { InsightsKPICards } from './InsightsKPICards';
import { SessionListPanel } from './SessionListPanel';
import { CallStackTree } from './CallStackTree';
import { NodeDetailDrawer } from './NodeDetailDrawer';
import { useSessionInspectorStore } from '@/store/session-inspector-store';

export function SessionInspector() {
  const { drawerEventId } = useSessionInspectorStore();

  return (
    <div className="flex h-full flex-col">
      <InsightsKPICards />
      <div className="flex flex-1 min-h-0">
        <div className="w-[300px] flex-shrink-0">
          <SessionListPanel />
        </div>
        <div className={`flex-1 min-w-0 ${drawerEventId ? '' : ''}`}>
          <CallStackTree />
        </div>
        {drawerEventId && (
          <div className="w-[340px] flex-shrink-0">
            <NodeDetailDrawer />
          </div>
        )}
      </div>
    </div>
  );
}
