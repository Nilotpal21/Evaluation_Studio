'use client';

/**
 * NotificationConfig
 *
 * Email and webhook notification configuration for a connector.
 * Auto-saves changes on debounce. Webhook has test + save actions.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Toggle } from '../../ui/Toggle';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import {
  useNotificationConfig,
  type NotificationConfigData,
} from '../../../hooks/useNotificationConfig';

interface NotificationConfigProps {
  indexId: string;
  connectorId: string;
}

const NOTIFICATION_EVENTS = [
  'sync_failure',
  'token_expiry',
  'permission_crawl_fail',
  'sync_complete',
] as const;

const DEBOUNCE_MS = 1000;

export function NotificationConfig({ indexId, connectorId }: NotificationConfigProps) {
  const t = useTranslations('search_ai.sharepoint.notifications');
  const { config, isLoading, updateConfig, testWebhook } = useNotificationConfig(
    indexId,
    connectorId,
  );

  const [webhookUrl, setWebhookUrl] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local webhook URL from fetched config
  useEffect(() => {
    if (config?.webhookUrl) {
      setWebhookUrl(config.webhookUrl);
    }
  }, [config?.webhookUrl]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const debouncedUpdate = useCallback(
    (updates: Partial<NotificationConfigData>) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        updateConfig(updates);
      }, DEBOUNCE_MS);
    },
    [updateConfig],
  );

  // Flush debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleEmailToggle = useCallback(
    (checked: boolean) => {
      debouncedUpdate({ emailAlertsEnabled: checked });
    },
    [debouncedUpdate],
  );

  const handleEmailEventToggle = useCallback(
    (event: string, checked: boolean) => {
      const currentEvents = config?.emailEvents ?? [];
      const newEvents = checked
        ? [...currentEvents, event]
        : currentEvents.filter((e) => e !== event);
      debouncedUpdate({ emailEvents: newEvents });
    },
    [config?.emailEvents, debouncedUpdate],
  );

  const handleWebhookEventToggle = useCallback(
    (event: string, checked: boolean) => {
      const currentEvents = config?.webhookEvents ?? [];
      const newEvents = checked
        ? [...currentEvents, event]
        : currentEvents.filter((e) => e !== event);
      debouncedUpdate({ webhookEvents: newEvents });
    },
    [config?.webhookEvents, debouncedUpdate],
  );

  const handleWebhookSave = useCallback(() => {
    updateConfig({ webhookUrl: webhookUrl || null });
  }, [updateConfig, webhookUrl]);

  const handleWebhookTest = useCallback(async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await testWebhook();
      setTestResult(result);
    } finally {
      setTestLoading(false);
    }
  }, [testWebhook]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('email_title')}</h3>
        <div className="h-20 bg-background-muted rounded animate-pulse" />
      </div>
    );
  }

  const emailEnabled = config?.emailAlertsEnabled ?? false;
  const emailEvents = config?.emailEvents ?? [];
  const webhookEvents = config?.webhookEvents ?? [];

  return (
    <div className="space-y-6">
      {/* Email Alerts */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('email_title')}</h3>
        <Toggle
          checked={emailEnabled}
          onChange={handleEmailToggle}
          label={t('email_toggle_label')}
        />
        {emailEnabled && (
          <div className="space-y-2 pl-12">
            <p className="text-xs text-muted">{t('email_service_note')}</p>
            {NOTIFICATION_EVENTS.map((event) => (
              <Checkbox
                key={`email-${event}`}
                checked={emailEvents.includes(event)}
                onChange={(checked) => handleEmailEventToggle(event, checked)}
                label={t(`event_${event}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Webhook */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('webhook_title')}</h3>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              label={t('webhook_url_label')}
              placeholder={t('webhook_url_placeholder')}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              aria-label={t('webhook_url_label')}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleWebhookTest}
            loading={testLoading}
            disabled={!webhookUrl}
          >
            {t('btn_test')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleWebhookSave} disabled={!webhookUrl}>
            {t('btn_save')}
          </Button>
        </div>
        {testResult && (
          <p className={`text-xs ${testResult.success ? 'text-success' : 'text-error'}`}>
            {testResult.success
              ? t('webhook_test_success')
              : t('webhook_test_failed', { error: testResult.error ?? '' })}
          </p>
        )}
        <p className="text-xs text-muted">{t('webhook_integrations_note')}</p>
        <p className="text-xs text-muted">{t('webhook_payload_note')}</p>
        <div className="space-y-2">
          {NOTIFICATION_EVENTS.map((event) => (
            <Checkbox
              key={`webhook-${event}`}
              checked={webhookEvents.includes(event)}
              onChange={(checked) => handleWebhookEventToggle(event, checked)}
              label={t(`event_${event}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
