/**
 * PublishModuleDialog Component
 *
 * Dialog for publishing a new module release with version, release notes,
 * optional environment pointer promotion, and a collapsible release preview.
 */

'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  Package,
  Wrench,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { useModuleStore } from '../../store/module-store';
import { publishRelease } from '../../api/modules';
import { sanitizeError } from '../../lib/sanitize-error';

interface ReadinessIssue {
  kind: string;
  agentName?: string;
  diagnostics?: Array<{ severity: string; message: string; source?: string }>;
}

interface PublishModuleDialogProps {
  projectId: string;
}

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

const ENVIRONMENT_OPTION_KEYS = [
  { value: '', key: 'envNone' },
  { value: 'dev', key: 'envDevelopment' },
  { value: 'staging', key: 'envStaging' },
  { value: 'production', key: 'envProduction' },
] as const;

interface PublishResult {
  version: string;
  warnings: string[];
  contract: {
    providedAgents?: Array<{ name: string }>;
    providedTools?: Array<{ name: string }>;
    requiredConfigKeys?: Array<{ key: string; isSecret: boolean }>;
    requiredAuthProfiles?: string[];
    requiredConnectors?: string[];
  } | null;
}

export function PublishModuleDialog({ projectId }: PublishModuleDialogProps) {
  const t = useTranslations('modules');

  const open = useModuleStore((s) => s.publishDialogOpen);
  const setOpen = useModuleStore((s) => s.setPublishDialogOpen);
  const releases = useModuleStore((s) => s.releases);
  const loadReleases = useModuleStore((s) => s.loadReleases);

  // Form state
  const [version, setVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [promoteToEnvironment, setPromoteToEnvironment] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [versionError, setVersionError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [readinessIssues, setReadinessIssues] = useState<ReadinessIssue[]>([]);

  // Success state
  const [result, setResult] = useState<PublishResult | null>(null);

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setVersion('');
      setReleaseNotes('');
      setPromoteToEnvironment('');
      setPreviewExpanded(false);
      setSubmitting(false);
      setVersionError('');
      setSubmitError('');
      setReadinessIssues([]);
      setResult(null);
    }
  }, [open]);

  const handleClose = () => {
    if (!submitting) setOpen(false);
  };

  const validateVersion = (v: string): boolean => {
    if (!v.trim()) {
      setVersionError(t('publish.version_required', { defaultValue: 'Version is required' }));
      return false;
    }
    if (!SEMVER_REGEX.test(v.trim())) {
      setVersionError(
        t('publish.version_format_error', {
          defaultValue: 'Version must be in semver format: X.Y.Z',
        }),
      );
      return false;
    }
    setVersionError('');
    return true;
  };

  const handleSubmit = async () => {
    setSubmitError('');

    if (!validateVersion(version)) return;

    setSubmitting(true);
    try {
      const response = await publishRelease(projectId, {
        version: version.trim(),
        releaseNotes: releaseNotes.trim() || undefined,
        promoteToEnvironment: promoteToEnvironment || undefined,
      });

      setResult({
        version: response.data.version,
        warnings: response.data.warnings,
        contract: response.data.contract,
      });

      toast.success(
        t('publish.success', {
          defaultValue: 'Version {version} published successfully',
          version: response.data.version,
        }),
      );

      // Reload releases list
      loadReleases(projectId);
    } catch (err: unknown) {
      const errRecord =
        err instanceof Error ? (err as unknown as Record<string, unknown>) : undefined;
      const statusCode =
        errRecord && 'statusCode' in errRecord ? (errRecord.statusCode as number) : undefined;

      if (statusCode === 409) {
        setVersionError(
          t('publish.version_conflict', {
            defaultValue: 'Version {version} already exists. Choose a different version.',
            version: version.trim(),
          }),
        );
      } else if (statusCode === 422) {
        const cause = errRecord?.cause as Record<string, unknown> | undefined;
        const issues: ReadinessIssue[] = Array.isArray(cause?.issues) ? cause.issues : [];

        if (issues.length > 0) {
          setSubmitError(
            t('publish.readiness_error', {
              defaultValue: 'Cannot publish — the project has issues that must be fixed first.',
            }),
          );
          setReadinessIssues(issues);
        } else {
          const errorMessage = sanitizeError(
            err,
            t('publish.build_error', {
              defaultValue: 'Build failed. Check your project for errors before publishing.',
            }),
          );
          setSubmitError(errorMessage);
        }
      } else {
        setSubmitError(
          sanitizeError(
            err,
            t('publish.generic_error', { defaultValue: 'Failed to publish release' }),
          ),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Derive preview data from latest release contract (approximation of what will be published)
  const latestRelease = releases[0];
  const previewContract = latestRelease?.contract as PublishResult['contract'] | undefined;
  const previewAgents = previewContract?.providedAgents ?? [];
  const previewTools = previewContract?.providedTools ?? [];
  const previewPrereqs = [
    ...(previewContract?.requiredConfigKeys?.map((k) =>
      t('publish.prereqConfig', { key: k.key }),
    ) ?? []),
    ...(previewContract?.requiredAuthProfiles?.map((p) =>
      t('publish.prereqAuthProfile', { name: p }),
    ) ?? []),
    ...(previewContract?.requiredConnectors?.map((c) =>
      t('publish.prereqConnector', { name: c }),
    ) ?? []),
  ];
  const hasPreviewData =
    previewAgents.length > 0 || previewTools.length > 0 || previewPrereqs.length > 0;

  // Success view
  if (result) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title={t('publish.success_title', { defaultValue: 'Release Published' })}
        maxWidth="sm"
      >
        <div className="space-y-5">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-success/10 border border-success/30">
            <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('publish.published_version', {
                  defaultValue: 'Version {version} is now available',
                  version: result.version,
                })}
              </p>
              {promoteToEnvironment && (
                <p className="text-xs text-muted mt-1">
                  {t('publish.promoted_to', {
                    defaultValue: 'Promoted to {environment}',
                    environment: promoteToEnvironment,
                  })}
                </p>
              )}
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div className="p-4 rounded-xl bg-warning/10 border border-warning/30 space-y-1.5">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-warning">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {result.contract && (
            <div className="space-y-2">
              {(result.contract.providedAgents?.length ?? 0) > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Package className="w-4 h-4" />
                  <span>
                    {t('publish.agents_exported', {
                      defaultValue: '{count} agent(s) exported',
                      count: result.contract.providedAgents!.length,
                    })}
                  </span>
                </div>
              )}
              {(result.contract.providedTools?.length ?? 0) > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Wrench className="w-4 h-4" />
                  <span>
                    {t('publish.tools_exported', {
                      defaultValue: '{count} tool(s) exported',
                      count: result.contract.providedTools!.length,
                    })}
                  </span>
                </div>
              )}
            </div>
          )}

          <Button variant="primary" onClick={handleClose} className="w-full">
            {t('publish.done', { defaultValue: 'Done' })}
          </Button>
        </div>
      </Dialog>
    );
  }

  // Form view
  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('publish.title', { defaultValue: 'Publish Module Release' })}
      maxWidth="md"
    >
      <div className="space-y-5">
        {/* Version input */}
        <Input
          label={t('publish.version_label', { defaultValue: 'Version' })}
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            if (versionError) validateVersion(e.target.value);
          }}
          placeholder="1.0.0"
          error={versionError}
        />

        {/* Release notes */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">
            {t('publish.release_notes_label', { defaultValue: 'Release Notes' })}
          </label>
          <textarea
            value={releaseNotes}
            onChange={(e) => setReleaseNotes(e.target.value)}
            placeholder={t('publish.release_notes_placeholder', {
              defaultValue: 'Describe what changed in this release...',
            })}
            rows={4}
            className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3 resize-y min-h-[6rem]"
          />
        </div>

        {/* Target pointer dropdown */}
        <Select
          label={t('publish.promote_label', { defaultValue: 'Promote to Environment' })}
          value={promoteToEnvironment}
          onChange={setPromoteToEnvironment}
          options={ENVIRONMENT_OPTION_KEYS.map((opt) => ({
            value: opt.value,
            label: t(`publish.${opt.key}`, { defaultValue: opt.key }),
          }))}
          placeholder={t('publish.promote_placeholder', { defaultValue: 'No promotion' })}
        />

        {/* Collapsible release preview */}
        {hasPreviewData && (
          <div className="border border-default rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setPreviewExpanded(!previewExpanded)}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-muted hover:text-foreground hover:bg-background-muted/30 transition-default"
            >
              {previewExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              {t('publish.preview_title', { defaultValue: 'Release Preview' })}
              <span className="text-xs font-normal text-subtle">
                {t('publish.preview_subtitle', {
                  defaultValue: '(based on latest release)',
                })}
              </span>
            </button>

            {previewExpanded && (
              <div className="px-4 pb-4 space-y-3 border-t border-default pt-3">
                {/* Exported agents */}
                {previewAgents.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-muted uppercase tracking-wider mb-2">
                      <Package className="w-3.5 h-3.5" />
                      {t('publish.preview_agents', { defaultValue: 'Exported Agents' })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {previewAgents.map((a) => (
                        <Badge key={a.name} variant="default">
                          {a.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Exported tools */}
                {previewTools.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-muted uppercase tracking-wider mb-2">
                      <Wrench className="w-3.5 h-3.5" />
                      {t('publish.preview_tools', { defaultValue: 'Exported Tools' })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {previewTools.map((tool) => (
                        <Badge key={tool.name} variant="default">
                          {tool.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Prerequisites */}
                {previewPrereqs.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-muted uppercase tracking-wider mb-2">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {t('publish.preview_prerequisites', { defaultValue: 'Prerequisites' })}
                    </div>
                    <ul className="space-y-1">
                      {previewPrereqs.map((p, i) => (
                        <li key={i} className="text-sm text-muted">
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Submit error */}
        {submitError && (
          <div className="p-4 rounded-xl bg-error/10 border border-error/30">
            <div className="flex items-start gap-2 text-sm text-error">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
            {readinessIssues.length > 0 && (
              <ul className="mt-3 space-y-2 pl-6 text-sm text-error">
                {readinessIssues.map((issue, idx) => (
                  <li key={idx} className="list-disc">
                    <span className="font-medium">
                      {issue.kind === 'agent_draft' && issue.agentName
                        ? t('publish.issue_agent', {
                            defaultValue: 'Agent "{name}"',
                            name: issue.agentName,
                          })
                        : issue.kind === 'runtime_config'
                          ? t('publish.issue_runtime_config', {
                              defaultValue: 'Runtime configuration',
                            })
                          : issue.kind === 'model_policy'
                            ? t('publish.issue_model_policy', {
                                defaultValue: 'Model policy',
                              })
                            : issue.kind}
                    </span>
                    {issue.diagnostics && issue.diagnostics.length > 0 && (
                      <span className="text-muted-foreground">
                        {' — '}
                        {issue.diagnostics.map((d) => d.message).join('; ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={submitting}
            className="flex-1"
          >
            {t('publish.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!version.trim()}
            className="flex-1"
          >
            {t('publish.submit', { defaultValue: 'Publish Release' })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
