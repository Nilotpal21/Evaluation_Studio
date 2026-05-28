/**
 * AddSourceButton Component
 *
 * Self-contained button + dialog for adding a new source to an index.
 * Step 1: Browse 80+ connectors in a catalog with categories, search, and brand icons.
 * Step 2: Fill in type-specific config + name, then submit.
 * Enterprise connectors (sharepoint) delegate to the connector wizard panel.
 * Web crawling opens full-page CrawlFlowV5 via crawl-flow-store.
 */

import { useState, useCallback, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { EnterpriseConnectorWizard } from '../EnterpriseConnectorWizard';
import { ConnectorCatalog } from './ConnectorCatalog';
import { addSource } from '../../../api/search-ai';
import { useCrawlFlowStore } from '../../../store/crawl-flow-store';

interface AddSourceButtonProps {
  indexId: string;
  onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
  /** One-shot: open the dialog programmatically (e.g. from SetupGuide). */
  autoOpen?: boolean;
  /** Called after auto-open is consumed so parent can reset state. */
  onAutoOpenConsumed?: () => void;
  /** When true, only renders the dialog (no trigger button). Parent controls open state. */
  dialogOnly?: boolean;
  /** External open state when dialogOnly is true */
  open?: boolean;
  /** Called when dialog closes in dialogOnly mode */
  onClose?: () => void;
  /** One-shot: resume a configuring source by opening the crawl flow panel with this sourceId */
  resumeSourceId?: string | null;
  /** Called after resumeSourceId is consumed so parent can reset state */
  onResumeSourceConsumed?: () => void;
}

type SourceType = 'file' | 'web' | 'database' | 'api' | 'sharepoint';

interface FormState {
  name: string;
  // file
  fileTypes: string;
  maxFileSize: string;
  // web
  url: string;
  crawlDepth: string;
  includePatterns: string;
  excludePatterns: string;
  // database
  connectionString: string;
  collection: string;
  query: string;
  // api
  method: string;
  headers: string;
  authType: string;
  authConfig: string;
}

const INITIAL_FORM: FormState = {
  name: '',
  fileTypes: '',
  maxFileSize: '',
  url: '',
  crawlDepth: '2',
  includePatterns: '',
  excludePatterns: '',
  connectionString: '',
  collection: '',
  query: '',
  method: 'GET',
  headers: '',
  authType: 'none',
  authConfig: '',
};

const METHOD_OPTIONS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
];

