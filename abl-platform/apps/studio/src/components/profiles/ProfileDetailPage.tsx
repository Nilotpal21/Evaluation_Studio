'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code, Eye, Loader2, Check, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { useRegisterPageHeader } from '../../contexts/PageHeaderContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { Skeleton } from '../ui/Skeleton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { BehaviorSection } from '../agent-detail/BehaviorSection';
import type { BehaviorSectionData, ConversationBehaviorData } from '../../store/agent-detail-store';
import {
  createBehaviorProfile,
  deleteBehaviorProfile,
  getBehaviorProfile,
  updateBehaviorProfile,
  type BehaviorProfileDetail,
} from '../../api/behavior-profiles';
import { NEW_BEHAVIOR_PROFILE_ROUTE_SEGMENT, getCategoryVariant } from './constants';

type ViewMode = 'structured' | 'raw';

interface ProfileEditorState {
  name: string;
  priority: number;
  whenExpression: string;
  conversationBehavior?: ConversationBehaviorData;
  rawDsl: string;
  parseErrors: string[];
  overrideCategories: string[];
  usedByAgents: string[];
  updatedAt?: string;
}

const INITIAL_STATE: ProfileEditorState = {
  name: '',
  priority: 10,
  whenExpression: 'true',
  conversationBehavior: undefined,
  rawDsl: '',
  parseErrors: [],
  overrideCategories: [],
  usedByAgents: [],
  updatedAt: undefined,
};

function mapProfileToState(profile: BehaviorProfileDetail): ProfileEditorState {
  return {
    name: profile.name,
    priority: profile.priority,
    whenExpression: profile.whenExpression,
    conversationBehavior: profile.conversationBehavior,
    rawDsl: profile.dslContent,
    parseErrors: profile.parseErrors,
    overrideCategories: profile.overrideCategories,
    usedByAgents: profile.usedByAgents,
    updatedAt: profile.updatedAt,
  };
}

