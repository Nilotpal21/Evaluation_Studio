/**
 * ExportDialog Component
 *
 * Preview and download a project export as .zip or .agent-bundle.json.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Download, Loader2, Package, AlertTriangle, Wrench, Layers } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import {
  fetchExportPreview,
  fetchExport,
  fetchExportV2,
  getExportErrorMessages,
  type ExportPreviewResponse,
  type ExportPreviewResponseV2,
  type ExportLayerInfo,
} from '../../api/project-io';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

export function ExportDialog({ open, onClose, projectId }: ExportDialogProps) {
  const t = useTranslations('projects.export');
  const [preview, setPreview] = useState<ExportPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [errorMessages, setErrorMessages] = useState<string[]>([]);
  const [selectedLayers, setSelectedLayers] = useState<Set<string>>(new Set());
  const [useV2, setUseV2] = useState(true);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setErrorMessages([]);
    try {
      const data = await fetchExportPreview(projectId);
      setPreview(data);
      // If v2 layer data is present, enable v2 mode and pre-select default layers
      const v2Data = data as ExportPreviewResponseV2;
      if (v2Data.layers && v2Data.defaultLayers) {
        setUseV2(true);
        setSelectedLayers(new Set(v2Data.defaultLayers));
      }
    } catch (err) {
      console.error('Failed to load export preview:', err);
      setErrorMessages(getExportErrorMessages(err, 'Failed to load preview'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setErrorMessages([]);
      setSelectedLayers(new Set());
      setUseV2(false);
      loadPreview();
    }
  }, [open, loadPreview]);

  const toggleLayer = (name: string, isAlways: boolean) => {
    if (isAlways) return; // Cannot deselect 'always' layers
    setSelectedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = useV2
        ? await fetchExportV2(projectId, [...selectedLayers], 'zip')
        : await fetchExport(projectId, 'zip');
      const slug = preview?.project.slug ?? 'project';

      // Create a real ZIP using fflate
      const { zipSync, strToU8 } = await import('fflate');

      const zipEntries: Record<string, Uint8Array> = {};
      for (const [path, content] of Object.entries(data.files)) {
        zipEntries[`${slug}/${path}`] = strToU8(content);
      }

      const zipped = zipSync(zipEntries);
      const blob = new Blob([new Uint8Array(zipped) as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (data.warnings.length > 0) {
        toast.warning(t('export_complete_warnings', { count: data.warnings.length }));
      } else {
        toast.success(t('export_success'));
      }
      onClose();
    } catch (err) {
      console.error('Export failed:', err);
      const [primaryMessage] = getExportErrorMessages(err, t('export_failed'));
      toast.error(primaryMessage);
    } finally {
      setExporting(false);
    }
  };

  const depWarnings = preview
    ? [
        ...preview.dependencies.validation.missing.map(
          (edge) => `${edge.from} references missing ${edge.type} "${edge.to}"`,
        ),
        ...preview.dependencies.validation.circular.map(
          (cycle) => `Circular dependency: ${cycle.join(' -> ')}`,
        ),
      ]
    : [];
  const tools = preview?.tools ?? [];
  const provisioning = (preview as ExportPreviewResponseV2 | null)?.provisioning;
  const provisioningSections = provisioning
    ? [
        { title: t('provisioning_env_vars'), values: provisioning.requiredEnvVars ?? [] },
        {
          title: t('provisioning_auth_profiles'),
          values: (provisioning.requiredAuthProfiles ?? []).map((profile) => profile.name),
        },
        { title: t('provisioning_connectors'), values: provisioning.requiredConnectors ?? [] },
        { title: t('provisioning_mcp_servers'), values: provisioning.requiredMcpServers ?? [] },
      ].filter((section) => section.values.length > 0)
    : [];

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="lg">
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      ) : errorMessages.length > 0 ? (
        <div className="text-center py-8">
          <div className="space-y-2">
            {errorMessages.map((message) => (
              <p key={message} className="text-sm text-error">
                {message}
              </p>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={loadPreview}>
            {t('retry')}
          </Button>
        </div>
      ) : preview ? (
        <div className="space-y-5">
          {/* Project info */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-subtle flex items-center justify-center">
              <Package className="w-5 h-5 text-accent" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{preview.project.name}</p>
              <p className="text-xs text-muted">
                {t('agent_count', { count: preview.agents.length })}
                {tools.length > 0 && ` \u00B7 ${t('tool_count', { count: tools.length })}`}
              </p>
            </div>
          </div>

          {/* Agent list */}
          <div>
            <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
              {t('agents_section')}
            </h3>
            <div className="space-y-1.5">
              {preview.agents.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
                >
                  <span className="text-sm text-foreground">{agent.name}</span>
                  <div className="flex items-center gap-2">
                    {!agent.hasDslContent && <Badge variant="warning">{t('no_dsl')}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tool list */}
          {tools.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('tools_section')}
              </h3>
              <div className="space-y-1.5">
                {tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
                  >
                    <div className="flex items-center gap-2">
                      <Wrench className="w-3.5 h-3.5 text-muted" />
                      <span className="text-sm text-foreground">{tool.name}</span>
                    </div>
                    <Badge variant="default">{tool.toolType}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {provisioningSections.length > 0 && (
            <div className="rounded-lg border border-border-subtle bg-background-muted p-3">
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
                {t('provisioning_section')}
              </h3>
              <div className="space-y-3">
                {provisioningSections.map((section) => (
                  <div key={section.title}>
                    <p className="text-xs font-medium text-foreground mb-1.5">{section.title}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {section.values.map((value) => (
                        <Badge key={`${section.title}-${value}`} variant="default">
                          {value}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Layer selection (v2) */}
          {useV2 && (preview as ExportPreviewResponseV2)?.layers && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                Export Layers
              </h3>
              <div className="space-y-1.5">
                {(preview as ExportPreviewResponseV2).layers.map((layer: ExportLayerInfo) => {
                  const isAlways = layer.defaultMode === 'always';
                  const checked = selectedLayers.has(layer.name);
                  return (
                    <div
                      key={layer.name}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted hover:bg-background-elevated transition-default"
                    >
                      <div className="flex items-center gap-2.5">
                        <Checkbox
                          checked={checked || isAlways}
                          disabled={isAlways}
                          onChange={() => toggleLayer(layer.name, isAlways)}
                          label={layer.name}
                          className="capitalize"
                        />
                        {isAlways && <Badge variant="default">required</Badge>}
                      </div>
                      {layer.entityCount > 0 && (
                        <span className="text-xs text-muted">{layer.entityCount} entities</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Dependency warnings */}
          {depWarnings.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-warning">{t('dependency_warnings')}</span>
              </div>
              <ul className="space-y-1">
                {depWarnings.map((w, i) => (
                  <li key={i} className="text-xs text-muted">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              icon={<Download className="w-4 h-4" />}
              loading={exporting}
              onClick={handleExport}
            >
              {t('export_button')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
