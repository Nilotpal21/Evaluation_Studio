/**
 * OverviewTab — connection summary, setup instructions, webhook URL, identifiers.
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info, RefreshCw, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { CodeBlock } from '../../../ui/CodeBlock';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useRuntimeConfig } from '../../../../contexts/RuntimeConfigContext';
import { updateConnection } from '../../../../api/channel-connections';
import type { ChannelTabProps } from '../types';
import { getActiveProviderOption } from '../channel-registry';
import {
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  WORKING_COPY_LABEL,
  formatDate,
} from '../channel-utils';
import { buildSdkChatExamplePayload } from '../sdk-chat-curl';

// =============================================================================
// HELPERS
// =============================================================================

// SOURCE_LABELS is defined inside the component to use i18n translations.

// =============================================================================
// COPY BUTTON HOOK
// =============================================================================

function useCopyField() {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback((fieldKey: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      /* clipboard API may not be available in all contexts */
    });
    setCopiedField(fieldKey);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  return { copiedField, handleCopy };
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function CopyableField({
  label,
  value,
  fieldKey,
  copiedField,
  onCopy,
}: {
  label: string;
  value: string;
  fieldKey: string;
  copiedField: string | null;
  onCopy: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted">{label}</label>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-background-muted border border-default font-mono text-xs break-all">
        <span className="flex-1 text-foreground">{value}</span>
        <button
          onClick={() => onCopy(fieldKey, value)}
          className="p-1 text-muted hover:text-foreground shrink-0 transition-default"
          title={`Copy ${label.toLowerCase()}`}
        >
          {copiedField === fieldKey ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="text-xs text-foreground">{children}</div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function OverviewTab({ channelDef, instance, projectId, onRefresh }: ChannelTabProps) {
  const t = useTranslations('channels.overview');
  const { copiedField, handleCopy } = useCopyField();
  const { runtimeUrl } = useRuntimeConfig();
  const [rotatingSecret, setRotatingSecret] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);

  const handleRotateSecret = useCallback(async () => {
    setShowRotateConfirm(false);
    setRotatingSecret(true);
    try {
      const result = await updateConnection(projectId, instance._sourceId, {
        rotate_secret: true,
      });
      if (result.ai4w?.connectionSecret) {
        setRotatedSecret(result.ai4w.connectionSecret);
      }
      toast.success('Connection secret rotated');
      // Do NOT call onRefresh() here — it re-mounts the component and wipes
      // the rotatedSecret state before the user can copy it.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to rotate secret: ${message}`);
    } finally {
      setRotatingSecret(false);
    }
  }, [projectId, instance._sourceId]);

  const handleDismissRotatedSecret = useCallback(() => {
    setRotatedSecret(null);
    onRefresh();
  }, [onRefresh]);

  // Use the webhook URL computed by the runtime API (which accounts for
  // provider-specific paths and identifier-based vs body-based routing).
  // Fall back to a simple base+path computation for channels without an API-provided URL.
  const webhookUrl = useMemo(() => {
    if (instance.webhookUrl) return instance.webhookUrl;
    if (!channelDef.webhookPath) return null;
    const base = runtimeUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}${channelDef.webhookPath}`;
  }, [instance.webhookUrl, channelDef.webhookPath, runtimeUrl]);

  const SOURCE_LABELS: Record<string, string> = {
    sdk_channel: t('source_labels.sdk_channel'),
    channel_connection: t('source_labels.channel_connection'),
    webhook_subscription: t('source_labels.webhook_subscription'),
  };

  const sourceLabel = SOURCE_LABELS[instance._source] || instance._source;
  const runtimeBaseUrl =
    runtimeUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const sdkInitUrl = `${runtimeBaseUrl}/api/v1/sdk/init`;
  const chatUrl = `${runtimeBaseUrl}/api/v1/chat/agent`;
  const sdkInitExample = useMemo(() => {
    const payload = JSON.stringify({ channelId: instance._sourceId }, null, 2);
    return `curl -X POST ${sdkInitUrl} \\
  -H "X-Public-Key: pk_your_public_key" \\
  -H "Content-Type: application/json" \\
  -d '${payload}'`;
  }, [instance._sourceId, sdkInitUrl]);
  const sdkChatExample = useMemo(() => {
    const payload = buildSdkChatExamplePayload({
      projectId,
      deploymentId: instance.deploymentId,
      environment: instance.environment,
    });

    return `curl -X POST ${chatUrl} \\
  -H "X-SDK-Token: <token from /api/v1/sdk/init>" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(payload, null, 2)}'`;
  }, [chatUrl, instance.deploymentId, instance.environment, projectId]);

  return (
    <div className="space-y-5">
      {/* A. Connection Summary Card */}
      <div className="bg-background-elevated border border-default rounded-lg p-4">
        <h4 className="text-sm font-semibold text-foreground mb-3">{t('connection_summary')}</h4>
        <div className="divide-y divide-border-muted">
          <SummaryRow label={t('status_label')}>
            <Badge variant={STATUS_BADGE_VARIANT[instance.status]} dot>
              {STATUS_LABEL[instance.status]}
            </Badge>
          </SummaryRow>
          <SummaryRow label={t('created_label')}>{formatDate(instance.createdAt)}</SummaryRow>
          <SummaryRow label={t('updated_label')}>{formatDate(instance.updatedAt)}</SummaryRow>
          <SummaryRow label={t('environment_label')}>
            {instance.environment ? (
              <Badge variant="accent">{instance.environment}</Badge>
            ) : !instance.deploymentId ? (
              <span className="text-subtle">{WORKING_COPY_LABEL}</span>
            ) : (
              <span className="text-subtle">{t('no_environment')}</span>
            )}
          </SummaryRow>
          <SummaryRow label={t('source_type_label')}>{sourceLabel}</SummaryRow>
          <SummaryRow label={t('source_id_label')}>
            <span className="font-mono text-subtle">{instance._sourceId}</span>
          </SummaryRow>
        </div>
      </div>

      {/* B. Setup Instructions */}
      <details className="group" open={instance.status === 'inactive'}>
        <summary className="cursor-pointer text-sm font-medium text-foreground flex items-center gap-2 select-none">
          <Info className="w-4 h-4 text-muted" />
          {t('setup_instructions')}
        </summary>
        <div className="mt-3 ml-6 text-sm text-muted space-y-2">
          {getActiveProviderOption(channelDef, instance)?.setupInstructions ||
            channelDef.setupInstructions}
        </div>
      </details>

      {channelDef.id === 'sdk_api' && (
        <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-foreground">{t('api_integration_title')}</h4>
            <p className="text-sm text-muted mt-1">{t('api_integration_description')}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <CopyableField
              label={t('api_integration_channel_id_label')}
              value={instance._sourceId}
              fieldKey="sdkChannelId"
              copiedField={copiedField}
              onCopy={handleCopy}
            />
            <CopyableField
              label={t('api_integration_project_id_label')}
              value={projectId}
              fieldKey="sdkProjectId"
              copiedField={copiedField}
              onCopy={handleCopy}
            />
            <CopyableField
              label={t('api_integration_sdk_init_label')}
              value={sdkInitUrl}
              fieldKey="sdkInitUrl"
              copiedField={copiedField}
              onCopy={handleCopy}
            />
            <CopyableField
              label={t('api_integration_chat_endpoint_label')}
              value={chatUrl}
              fieldKey="sdkChatUrl"
              copiedField={copiedField}
              onCopy={handleCopy}
            />
          </div>

          <div className="space-y-2 text-sm text-muted">
            <p>
              <span className="font-medium text-foreground">
                {t('api_integration_bootstrap_heading')}
              </span>{' '}
              {t('api_integration_bootstrap_text')}
            </p>
            <p>
              <span className="font-medium text-foreground">
                {t('api_integration_chat_heading')}
              </span>{' '}
              {t('api_integration_chat_text')}
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              {t('api_integration_init_example_label')}
            </div>
            <CodeBlock code={sdkInitExample} language="bash" />
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              {t('api_integration_chat_example_label')}
            </div>
            <CodeBlock code={sdkChatExample} language="bash" />
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              {t('api_integration_docs_title')}
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <a href="/docs/api-reference/api-overview" className="text-info hover:underline">
                {t('api_integration_docs_auth')}
              </a>
              <a href="/docs/api-reference/conversation-api" className="text-info hover:underline">
                {t('api_integration_docs_conversation')}
              </a>
              <a href="/docs/api-reference/sdks" className="text-info hover:underline">
                {t('api_integration_docs_sdks')}
              </a>
            </div>
          </div>
        </div>
      )}

      {/* C. Webhook / Endpoint URL */}
      {webhookUrl && (
        <CopyableField
          label={channelDef.id === 'ai4w' ? 'Endpoint URL' : t('webhook_url_label')}
          value={webhookUrl}
          fieldKey="webhookUrl"
          copiedField={copiedField}
          onCopy={handleCopy}
        />
      )}

      {/* D. External Identifier (hidden for ai4w — connectionId is embedded in endpoint URL) */}
      {instance.externalIdentifier && channelDef.id !== 'ai4w' && (
        <CopyableField
          label={
            getActiveProviderOption(channelDef, instance)?.externalIdentifierLabel ||
            channelDef.externalIdentifierLabel
          }
          value={instance.externalIdentifier}
          fieldKey="externalIdentifier"
          copiedField={copiedField}
          onCopy={handleCopy}
        />
      )}

      {/* E. AI4W Connection Secret (masked + rotate) */}
      {channelDef.id === 'ai4w' && instance.hasCredentials && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted">Connection Secret</label>
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-background-muted border border-default font-mono text-xs">
              <span className="flex-1 text-foreground">
                {(instance.config?.secretPrefix as string) || 'abl_cs_'}
                {'••••••••••••'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRotateConfirm(true)}
                loading={rotatingSecret}
                className="shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Rotate
              </Button>
            </div>
            <p className="text-xs text-subtle">
              The full secret was shown only at creation time and cannot be retrieved.
            </p>
          </div>

          {rotatedSecret && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle p-3 space-y-3">
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-warning">
                    New Connection Secret
                  </p>
                  <p className="text-xs text-warning mt-1">
                    Copy and store this secret securely. It is shown <strong>only once</strong> and
                    cannot be retrieved again. Update your AIforWork configuration with this new
                    secret.
                  </p>
                </div>
              </div>
              <CodeBlock code={rotatedSecret} language="Secret" maxHeight="160px" />
              <Button variant="secondary" size="sm" onClick={handleDismissRotatedSecret}>
                I&apos;ve copied the secret
              </Button>
            </div>
          )}
        </div>
      )}

      {/* F. Rotate secret confirmation */}
      <ConfirmDialog
        open={showRotateConfirm}
        onClose={() => setShowRotateConfirm(false)}
        onConfirm={handleRotateSecret}
        title="Rotate Connection Secret?"
        description="The current secret will stop working immediately. Any AIforWork integration using the old secret will fail until updated with the new one."
        confirmLabel="Rotate Secret"
        variant="danger"
      />
    </div>
  );
}