export function ProfileDetailPage() {
  const { projectId, subPage, navigate } = useNavigationStore();
  const isNew = subPage === NEW_BEHAVIOR_PROFILE_ROUTE_SEGMENT;
  const requestedName = subPage ? decodeURIComponent(subPage) : null;

  const [profile, setProfile] = useState<ProfileEditorState>(INITIAL_STATE);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('structured');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const behaviorData = useMemo<BehaviorSectionData>(
    () => ({
      conversationBehavior: profile.conversationBehavior,
      profiles: [],
    }),
    [profile.conversationBehavior],
  );

  const loadProfile = useCallback(async () => {
    if (!projectId || !requestedName || isNew) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const loaded = await getBehaviorProfile(projectId, requestedName);
      setProfile(mapProfileToState(loaded));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load behavior profile');
    } finally {
      setLoading(false);
    }
  }, [isNew, projectId, requestedName]);

  useEffect(() => {
    if (isNew) {
      setProfile(INITIAL_STATE);
      setLoading(false);
      return;
    }

    void loadProfile();
  }, [isNew, loadProfile]);

  const profilesHref = projectId ? `/projects/${projectId}/profiles` : '';

  const updateProfileState = useCallback(
    <K extends keyof ProfileEditorState>(key: K, value: ProfileEditorState[K]) => {
      setProfile((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const trimmedName = profile.name.trim();
  const nameInvalid = viewMode === 'structured' && trimmedName.length === 0;
  const canSave = !saving && !deleting && !nameInvalid;

  const handleSave = useCallback(async () => {
    if (!projectId) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const saved =
        viewMode === 'raw'
          ? isNew
            ? await createBehaviorProfile(projectId, {
                mode: 'raw',
                dslContent: profile.rawDsl,
              })
            : await updateBehaviorProfile(projectId, requestedName!, {
                mode: 'raw',
                dslContent: profile.rawDsl,
              })
          : isNew
            ? await createBehaviorProfile(projectId, {
                mode: 'structured',
                name: profile.name,
                priority: profile.priority,
                whenExpression: profile.whenExpression,
                conversationBehavior: profile.conversationBehavior,
                baseDslContent: profile.rawDsl,
              })
            : await updateBehaviorProfile(projectId, requestedName!, {
                mode: 'structured',
                name: profile.name,
                priority: profile.priority,
                whenExpression: profile.whenExpression,
                conversationBehavior: profile.conversationBehavior,
                baseDslContent: profile.rawDsl,
              });

      setProfile(mapProfileToState(saved));
      if (isNew || requestedName !== saved.name) {
        navigate(`/projects/${projectId}/profiles/${encodeURIComponent(saved.name)}`);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save behavior profile');
    } finally {
      setSaving(false);
    }
  }, [isNew, navigate, profile, projectId, requestedName, viewMode]);

  const handleDelete = useCallback(async () => {
    if (!projectId || isNew || !requestedName) {
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      await deleteBehaviorProfile(projectId, requestedName);
      setShowDeleteConfirm(false);
      navigate(`/projects/${projectId}/profiles`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'Failed to delete behavior profile',
      );
      setDeleting(false);
    }
  }, [isNew, navigate, projectId, requestedName]);

  const headerTitle = isNew
    ? 'New Behavior Profile'
    : profile.name || requestedName || 'Behavior Profile';

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <SegmentedControl
          size="sm"
          ariaLabel="Editor view"
          value={viewMode}
          onChange={(next) => setViewMode(next as ViewMode)}
          options={[
            { id: 'structured', label: 'Structured', icon: <Eye className="h-3.5 w-3.5" /> },
            { id: 'raw', label: 'Raw ABL', icon: <Code className="h-3.5 w-3.5" /> },
          ]}
        />
        {!isNew && (
          <Button
            variant="destructive-ghost"
            size="sm"
            icon={
              deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )
            }
            onClick={() => setShowDeleteConfirm(true)}
            disabled={saving || deleting}
          >
            Delete
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          icon={
            saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />
          }
          onClick={handleSave}
          disabled={!canSave}
        >
          Save
        </Button>
      </div>
    ),
    [canSave, deleting, handleSave, isNew, saving, viewMode],
  );

  const breadcrumbs = useMemo(
    () => [{ label: 'Behavior Profiles', href: profilesHref }, { label: headerTitle }],
    [profilesHref, headerTitle],
  );

  useRegisterPageHeader(
    headerTitle,
    headerActions,
    'Reusable overrides that change how an agent speaks, listens, and decides in specific contexts.',
    breadcrumbs,
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        ) : (
          <div className="space-y-6">
            {error && <Alert variant="error">{error}</Alert>}

            {profile.parseErrors.length > 0 && (
              <Alert variant="warning" title="Structured parsing found issues.">
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {profile.parseErrors.map((parseError) => (
                    <li key={parseError}>{parseError}</li>
                  ))}
                </ul>
                <p className="mt-3">
                  Raw ABL mode stays available so you can inspect or repair sections outside the
                  structured editor.
                </p>
              </Alert>
            )}

            {viewMode === 'structured' && (
              <div className="grid gap-4 md:grid-cols-6">
                <div className="md:col-span-2">
                  <Input
                    label="Profile Name"
                    placeholder="voice_support"
                    value={profile.name}
                    onChange={(event) => updateProfileState('name', event.target.value)}
                    error={nameInvalid ? 'Name is required' : undefined}
                  />
                </div>
                <div className="md:col-span-1">
                  <Input
                    label="Priority"
                    type="number"
                    value={String(profile.priority)}
                    onChange={(event) =>
                      updateProfileState(
                        'priority',
                        event.target.value ? Number.parseInt(event.target.value, 10) : 0,
                      )
                    }
                  />
                </div>
                <div className="md:col-span-3">
                  <Input
                    label="WHEN Expression"
                    placeholder='channel == "voice"'
                    value={profile.whenExpression}
                    onChange={(event) => updateProfileState('whenExpression', event.target.value)}
                    className="font-mono"
                  />
                </div>
              </div>
            )}

            {(profile.overrideCategories.length > 0 || profile.usedByAgents.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {profile.overrideCategories.map((category) => (
                  <Badge key={category} variant={getCategoryVariant(category)}>
                    {category.replace(/_/g, ' ')}
                  </Badge>
                ))}
                {profile.usedByAgents.length > 0 && (
                  <Badge variant="info">
                    Used by {profile.usedByAgents.length} agent
                    {profile.usedByAgents.length === 1 ? '' : 's'}
                  </Badge>
                )}
              </div>
            )}

            {viewMode === 'raw' ? (
              <div className="space-y-3 rounded-xl border border-default bg-background-muted p-4">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Raw ABL</h2>
                  <p className="text-xs text-muted">
                    Raw mode is the escape hatch for sections the structured editor does not own
                    yet.
                  </p>
                </div>
                <textarea
                  value={profile.rawDsl}
                  onChange={(event) => updateProfileState('rawDsl', event.target.value)}
                  className={clsx(
                    'min-h-[420px] w-full rounded-xl border border-default bg-background-subtle p-4 font-mono text-sm text-foreground',
                    'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                  )}
                  placeholder="BEHAVIOR_PROFILE: voice_support"
                  spellCheck={false}
                />
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-default bg-background-subtle p-4 text-sm text-muted">
                  Structured edits update the behavior profile header, <code>PRIORITY</code>,{' '}
                  <code>WHEN</code>, and the <code>CONVERSATION:</code> block. Other sections stay
                  preserved from the raw ABL until we add dedicated UI for them.
                </div>

                <BehaviorSection
                  data={behaviorData}
                  isExpanded={true}
                  onToggle={() => {}}
                  onChange={(nextData) =>
                    updateProfileState('conversationBehavior', nextData.conversationBehavior)
                  }
                  showProfileReferences={false}
                  authoringNote="Profile-specific Conversation Behavior here layers on top of any agent baseline when this profile is active."
                />
              </>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => (deleting ? undefined : setShowDeleteConfirm(false))}
        onConfirm={handleDelete}
        title="Delete behavior profile?"
        description={`"${requestedName ?? profile.name}" will be removed from this project. Agents that reference it will fall back to their baseline behavior.`}
        confirmLabel="Delete profile"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
