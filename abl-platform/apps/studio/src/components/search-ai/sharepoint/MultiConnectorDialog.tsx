/**
 * MultiConnectorDialog Component
 *
 * Multi-step dialog for creating additional connectors.
 * Methods: From Scratch, Clone Existing, From Template, Import, API/CLI.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Copy, FileCode, Upload, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { TemplateSecurityGate } from './TemplateSecurityGate';
import {
  useConnectorTemplates,
  type ConnectorTemplate,
} from '../../../hooks/useConnectorTemplates';
import { apiFetch, handleResponse } from '../../../lib/api-client';

interface MultiConnectorDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  existingConnectors: Array<{
    connectorId: string;
    name: string;
    tenantId: string;
    permissionMode: 'enabled' | 'public_access';
    status: string;
  }>;
  onConnectorCreated: (connectorId: string) => void;
}

type Step =
  | 'method_select'
  | 'clone_select'
  | 'template_select'
  | 'import_upload'
  | 'security_gate'
  | 'creating'
  | 'api_cli';

interface MethodOption {
  id: Step;
  icon: React.ReactNode;
  labelKey: string;
  descKey: string;
}

export function MultiConnectorDialog({
  open,
  onClose,
  indexId,
  existingConnectors,
  onConnectorCreated,
}: MultiConnectorDialogProps) {
  const t = useTranslations('search_ai.sharepoint.multi_connector');

  const [step, setStep] = useState<Step>('method_select');
  const [selectedCloneId, setSelectedCloneId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [importConfig, setImportConfig] = useState<string>('');
  const [pendingPermissionMode, setPendingPermissionMode] = useState<'enabled' | 'public_access'>(
    'public_access',
  );
  const [loading, setLoading] = useState(false);

  const { templates } = useConnectorTemplates(indexId);

  const methods: MethodOption[] = [
    {
      id: 'method_select',
      icon: <Plus className="w-5 h-5" />,
      labelKey: 'method_scratch',
      descKey: 'method_scratch_desc',
    },
    {
      id: 'clone_select',
      icon: <Copy className="w-5 h-5" />,
      labelKey: 'method_clone',
      descKey: 'method_clone_desc',
    },
    {
      id: 'template_select',
      icon: <FileCode className="w-5 h-5" />,
      labelKey: 'method_template',
      descKey: 'method_template_desc',
    },
    {
      id: 'import_upload',
      icon: <Upload className="w-5 h-5" />,
      labelKey: 'method_import',
      descKey: 'method_import_desc',
    },
    {
      id: 'api_cli',
      icon: <Terminal className="w-5 h-5" />,
      labelKey: 'method_api',
      descKey: 'method_api_desc',
    },
  ];

  const resetState = useCallback(() => {
    setStep('method_select');
    setSelectedCloneId(null);
    setSelectedTemplateId(null);
    setImportConfig('');
    setLoading(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const handleMethodSelect = useCallback(
    (method: Step) => {
      if (method === 'method_select') {
        // "From Scratch" — just close and let the parent open the panel
        handleClose();
        return;
      }
      setStep(method);
    },
    [handleClose],
  );

  const handleClone = useCallback(
    async (securityDecision?: string) => {
      if (!selectedCloneId) return;
      setLoading(true);
      try {
        const resp = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connectors/${selectedCloneId}/clone`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ securityDecision }),
          },
        );
        const result = await handleResponse<{ data: { connectorId: string } }>(resp);
        toast.success(t('clone_success'));
        onConnectorCreated(result.data.connectorId);
        handleClose();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('clone_error')));
      } finally {
        setLoading(false);
      }
    },
    [indexId, selectedCloneId, onConnectorCreated, handleClose, t],
  );

  const handleApplyTemplate = useCallback(
    async (securityDecision?: string) => {
      if (!selectedTemplateId) return;
      setLoading(true);
      try {
        const resp = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connector-templates/${selectedTemplateId}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ securityDecision }),
          },
        );
        const result = await handleResponse<{ data: { connectorId: string } }>(resp);
        toast.success(t('template_success'));
        onConnectorCreated(result.data.connectorId);
        handleClose();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('template_error')));
      } finally {
        setLoading(false);
      }
    },
    [indexId, selectedTemplateId, onConnectorCreated, handleClose, t],
  );

  const handleImport = useCallback(
    async (securityDecision?: string) => {
      setLoading(true);
      try {
        const config = JSON.parse(importConfig);
        const resp = await apiFetch(`/api/search-ai/indexes/${indexId}/connectors/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, format: 'json', securityDecision }),
        });
        const result = await handleResponse<{ data: { connectorId: string } }>(resp);
        toast.success(t('import_success'));
        onConnectorCreated(result.data.connectorId);
        handleClose();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('import_error')));
      } finally {
        setLoading(false);
      }
    },
    [indexId, importConfig, onConnectorCreated, handleClose, t],
  );

  const proceedWithSecurityCheck = useCallback(
    (mode: 'enabled' | 'public_access', action: () => void) => {
      if (mode === 'enabled') {
        setPendingPermissionMode(mode);
        setStep('security_gate');
      } else {
        action();
      }
    },
    [],
  );

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} maxWidth="lg">
      <div className="space-y-4">
        {step === 'method_select' && (
          <div className="grid grid-cols-1 gap-2">
            {methods.map((method) => (
              <button
                key={method.id}
                onClick={() => handleMethodSelect(method.id)}
                className="flex items-center gap-3 p-4 rounded-lg border border-default hover:bg-background-subtle transition-default text-left"
              >
                <div className="shrink-0 text-muted">{method.icon}</div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t(method.labelKey)}</p>
                  <p className="text-xs text-muted">{t(method.descKey)}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {step === 'clone_select' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('clone_select_label')}</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {existingConnectors.map((c) => (
                <button
                  key={c.connectorId}
                  onClick={() => setSelectedCloneId(c.connectorId)}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border transition-default text-left ${
                    selectedCloneId === c.connectorId
                      ? 'border-accent bg-accent/5'
                      : 'border-default hover:bg-background-subtle'
                  }`}
                >
                  <span className="text-sm text-foreground">{c.name}</span>
                  <Badge variant={c.permissionMode === 'enabled' ? 'warning' : 'default'}>
                    {c.permissionMode}
                  </Badge>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const source = existingConnectors.find((c) => c.connectorId === selectedCloneId);
                  if (source) {
                    proceedWithSecurityCheck(source.permissionMode, () => handleClone());
                  }
                }}
                disabled={!selectedCloneId || loading}
                loading={loading}
              >
                {t('clone_button')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStep('method_select')}>
                {t('back')}
              </Button>
            </div>
          </div>
        )}

        {step === 'template_select' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('template_select_label')}</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {templates.length === 0 ? (
                <p className="text-sm text-muted p-3">{t('no_templates')}</p>
              ) : (
                templates.map((tmpl) => (
                  <button
                    key={tmpl.templateId}
                    onClick={() => setSelectedTemplateId(tmpl.templateId)}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border transition-default text-left ${
                      selectedTemplateId === tmpl.templateId
                        ? 'border-accent bg-accent/5'
                        : 'border-default hover:bg-background-subtle'
                    }`}
                  >
                    <div>
                      <span className="text-sm text-foreground">{tmpl.name}</span>
                      {tmpl.description && <p className="text-xs text-muted">{tmpl.description}</p>}
                    </div>
                    <Badge variant={tmpl.permissionMode === 'enabled' ? 'warning' : 'default'}>
                      {tmpl.permissionMode}
                    </Badge>
                  </button>
                ))
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const tmpl = templates.find((t) => t.templateId === selectedTemplateId);
                  if (tmpl) {
                    const mode =
                      tmpl.permissionMode === 'enabled'
                        ? ('enabled' as const)
                        : ('public_access' as const);
                    proceedWithSecurityCheck(mode, () => handleApplyTemplate());
                  }
                }}
                disabled={!selectedTemplateId || loading}
                loading={loading}
              >
                {t('template_button')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStep('method_select')}>
                {t('back')}
              </Button>
            </div>
          </div>
        )}

        {step === 'import_upload' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('import_label')}</p>
            <textarea
              className="w-full h-40 p-3 text-xs font-mono bg-background-subtle border border-default rounded-lg resize-none"
              placeholder={t('import_placeholder')}
              value={importConfig}
              onChange={(e) => setImportConfig(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleImport()}
                disabled={!importConfig.trim() || loading}
                loading={loading}
              >
                {t('import_button')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStep('method_select')}>
                {t('back')}
              </Button>
            </div>
          </div>
        )}

        {step === 'security_gate' && (
          <TemplateSecurityGate
            sourceName={t('security_gate_source_name')}
            sourcePermissionMode={pendingPermissionMode}
            requiredScopes={['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All']}
            onContinueWithPermissions={() => {
              if (selectedCloneId) handleClone('continue_with_permissions');
              else if (selectedTemplateId) handleApplyTemplate('continue_with_permissions');
              else handleImport('continue_with_permissions');
            }}
            onDisablePermissions={() => {
              if (selectedCloneId) handleClone('disable_permissions');
              else if (selectedTemplateId) handleApplyTemplate('disable_permissions');
              else handleImport('disable_permissions');
            }}
            onCancel={() => setStep('method_select')}
          />
        )}

        {step === 'api_cli' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('api_description')}</p>
            <div className="p-3 rounded-lg bg-background-subtle border border-default">
              <pre className="text-xs font-mono text-foreground whitespace-pre-wrap">
                {`POST /api/search-ai/indexes/${indexId}/connectors
Content-Type: application/json

{
  "name": "My SharePoint Connector",
  "connectorType": "sharepoint",
  "connectionConfig": { ... }
}`}
              </pre>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStep('method_select')}>
              {t('back')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
