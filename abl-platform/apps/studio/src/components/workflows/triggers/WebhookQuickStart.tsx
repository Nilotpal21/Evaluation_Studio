'use client';

/**
 * WebhookQuickStart
 *
 * Quick-start panel for webhook triggers. Shows the endpoint URL with a
 * copy button, embeds CodeSnippets for curl examples, and displays the
 * current API key status badge with a link to manage keys.
 */

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Copy, Check, ExternalLink, Key, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CodeSnippets } from './CodeSnippets';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { workflowInputSample } from '../../../lib/json-schema-sample';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WebhookQuickStartProps {
  workflow: { id: string; name: string };
  trigger: { id: string; config: Record<string, unknown> };
  projectId: string;
  apiKey?: {
    id: string;
    prefix: string;
    isActive: boolean;
    expiresAt: string | null;
  };
  rawApiKey?: string;
  onRequestKey?: () => void;
  /** Currently viewed workflow version (e.g. 'v0.2.0', 'draft') */
  version?: string;
  /** State of the currently viewed version */
  versionState?: 'active' | 'inactive' | 'draft';
  /**
   * Workflow's declared inputSchema (JSON Schema). When present, the curl
   * snippets populate `-d '{"input": ...}'` with a sample derived from the
   * schema so the example aligns with the workflow's own contract.
   */
  inputSchema?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WebhookQuickStart({
  workflow,
  trigger,
  projectId,
  apiKey,
  rawApiKey,
  onRequestKey,
  version,
  versionState,
  inputSchema,
}: WebhookQuickStartProps) {
  const t = useTranslations('workflows.triggers');
  const router = useRouter();
  const [keyCopied, setKeyCopied] = useState(false);
  const [sameOriginBaseUrl, setSameOriginBaseUrl] = useState('');
  const { runtimeUrl } = useRuntimeConfig();

  useEffect(() => {
    if (runtimeUrl || typeof window === 'undefined') {
      return;
    }

    setSameOriginBaseUrl(window.location.origin);
  }, [runtimeUrl]);

  const runtimeBaseUrl = runtimeUrl || sameOriginBaseUrl;

  const handleCopyKey = useCallback(async () => {
    const keyToCopy = rawApiKey || apiKey?.prefix;
    if (!keyToCopy) return;
    try {
      await navigator.clipboard.writeText(keyToCopy);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }, [rawApiKey, apiKey?.prefix]);

  const keyStatusVariant = apiKey?.isActive ? 'success' : 'warning';
  const keyStatusLabel = apiKey ? (apiKey.isActive ? t('key_active') : t('key_expired')) : null;

  const callbackUrl = trigger.config.callbackUrl as string | undefined;
  const callbackAccessToken = trigger.config.callbackAccessToken as string | undefined;

  return (
    <div className="space-y-4">
      {/* Section header */}
      <h3 className="text-sm font-semibold text-foreground">{t('webhook_quick_start')}</h3>

      {/* API Key section */}
      {apiKey ? (
        <div
          className={clsx(
            'rounded-lg border border-default p-3 space-y-2',
            'bg-background-muted/50',
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-3.5 h-3.5 text-muted" />
              <span className="text-xs font-medium text-muted">{t('api_key_status')}</span>
              <Badge variant={keyStatusVariant}>{keyStatusLabel}</Badge>
            </div>
            <button
              onClick={() => router.push('/settings/api-keys')}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              aria-label={t('manage_api_keys')}
            >
              {t('manage_api_keys')}
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <code
              className={clsx(
                'flex-1 text-xs font-mono px-3 py-1.5 rounded-md truncate',
                'bg-background-muted text-foreground border border-default',
              )}
            >
              {apiKey.prefix}...
            </code>
            <button
              onClick={handleCopyKey}
              className={clsx(
                'p-1.5 rounded-md transition-fast shrink-0',
                'hover:bg-background-muted text-muted hover:text-foreground',
              )}
              aria-label={t('copy_curl')}
            >
              {keyCopied ? (
                <Check className="w-3.5 h-3.5 text-success" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
            {onRequestKey && (
              <Button
                variant="ghost"
                size="xs"
                icon={<RefreshCw className="w-3 h-3" />}
                onClick={onRequestKey}
              >
                {t('change_key')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-warning">{t('api_key_required')}</p>
          {onRequestKey && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Key className="w-3.5 h-3.5" />}
              onClick={onRequestKey}
            >
              {t('generate_api_key')}
            </Button>
          )}
        </div>
      )}

      {/* Code snippets */}
      <CodeSnippets
        workflowId={workflow.id}
        projectId={projectId}
        apiKeyPrefix={apiKey?.prefix ?? ''}
        baseUrl={runtimeBaseUrl}
        fullApiKey={rawApiKey}
        callbackUrl={callbackUrl}
        callbackAccessToken={callbackAccessToken}
        version={version}
        sampleInput={workflowInputSample(inputSchema)}
      />
    </div>
  );
}
