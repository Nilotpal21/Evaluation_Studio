/**
 * WorkflowsListPage Component
 *
 * Project workflows overview page with search, status filter,
 * and a 2-column grid of WorkflowCard components.
 */

import { useState, useMemo } from 'react';
import { GitBranch, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigationStore } from '../../store/navigation-store';
import { useWorkflowStore } from '../../store/workflow-store';
import { useWorkflows } from '../../hooks/useWorkflows';
import type { WorkflowSummary } from '../../api/workflows';
import { deleteWorkflow } from '../../api/workflows';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { EmptyState } from '../ui/EmptyState';
import { WorkflowCard } from './WorkflowCard';
import { CreateWorkflowModal } from './CreateWorkflowModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';

// =============================================================================
// CONSTANTS
// =============================================================================

const SKELETON_COUNT = 4;

type StatusFilter = 'all' | 'active' | 'paused' | 'error';

const statusFilterOptions = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'error', label: 'Error' },
];

// =============================================================================
// SKELETON
// =============================================================================

function WorkflowCardSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg skeleton" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="h-4 w-32 rounded skeleton" />
            <div className="ml-auto h-5 w-16 rounded-full skeleton" />
          </div>
        </div>
      </div>
      <div className="border-t border-muted my-3" />
      <div className="mb-3 space-y-2">
        <div className="h-3.5 w-full rounded skeleton" />
        <div className="h-3.5 w-2/3 rounded skeleton" />
      </div>
      <div className="flex items-center gap-3">
        <div className="h-3 w-16 rounded skeleton" />
        <div className="h-3 w-20 rounded skeleton" />
      </div>
    </div>
  );
}

function WorkflowCardSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <WorkflowCardSkeleton key={i} />
      ))}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowsListPage() {
  const { projectId, navigate } = useNavigationStore();
  const { setCurrentWorkflow } = useWorkflowStore();
  const { workflows, isLoading, error, refresh } = useWorkflows(projectId);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Filter workflows by search query and status (always exclude archived/deleted)
  const filtered = useMemo(() => {
    return workflows.filter((w) => {
      if (w.status === 'archived') return false;
      if (statusFilter !== 'all' && w.status !== statusFilter) return false;

      return (
        searchQuery === '' ||
        w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        w.description?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    });
  }, [workflows, searchQuery, statusFilter]);

  const handleOpenWorkflow = (workflow: WorkflowSummary) => {
    setCurrentWorkflow(workflow.id);
    navigate(`/projects/${projectId}/workflows/${workflow.id}`);
  };

  const handleDeleteWorkflow = async () => {
    if (!deleteTarget || !projectId) return;
    setIsDeleting(true);
    try {
      await deleteWorkflow(projectId, deleteTarget.id);
      toast.success(`Workflow "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to delete workflow: ${message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCreateWorkflow = () => {
    setShowCreateModal(true);
  };

  const handleWorkflowCreated = (workflowId: string) => {
    setShowCreateModal(false);
    navigate(`/projects/${projectId}/workflows/${workflowId}`);
  };

  const isEmptyStateShown = !isLoading && !error && filtered.length === 0;

  return (
    <>
      <ListPageShell
        title="Workflows"
        description={
          workflows.length > 0
            ? `${filtered.length} ${filtered.length === 1 ? 'workflow' : 'workflows'} in this project`
            : undefined
        }
        hidePrimaryAction={isEmptyStateShown}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={handleCreateWorkflow}>
            New Workflow
          </Button>
        }
        searchPlaceholder="Search workflows..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        filterBar={
          <FilterSelect
            options={statusFilterOptions}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
          />
        }
      >
        {/* Workflow Cards */}
        {isLoading ? (
          <WorkflowCardSkeletonGrid />
        ) : error ? (
          <EmptyState
            icon={<GitBranch className="w-6 h-6" />}
            title="Failed to load workflows"
            description={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          searchQuery ? (
            <EmptyState
              icon={<Search className="w-6 h-6" />}
              title="No matching workflows"
              description={`No workflows match "${searchQuery}".`}
            />
          ) : (
            <EmptyState
              icon={<GitBranch className="w-6 h-6" />}
              title="No workflows yet"
              description="Create your first workflow to automate multi-step processes with triggers, approvals, and notifications."
              action={
                <Button icon={<Plus className="w-4 h-4" />} onClick={handleCreateWorkflow}>
                  New Workflow
                </Button>
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger-children">
            {filtered.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onOpen={() => handleOpenWorkflow(workflow)}
                onDelete={() => setDeleteTarget(workflow)}
              />
            ))}
          </div>
        )}
      </ListPageShell>

      {showCreateModal && projectId && (
        <CreateWorkflowModal
          projectId={projectId}
          onCreated={handleWorkflowCreated}
          onClose={() => setShowCreateModal(false)}
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteWorkflow}
        title="Delete Workflow"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