export function AddSourceButton({
  indexId,
  onSourceAdded,
  autoOpen,
  onAutoOpenConsumed,
  dialogOnly,
  open: externalOpen,
  onClose: externalOnClose,
  resumeSourceId,
  onResumeSourceConsumed,
}: AddSourceButtonProps) {
  const t = useTranslations('search_ai.add_source');
  const openCrawlFlow = useCrawlFlowStore((s) => s.open);
  const tCatalog = useTranslations('search_ai.connector_catalog');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<'select' | 'config'>('select');
  const [selectedType, setSelectedType] = useState<SourceType | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Enterprise wizard state
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);

  const resetState = useCallback(() => {
    setStep('select');
    setSelectedType(null);
    setForm(INITIAL_FORM);
    setSubmitting(false);
    setFormError(null);
  }, []);

  // Sync external open state for dialogOnly mode
  useEffect(() => {
    if (dialogOnly && externalOpen !== undefined) {
      if (externalOpen && !dialogOpen) {
        resetState();
        setDialogOpen(true);
      } else if (!externalOpen && dialogOpen) {
        setDialogOpen(false);
        resetState();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOnly, externalOpen]);

  // One-shot auto-open: consume flag and open dialog (learning from B3: one-shot, not persistent)
  // Dep array: only `autoOpen` and `resetState` — `onAutoOpenConsumed` is an inline callback
  // from the parent that changes reference every render. Including it would cause wasteful
  // re-fires or potential double-fire (R1-1).
  useEffect(() => {
    if (autoOpen) {
      resetState();
      setDialogOpen(true);
      onAutoOpenConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, resetState]);

  // One-shot: resume a configuring source — open full-page crawl flow directly
  useEffect(() => {
    if (resumeSourceId) {
      openCrawlFlow({ sourceId: resumeSourceId });
      onResumeSourceConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSourceId]);

  const handleOpen = () => {
    resetState();
    setDialogOpen(true);
  };

  const handleClose = () => {
    setDialogOpen(false);
    resetState();
    if (dialogOnly) {
      externalOnClose?.();
    }
  };

  // Web Crawler: catalog signals web_modes → open full-page crawl flow
  const handleWebModeRequested = useCallback(() => {
    setDialogOpen(false);
    resetState();
    openCrawlFlow();
  }, [openCrawlFlow, resetState]);

  const handleBack = () => {
    setStep('select');
    setSelectedType(null);
    setFormError(null);
  };

  const updateField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormError(null);
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t('validation_name_required');
    if (selectedType === 'web' && !form.url.trim()) return t('validation_url_required');
    if (selectedType === 'database' && !form.connectionString.trim())
      return t('validation_connection_string_required');
    if (selectedType === 'api' && !form.url.trim()) return t('validation_url_required');
    return null;
  };

  const buildSourceConfig = (): Record<string, unknown> => {
    switch (selectedType) {
      case 'file':
        return {
          ...(form.fileTypes.trim() && { fileTypes: form.fileTypes.trim() }),
          ...(form.maxFileSize.trim() && { maxFileSize: form.maxFileSize.trim() }),
        };
      case 'web':
        return {
          url: form.url.trim(),
          ...(form.crawlDepth.trim() && { crawlDepth: form.crawlDepth.trim() }),
          ...(form.includePatterns.trim() && { includePatterns: form.includePatterns.trim() }),
          ...(form.excludePatterns.trim() && { excludePatterns: form.excludePatterns.trim() }),
        };
      case 'database':
        return {
          connectionString: form.connectionString.trim(),
          ...(form.collection.trim() && { collection: form.collection.trim() }),
          ...(form.query.trim() && { query: form.query.trim() }),
        };
      case 'api':
        return {
          url: form.url.trim(),
          method: form.method,
          ...(form.headers.trim() && { headers: form.headers.trim() }),
          ...(form.authType !== 'none' && { authType: form.authType }),
          ...(form.authType !== 'none' &&
            form.authConfig.trim() && {
              authConfig: form.authConfig.trim(),
            }),
        };
      default:
        return {};
    }
  };

  const handleSubmit = async () => {
    if (!selectedType) return;

    // File upload: skip source creation — source is resolved lazily at upload
    // time inside FileUploadDialog via resolveSourceId().
    if (selectedType === 'file') {
      handleClose();
      onSourceAdded(); // no source — signals "open upload dialog"
      return;
    }

    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const { source } = await addSource(indexId, {
        name: form.name.trim(),
        sourceType: selectedType,
        sourceConfig: buildSourceConfig(),
      });
      toast.success(t('toast_source_added'));
      handleClose();
      onSourceAdded(source);
    } catch (err: unknown) {
      const message = sanitizeError(err, t('toast_add_failed'));
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnterpriseSuccess = () => {
    setEnterpriseOpen(false);
    onSourceAdded();
  };

  const authTypeOptions = [
    { value: 'none', label: t('auth_none') },
    { value: 'bearer', label: t('auth_bearer') },
    { value: 'api-key', label: t('auth_api_key') },
    { value: 'basic', label: t('auth_basic') },
  ];

  // ─── Render ────────────────────────────────────────────────────────────

  const renderConfigForm = () => {
    if (!selectedType) return null;

    if (selectedType === 'web') {
      // Web crawling opens full-page via crawl-flow-store
      return null;
    }

    return (
      <div className="space-y-4">
        <Input
          label={t('label_source_name')}
          value={form.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder={t('placeholder_source_name')}
        />

        {selectedType === 'database' && (
          <>
            <Input
              label={t('label_connection_string')}
              value={form.connectionString}
              onChange={(e) => updateField('connectionString', e.target.value)}
              placeholder={t('placeholder_connection_string')}
            />
            <Input
              label={t('label_collection')}
              value={form.collection}
              onChange={(e) => updateField('collection', e.target.value)}
              placeholder={t('placeholder_collection')}
            />
            <div className="space-y-1.5">
              <label
                htmlFor="source-query-input"
                className="block text-sm font-medium text-foreground"
              >
                {t('label_query')}
              </label>
              <textarea
                id="source-query-input"
                value={form.query}
                onChange={(e) => updateField('query', e.target.value)}
                placeholder={t('placeholder_query')}
                rows={3}
                className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3"
              />
            </div>
          </>
        )}

        {selectedType === 'api' && (
          <>
            <Input
              label={t('label_url')}
              value={form.url}
              onChange={(e) => updateField('url', e.target.value)}
              placeholder={t('placeholder_url_api')}
            />
            <Select
              label={t('label_method')}
              options={METHOD_OPTIONS}
              value={form.method}
              onChange={(v) => updateField('method', v)}
            />
            <Input
              label={t('label_headers')}
              value={form.headers}
              onChange={(e) => updateField('headers', e.target.value)}
              placeholder={t('placeholder_headers')}
            />
            <Select
              label={t('label_auth_type')}
              options={authTypeOptions}
              value={form.authType}
              onChange={(v) => updateField('authType', v)}
            />
            {form.authType !== 'none' && (
              <Input
                label={t('label_auth_config')}
                value={form.authConfig}
                onChange={(e) => updateField('authConfig', e.target.value)}
                placeholder={t('placeholder_auth_config')}
              />
            )}
          </>
        )}

        {formError && <p className="text-sm text-error">{formError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleBack}>
            {t('button_back')}
          </Button>
          <Button size="sm" onClick={handleSubmit} loading={submitting} disabled={submitting}>
            {t('button_add_source')}
          </Button>
        </div>
      </div>
    );
  };

  // Dialog title: catalog shows "Connect a Data Source", config shows type-specific title
  const dialogTitle =
    step === 'select'
      ? tCatalog('dialog_title')
      : t('dialog_title_config', {
          sourceType: selectedType === 'web' ? t('type_web') : '',
        });

  return (
    <>
      {!dialogOnly && (
        <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleOpen}>
          {t('button_label')}
        </Button>
      )}

      {/* Standard dialog for catalog + non-web source types */}
      <Dialog
        open={dialogOpen}
        onClose={handleClose}
        title={step === 'config' ? dialogTitle : undefined}
        maxWidth={step === 'select' ? '7xl' : 'lg'}
      >
        {step === 'select' && (
          <ConnectorCatalog
            indexId={indexId}
            onSourceAdded={onSourceAdded}
            onClose={handleClose}
            onWebModeRequested={handleWebModeRequested}
          />
        )}
        {step === 'config' && renderConfigForm()}
      </Dialog>

      <EnterpriseConnectorWizard
        open={enterpriseOpen}
        onClose={() => setEnterpriseOpen(false)}
        indexId={indexId}
        connectorType="sharepoint"
        onSuccess={handleEnterpriseSuccess}
      />
    </>
  );
}
