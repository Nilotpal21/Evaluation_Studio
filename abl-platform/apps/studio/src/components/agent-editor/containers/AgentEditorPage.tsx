'use client';

/**
 * AgentEditorPage
 *
 * Full-page wrapper for the agent editor.
 * Fetches agent list for the switcher and uses navigation store for back nav.
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import { useNavigationStore } from '../../../store/navigation-store';
import { type RuntimeAgentListResponse } from '../../../api/runtime-agents';
import { apiFetch } from '../../../lib/api-client';
import { AgentEditor } from '../AgentEditor';

// =============================================================================
// PROPS
// =============================================================================

interface AgentEditorPageProps {
  projectId: string;
  agentName: string;
  onSaved?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentEditorPage({ projectId, agentName, onSaved }: AgentEditorPageProps) {
  const navigate = useNavigationStore((s) => s.navigate);

  // Fetch agent list for the switcher dropdown
  const { data: agentListData } = useSWR<RuntimeAgentListResponse>(
    projectId ? `/api/projects/${projectId}/agents` : null,
    (url: string) => apiFetch(url).then((r) => r.json()),
  );
  const agents = agentListData?.agents?.map((a) => ({ name: a.name }));

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/agents`);
  }, [navigate, projectId]);

  return (
    <div className="h-full">
      <AgentEditor
        projectId={projectId}
        agentName={agentName}
        agents={agents}
        onBack={handleBack}
        onSaved={onSaved}
      />
    </div>
  );
}
