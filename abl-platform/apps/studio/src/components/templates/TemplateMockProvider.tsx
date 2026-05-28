/**
 * TemplateMockProvider — Lightweight template preview renderer for Studio.
 *
 * Renders a simplified visual preview of rich content JSON using Studio's own
 * React components. Does NOT depend on the web-sdk package — Studio and web-sdk
 * are separate architectural boundaries.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { extractStructuredTextPreview, sanitizeHtml } from '@agent-platform/web-sdk';
import { Paperclip, ThumbsUp, ThumbsDown, Star, Play, Music } from 'lucide-react';

export interface TemplateMockProviderProps {
  richContent: Record<string, unknown>;
  actions?: Record<string, unknown>;
  className?: string;
}

/**
 * Renders a lightweight preview of rich content template JSON.
 * Each template type gets a simple visual representation sufficient
 * for the catalog browsing experience.
 */
export function TemplateMockProvider({
  richContent,
  actions,
  className,
}: TemplateMockProviderProps) {
  const t = useTranslations('templates');
  const elements: React.ReactNode[] = [];

  if (richContent.html && typeof richContent.html === 'string') {
    elements.push(
      <div
        key="html"
        className="rounded border border-default bg-background-muted p-3 text-sm"
        // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- Template preview HTML is sanitized with DOMPurify via sanitizeHtml before rendering.
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(richContent.html) }}
      />,
    );
  }

  if (richContent.markdown && typeof richContent.markdown === 'string') {
    elements.push(
      <div key="markdown" className="rounded border border-default bg-background-muted p-3 text-sm">
        {richContent.markdown}
      </div>,
    );
  }

  if (richContent.quick_replies && Array.isArray(richContent.quick_replies)) {
    elements.push(
      <div key="quick_replies" className="flex flex-wrap gap-1.5">
        {(richContent.quick_replies as Array<{ id: string; label: string }>).map((qr) => (
          <span
            key={qr.id}
            className="rounded-full border border-default bg-background px-3 py-1 text-xs"
          >
            {qr.label}
          </span>
        ))}
      </div>,
    );
  }

  if (richContent.list && typeof richContent.list === 'object') {
    const list = richContent.list as {
      title?: string;
      items: Array<{ title: string; subtitle?: string }>;
    };
    elements.push(
      <div key="list" className="space-y-1">
        {list.title && <div className="text-xs font-medium text-muted">{list.title}</div>}
        {list.items?.map((item, i) => (
          <div key={i} className="rounded border border-default p-2">
            <div className="text-sm font-medium">{item.title}</div>
            {item.subtitle && <div className="text-xs text-muted">{item.subtitle}</div>}
          </div>
        ))}
      </div>,
    );
  }

  if (richContent.image && typeof richContent.image === 'object') {
    const img = richContent.image as { url: string; alt?: string; caption?: string };
    elements.push(
      <div key="image" className="space-y-1">
        <div className="flex h-32 items-center justify-center rounded border border-default bg-background-muted text-xs text-muted">
          {img.alt ?? t('preview_image_placeholder')}
        </div>
        {img.caption && <div className="text-xs text-muted">{img.caption}</div>}
      </div>,
    );
  }

  if (richContent.video && typeof richContent.video === 'object') {
    const vid = richContent.video as { alt?: string };
    elements.push(
      <div
        key="video"
        className="flex h-32 items-center justify-center gap-1 rounded border border-default bg-background-muted text-xs text-muted"
      >
        <Play className="h-4 w-4" />
        {vid.alt ?? t('preview_video_placeholder')}
      </div>,
    );
  }

  if (richContent.audio && typeof richContent.audio === 'object') {
    const aud = richContent.audio as { alt?: string };
    elements.push(
      <div
        key="audio"
        className="flex h-10 items-center justify-center gap-1 rounded border border-default bg-background-muted text-xs text-muted"
      >
        <Music className="h-4 w-4" />
        {aud.alt ?? t('preview_audio_placeholder')}
      </div>,
    );
  }

  if (richContent.file && typeof richContent.file === 'object') {
    const file = richContent.file as { filename: string; mime_type?: string };
    elements.push(
      <div key="file" className="flex items-center gap-2 rounded border border-default p-2">
        <Paperclip className="h-4 w-4 text-muted" />
        <span className="text-sm">{file.filename}</span>
        {file.mime_type && <span className="text-xs text-muted">{file.mime_type}</span>}
      </div>,
    );
  }

  if (richContent.kpi && typeof richContent.kpi === 'object') {
    const kpi = richContent.kpi as {
      label: string;
      value: string | number;
      unit?: string;
      trend?: string;
    };
    elements.push(
      <div key="kpi" className="rounded border border-default p-3">
        <div className="text-xs text-muted">{kpi.label}</div>
        <div className="text-2xl font-bold">
          {kpi.value}
          {kpi.unit && <span className="ml-1 text-sm font-normal text-muted">{kpi.unit}</span>}
          {kpi.trend === 'up' && <span className="ml-1 text-success">↑</span>}
          {kpi.trend === 'down' && <span className="ml-1 text-error">↓</span>}
        </div>
      </div>,
    );
  }

  if (richContent.table && typeof richContent.table === 'object') {
    const table = richContent.table as {
      columns: Array<{ key: string; header: string }>;
      rows: Array<Record<string, string | number>>;
    };
    elements.push(
      <div key="table" className="overflow-x-auto rounded border border-default">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-default bg-background-muted">
              {table.columns?.map((col) => (
                <th key={col.key} className="px-3 py-1.5 text-left font-medium">
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows?.map((row, i) => (
              <tr key={i} className="border-b border-default last:border-0">
                {table.columns?.map((col) => (
                  <td key={col.key} className="px-3 py-1.5">
                    {String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  }

  if (richContent.chart && typeof richContent.chart === 'object') {
    const chart = richContent.chart as {
      type: string;
      title?: string;
      data: Array<{ label: string; value: number }>;
    };
    const maxVal = Math.max(...(chart.data?.map((d) => d.value) ?? [1]));
    elements.push(
      <div key="chart" className="space-y-2">
        {chart.title && <div className="text-xs font-medium">{chart.title}</div>}
        <div className="space-y-1">
          {chart.data?.map((dp, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-right text-xs text-muted">{dp.label}</span>
              <div className="flex-1 rounded bg-background-muted">
                <div
                  className="h-4 rounded bg-accent"
                  style={{ width: `${(dp.value / maxVal) * 100}%` }}
                />
              </div>
              <span className="w-8 text-right text-xs">{dp.value}</span>
            </div>
          ))}
        </div>
      </div>,
    );
  }

  if (richContent.form && typeof richContent.form === 'object') {
    const form = richContent.form as {
      title?: string;
      fields: Array<{ id: string; label: string; type: string }>;
      submit_label?: string;
    };
    elements.push(
      <div key="form" className="space-y-2 rounded border border-default p-3">
        {form.title && <div className="text-sm font-medium">{form.title}</div>}
        {form.fields?.map((field) => (
          <div key={field.id} className="space-y-0.5">
            <label htmlFor={`preview-${field.id}`} className="text-xs text-muted">
              {field.label}
            </label>
            <div
              id={`preview-${field.id}`}
              className="h-8 rounded border border-default bg-background-subtle"
            />
          </div>
        ))}
        {form.submit_label && (
          <button
            type="button"
            className="rounded bg-background-active px-3 py-1.5 text-xs font-medium"
            disabled
          >
            {form.submit_label}
          </button>
        )}
      </div>,
    );
  }

  if (richContent.progress && typeof richContent.progress === 'object') {
    const prog = richContent.progress as { label?: string; value: number; max?: number };
    const pct = ((prog.value / (prog.max ?? 100)) * 100).toFixed(0);
    elements.push(
      <div key="progress" className="space-y-1">
        {prog.label && <div className="text-xs text-muted">{prog.label}</div>}
        <div className="h-3 rounded-full bg-background-muted">
          <div className="h-3 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-right text-xs text-muted">{pct}%</div>
      </div>,
    );
  }

  if (richContent.feedback && typeof richContent.feedback === 'object') {
    const fb = richContent.feedback as { prompt: string; type: string; max?: number };
    const fbMax = Math.min(fb.max ?? 5, 20);
    elements.push(
      <div key="feedback" className="space-y-2">
        <div className="text-sm">{fb.prompt}</div>
        <div className="flex gap-1">
          {fb.type === 'stars' &&
            Array.from({ length: fbMax }, (_, i) => (
              <Star key={i} className="h-5 w-5 text-muted" />
            ))}
          {fb.type === 'thumbs' && (
            <>
              <ThumbsUp className="h-5 w-5 text-muted" />
              <ThumbsDown className="h-5 w-5 text-muted" />
            </>
          )}
          {fb.type === 'scale' && (
            <div className="flex gap-1">
              {Array.from({ length: fbMax }, (_, i) => (
                <span key={i} className="rounded border border-default px-1.5 py-0.5 text-xs">
                  {i + 1}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>,
    );
  }

  if (richContent.carousel && typeof richContent.carousel === 'object') {
    const carousel = richContent.carousel as {
      cards: Array<{ title: string; subtitle?: string; image_url?: string }>;
    };
    elements.push(
      <div key="carousel" className="flex gap-2 overflow-x-auto">
        {carousel.cards?.map((card, i) => (
          <div key={i} className="min-w-[140px] rounded border border-default p-2">
            {card.image_url && <div className="mb-1 h-16 rounded bg-background-muted" />}
            <div className="text-sm font-medium">{card.title}</div>
            {card.subtitle && <div className="text-xs text-muted">{card.subtitle}</div>}
          </div>
        ))}
      </div>,
    );
  }

  const channelPreviewTypes = ['adaptive_card', 'slack', 'whatsapp', 'ag_ui'] as const;
  for (const type of channelPreviewTypes) {
    const payload = richContent[type];
    if (typeof payload !== 'string' || payload.trim().length === 0) {
      continue;
    }

    const preview = extractStructuredTextPreview(payload);
    const titleKey = `type_${type}_name` as const;
    elements.push(
      <div key={type} className="rounded border border-default bg-background-muted p-3 text-sm">
        <div className="font-medium text-foreground">{t(titleKey)}</div>
        <div className="mt-1 text-xs text-muted">
          {preview ?? t('preview_channel_fallback', { channel: t(titleKey) })}
        </div>
      </div>,
    );
  }

  if (actions && typeof actions === 'object') {
    const actionSet = actions as {
      elements?: Array<{
        id: string;
        type: string;
        label: string;
        placeholder?: string;
        options?: Array<{ id: string; label: string }>;
      }>;
      submit_label?: string;
    };

    if (Array.isArray(actionSet.elements) && actionSet.elements.length > 0) {
      elements.push(
        <div key="actions" className="space-y-2 rounded border border-default p-3">
          <div className="text-sm font-medium text-foreground">{t('type_actions_name')}</div>
          <div className="flex flex-wrap gap-2">
            {actionSet.elements.map((element) => {
              if (element.type === 'button') {
                return (
                  <button
                    key={element.id}
                    type="button"
                    className="rounded bg-background-active px-3 py-1.5 text-xs font-medium"
                    disabled
                  >
                    {element.label}
                  </button>
                );
              }

              if (element.type === 'select') {
                return (
                  <select
                    key={element.id}
                    className="rounded border border-default bg-background-subtle px-2 py-1.5 text-xs"
                    disabled
                    defaultValue=""
                  >
                    <option value="">{element.label}</option>
                    {(element.options ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                );
              }

              return (
                <input
                  key={element.id}
                  className="rounded border border-default bg-background-subtle px-2 py-1.5 text-xs"
                  placeholder={element.placeholder ?? element.label}
                  disabled
                />
              );
            })}
          </div>
          {actionSet.submit_label && (
            <button
              type="button"
              className="rounded bg-background-active px-3 py-1.5 text-xs font-medium"
              disabled
            >
              {actionSet.submit_label}
            </button>
          )}
        </div>,
      );
    }
  }

  if (elements.length === 0) {
    return (
      <div className={className}>
        <div className="text-xs text-muted">{t('no_preview')}</div>
      </div>
    );
  }

  return <div className={`space-y-3 ${className ?? ''}`}>{elements}</div>;
}
