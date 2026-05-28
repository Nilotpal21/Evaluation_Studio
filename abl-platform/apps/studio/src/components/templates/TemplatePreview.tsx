/**
 * TemplatePreview — Renders a selected template with mock data.
 *
 * Uses TemplateMockProvider (Studio's own lightweight renderer),
 * NOT the web-sdk. Studio and web-sdk are separate boundaries.
 */

'use client';

import React, { useMemo } from 'react';
import { TemplateMockProvider } from './TemplateMockProvider';
import { useTranslations } from 'next-intl';

export interface TemplatePreviewProps {
  jsonData: string;
}

export function TemplatePreview({ jsonData }: TemplatePreviewProps) {
  const t = useTranslations('templates');

  const { richContent, actions, error } = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonData) as Record<string, unknown>;
      const { actions: parsedActions, ...richContent } = parsed;
      return {
        richContent,
        actions:
          parsedActions && typeof parsedActions === 'object'
            ? (parsedActions as Record<string, unknown>)
            : undefined,
        error: null,
      };
    } catch {
      return { richContent: null, actions: undefined, error: t('invalid_json') };
    }
  }, [jsonData, t]);

  if (error) {
    return (
      <div className="rounded border border-error bg-error-subtle/10 p-4 text-sm text-error">
        {error}
      </div>
    );
  }

  if (!richContent) {
    return (
      <div className="rounded border border-default p-4 text-sm text-muted">{t('no_preview')}</div>
    );
  }

  return (
    <div className="rounded border border-default bg-background p-4">
      <TemplateMockProvider richContent={richContent} actions={actions} className="space-y-2" />
    </div>
  );
}
